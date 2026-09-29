import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { samePubkey } from '@dotrino/proxy-client'
import { useConnectionStore } from './connectionStore'
import { useContactsStore } from './contactsStore'
import { useRequestsStore } from './requestsStore'
import { shouldNotifyKind } from '../services/notifications'
import { getIdentity } from '../services/identity'
import { getStore, onVaultChanged } from '../services/store'
import { getReputation } from '../services/reputation'
import { sanitizeMessage, sanitizeNickname } from '../utils/sanitize'
import { key as accountKey } from '../services/account'
import { MINE as MI_VERSION, revisar } from '../services/compat'

// Contactos a los que ya contestamos el saludo esta sesión (por token). Evita la
// "tormenta de HELLO": un saludo de respuesta es a su vez un saludo, y dos contactos en
// línea entraban en ping-pong. Los tokens son de una conexión: al reconectar, se re-saluda.
const greetedTokens = new Set()

// "Avalado por tu red": alguien en quien confías (directo/transitivo) tiene una
// atestación sobre este pubkey. Si sí → la solicitud notifica; si no → silenciosa.
async function isVouched (pubkey) {
  try {
    const rep = await getReputation()
    if (!rep) return false
    const r = await rep.reputationOf(pubkey)
    return (r?.trustedCount || 0) > 0
  } catch (_) { return false }
}

const MAX_THREAD = 1000   // cap per-thread history (server-side cap también)
const LEGACY_KEY = 'messenger_threads_v1'  // migración del antiguo localStorage
// El espejo local es DE LA CUENTA activa (services/account.js). Sin namespacear, los
// hilos de una cuenta se veían al entrar con otra.
//
// Es una FUNCIÓN, no una constante de módulo: los imports se evalúan mucho antes de
// que `resolveAccount()` resuelva, así que una constante se quedaba con la clave
// pelada para siempre — y entonces esto no namespacea nada.
const cacheKey = () => accountKey('messenger_threads_cache_v1')

