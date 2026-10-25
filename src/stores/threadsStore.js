import { defineStore } from 'pinia'
import { ref, computed, markRaw } from 'vue'
import { useConnectionStore } from './connectionStore'
import { useContactsStore } from './contactsStore'
import { useRequestsStore } from './requestsStore'
import { getFriends, hooks as friendHooks } from '../services/friends'
import { shouldNotifyKind } from '../services/notifications'
import { getIdentity } from '../services/identity'
import { getStore, onVaultChanged } from '../services/store'
import { getReputation } from '../services/reputation'
import { sanitizeMessage, sanitizeNickname } from '../utils/sanitize'
import { key as accountKey } from '../services/account'
import { checkPeer } from '../services/compat'
import { readFile, validIncomingFile, toBase64 } from '../utils/file'

// LOS BYTES DE LOS ARCHIVOS van en su propio hilo del almacén (`file:<contacto>`). En el
// hilo de la conversación queda solo su descripción ({ name, mime, size, w, h }): ese hilo
// se copia entero a localStorage en cada cambio, y unos archivos lo llenarían en minutos.
//
// Y cada archivo va en TROZOS de 384 KB (`<id>#<i>`): el respaldo en la bóveda no admite
// entradas de más de 550 KB, y un archivo entero se quedaría solo en este navegador.
const FILE_PREFIX = 'file:'
const fileKey = (pubkey) => FILE_PREFIX + pubkey
const FILE_PIECE = 384 * 1024

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
    const byId = new Map()
    for (const e of (local?.[k] || [])) if (e?.id) byId.set(e.id, e)
    for (const e of (remote?.[k] || [])) if (e?.id) byId.set(e.id, { ...byId.get(e.id), ...e })
    out[k] = [...byId.values()].sort((a, b) => (a.ts || 0) - (b.ts || 0)).slice(-MAX_THREAD)
  }
  return out
}

/**
 * Thread entry shape: { id, dir: 'in'|'out', text, ts, pending?: boolean, file?: { name, mime, size, w, h }, waits?: 'online'|'direct'|'version' }
 * Threads are keyed by contact pubkey.
 *
 * WIRE PROTOCOL (protocol 2). Every message is an object SEALED by the transport pillar
 * (`requireSealed`, CONVENCIONES §4.1): the proxy sees neither the type nor the content.
 * Nothing goes in the clear, not even the greeting.
 *
 *   CONTACT_REQUEST / CONTACT_ACCEPT          friend requests: handled by @dotrino/profile/friends
 *   HELLO           { nickname, v, card? }   presence between contacts (token + nickname)
 *   DM              { text, ts, mid, file? }  a chat message — only from a contact. `file` is
 *                                            { name, mime, data (base64), w, h }, sent as is;
 *                                            `text` is its caption
 *   DM_ACK          { id }
 *   RATING_QUERY    { queryId, subject }
 *   RATING_REPLY    { queryId, subject, mine, endorsements }
 *
 * WHO WROTE IT is decided by @dotrino/profile/friends (`receive`): the key that sealed it has to be
 * one of the contact's, or the one that identity announced signed.
 */
