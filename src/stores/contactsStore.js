import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { getIdentity } from '../services/identity'
import { computeDerivedRating, buildTrustMap } from '../utils/rating'
import { getReputation } from '../services/reputation'
import { avatarDataUri } from '@dotrino/identity/avatar'
import dotrinoLogo from '../assets/dotrino.png'

import { getFriends, DOTRINO_ACCOUNT } from '../services/friends'

export { DOTRINO_ACCOUNT }

/**
 * Los contactos son los AMIGOS del ecosistema: viven en la libreta de la identidad
 * (id.dotrino.com), la misma que leen el chat, el ajedrez y cualquier otra app, y los lee
 * `@dotrino/profile/friends` (por cuenta, con su tarjeta de perfil). Este store es la vista reactiva
 * que pinta el messenger, más lo suyo: calificaciones y reputación.
 */
export const useContactsStore = defineStore('contacts', () => {
  const friends = getFriends()
  const book = friends.book

  const peers = ref([])              // todos los registros de la libreta
  const onlineTick = ref(0)          // presencia de esta sesión (la lleva @dotrino/profile/friends)
  const ratingTick = ref(0)
  book.onChange(() => { peers.value = book.peers; ratingTick.value++ })
  friends.onChange(() => { onlineTick.value++ })

  const contacts = computed(() => {
    ratingTick.value
    // Dotrino, el contacto fijo, no sale hasta que se le pueda escribir: sus aparatos llegan con
    // su tarjeta, cuando contesta lo que se pidió por correo. Antes era un chat sin salida.
    return peers.value.filter(p => p.isContact && (!book.isPinned(p.publickey) || book.recipientsOf(p.publickey).length > 0))
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
  })

  const trustMap = computed(() => buildTrustMap(peers.value))

  const refresh = async () => {
    try { await book.refresh() } catch (e) { console.warn('listPeers failed:', e) }
  }
  // backward-compat alias used elsewhere
  const refreshPeers = refresh

  const addContact = (c) => book.add(c)
  const updateContact = (pubkey, patch) => book.update(pubkey, patch)
  const removeContact = (pubkey) => book.remove(pubkey)

  // Lo que se lee de la libreta: lo calcula @dotrino/profile/friends. Se toca `peers` para que Vue
  // vuelva a pintar cuando cambie.
  const findByPubkey = (pubkey) => (peers.value, book.find(pubkey))
  const isPinned = (pubkey) => book.isPinned(pubkey)
  // El AVATAR es el del ecosistema: el identicon DETERMINISTA del pubkey, el mismo que pintan
  // <dotrino-topbar> y <dotrino-profile>; no cambia con el apodo porque la llave no cambia.
  // La excepción es Dotrino, el contacto fijo: lleva su logo, para que se reconozca de un vistazo.
  const avatarFor = (pubkey, opts) => (isPinned(pubkey) ? dotrinoLogo : avatarDataUri(pubkey, opts))
  const cardOf = (pubkey) => (peers.value, book.cardOf(pubkey))
  const findBySender = (pubkey) => (peers.value, book.findBySender(pubkey))
  const moveToAccount = (from, account) => book.moveToAccount(from, account)
  const findByToken = (token) => contacts.value.find(c => c.lastToken === token)
  const peerFor = (pubkey) => (peers.value, book.peer(pubkey))
  const accountFromCard = (card, devicePubkey) => book.accountFromCard(card, devicePubkey)
  const recipientsOf = (pubkey) => (peers.value, book.recipientsOf(pubkey))

  // ---- Presencia de esta sesión (no se guarda): la lleva @dotrino/profile/friends ----
  const markOnline = (pubkey, token) => friends.markOnline(pubkey, token)
  const markOffline = (token) => friends.markOffline(token)
  const isOnline = (pubkey) => (onlineTick.value, friends.isOnline(pubkey))
  // Token "fresco": solo de la sesión actual. Sin él se va por pubkey (la cola offline).
  const liveTokenFor = (pubkey) => (onlineTick.value, friends.liveTokenFor(pubkey))
  const tokenFor = (pubkey) => (onlineTick.value, friends.tokenFor(pubkey))

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
  const isBlocked = (pubkey) => (peers.value, book.isBlocked(pubkey))

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
    peers, contacts, ratingTick,
    refresh, refreshPeers,
    addContact, updateContact, removeContact,
    findByPubkey, findByToken, findBySender, cardOf, peerFor,
    isPinned, avatarFor, accountFromCard, recipientsOf, moveToAccount,
    markOnline, markOffline, isOnline, tokenFor, liveTokenFor,
    ratePeer, ratingFor, myRatingFor, isBlocked, cloudReputationFor, myIndicatorsFor
  }
})
