import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useConnectionStore } from './connectionStore'
import { useContactsStore } from './contactsStore'
import { useRequestsStore } from './requestsStore'
import { shouldNotifyKind } from '../services/notifications'
import { getIdentity } from '../services/identity'
import { getStore } from '../services/store'
import { getReputation } from '../services/reputation'
import { sanitizeMessage } from '../utils/sanitize'
import { pushThreadsToBridge, pullThreadsFromBridge, onThreadsChanged } from '../services/threadsBridge'
import { key as accountKey } from '../services/account'
import { MINE as MI_VERSION, revisar } from '../services/compat'

// Peers que nos saludaron (HELLO) pero NO son contactos: guardamos su
// encryptionPubkey para poder descifrar su DM y rutearlo a Solicitudes. En
// memoria, esta sesión (las solicitudes durables viven en requestsStore).
const pendingPeers = new Map()    // pubkey -> { encryptionPubkey, token, nickname }
const pendingByToken = new Map()  // token  -> pubkey
// Tokens a los que ya respondimos un HELLO esta sesión. Evita la "tormenta de
// HELLO": handleHello respondía con sendHello a CADA HELLO recibido, y como un
// HELLO de respuesta es a su vez un HELLO, dos contactos online entraban en
// ping-pong infinito. Respondiendo ≤1 vez por token remoto el loop no se
// sostiene (aunque el otro lado sea una versión vieja que siga haciendo eco).
// Los tokens son efímeros por conexión: una reconexión trae token nuevo → re-saludo.
const greetedTokens = new Set()
// Apodo elegido al agregar por token (AddContactModal): token -> nickname. Se
// aplica al promover el peer a contacto tras el handshake.
const pendingAliasByToken = new Map()

// "Avalado por tu red": alguien en quien confiás (directo/transitivo) tiene una
// atestación sobre este pubkey. Si sí → la solicitud notifica; si no → silenciosa.
async function isVouched (pubkey) {
  try {
    const rep = await getReputation()
    if (!rep) return false
    const r = await rep.reputationOf(pubkey)
    return (r?.trustedCount || 0) > 0
  } catch (_) { return false }
}

const URL_EMBED = new URLSearchParams(typeof location !== 'undefined' ? location.search : '').get('embed')
const IS_OVERLAY_EMBED = URL_EMBED === 'overlay'

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
 * Wire protocol (string format `TYPE|json`):
 *   HELLO            { nickname, encryptionPubkey, pubkey, v, card? }
 *   IDENTIFY_CHALLENGE { nonce }
 *   IDENTIFY_RESPONSE  { nonce, signature, publickey, encryptionPubkey }
 *   DM_ENC           { envelope, ts }      payload encrypted with id.encrypt
 *   DM_ACK           { id }
 *   RATING_QUERY     { envelope }            { queryId, subject } cifrado
 *   RATING_REPLY     { envelope }            { queryId, subject, mine, endorsements } cifrado
 */
