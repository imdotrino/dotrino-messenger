import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useConnectionStore } from './connectionStore'
import { getIdentity } from '../services/identity'
import { sanitizeNickname } from '../utils/sanitize'
import { computeDerivedRating, buildTrustMap } from '../utils/rating'
import { getReputation } from '../services/reputation'

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
      ratingTick.value++
    } catch (e) { console.warn('listPeers failed:', e) }
  }
  // backward-compat alias used elsewhere
  const refreshPeers = refresh

  const addContact = async ({ pubkey, nickname, token, encryptionPubkey, notes }) => {
    if (!pubkey) throw new Error('pubkey required')
    const id = await getIdentity()
    if (!id) throw new Error('Identity vault no disponible')
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
    const id = await getIdentity()
    if (!id) return
    await id.removeContact(pubkey)
    await refresh()
  }

  const findByPubkey = (pubkey) => contacts.value.find(c => c.publickey === pubkey)
  const findByToken  = (token)  => contacts.value.find(c => c.lastToken === token)
  const peerFor      = (pubkey) => peers.value.find(p => p.publickey === pubkey) || null

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
    if (!id) throw new Error('Identity vault no disponible')
    const indicators = typeof valueOrIndicators === 'number'
      ? { confianza: valueOrIndicators }
      : (valueOrIndicators || {})
    if (typeof indicators.confianza === 'number') await id.setRating(pubkey, indicators.confianza, notes || '')
    await refresh()
    try {
      const rep = await getReputation()
      await rep?.client.publishRating({ subject: pubkey, indicators, notes: notes || undefined })
    } catch (e) { console.warn('[reputation] publish falló', e) }
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

  // Reputación de la NUBE ponderada por mi web-of-trust (rellena el cold-start
  // con lo que dice mi red, no solo lo que recibí por el proxy). Async → para
  // un badge enriquecido. Devuelve null si no hay datos confiables.
  const cloudReputationFor = async (pubkey) => {
    if (!pubkey) return null
    try {
      const rep = await getReputation()
      if (!rep) return null
      return await rep.reputationOf(pubkey)
    } catch (e) { console.warn('[reputation] lookup falló', e); return null }
  }

  return {
    peers, contacts, ratingTick, onlineMap,
    refresh, refreshPeers,
    addContact, updateContact, removeContact,
    findByPubkey, findByToken, peerFor,
    markOnline, markOffline, isOnline, tokenFor, liveTokenFor,
    ratePeer, ratingFor, myRatingFor, cloudReputationFor, myIndicatorsFor
  }
})
