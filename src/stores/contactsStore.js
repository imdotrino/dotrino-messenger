import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useConnectionStore } from './connectionStore'
import { getIdentity } from '../services/identity'
import { sanitizeNickname } from '../utils/sanitize'
import { computeDerivedRating, buildTrustMap } from '../utils/rating'
import { getReputation } from '../services/reputation'
import { samePubkey } from '@dotrino/proxy-client'

/**
 * LA CUENTA DE DOTRINO: contacto fijo de todo messenger. Por ahí llegan las respuestas a lo
 * que se pide por correo (feedback.dotrino.com), así que no se puede quitar ni bloquear: si
 * falta en el libro de contactos, se vuelve a poner.
 *
 * Es la llave del PERFIL (la que sella su acta), no la de un aparato: contesta cualquier
 * aparato de la cuenta, y se le reconoce por su tarjeta de perfil, que tiene que venir
 * firmada por esta misma llave (`ownCard`). Hasta que llegue la primera, no hay a qué
 * aparato escribirle: Dotrino escribe primero.
 */
export const DOTRINO_ACCOUNT = '{"key_ops":["verify"],"ext":true,"kty":"EC","x":"McyhKieRw_Jcl3TY9EvLovL-ALzGoWqMOrfnFjT7XpA","y":"V7tfpDWN37tPnhXnIFUlMaTepcTzzxPWTj_72PkpKPw","crv":"P-256"}'

/**
 * Contacts live in the shared identity vault (id.dotrino.com) since v0.6.0,
 * so chat / chess / messenger see the same address book. The vault stores
 * contact metadata next to rating/endorsement data on the same peer record.
 */