export const useThreadsStore = defineStore('threads', () => {
  const connection = useConnectionStore()
  const contacts = useContactsStore()
  const requests = useRequestsStore()
  const friends = getFriends()

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
  // id de mensaje → data URI de su archivo. Se llena al leer el almacén.
  const files = ref(/** @type {Record<string, string>} */ ({}))
  const filesLoaded = new Set()
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
      if (k.startsWith(FILE_PREFIX)) continue // bytes de archivos: se leen al abrir la conversación
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
  // para marcar `pending: false` tras DM_ACK.
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
    const unread = arr.filter(e => e.dir === 'in' && !e._read)
    if (!unread.length) return
    for (const e of unread) e._read = true
    saveLocalCache(threads.value)
    const store = await getStore()
    if (!store) return
    for (const e of unread) {
      try { await store.appendMessage(pubkey, e) } catch (_) { /* se reintenta al releer */ }
    }
  }

  const setActive = (pubkey) => {
    activePubkey.value = pubkey
    if (pubkey) {
      localStorage.setItem(ACTIVE_KEY, pubkey)
      sendHelloTo(pubkey)
      markThreadRead(pubkey).catch(() => {})
      loadFiles(pubkey).catch(() => {})
    } else {
      localStorage.removeItem(ACTIVE_KEY)
    }
  }

  // ------------------------------------------------------------------------
  // Sending: everything sealed, by the most direct road the pillar has
  // ------------------------------------------------------------------------

  /** Seal `payload` to a contact, to every device of their account (@dotrino/profile/friends). */
  const sendToContact = (pubkey, payload, opts) => friends.send(pubkey, payload, opts)

  /** What I send about myself: nickname, version and my profile card (@dotrino/profile/friends). */
  const whoAmI = async () => {
    const id = await getIdentity()
    if (!id) return null
    return friends.me()
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

  /**
   * Manda un archivo TAL CUAL (con `caption` opcional). Si no cabe por el camino de ahora,
   * queda pendiente: `waits: 'online'` hasta que el contacto se conecte, `'direct'` hasta que
   * haya canal directo. Devuelve la entrada.
   */
  const sendFile = async (pubkey, file, caption = '') => {
    const contact = contacts.findByPubkey(pubkey)
    if (!contact) throw new Error('Unknown contact')
    // markRaw: los bytes no se vuelven reactivos al pasar por el outbox.
    const f = markRaw(await readFile(file))
    const text = sanitizeMessage(caption || '')
    const entry = { id: crypto.randomUUID(), dir: 'out', text, ts: Date.now(), pending: true, file: { name: f.name, mime: f.mime, size: f.size, w: f.w, h: f.h } }
    await saveFile(pubkey, entry.id, f)
    append(pubkey, entry)
    await deliver({ pubkey, entryId: entry.id, text, ts: entry.ts, file: f })
    return entry
  }

  /** Guarda los bytes de un archivo en su hilo aparte (en base64: el almacén guarda JSON). */
  const saveFile = async (pubkey, id, f) => {
    const b64 = toBase64(f.data)
    files.value = { ...files.value, [id]: `data:${f.mime};base64,${b64}` }
    const store = await getStore()
    if (!store) return
    const n = Math.max(1, Math.ceil(b64.length / FILE_PIECE))
    try {
      for (let i = 0; i < n; i++) {
        await store.appendMessage(fileKey(pubkey), {
          id: `${id}#${i}`, msg: id, i, n, ts: Date.now(), mime: f.mime,
          data: b64.slice(i * FILE_PIECE, (i + 1) * FILE_PIECE)
        })
      }
    } catch (e) { console.warn('[messenger] could not store the file:', e?.code || '', e?.message) }
  }

  /** Lee del almacén los archivos de una conversación (una vez por sesión). */
  const loadFiles = async (pubkey) => {
    if (!pubkey || filesLoaded.has(pubkey)) return
    const store = await getStore()
    if (!store) return
    filesLoaded.add(pubkey)
    try {
      const list = await store.listThread(fileKey(pubkey))
      const byFile = new Map()
      for (const e of list || []) {
        if (!e?.msg || typeof e.data !== 'string' || !e.mime || !Number.isInteger(e.i) || !Number.isInteger(e.n)) continue
        if (!byFile.has(e.msg)) byFile.set(e.msg, { mime: e.mime, n: e.n, parts: [] })
        byFile.get(e.msg).parts[e.i] = e.data
      }
      const next = { ...files.value }
      for (const [id, f] of byFile) {
        const parts = f.parts.slice(0, f.n)
        // Un archivo al que le falta un trozo (todavía llegando de otro aparato) no se enseña a medias.
        if (parts.length === f.n && parts.every((p) => typeof p === 'string')) next[id] = `data:${f.mime};base64,${parts.join('')}`
      }
      files.value = next
    } catch (e) {
      filesLoaded.delete(pubkey)
      console.warn('[messenger] could not read the files:', e?.code || '', e?.message)
    }
  }

  /** Por dónde va un contacto ahora: el mejor camino entre sus aparatos conectados. */
  const routeOf = (pubkey) => friends.routeOf(pubkey)

  /** Un token que murió (la otra punta se fue) deja de usarse para escribirle. */
  const forgetToken = (token) => friends.forgetDevice(token)

  /**
   * EL ✓ LO PONE EL ACUSE DEL OTRO LADO, NO QUE AQUÍ SALIERA. Hasta 0.8.x un mensaje se daba
   * por entregado en cuanto salía de este aparato: si se perdía por el camino (un canal
   * directo medio caído, la otra punta con una versión vieja), aquí se veía ✓ y nadie lo
   * volvía a mandar. Ahora, lo que sale en vivo y no se confirma en ACK_WAIT_MS se manda otra
   * vez por la cola del proxio (por pubkey), que se lo entrega al reconectar; el otro lado
   * descarta el repetido por su id.
   */
  const ACK_WAIT_MS = 10000
  const awaitAck = (item) => {
    setTimeout(async () => {
      const e = (threads.value[item.pubkey] || []).find(x => x.id === item.entryId)
      if (!e || !e.pending) return
      try {
        await sendToContact(item.pubkey, { type: 'DM', text: item.text, ts: item.ts, mid: item.entryId }, { queue: true })
      } catch (err) {
        console.warn('[messenger] unacknowledged DM could not be queued, will retry:', err?.code || '', err?.message)
        if (!outbox.value.some(x => x.entryId === item.entryId)) outbox.value.push(item)
      }
    }, ACK_WAIT_MS)
  }

  /** Sends one outgoing DM; if it cannot leave now, it stays in the outbox. */
  const deliver = async (item) => {
    try {
      // Si va en vivo (el contacto está conectado) hay que vigilar el acuse; si no, ya va a la
      // cola. Si no se sabe por dónde va, se vigila: reencolar de más lo descarta el otro lado.
      const live = !item.file && (await routeOf(item.pubkey).catch(() => 'unknown')) !== 'offline'
      await sendToContact(item.pubkey, { type: 'DM', text: item.text, ts: item.ts, mid: item.entryId, ...(item.file ? { file: item.file } : {}) })
      // Un archivo también se da por entregado con el acuse: va en partes, y si la otra punta
      // se va a mitad, no llega entero aunque aquí todo saliera.
      if (item.file) await updateEntry(item.pubkey, item.entryId, { waits: null })
      if (live) awaitAck(item)
      return true
    } catch (e) {
      console.warn('[messenger] DM could not be sent, will retry:', e?.code || '', e?.message)
      // No cabe por el camino de ahora: sale cuando el contacto se conecte, o cuando haya
      // canal directo. Se dice en la burbuja, no se queda en un ⌛ mudo.
      if (e?.code === 'too-big-for-queue') updateEntry(item.pubkey, item.entryId, { waits: 'online' })
      if (e?.code === 'too-big-for-relay' || e?.code === 'direct-lost') updateEntry(item.pubkey, item.entryId, { waits: 'direct' })
      // La otra punta dijo en su saludo que no entiende bytes (una versión anterior, la app
      // nativa): sale cuando se actualice y vuelva a saludar.
      if (e?.code === 'peer-no-binary') updateEntry(item.pubkey, item.entryId, { waits: 'version' })
      if (!outbox.value.some(x => x.entryId === item.entryId)) outbox.value.push(item)
      return false
    }
  }

  const flushOutbox = async () => {
    if (outbox.value.length === 0) return
    const pending = outbox.value
    outbox.value = []
    for (const item of pending) await deliver(item)
  }

  // ---- Greeting between contacts (presence) ------------------------------

  /** Say hello to a contact: by token if they are online, by pubkey (quietly) if not. */
  const sendHelloTo = async (pubkey) => {
    try {
      const me = await whoAmI()
      if (!me) return
      // Una cuenta sin aparatos conocidos (Dotrino antes de escribir) no tiene a quién saludar.
      if (!contacts.recipientsOf(pubkey).length) return
      await sendToContact(pubkey, { type: 'HELLO', ...me }, { quiet: true })
    } catch (e) { console.warn('[messenger] hello failed:', e?.code || '', e?.message) }
  }

  // Reply to a greeting ONCE per token (anti-storm).
  const greetBack = async (token, pubkey) => {
    if (!token || greetedTokens.has(token)) return
    greetedTokens.add(token)
    await sendHelloTo(pubkey)
  }

  // ---- Contact requests: @dotrino/profile/friends --------------------------------

  /** Ask someone to be a contact (their requests inbox; nobody is a contact until they accept). */
  const sendContactRequest = ({ token, pubkey, alias, card = null }) => friends.request({ token, pubkey, alias, card })

  // ------------------------------------------------------------------------
  // Inbound
  // ------------------------------------------------------------------------

  const handleIncoming = async (fromToken, payload, meta = {}) => {
    // Sellado, autenticado, sin bloqueados, y las solicitudes de amistad: @dotrino/profile/friends.
    const r = await friends.receive(fromToken, payload, meta)
    if (!r || r.handled) return
    const who = r.who
    // From here on, only contacts. A stranger's message goes nowhere — not to a chat,
    // not to the inbox.
    if (!who.contact) return
    switch (payload.type) {
      case 'HELLO':        return handleHello(fromToken, who, payload)
      case 'DM':           return handleDM(fromToken, who.contact, payload, meta)
      case 'DM_ACK':       return handleAck(payload)
      case 'RATING_QUERY': return handleRatingQuery(who.contact, payload)
      case 'RATING_REPLY': return handleRatingReply(payload)
    }
  }

  /** Their version (§14): noted, not blocking — talking to a version that does not understand looks like silence. */
  friendHooks.onProfile = (pubkey, payload) => {
    const mismatch = checkPeer(payload.v)
    if (mismatch) peerCompat.value = { ...peerCompat.value, [pubkey]: mismatch }
    else if (peerCompat.value[pubkey]) {
      const { [pubkey]: _removed, ...rest } = peerCompat.value
      peerCompat.value = rest
    }
  }
  const noteProfile = (pubkey, payload) => friends.noteProfile(pubkey, payload)

  /** A contact kept by a device key moves to its account when that device brings its card; its thread goes with it. */
  const upgradeToAccount = (who, payload) => friends.upgradeToAccount(who, payload)
  friendHooks.onMoved = (from, to) => moveThread(from, to)

  /** Lleva los mensajes de un hilo a otra clave (el del aparato al de la cuenta). */
  const moveThread = async (from, to) => {
    const arr = threads.value[from] || []
    if (!arr.length) return
    threads.value = mergeThreads(threads.value, { [to]: arr })
    const { [from]: _old, ...rest } = threads.value
    threads.value = rest
    if (activePubkey.value === from) setActive(to)
    saveLocalCache(threads.value)
    const store = await getStore()
    if (!store) return
    for (const e of arr) await store.appendMessage(to, e)
    const fs = await store.listThread(fileKey(from)).catch(() => [])
    for (const e of fs || []) await store.appendMessage(fileKey(to), e)
    filesLoaded.delete(to)
  }

  // Lo que el messenger hace cuando @dotrino/profile/friends dice algo: ya sois amigos (sale lo que
  // esperaba) y llegó una solicitud (aviso en pantalla, según las preferencias).
  friendHooks.onFriend = () => { flushOutbox() }
  friendHooks.isVouched = isVouched
  friendHooks.onRequest = (r) => notify('hello', {
    id: 'request-' + r.pubkey,
    fromPubkey: r.pubkey,
    fromNickname: r.nickname || r.pubkey.slice(0, 8),
    text: '',
    ts: Date.now(),
    request: true
  }, r.vouched)

  const handleHello = async (fromToken, who, payload) => {
    await noteProfile(who.contact.publickey, payload)
    const contact = await upgradeToAccount(who, payload)
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
    // Un archivo que no pasa la validación se descarta entero: el texto solo sería un pie
    // sin lo que acompaña.
    const file = payload.file === undefined ? null : validIncomingFile(payload.file)
    if (payload.file !== undefined && !file) {
      console.warn('[messenger] an incoming file was not valid: dropped')
      return
    }
    const mid = typeof payload.mid === 'string' ? payload.mid : crypto.randomUUID()
    const ts = Number(payload.ts) || Date.now()
    const pubkey = contact.publickey
    // Nace leído si su conversación está abierta y la ventana a la vista: si no,
    // el contador subiría con el mensaje delante de los ojos del usuario.
    const read = activePubkey.value === pubkey &&
      (typeof document === 'undefined' || document.visibilityState === 'visible')
    // El mismo mensaje puede llegar dos veces (cola offline + en vivo): una vez basta.
    if (!(threads.value[pubkey] || []).some(e => e.id === mid)) {
      if (file) await saveFile(pubkey, mid, file)
      append(pubkey, { id: mid, dir: 'in', text: cleanText, ts, queued: !!meta.queued, queuedAt: meta.queuedAt || null, ...(file ? { file: { name: file.name, mime: file.mime, size: file.size, w: file.w, h: file.h } } : {}), ...(read ? { _read: true } : {}) })
      notify('message', {
        id: mid,
        fromPubkey: pubkey,
        fromNickname: contact.nickname || pubkey.slice(0, 8),
        text: cleanText,
        file: file ? file.name : null,
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

  // ---- Requests inbox: @dotrino/profile/friends -----------------------------------

  /** Accept a request: now we are contacts on both sides. No message enters any chat. */
  const acceptRequest = async (pubkey) => {
    await friends.accept(pubkey)
    await contacts.refresh()
  }

  /** Dismiss an incoming request, or cancel one I sent. The other side is not told. */
  const dismissRequest = (pubkey, dir = 'in') => friends.dismiss(pubkey, dir)

  return {
    threads, activePubkey, activeThread, activeContact, outbox, lastIncomingDM, peerCompat,
    files, loadFiles, routeOf, forgetToken,
    setActive, sendDM, sendFile, flushOutbox, markThreadRead,
    handleIncoming, sendHelloTo, sendContactRequest,
    askRatingsAbout, load,
    requests, acceptRequest, dismissRequest
  }
})