export const useThreadsStore = defineStore('threads', () => {
  const connection = useConnectionStore()
  const contacts = useContactsStore()
  const requests = useRequestsStore()

  // Dispara la notificación in-app (App.vue observa lastIncomingDM) respetando
  // las preferencias del panel compartido. `kind`: 'message' | 'request' | 'hello'.
  const notify = (kind, dm, vouched = false) => {
    if (!shouldNotifyKind(kind, vouched)) return
    lastIncomingDM.value = dm
  }

  // Apodo recordado al "Enviar saludo" desde AddContactModal.
  const rememberAlias = (token, nickname) => {
    if (token && nickname) pendingAliasByToken.set(token, nickname)
  }

  const threads = ref(loadLocalCache())   // hidratación inmediata desde cache local
  const ACTIVE_KEY = accountKey('messenger_active_pubkey_v1')
  const activePubkey = ref(localStorage.getItem(ACTIVE_KEY) || null)
  const outbox = ref([])        // messages waiting for recipient to come online
  // Último DM entrante decodificado, para que App.vue muestre la notificación
  // centrada cuando llegue uno nuevo.
  const lastIncomingDM = ref(null)
  // pubkey -> 'incompatible' | 'unknown'. Lo que dijo su saludo (§14).
  const peerCompat = ref({})

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
    // Comparte snapshot completo con los overlays via chrome.storage bridge.
    if (!IS_OVERLAY_EMBED) pushThreadsToBridge(threads.value)
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
    // Espeja al chrome.storage bridge si NO somos un overlay (los overlays
    // solo leen). Así popups/offscreen/direct tab convergen en una snapshot
    // que los overlays lectores pueden hidratar.
    if (!IS_OVERLAY_EMBED) pushThreadsToBridge(threads.value)
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
    if (!IS_OVERLAY_EMBED) pushThreadsToBridge(threads.value)
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
    if (!IS_OVERLAY_EMBED) pushThreadsToBridge(threads.value)
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
      tryHandshake(pubkey)
      markThreadRead(pubkey).catch(() => {})
    } else {
      localStorage.removeItem(ACTIVE_KEY)
    }
  }

  const formatMessage = (type, payload) => `${type}|${JSON.stringify(payload)}`
  const parseMessage = (raw) => {
    const i = raw.indexOf('|')
    if (i < 0) return { type: null, payload: null }
    try { return { type: raw.slice(0, i), payload: JSON.parse(raw.slice(i + 1)) } }
    catch { return { type: null, payload: null } }
  }

  // ------------------------------------------------------------------------
  // Outbound: send DM
  // ------------------------------------------------------------------------

  const sendDM = async (pubkey, text) => {
    const trimmed = sanitizeMessage(text)
    if (!trimmed) return
    const contact = contacts.findByPubkey(pubkey)
    if (!contact) throw new Error('Unknown contact')

    const entry = { id: crypto.randomUUID(), dir: 'out', text: trimmed, ts: Date.now(), pending: true }
    append(pubkey, entry)

    if (!contact.encryptionPubkey) {
      // No conocemos su clave de cifrado todavía — queda en outbox local
      // hasta completar el handshake.
      outbox.value.push({ pubkey, entryId: entry.id, text: trimmed })
      return
    }
    try {
      const id = await getIdentity()
      if (!id) throw new Error('identity vault unreachable')
      // El proxy direcciona por pubkey: si está online, entrega al instante;
      // si no, encola hasta 24h. El "token" del wrap puede ser cualquier
      // identificador estable: usamos la pubkey del destinatario para que
      // sea el mismo valor al cifrar y al descifrar (vault.decrypt usa
      // myToken como key del wrap).
      // `publickey` es lo que permite al vault expandir el sobre a TODOS los dispositivos
      // de esa persona (si conocemos su tarjeta). `token` se mantiene por compatibilidad
      // del sobre v1; el v2 se indexa por llave, no por conexión.
      const envelope = await id.encrypt(
        [{ publickey: pubkey, token: pubkey, encryptionPubkey: contact.encryptionPubkey }],
        trimmed
      )
      const msg = formatMessage('DM_ENC', { envelope, ts: entry.ts, mid: entry.id })
      // Solo rutamos por token si tenemos presencia CONFIRMADA en esta sesión
      // (`liveTokenFor`). El `lastToken` persistido en vault puede ser de una
      // sesión anterior y el proxy lo descartaría sin caer a cola offline,
      // así que para esos casos usamos pubkey (cola offline 24h del proxy).
      const token = contacts.liveTokenFor(pubkey)
      if (token) await connection.sendMessage([token], msg)
      else       await connection.sendByPubkey([pubkey], msg)
      await updateEntry(pubkey, entry.id, { pending: false })
    } catch (e) {
      console.warn('sendDM failed; will retry:', e)
      outbox.value.push({ pubkey, entryId: entry.id, text: trimmed })
    }
  }

  const flushOutbox = async () => {
    if (outbox.value.length === 0) return
    const remaining = []
    for (const item of outbox.value) {
      const c = contacts.findByPubkey(item.pubkey)
      if (!c || !c.encryptionPubkey) { remaining.push(item); continue }
      try {
        const id = await getIdentity()
        if (!id) { remaining.push(item); continue }
        const envelope = await id.encrypt(
          [{ publickey: item.pubkey, token: item.pubkey, encryptionPubkey: c.encryptionPubkey }],
          item.text
        )
        const msg = formatMessage('DM_ENC', { envelope, ts: Date.now(), mid: item.entryId })
        const token = contacts.liveTokenFor(item.pubkey)
        if (token) await connection.sendMessage([token], msg)
        else       await connection.sendByPubkey([item.pubkey], msg)
        await updateEntry(item.pubkey, item.entryId, { pending: false })
      } catch (err) {
        console.warn('flush failed:', err)
        remaining.push(item)
      }
    }
    outbox.value = remaining
  }

  // ------------------------------------------------------------------------
  // Handshake — exchange identity + encryption pubkeys with a contact whose
  // token we know is online.
  // ------------------------------------------------------------------------

  const tryHandshake = async (pubkey) => {
    const c = contacts.findByPubkey(pubkey)
    if (!c) return
    const token = contacts.liveTokenFor(pubkey)
    // Si tenemos presencia confirmada esta sesión, vamos por challenge.
    // Si no, mandamos un HELLO por pubkey: el proxy lo entregará al peer
    // (instant si está conectado, queue offline si no). Cuando responda
    // su HELLO, markOnline lo marcará como en línea en el UI.
    if (token) {
      try {
        const id = await getIdentity()
        if (!id) return
        const { nonce } = await id.makeChallenge()
        const msg = formatMessage('IDENTIFY_CHALLENGE', { nonce })
        await connection.sendMessage([token], msg)
      } catch (e) { console.warn('tryHandshake:', e) }
    } else {
      await sendHelloByPubkey(pubkey)
    }
  }

  // Manda un IDENTIFY_CHALLENGE a un token cuyo pubkey aún no conocemos
  // (alta por token). CRÍTICO: el nonce debe salir de `makeChallenge()` para
  // que quede registrado (rememberNonce); si no, cuando el peer responda,
  // `verifyResponse` lo rechaza por `isFreshNonce` y el contacto NUNCA se agrega.
  const sendChallenge = async (token) => {
    try {
      const id = await getIdentity()
      if (!id) return
      const { nonce } = await id.makeChallenge()
      await connection.sendMessage([token], formatMessage('IDENTIFY_CHALLENGE', { nonce }))
    } catch (e) { console.warn('sendChallenge:', e) }
  }

  const buildHello = async () => {
    const id = await getIdentity()
    if (!id) return null
    const pubkey = id.me?.publickey
    if (!pubkey) return null
    const encryptionPubkey = await id.getEncryptionPubkey()
    // TARJETA DE PERFIL: lo mínimo para que el otro pueda cifrarnos a TODOS nuestros
    // dispositivos y no solo a este (perfil, versión y llaves de cifrado; sin etiquetas
    // ni permisos). Ver dotrino-vault/docs/acta-de-perfil.md.
    const card = await id.profileCard?.().catch(() => null)
    return formatMessage('HELLO', {
      nickname: connection.nickname,
      pubkey, encryptionPubkey,
      v: MI_VERSION,              // qué soy y qué versión corro (§14)
      ...(card ? { card } : {})
    })
  }

  const sendHello = async (token) => {
    try {
      const msg = await buildHello()
      if (!msg) return
      await connection.sendMessage([token], msg)
    } catch (e) { console.warn('sendHello:', e) }
  }

  // Pinga por pubkey: usado cuando no tenemos token vivo del peer pero
  // queremos saber su presencia. El proxy ruta al token actual (si está
  // identificado) o encola hasta 24h.
  const sendHelloByPubkey = async (pubkey) => {
    try {
      const msg = await buildHello()
      if (!msg) return
      await connection.sendByPubkey([pubkey], msg)
    } catch (e) { console.warn('sendHelloByPubkey:', e) }
  }

  // Responder un HELLO al peer, pero SOLO una vez por token (anti-tormenta de
  // HELLO). El saludo proactivo (announceToKnown / handshake) NO pasa por acá:
  // esto es exclusivamente el "eco" de respuesta dentro de handleHello.
  const greetBack = (token) => {
    if (!token || greetedTokens.has(token)) return
    greetedTokens.add(token)
    sendHello(token)
  }

  // ------------------------------------------------------------------------
  // Inbound dispatch
  // ------------------------------------------------------------------------

  const handleIncoming = async (fromToken, raw, meta = {}) => {
    const { type, payload } = parseMessage(raw)
    if (!type || !payload) return
    switch (type) {
      case 'HELLO':                return handleHello(fromToken, payload, meta)
      case 'IDENTIFY_CHALLENGE':   return handleChallenge(fromToken, payload)
      case 'IDENTIFY_RESPONSE':    return handleResponse(fromToken, payload)
      case 'DM_ENC':               return handleDM(fromToken, payload, meta)
      case 'DM_ACK':               return handleAck(fromToken, payload)
      case 'RATING_QUERY':         return handleRatingQuery(fromToken, payload, meta)
      case 'RATING_REPLY':         return handleRatingReply(fromToken, payload, meta)
    }
  }

  const handleHello = async (fromToken, payload) => {
    if (!payload?.pubkey) return
    // Qué versión corre el otro lado (§14). No bloquea: se anota y la conversación lo
    // enseña. Sin esto, hablarle a una versión que no entiende se ve como silencio.
    const desajuste = revisar(payload.v)
    if (desajuste) peerCompat.value = { ...peerCompat.value, [payload.pubkey]: desajuste }
    else if (peerCompat.value[payload.pubkey]) {
      const { [payload.pubkey]: _fuera, ...resto } = peerCompat.value
      peerCompat.value = resto
    }
    // Su tarjeta de perfil, si la manda: con ella podremos cifrarle a todos sus
    // dispositivos. El vault la verifica y no acepta retrocesos ni cambios de master
    // en silencio; si la rechaza, seguimos como siempre (cifrando solo a este aparato).
    if (payload.card) {
      try {
        const id = await getIdentity()
        const r = await id?.adoptPeerCard?.(payload.card)
        if (r && !r.adopted && r.reason === 'master-cambiado') {
          console.warn('[messenger] la tarjeta de %s la firma otro dispositivo: no se adopta sola', payload.pubkey.slice(0, 24))
        }
      } catch (e) { console.warn('adoptPeerCard:', e?.message || e) }
    }
    // If this pubkey is already a contact, refresh its presence + encryption key.
    const existing = contacts.findByPubkey(payload.pubkey)
    // Importante: hay que AWAIT antes de mandar el HELLO de vuelta. Si no,
    // el otro lado recibe nuestro HELLO, manda DM_ENC, y cuando llega aquí
    // el contacto aún no está persistido en el vault → "DM from unknown peer".
    if (existing) {
      await contacts.updateContact(payload.pubkey, {
        lastToken: fromToken,
        encryptionPubkey: payload.encryptionPubkey || existing.encryptionPubkey,
        nickname: existing.nickname || payload.nickname
      })
      contacts.markOnline(payload.pubkey, fromToken)
      flushOutbox()
      greetBack(fromToken)
    } else {
      // Desconocido: NO se auto-agrega al vault. Guardamos su encryptionPubkey
      // en memoria para poder descifrar su DM y rutearlo a Solicitudes. Le
      // mandamos HELLO de vuelta (nuestra enc) para que pueda escribirnos —
      // pero su mensaje irá a la bandeja, no a contactos.
      pendingPeers.set(payload.pubkey, {
        encryptionPubkey: payload.encryptionPubkey || null,
        token: fromToken,
        nickname: payload.nickname || ''
      })
      if (fromToken) pendingByToken.set(fromToken, payload.pubkey)
      contacts.markOnline(payload.pubkey, fromToken)
      greetBack(fromToken)
      // Si alguien nuevo saluda es porque acaba de canjear tu código, y un código
      // es de UN SOLO USO: el que se ve en pantalla ya está quemado. Se pide otro
      // ahora, no dentro de cinco minutos, o el siguiente amigo teclea uno muerto.
      connection.refreshPairingCode?.().catch?.(() => {})
      // Alguien te está agregando: lo dejamos VISIBLE en Solicitudes aunque
      // todavía no mande un mensaje (antes solo quedaba en memoria y no se veía
      // nada). Idempotente por pubkey; si luego llega un DM, se actualiza el texto.
      const vouched = await isVouched(payload.pubkey)
      requests.upsert({
        pubkey: payload.pubkey,
        nickname: payload.nickname || '',
        encryptionPubkey: payload.encryptionPubkey || null,
        token: fromToken,
        text: '',
        ts: Date.now(),
        vouched,
        hello: true
      })
      notify('hello', {
        id: 'hello-' + payload.pubkey,
        fromPubkey: payload.pubkey,
        fromNickname: payload.nickname || payload.pubkey.slice(0, 8),
        text: '',
        ts: Date.now(),
        request: true,
        hello: true
      }, vouched)
    }
  }

  const handleChallenge = async (fromToken, payload) => {
    const id = await getIdentity()
    if (!id || !payload?.nonce) return
    try {
      const response = await id.signChallenge(payload.nonce)
      const card = await id.profileCard?.().catch(() => null)
      const msg = formatMessage('IDENTIFY_RESPONSE', { ...response, ...(card ? { card } : {}) })
      await connection.sendMessage([fromToken], msg)
      // also send a HELLO so they learn nickname
      sendHello(fromToken)
    } catch (e) { console.warn('signChallenge:', e) }
  }

  const handleResponse = async (fromToken, payload) => {
    const id = await getIdentity()
    if (!id || !payload?.publickey) return
    try {
      const result = await id.verifyResponse(payload)
      if (!result.ok) return
      if (payload.card) { try { await id.adoptPeerCard?.(payload.card) } catch (_) {} }
      const pubkey = result.publickey
      const encryptionPubkey = result.encryptionPubkey || payload.encryptionPubkey || null
      // Promote to contact (or refresh if already there). Si lo agregamos por
      // token, aplicamos el apodo elegido en el modal.
      const alias = contacts.findByPubkey(pubkey)?.nickname || pendingAliasByToken.get(fromToken)
      contacts.addContact({
        pubkey, token: fromToken, encryptionPubkey,
        nickname: alias
      })
      pendingAliasByToken.delete(fromToken)
      // Ya es contacto: si había una solicitud pendiente suya (p.ej. de su
      // HELLO), la quitamos de la bandeja para no dejar un duplicado.
      requests.remove(pubkey)
      contacts.markOnline(pubkey, fromToken)
      contacts.refreshPeers()
      flushOutbox()
    } catch (e) { console.warn('verifyResponse:', e) }
  }

  const handleDM = async (fromToken, payload, meta = {}) => {
    if (!payload?.envelope) return
    // Resolver al remitente: si el proxy nos da `from_publickey` (caso de
    // entrega offline o cualquier mensaje pubkey-direccionado) lo usamos
    // directamente; si no, caemos a buscar por lastToken.
    const findContact = () => {
      let c = null
      if (meta.fromPubkey) c = contacts.findByPubkey(meta.fromPubkey)
      if (!c) c = contacts.contacts.find(x => x.lastToken === fromToken)
      return c
    }
    let c = findContact()
    // Si el HELLO viene en paralelo y aún no terminó, esperamos hasta 2s.
    if (!c) {
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 200))
        c = findContact()
        if (c?.encryptionPubkey) break
      }
    }
    // Resolver pubkey + encryptionPubkey: de un contacto, o de un peer pendiente
    // (HELLO recibido pero sin agregar). Los desconocidos NO se descartan: se
    // descifran y van a Solicitudes.
    const isContact = !!(c && c.encryptionPubkey)
    const senderPubkey = c?.publickey || meta.fromPubkey || pendingByToken.get(fromToken) || null
    let senderEnc = c?.encryptionPubkey || null
    let senderNick = c?.nickname || ''
    if (!isContact && senderPubkey) {
      const pend = pendingPeers.get(senderPubkey)
      if (pend?.encryptionPubkey) { senderEnc = pend.encryptionPubkey; senderNick = pend.nickname || senderNick }
    }
    if (!senderPubkey || !senderEnc) {
      console.warn('DM from unknown peer', fromToken, meta.fromPubkey || '', '— dropping until handshake')
      return
    }
    try {
      const id = await getIdentity()
      if (!id) return
      // El wrap key es la pubkey del receptor (myPublickey). Si el sobre
      // viene del flujo legacy por token, intentamos primero pubkey y luego
      // token como fallback.
      const myPub = connection.myPublickey
      let result
      try {
        result = await id.decrypt(senderEnc, myPub, payload.envelope)
      } catch (e1) {
        try { result = await id.decrypt(senderEnc, connection.token, payload.envelope) }
        catch (e2) { throw e1 }
      }
      // El vault devuelve { plaintext }, no un string directo.
      const text = result?.plaintext ?? ''
      const cleanText = sanitizeMessage(text)
      const mid = payload.mid || crypto.randomUUID()
      const ts = payload.ts || Date.now()

      if (!isContact) {
        // Desconocido → bandeja de Solicitudes. Notifica SOLO si está avalado por
        // tu red (alguien en quien confiás tiene una atestación sobre él); si no,
        // queda en silencio y se purga a las 24h.
        const vouched = await isVouched(senderPubkey)
        requests.upsert({ pubkey: senderPubkey, nickname: senderNick, encryptionPubkey: senderEnc, token: fromToken, text: cleanText, ts, vouched })
        // Notifica según preferencias (por defecto TODAS las solicitudes; el
        // panel deja apagar las de desconocidos). El aval solo cambia jerarquía.
        notify('request', { id: mid, fromPubkey: senderPubkey, fromNickname: senderNick || senderPubkey.slice(0, 8), text: cleanText, ts, request: true, vouched }, vouched)
      } else {
        // Nace leído si su conversación está abierta y la ventana a la vista: si no,
        // el contador subiría con el mensaje delante de los ojos del usuario.
        const leido = activePubkey.value === senderPubkey &&
          (typeof document === 'undefined' || document.visibilityState === 'visible')
        const entry = { id: mid, dir: 'in', text: cleanText, ts, queued: !!meta.queued, queuedAt: meta.queuedAt || null, ...(leido ? { _read: true } : {}) }
        append(senderPubkey, entry)

        // Notifica a la UI para mostrar la notificación centrada (App.vue
        // observa `lastIncomingDM` y aplica el fade in/out + mark-as-displayed).
        // Respeta la preferencia de mensajes de contactos del panel.
        notify('message', {
          id: mid,
          fromPubkey: senderPubkey,
          fromNickname: senderNick || senderPubkey.slice(0, 8),
          text: cleanText,
          ts
        })

        // Si el PWA está embebido (extensión / future apps), notifica al parent
        // para que pueda disparar toast/notificación nativa.
        if (window !== window.parent) {
          try {
            window.parent.postMessage({
              source: 'cc-messenger',
              type: 'dm-arrived',
              dm: {
                id: mid,
                fromPubkey: senderPubkey,
                fromNickname: senderNick || senderPubkey.slice(0, 8),
                text: cleanText,
                ts,
                queued: !!meta.queued
              }
            }, '*')
          } catch (_) {}
        }
      }
      // Optional ack — si conocemos token actual, lo mandamos por token;
      // si no, por pubkey (el ack también puede irse offline).
      if (payload.mid) {
        const ack = formatMessage('DM_ACK', { id: payload.mid })
        const tk = contacts.tokenFor(senderPubkey) || fromToken
        if (tk) await connection.sendMessage([tk], ack)
        else    await connection.sendByPubkey([senderPubkey], ack)
      }
    } catch (e) { console.warn('decrypt failed:', e) }
  }

  const handleAck = async (fromToken, payload) => {
    if (!payload?.id) return
    for (const [pk, arr] of Object.entries(threads.value)) {
      const e = arr.find(x => x.id === payload.id)
      if (e) { await updateEntry(pk, payload.id, { pending: false }); return }
    }
  }

  // ---- Ratings -----------------------------------------------------------
  //
  // VAN CIFRADOS. El proxio no cifra nada de lo que enruta (CONVENCIONES §4.1), y
  // estos mensajes son lo más delicado que manda el messenger después del propio
  // texto: preguntan «¿qué sabes de FULANO?» y contestan con calificaciones. En claro,
  // quien opere el nodo lee tu red de confianza entera — a quién conoces, de quién te
  // fías y quién te pregunta por quién.
  //
  // Se usa el MISMO sobre del vault que el DM (`id.encrypt`), no una cripto propia: es
  // la que el pilar ya expone y la que sabe abrirle a todos los dispositivos de esa
  // persona. El HELLO y el desafío no pueden ir así, y no es un descuido: son
  // justamente el intercambio que entrega la llave con la que se cifra.

  /** Manda `type` cifrado a un contacto. Sin su llave de cifrado no se manda nada. */
  const sendEnc = async (pubkey, type, payload) => {
    const c = contacts.findByPubkey(pubkey)
    if (!c?.encryptionPubkey) return false
    const id = await getIdentity()
    if (!id) return false
    const envelope = await id.encrypt(
      [{ publickey: pubkey, token: pubkey, encryptionPubkey: c.encryptionPubkey }],
      JSON.stringify(payload)
    )
    const msg = formatMessage(type, { envelope })
    const token = contacts.liveTokenFor(pubkey)
    if (token) await connection.sendMessage([token], msg)
    else       await connection.sendByPubkey([pubkey], msg)
    return true
  }

  /** Abre un sobre que llega de `fromToken`/`meta.fromPubkey`. `null` si no se puede. */
  const openEnc = async (fromToken, payload, meta = {}) => {
    if (!payload?.envelope) return null
    const c = (meta.fromPubkey && contacts.findByPubkey(meta.fromPubkey)) ||
      contacts.contacts.find(x => x.lastToken === fromToken)
    if (!c?.encryptionPubkey) return null
    const id = await getIdentity()
    if (!id) return null
    try {
      const r = await id.decrypt(c.encryptionPubkey, connection.myPublickey, payload.envelope)
      return { from: c, data: JSON.parse(r?.plaintext ?? 'null') }
    } catch (e) { console.warn('rating envelope could not be opened:', e?.message || e); return null }
  }

  const askRatingsAbout = async (subjectPubkey) => {
    const id = await getIdentity()
    if (!id) return
    const queryId = crypto.randomUUID()
    for (const c of contacts.contacts) {
      if (c.publickey === subjectPubkey) continue
      if (!contacts.tokenFor(c.publickey)) continue
      await sendEnc(c.publickey, 'RATING_QUERY', { queryId, subject: subjectPubkey })
        .catch(e => console.warn('askRatingsAbout:', e?.message || e))
    }
  }

  const handleRatingQuery = async (fromToken, payload, meta = {}) => {
    const id = await getIdentity()
    if (!id) return
    const abierto = await openEnc(fromToken, payload, meta)
    // Sin sobre no se contesta. Quien pregunta es un contacto y un contacto tiene
    // llave; si no la tiene, esto no viene de donde dice venir.
    if (!abierto?.data?.subject || !abierto.data.queryId) return
    try {
      await id.recordQuery(abierto.from.publickey, abierto.data.subject)
      const { mine, endorsements } = await id.getRatingsForSubject(abierto.data.subject)
      await sendEnc(abierto.from.publickey, 'RATING_REPLY', {
        queryId: abierto.data.queryId, subject: abierto.data.subject, mine, endorsements
      })
    } catch (e) { console.warn('handleRatingQuery:', e) }
  }

  const handleRatingReply = async (fromToken, payload, meta = {}) => {
    const id = await getIdentity()
    if (!id) return
    const abierto = await openEnc(fromToken, payload, meta)
    if (!abierto?.data?.subject) return
    const data = abierto.data
    try {
      if (data.mine) await id.mergeEndorsements(data.subject, [data.mine])
      if (Array.isArray(data.endorsements) && data.endorsements.length) {
        await id.mergeEndorsements(data.subject, data.endorsements)
      }
      contacts.refreshPeers()
    } catch (e) { console.warn('handleRatingReply:', e) }
  }

  // Overlay: hidrata los threads desde chrome.storage.local (espejado por el
  // popup/offscreen/direct tab) y se queda escuchando cambios. No corremos
  // `load()` porque store.dotrino.com está particionado por el site visitado
  // y devuelve vacío.
  if (IS_OVERLAY_EMBED) {
    ;(async () => {
      const remote = await pullThreadsFromBridge()
      if (remote && Object.keys(remote).length > 0) {
        threads.value = remote
        saveLocalCache(threads.value)
      }
    })().catch(() => {})
    onThreadsChanged((snapshot) => {
      if (!snapshot) return
      threads.value = snapshot
      saveLocalCache(threads.value)
    })
  }

  // Carga asíncrona — el UI verá hilos aparecer cuando el store responda.
  // Además, nos suscribimos a `onSync`: el store puede arrancar bloqueado
  // (sin passphrase) y los hilos cifrados solo aparecen tras unlock + sync.
  // Sin esto, al refrescar la página los mensajes no se ven porque `load`
  // corre antes de que el vault esté desbloqueado.
  const reload = () => load().catch(e => console.warn('threads.load failed:', e))
  if (!IS_OVERLAY_EMBED) reload()
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

  // ---- Solicitudes (bandeja de desconocidos) -----------------------------

  // Aceptar una solicitud: promueve al peer a contacto (recién ahí entra al
  // vault), inyecta su primer mensaje al hilo y la quita de la bandeja.
  const acceptRequest = async (pubkey) => {
    const r = requests.get(pubkey)
    if (!r) return
    await contacts.addContact({
      pubkey,
      nickname: r.nickname || pubkey.slice(0, 8),
      token: r.token,
      encryptionPubkey: r.encryptionPubkey
    })
    if (r.text) await append(pubkey, { id: crypto.randomUUID(), dir: 'in', text: r.text, ts: r.ts })
    pendingPeers.delete(pubkey)
    requests.remove(pubkey)
    await contacts.refresh()
  }

  const dismissRequest = (pubkey) => {
    pendingPeers.delete(pubkey)
    requests.remove(pubkey)
  }

  return {
    threads, activePubkey, activeThread, activeContact, outbox, lastIncomingDM, peerCompat,
    setActive, sendDM, flushOutbox, markThreadRead,
    handleIncoming, sendHello, sendHelloByPubkey, tryHandshake, sendChallenge,
    askRatingsAbout, load, rememberAlias,
    requests, acceptRequest, dismissRequest
  }
})