const loadLocalCache = () => {
  try {
    const raw = localStorage.getItem(cacheKey())
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}
const saveLocalCache = (data) => {
  try { localStorage.setItem(cacheKey(), JSON.stringify(data)) }
  catch (e) { console.warn('local thread cache write failed:', e) }
}

/**
 * Une dos mapas de hilos por id de mensaje, ordenando por fecha. Gana el más completo:
 * un mensaje que solo está de un lado se queda, y de los repetidos gana el remoto
 * (que trae el `pending:false` de un envío ya confirmado).
 */
function mergeThreads (local, remote) {
  const out = {}
  for (const k of new Set([...Object.keys(local || {}), ...Object.keys(remote || {})])) {
    const porId = new Map()
    for (const e of (local?.[k] || [])) if (e?.id) porId.set(e.id, e)
    for (const e of (remote?.[k] || [])) if (e?.id) porId.set(e.id, { ...porId.get(e.id), ...e })
    out[k] = [...porId.values()].sort((a, b) => (a.ts || 0) - (b.ts || 0)).slice(-MAX_THREAD)
  }
  return out
}

/**
 * Thread entry shape: { id, dir: 'in'|'out', text, ts, pending?: boolean }
 * Threads are keyed by contact pubkey.
 *
 * WIRE PROTOCOL (protocol 2). Every message is an object SEALED by the transport pillar
 * (`requireSealed`, CONVENCIONES §4.1): the proxy sees neither the type nor the content.
 * Nothing goes in the clear, not even the greeting.
 *
 *   CONTACT_REQUEST { nickname, v, card? }   "I want to add you" — goes to the other side's
 *                                            requests inbox, NEVER to a chat
 *   CONTACT_ACCEPT  { nickname, v, card? }   "accepted" — only counts if I asked first
 *   HELLO           { nickname, v, card? }   presence between contacts (token + nickname)
 *   DM              { text, ts, mid }        a chat message — only from a contact
 *   DM_ACK          { id }
 *   RATING_QUERY    { queryId, subject }
 *   RATING_REPLY    { queryId, subject, mine, endorsements }
 *
 * WHO WROTE IT is said by the key that sealed it (`meta.senderEncPub`): only the holder of
 * that private key could build the envelope. It is checked against the contact's known
 * keys, or against the encryption key that identity announced SIGNED (`encPubOf`). The
 * token says nothing and the transport greeting does not authenticate.
 */
export const useThreadsStore = defineStore('threads', () => {
  const connection = useConnectionStore()
  const contacts = useContactsStore()
  const requests = useRequestsStore()

  // Dispara la notificación in-app (App.vue observa lastIncomingDM) respetando
  // las preferencias del panel compartido. `kind`: 'message' | 'hello'.
  const notify = (kind, dm, vouched = false) => {
    if (!shouldNotifyKind(kind, vouched)) return
    lastIncomingDM.value = dm
  }

  const threads = ref(loadLocalCache())   // hidratación inmediata desde cache local
  const ACTIVE_KEY = accountKey('messenger_active_pubkey_v1')
  const activePubkey = ref(localStorage.getItem(ACTIVE_KEY) || null)
  const outbox = ref([])        // messages that could not leave yet (no connection)
  // Último DM entrante decodificado, para que App.vue muestre la notificación
  // centrada cuando llegue uno nuevo.
  const lastIncomingDM = ref(null)
  // pubkey -> 'incompatible' | 'unknown'. Lo que dijo su saludo (§14).
  const peerCompat = ref(/** @type {Record<string, string>} */ ({}))

  const activeThread = computed(() => activePubkey.value ? (threads.value[activePubkey.value] || []) : [])
  const activeContact = computed(() => activePubkey.value ? contacts.findByPubkey(activePubkey.value) : null)

  // Carga inicial: pide los hilos al store remoto y, si encontramos un
  // localStorage legacy del messenger viejo, lo migramos una vez.
  const load = async () => {
    const store = await getStore()
    // Si el store remoto no está disponible, NO borramos lo que ya tenemos
    // en memoria (hidratado desde el cache local). Mejor mostrar histórico
    // potencialmente desactualizado que pantalla en blanco.
    if (!store) return
    // Migración one-time desde el localStorage del messenger antiguo
    try {
      const legacy = localStorage.getItem(LEGACY_KEY)
      if (legacy) {
        const oldThreads = JSON.parse(legacy)
        for (const [pk, arr] of Object.entries(oldThreads || {})) {
          if (!Array.isArray(arr)) continue
          for (const entry of arr) await store.appendMessage(pk, entry)
        }
        localStorage.removeItem(LEGACY_KEY)
        console.log('[threads] migrated legacy localStorage to store.dotrino.com')
      }
    } catch (e) { console.warn('legacy migration failed:', e) }

    // Carga el snapshot completo: para messenger es viable porque en general
    // hay pocas conversaciones. Si crece, podemos pasar a lazy-load por hilo.
    const summaries = await store.getThreadSummaries()
    const next = {}
    for (const k of Object.keys(summaries)) {
      next[k] = await store.listThread(k)
    }
    // SE FUSIONA, NO SE PISA. Antes esto era `threads.value = next` + guardar: si el
    // remoto contestaba PARCIAL —el vault todavía reconciliando, un hilo que no llegó—
    // el espejo local se sobreescribía con menos de lo que tenía y esos mensajes se
    // perdían para siempre. El guard de «remoto vacío» solo cubría el todo-o-nada.
    threads.value = mergeThreads(threads.value, next)
    saveLocalCache(threads.value)
  }

  // Apend optimista en memoria + escritura asíncrona al store remoto.
  // El UI ve el cambio al instante; si la escritura falla queda log.
  const append = async (pubkey, entry) => {
    if (!entry.id) entry.id = crypto.randomUUID()
    if (!entry.ts) entry.ts = Date.now()
    if (!threads.value[pubkey]) threads.value[pubkey] = []
    threads.value[pubkey].push(entry)
    if (threads.value[pubkey].length > MAX_THREAD) {
      threads.value[pubkey] = threads.value[pubkey].slice(-MAX_THREAD)
    }
    saveLocalCache(threads.value)
    const store = await getStore()
    if (store) {
      try { await store.appendMessage(pubkey, entry) }
      catch (e) { console.warn('store.appendMessage failed:', e) }
    }
  }

  // Actualiza un campo de una entry existente y la persiste de nuevo. Útil
  // para marcar `pending: false` tras DM_ACK o tras envío exitoso.
  const updateEntry = async (pubkey, entryId, patch) => {
    const arr = threads.value[pubkey]
    if (!arr) return
    const e = arr.find(x => x.id === entryId)
    if (!e) return
    Object.assign(e, patch)
    saveLocalCache(threads.value)
    const store = await getStore()
    if (store) { try { await store.appendMessage(pubkey, e) } catch (_) {} }
  }

  /**
   * Marca como leído lo recibido en un hilo. El contador de no leídos se calculaba
   * con `!e._read` y NADIE escribía `_read` nunca, así que la burbuja enseñaba el
   * total de mensajes recibidos y no bajaba jamás.
   */
  const markThreadRead = async (pubkey) => {
    const arr = threads.value[pubkey]
    if (!arr) return
    const nuevas = arr.filter(e => e.dir === 'in' && !e._read)
    if (!nuevas.length) return
    for (const e of nuevas) e._read = true
    saveLocalCache(threads.value)
    const store = await getStore()
    if (!store) return
    for (const e of nuevas) {
      try { await store.appendMessage(pubkey, e) } catch (_) { /* se reintenta al releer */ }
    }
  }

  const setActive = (pubkey) => {
    activePubkey.value = pubkey
    if (pubkey) {
      localStorage.setItem(ACTIVE_KEY, pubkey)
      sendHelloTo(pubkey)
      markThreadRead(pubkey).catch(() => {})
    } else {
      localStorage.removeItem(ACTIVE_KEY)
    }
  }

  // ------------------------------------------------------------------------
  // Sending: everything sealed, by the most direct road the pillar has
  // ------------------------------------------------------------------------

  /**
   * Seal `payload` to a contact. With a live token it goes by token (the only road that
   * can go up to WebRTC); without one, by pubkey (the proxy's 24 h offline queue).
   * `quiet`: queue it without ringing their phone (presence can wait).
   */
  const sendToContact = async (pubkey, payload, { quiet = false } = {}) => {
    const c = contacts.findByPubkey(pubkey)
    if (!c) throw Object.assign(new Error('not a contact'), { code: 'not-contact' })
    const peerEncPub = c.encryptionPubkey || undefined
    const token = contacts.liveTokenFor(pubkey)
    if (token) await connection.sendSealedTo(token, payload, { peerPubkey: pubkey, peerEncPub })
    else await connection.sendSealed(pubkey, payload, { peerEncPub, quiet })
  }

  const whoAmI = async () => {
    const id = await getIdentity()
    if (!id) return null
    // TARJETA DE PERFIL: lo mínimo para que el otro pueda cifrarnos a TODOS nuestros
    // dispositivos y no solo a este (perfil, versión y llaves de cifrado; sin etiquetas
    // ni permisos). Ver dotrino-vault/docs/acta-de-perfil.md.
    const card = await id.profileCard?.().catch(() => null)
    return {
      nickname: connection.nickname,
      v: MI_VERSION,              // qué soy y qué versión corro (§14)
      ...(card ? { card } : {})
    }
  }

  const sendDM = async (pubkey, text) => {
    const trimmed = sanitizeMessage(text)
    if (!trimmed) return
    const contact = contacts.findByPubkey(pubkey)
    if (!contact) throw new Error('Unknown contact')

    const entry = { id: crypto.randomUUID(), dir: 'out', text: trimmed, ts: Date.now(), pending: true }
    append(pubkey, entry)
    await deliver({ pubkey, entryId: entry.id, text: trimmed, ts: entry.ts })
  }

  /** Sends one outgoing DM; if it cannot leave now, it stays in the outbox. */
  const deliver = async (item) => {
    try {
      await sendToContact(item.pubkey, { type: 'DM', text: item.text, ts: item.ts, mid: item.entryId })
      await updateEntry(item.pubkey, item.entryId, { pending: false })
      return true
    } catch (e) {
      console.warn('[messenger] DM could not be sent, will retry:', e?.code || '', e?.message)
      if (!outbox.value.some(x => x.entryId === item.entryId)) outbox.value.push(item)
      return false
    }
  }

  const flushOutbox = async () => {
    if (outbox.value.length === 0) return
    const pendientes = outbox.value
    outbox.value = []
    for (const item of pendientes) await deliver(item)
  }

  // ---- Greeting between contacts (presence) ------------------------------

  /** Say hello to a contact: by token if they are online, by pubkey (quietly) if not. */
  const sendHelloTo = async (pubkey) => {
    try {
      const me = await whoAmI()
      if (!me) return
      await sendToContact(pubkey, { type: 'HELLO', ...me }, { quiet: true })
    } catch (e) { console.warn('[messenger] hello failed:', e?.code || '', e?.message) }
  }

  // Reply to a greeting ONCE per token (anti-storm).
  const greetBack = async (token, pubkey) => {
    if (!token || greetedTokens.has(token)) return
    greetedTokens.add(token)
    await sendHelloTo(pubkey)
  }

  // ---- Contact requests ---------------------------------------------------

  /**
   * Ask someone to be a contact. The other side gets it in its REQUESTS INBOX; nothing
   * reaches any chat, and nobody is a contact of anybody until they accept.
   * `token` + `pubkey` come from redeeming their pairing code.
   */
  const sendContactRequest = async ({ token, pubkey, alias }) => {
    if (!pubkey) throw Object.assign(new Error('the pairing code did not say whose it is'), { code: 'no-peer-identity' })
    const me = await whoAmI()
    if (!me) throw Object.assign(new Error('identity vault unreachable'), { code: 'no-identity' })
    // If they already asked me, this is an acceptance: both sides want it.
    if (requests.get(pubkey, 'in')) { await acceptRequest(pubkey); return }
    const payload = { type: 'CONTACT_REQUEST', ...me }
    if (token) await connection.sendSealedTo(token, payload, { peerPubkey: pubkey })
    else await connection.sendSealed(pubkey, payload)
    requests.upsert({ pubkey, dir: 'out', nickname: (alias || '').trim(), token: token || null, ts: Date.now() })
  }

  // ------------------------------------------------------------------------
  // Inbound
  // ------------------------------------------------------------------------

  const sameKey = (a, b) => { try { return !!a && !!b && samePubkey(a, b) } catch (_) { return false } }

  /** Every encryption key I know for a contact: the one I saved, plus their profile card. */
  const knownEncPubs = (c) => {
    const out = []
    if (c?.encryptionPubkey) out.push(c.encryptionPubkey)
    const card = contacts.cardOf(c?.publickey)
    for (const k of (card?.keys || [])) if (k.encPub) out.push(k.encPub)
    return out
  }

  /**
   * WHO SENT THIS. Their identity comes from the proxy (`fromPubkey`, when routed by key)
   * or from the transport greeting (by token); it is TRUSTED only if the key that sealed
   * the envelope belongs to that identity: one I already know for that contact, or the one
   * that identity announced signed. Returns `{ pubkey, contact }` or null.
   */
  const authenticate = async (fromToken, meta) => {
    const claimed = meta.fromPubkey || connection.pubkeyOfToken(fromToken)
    const senderEncPub = meta.senderEncPub
    if (!claimed || !senderEncPub) return null
    const contact = contacts.findBySender(claimed)
    if (contact && knownEncPubs(contact).some(k => sameKey(k, senderEncPub))) {
      return { pubkey: contact.publickey, contact, encPub: senderEncPub }
    }
    let announced = null
    try { announced = await connection.encPubOf(claimed) } catch (e) {
      console.warn('[messenger] could not verify the sender key:', e?.code || '', e?.message)
      return null
    }
    if (!sameKey(announced, senderEncPub)) {
      console.warn('[messenger] message sealed with a key that is not the sender\'s — dropped')
      return null
    }
    return { pubkey: contact?.publickey || claimed, contact: contact || null, encPub: senderEncPub }
  }

  const handleIncoming = async (fromToken, payload, meta = {}) => {
    if (!payload || typeof payload !== 'object' || typeof payload.type !== 'string') return
    // Lo que no llegó sellado ni se mira (el pilar ya lo descarta con requireSealed).
    if (!meta.sealed) return
    const who = await authenticate(fromToken, meta)
    if (!who) return
    switch (payload.type) {
      case 'CONTACT_REQUEST': return handleContactRequest(fromToken, who, payload)
      case 'CONTACT_ACCEPT':  return handleContactAccept(fromToken, who, payload)
    }
    // From here on, only contacts. A stranger's message goes nowhere — not to a chat,
    // not to the inbox.
    if (!who.contact) return
    switch (payload.type) {
      case 'HELLO':        return handleHello(fromToken, who.contact, payload)
      case 'DM':           return handleDM(fromToken, who.contact, payload, meta)
      case 'DM_ACK':       return handleAck(payload)
      case 'RATING_QUERY': return handleRatingQuery(who.contact, payload)
      case 'RATING_REPLY': return handleRatingReply(payload)
    }
  }

  /** Their version (§14) and their profile card, whatever the message that brings them. */
  /** @param {string} pubkey @param {any} payload */
  const noteProfile = async (pubkey, payload) => {
    // Qué versión corre el otro lado (§14). No bloquea: se anota y la conversación lo
    // enseña. Sin esto, hablarle a una versión que no entiende se ve como silencio.
    const desajuste = revisar(payload.v)
    if (desajuste) peerCompat.value = { ...peerCompat.value, [pubkey]: desajuste }
    else if (peerCompat.value[pubkey]) {
      const { [pubkey]: _fuera, ...resto } = peerCompat.value
      peerCompat.value = resto
    }
    // Su tarjeta de perfil: con ella podremos cifrarle a todos sus dispositivos. El vault
    // la verifica y no acepta retrocesos ni cambios de master en silencio.
    if (payload.card) {
      try {
        const id = await getIdentity()
        const r = await id?.adoptPeerCard?.(payload.card)
        if (r && !r.adopted && r.reason === 'master-cambiado') {
          console.warn('[messenger] the card of %s is signed by another device: not adopted silently', pubkey.slice(0, 24))
        }
      } catch (e) { console.warn('adoptPeerCard:', e?.message || e) }
    }
  }

  const handleContactRequest = async (fromToken, who, payload) => {
    const nickname = sanitizeNickname(payload.nickname || '')
    await noteProfile(who.pubkey, payload)
    // Someone redeemed your code: a code is SINGLE USE, so the one on screen is burnt.
    // Ask for another one now, or the next friend types a dead one.
    connection.refreshPairingCode?.().catch?.(() => {})
    contacts.markOnline(who.pubkey, fromToken)
    // Already a contact (they reinstalled, lost us…): accept straight away.
    // And if I had asked them too, both sides want it.
    if (who.contact || requests.get(who.pubkey, 'out')) {
      await becomeContacts(who.pubkey, { nickname, token: fromToken, encryptionPubkey: who.encPub })
      await replyAccept(who.pubkey)
      return
    }
    const vouched = await isVouched(who.pubkey)
    requests.upsert({
      pubkey: who.pubkey, dir: 'in', nickname, token: fromToken,
      encryptionPubkey: who.encPub, ts: Date.now(), vouched
    })
    notify('hello', {
      id: 'request-' + who.pubkey,
      fromPubkey: who.pubkey,
      fromNickname: nickname || who.pubkey.slice(0, 8),
      text: '',
      ts: Date.now(),
      request: true
    }, vouched)
  }

  const handleContactAccept = async (fromToken, who, payload) => {
    // Only counts if I asked. Nobody adds themselves to my contacts.
    const mine = requests.get(who.pubkey, 'out')
    if (!mine && !who.contact) return
    await noteProfile(who.pubkey, payload)
    await becomeContacts(who.pubkey, {
      nickname: mine?.nickname || sanitizeNickname(payload.nickname || ''),
      token: fromToken,
      encryptionPubkey: who.encPub
    })
    contacts.markOnline(who.pubkey, fromToken)
  }

  const becomeContacts = async (pubkey, { nickname, token, encryptionPubkey }) => {
    const existing = contacts.findByPubkey(pubkey)
    await contacts.addContact({
      pubkey,
      nickname: existing?.nickname || nickname || pubkey.slice(0, 8),
      token: token || undefined,
      encryptionPubkey: encryptionPubkey || existing?.encryptionPubkey,
      notes: undefined
    })
    requests.remove(pubkey)
    flushOutbox()
  }

  const replyAccept = async (pubkey) => {
    const me = await whoAmI()
    if (!me) return
    await sendToContact(pubkey, { type: 'CONTACT_ACCEPT', ...me })
  }

  const handleHello = async (fromToken, contact, payload) => {
    await noteProfile(contact.publickey, payload)
    const patch = { lastToken: fromToken }
    if (!contact.nickname && payload.nickname) patch.nickname = sanitizeNickname(payload.nickname)
    await contacts.updateContact(contact.publickey, patch)
    contacts.markOnline(contact.publickey, fromToken)
    flushOutbox()
    greetBack(fromToken, contact.publickey)
  }

  const handleDM = async (fromToken, contact, payload, meta = {}) => {
    if (typeof payload.text !== 'string') return
    const cleanText = sanitizeMessage(payload.text)
    const mid = typeof payload.mid === 'string' ? payload.mid : crypto.randomUUID()
    const ts = Number(payload.ts) || Date.now()
    const pubkey = contact.publickey
    // Nace leído si su conversación está abierta y la ventana a la vista: si no,
    // el contador subiría con el mensaje delante de los ojos del usuario.
    const leido = activePubkey.value === pubkey &&
      (typeof document === 'undefined' || document.visibilityState === 'visible')
    // El mismo mensaje puede llegar dos veces (cola offline + en vivo): una vez basta.
    if (!(threads.value[pubkey] || []).some(e => e.id === mid)) {
      append(pubkey, { id: mid, dir: 'in', text: cleanText, ts, queued: !!meta.queued, queuedAt: meta.queuedAt || null, ...(leido ? { _read: true } : {}) })
      notify('message', {
        id: mid,
        fromPubkey: pubkey,
        fromNickname: contact.nickname || pubkey.slice(0, 8),
        text: cleanText,
        ts
      })
    }
    if (fromToken) contacts.markOnline(pubkey, fromToken)
    try { await sendToContact(pubkey, { type: 'DM_ACK', id: mid }, { quiet: true }) }
    catch (e) { console.warn('[messenger] ack failed:', e?.code || '', e?.message) }
  }

  const handleAck = async (payload) => {
    if (typeof payload.id !== 'string') return
    for (const [pk, arr] of Object.entries(threads.value)) {
      const e = arr.find(x => x.id === payload.id)
      if (e) { await updateEntry(pk, payload.id, { pending: false }); return }
    }
  }

  // ---- Ratings -----------------------------------------------------------
  //
  // Preguntan «¿qué sabes de FULANO?» y contestan con calificaciones: lo más delicado
  // que manda el messenger después del propio texto. Van sellados como todo lo demás.

  const askRatingsAbout = async (subjectPubkey) => {
    const queryId = crypto.randomUUID()
    for (const c of contacts.contacts) {
      if (c.publickey === subjectPubkey) continue
      if (!contacts.tokenFor(c.publickey)) continue
      await sendToContact(c.publickey, { type: 'RATING_QUERY', queryId, subject: subjectPubkey })
        .catch(e => console.warn('askRatingsAbout:', e?.message || e))
    }
  }

  const handleRatingQuery = async (contact, payload) => {
    if (typeof payload.subject !== 'string' || typeof payload.queryId !== 'string') return
    const id = await getIdentity()
    if (!id) return
    try {
      await id.recordQuery(contact.publickey, payload.subject)
      const { mine, endorsements } = await id.getRatingsForSubject(payload.subject)
      await sendToContact(contact.publickey, {
        type: 'RATING_REPLY', queryId: payload.queryId, subject: payload.subject, mine, endorsements
      })
    } catch (e) { console.warn('handleRatingQuery:', e) }
  }

  const handleRatingReply = async (data) => {
    if (typeof data.subject !== 'string') return
    const id = await getIdentity()
    if (!id) return
    try {
      if (data.mine) await id.mergeEndorsements(data.subject, [data.mine])
      if (Array.isArray(data.endorsements) && data.endorsements.length) {
        await id.mergeEndorsements(data.subject, data.endorsements)
      }
      contacts.refreshPeers()
    } catch (e) { console.warn('handleRatingReply:', e) }
  }

  // Carga asíncrona — el UI verá hilos aparecer cuando el store responda.
  // Además, nos suscribimos a `onSync`: el store puede arrancar bloqueado
  // (sin passphrase) y los hilos cifrados solo aparecen tras unlock + sync.
  // Sin esto, al refrescar la página los mensajes no se ven porque `load`
  // corre antes de que el vault esté desbloqueado.
  const reload = () => load().catch(e => console.warn('threads.load failed:', e))
  reload()
  ;(async () => {
    const store = await getStore()
    if (!store?.onSync) return
    store.onSync((ev) => {
      const t = ev?.type || ev
      if (t === 'unlock' || t === 'sync' || t === 'connect' || t === 'remote-update') {
        reload()
      }
    })
  })()

  // Con el respaldo por partes (@dotrino/store ≥ 0.11) las lecturas son LOCALES: lo que
  // se escribió en otro aparato ya no aparece solo al leer, llega por este evento. Sin
  // esto, un mensaje mandado desde el móvil no se vería aquí hasta recargar la página.
  onVaultChanged(() => reload())

  // ---- Requests inbox ------------------------------------------------------

  /** Accept a request: now we are contacts on both sides. No message enters any chat. */
  const acceptRequest = async (pubkey) => {
    const r = requests.get(pubkey, 'in')
    if (!r) return
    await becomeContacts(pubkey, { nickname: r.nickname, token: r.token, encryptionPubkey: r.encryptionPubkey })
    if (r.token) contacts.markOnline(pubkey, r.token)
    await replyAccept(pubkey)
    await contacts.refresh()
  }

  /** Dismiss an incoming request, or cancel one I sent. The other side is not told. */
  const dismissRequest = (pubkey, dir = 'in') => {
    requests.remove(pubkey, dir)
  }

  return {
    threads, activePubkey, activeThread, activeContact, outbox, lastIncomingDM, peerCompat,
    setActive, sendDM, flushOutbox, markThreadRead,
    handleIncoming, sendHelloTo, sendContactRequest,
    askRatingsAbout, load,
    requests, acceptRequest, dismissRequest
  }
})