export const useContactsStore = defineStore('contacts', () => {
  const connection = useConnectionStore()

  const peers = ref([])              // all peer records from vault
  const onlineMap = ref(new Map())   // pubkey -> token (in-memory, this session)
  const ratingTick = ref(0)

  const contacts = computed(() => {
    ratingTick.value
    return peers.value.filter(p => p.isContact)
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
  })

  const trustMap = computed(() => buildTrustMap(peers.value))

  const refresh = async () => {
    const id = await getIdentity()
    if (!id) return
    try {
      peers.value = await id.listPeers()
      await ensurePinned(id)
      ratingTick.value++
    } catch (e) { console.warn('listPeers failed:', e) }
  }

  /**
   * Dotrino está siempre en los contactos. Si lo quitaron (desde esta u otra app que
   * comparta el libro), vuelve. Va con la misma cadena que trae su tarjeta, si ya llegó,
   * para que contacto y tarjeta sean el mismo registro del libro.
   */
  const ensurePinned = async (id) => {
    if (peers.value.some(p => p.isContact && isPinned(p.publickey))) return
    const key = peers.value.find(p => p.card && isPinned(p.card.profileId))?.card.profileId || DOTRINO_ACCOUNT
    await id.addContact({ publickey: key, nickname: 'Dotrino' })
    peers.value = await id.listPeers()
  }
  // backward-compat alias used elsewhere
  const refreshPeers = refresh

  const addContact = async ({ pubkey, nickname, token, encryptionPubkey, notes }) => {
    if (!pubkey) throw new Error('pubkey required')
    const id = await getIdentity()
    if (!id) throw new Error('identity vault unreachable')
    const cleanNick = nickname ? sanitizeNickname(nickname) : undefined
    await id.addContact({
      publickey: pubkey,
      nickname: cleanNick,
      encryptionPubkey: encryptionPubkey || undefined,
      lastToken: token || undefined,
      notes
    })
    await refresh()
    return findByPubkey(pubkey)
  }

  const updateContact = async (pubkey, patch) => {
    const id = await getIdentity()
    if (!id) return
    const allowed = {}
    for (const k of ['nickname', 'lastToken', 'encryptionPubkey', 'contactNotes']) {
      if (k in patch) allowed[k] = patch[k]
    }
    if (Object.keys(allowed).length === 0) return
    await id.updateContact(pubkey, allowed)
    await refresh()
  }

  const removeContact = async (pubkey) => {
    if (isPinned(pubkey)) throw Object.assign(new Error('the Dotrino account cannot be removed'), { code: 'pinned-contact' })
    const id = await getIdentity()
    if (!id) return
    await id.removeContact(pubkey)
    await refresh()
  }

  const same = (a, b) => { try { return !!a && !!b && samePubkey(a, b) } catch (_) { return false } }
  // La misma llave puede llegar escrita con otro orden de campos: se compara por la llave.
  const findByPubkey = (pubkey) => contacts.value.find(c => c.publickey === pubkey) ||
    contacts.value.find(c => same(c.publickey, pubkey))
  /** ¿Es la cuenta de Dotrino? */
  const isPinned = (pubkey) => same(pubkey, DOTRINO_ACCOUNT)
  /**
   * La tarjeta de perfil de un contacto (sus aparatos). Solo la de un contacto guardado
   * por su CUENTA, y solo si la firmó la llave de ese perfil (`ownCard`).
   *
   * Antes se buscaba también cualquier tarjeta que listara la llave del contacto, y eso
   * era un agujero: cualquiera puede firmar una tarjeta de SU perfil que liste la llave de
   * otro, y con ella hacerse pasar por ese contacto (y, al escribirle a todos los aparatos,
   * recibir lo que se le manda).
   */
  const cardOf = (pubkey) => {
    if (!pubkey) return null
    const card = peerFor(pubkey)?.card || peers.value.find(p => p.card && same(p.card.profileId, pubkey))?.card || null
    return ownCard(card) && same(card.profileId, pubkey) ? card : null
  }
  /**
   * El contacto que escribe, aunque lo haga desde OTRO de sus aparatos: la pubkey que
   * llega es la del aparato, y la tarjeta de su cuenta dice que es suyo.
   */
  const findBySender = (pubkey) => {
    const direct = contacts.value.find(c => same(c.publickey, pubkey))
    if (direct) return direct
    return contacts.value.find(c => cardOf(c.publickey)?.keys?.some(k => same(k.pub, pubkey))) || null
  }
  /**
   * Pasa un contacto guardado por la llave de un aparato a su CUENTA: la de los contactos
   * agregados antes de que el messenger fuera por cuenta. Conserva apodo, notas y tu
   * calificación; el hilo lo mueve quien lo tiene (threadsStore).
   */
  const moveToAccount = async (from, account) => {
    const id = await getIdentity()
    if (!id) throw Object.assign(new Error('identity vault unreachable'), { code: 'no-identity' })
    const old = peerFor(from)
    await id.addContact({
      publickey: account,
      nickname: old?.nickname || undefined,
      encryptionPubkey: old?.encryptionPubkey || undefined,
      lastToken: old?.lastToken || undefined,
      notes: old?.contactNotes
    })
    const r = old?.myRating
    if (typeof r?.rating === 'number' && !peerFor(account)?.myRating) await id.setRating(account, r.rating, r.notes || '')
    await id.removeContact(from)
    const token = onlineMap.value.get(from)
    if (token) {
      onlineMap.value.delete(from)
      onlineMap.value.set(account, token)
      onlineMap.value = new Map(onlineMap.value)
    }
    await refresh()
  }

  const findByToken  = (token)  => contacts.value.find(c => c.lastToken === token)
  const peerFor      = (pubkey) => peers.value.find(p => p.publickey === pubkey) ||
    peers.value.find(p => same(p.publickey, pubkey)) || null

  // ---- Por CUENTA, no por aparato -------------------------------------------
  //
  // Un contacto es una persona, y una persona escribe y lee desde varios aparatos. Lo que
  // dice cuáles es su tarjeta de perfil (la adopta el vault, que no acepta retrocesos ni
  // cambios de master). Con ella se le escribe a TODOS sus aparatos: antes el mensaje iba
  // solo a la llave del aparato que aceptó, y si ese pasaba 24 h apagado se perdía.

  /**
   * Una tarjeta firmada por la llave del propio perfil. Solo esa prueba que el `profileId`
   * es de quien la firmó: cualquiera puede escribir un `profileId` ajeno en una tarjeta
   * firmada con su llave.
   */
  const ownCard = (card) => !!card && same(card.sealedBy, card.profileId)

  /**
   * La cuenta del aparato que mandó `card`. Hacen falta las dos puntas: la tarjeta la
   * firmó su perfil Y la entregó el propio aparato, que va en ella. Que un perfil liste
   * una llave no prueba nada (puede listar la de otro); que ese aparato la traiga, sí.
   * Se lee la tarjeta GUARDADA (el vault ya decidió si adoptaba la que llegó).
   */
  const accountFromCard = (card, devicePubkey) => {
    if (!ownCard(card)) return null
    const kept = cardOf(card.profileId)
    return kept?.keys?.some(k => same(k.pub, devicePubkey)) ? kept.profileId : null
  }

  /**
   * A qué aparatos se le escribe a un contacto: los de su tarjeta, o la llave con la que se
   * agregó si todavía no mandó ninguna. Una cuenta sin tarjeta (Dotrino antes de escribir)
   * no tiene ninguno: no hay llave de aparato a la que mandar.
   */
  const recipientsOf = (pubkey) => {
    const card = cardOf(pubkey)
    if (card?.keys?.length) return card.keys.filter(k => k.pub && k.encPub).map(k => ({ pubkey: k.pub, encPub: k.encPub }))
    if (isPinned(pubkey)) return []
    const c = findByPubkey(pubkey)
    return [{ pubkey: c?.publickey || pubkey, encPub: c?.encryptionPubkey || undefined }]
  }

  // ---- Online presence (per-session, not persisted) ----------------------

  const markOnline = (pubkey, token) => {
    onlineMap.value.set(pubkey, token)
    onlineMap.value = new Map(onlineMap.value)
    // Also record the latest token in the vault contact record
    if (findByPubkey(pubkey) && token) {
      updateContact(pubkey, { lastToken: token }).catch(() => {})
    }
  }
  const markOffline = (token) => {
    for (const [pk, tk] of onlineMap.value.entries()) {
      if (tk === token) onlineMap.value.delete(pk)
    }
    onlineMap.value = new Map(onlineMap.value)
  }
  const isOnline = (pubkey) => onlineMap.value.has(pubkey)
  // Token "fresco": solo de la sesión actual (presencia confirmada).
  // Útil para enrutar por token (WebRTC/proxy directo). Si no hay, hay que
  // ir por pubkey para aprovechar la cola offline del proxy.
  const liveTokenFor = (pubkey) => onlineMap.value.get(pubkey) || null
  const tokenFor = (pubkey) => onlineMap.value.get(pubkey) || findByPubkey(pubkey)?.lastToken || null

  // ---- Rating -------------------------------------------------------------

  // `valueOrIndicators`: número (= confianza) o mapa { confianza, afinidad, ... }.
  // La confianza se guarda en el vault local (web-of-trust); el mapa completo se
  // atesta firmado en el registro. La reputación se pondera por confianza (anti-sybil).
  const ratePeer = async (pubkey, valueOrIndicators, notes) => {
    const id = await getIdentity()
    if (!id) throw new Error('identity vault unreachable')
    const indicators = typeof valueOrIndicators === 'number'
      ? { confianza: valueOrIndicators }
      : (valueOrIndicators || {})
    if (typeof indicators.confianza === 'number') await id.setRating(pubkey, indicators.confianza, notes || '')
    await refresh()
    try {
      const rep = await getReputation()
      await rep?.client.publishRating({ subject: pubkey, indicators, notes: notes || undefined })
    } catch (e) { console.warn('[reputation] publish failed:', e) }
  }

  // Mis propios indicadores hacia un peer (desde mi atestación en el registro),
  // p.ej. para precargar el control de afinidad. {} si no tengo atestación.
  const myIndicatorsFor = async (pubkey) => {
    try {
      const rep = await getReputation()
      if (!rep) return {}
      // El registro guarda una atestación por eje; el paquete las fusiona (leer
      // solo la primera devolvía un único eje, así que la afinidad se perdía).
      return await rep.myIndicatorsFor(pubkey)
    } catch (_) { return {} }
  }

  const ratingFor = (pubkey) => {
    if (!pubkey) return { value: null, source: null, count: 0 }
    return computeDerivedRating(peerFor(pubkey), trustMap.value)
  }
  const myRatingFor = (pubkey) => peerFor(pubkey)?.myRating?.rating ?? null
  /** Bloqueado por mí (privado, en el libro de contactos; identity ≥ 0.108). */
  // A Dotrino no se le bloquea: es el canal de las respuestas a lo que pediste.
  const isBlocked = (pubkey) => !isPinned(pubkey) && peerFor(pubkey)?.blocked === true

  // Reputación de la NUBE ponderada por mi web-of-trust (rellena el cold-start
  // con lo que dice mi red, no solo lo que recibí por el proxy). Async → para
  // un badge enriquecido. Devuelve null si no hay datos confiables.
  const cloudReputationFor = async (pubkey) => {
    if (!pubkey) return null
    try {
      const rep = await getReputation()
      if (!rep) return null
      return await rep.reputationOf(pubkey)
    } catch (e) { console.warn('[reputation] lookup failed:', e); return null }
  }

  return {
    peers, contacts, ratingTick, onlineMap,
    refresh, refreshPeers,
    addContact, updateContact, removeContact,
    findByPubkey, findByToken, findBySender, cardOf, peerFor,
    isPinned, accountFromCard, recipientsOf, moveToAccount,
    markOnline, markOffline, isOnline, tokenFor, liveTokenFor,
    ratePeer, ratingFor, myRatingFor, isBlocked, cloudReputationFor, myIndicatorsFor
  }
})
