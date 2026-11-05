/**
 * Compute a derived rating for a peer.
 *
 * Rules (per the project's design):
 *  - If we have our own (myRating), that wins.
 *  - Otherwise, weighted average of endorsements whose ratedBy is a peer
 *    we have rated (weight = ourTrust / 5). Endorsements from unknown
 *    raters are ignored.
 *
 * @param {import('../types').Peer|null|undefined} peer Peer record from the vault
 * @param {Map<string, number>} ratedByMap Map<pubkey, ratingINT 0-5> of peers I've rated
 * @returns {import('../types').DerivedRating}
 */
export function computeDerivedRating (peer, ratedByMap) {
  if (!peer) return { value: null, source: null, count: 0 }
  const mine = peer.myRating
  if (mine && typeof mine.rating === 'number') {
    return { value: mine.rating, source: 'mine', count: 1 }
  }
  const list = Array.isArray(peer.endorsements) ? peer.endorsements : []
  let weightedSum = 0
  let totalWeight = 0
  let count = 0
  for (const e of list) {
    if (!e || typeof e.rating !== 'number') continue
    const trust = ratedByMap.get(e.ratedBy)
    if (typeof trust !== 'number' || trust <= 0) continue
    const weight = trust / 5
    weightedSum += e.rating * weight
    totalWeight += weight
    count++
  }
  if (count === 0 || totalWeight === 0) return { value: null, source: null, count: 0 }
  return { value: weightedSum / totalWeight, source: 'derived', count }
}

/**
 * Build a Map<pubkey, rating> for peers I have rated, used as trust input
 * to weight endorsements.
 * @param {import('../types').Peer[]} allPeersList
 * @returns {Map<string, number>}
 */
export function buildTrustMap (allPeersList) {
  /** @type {Map<string, number>} */
  const map = new Map()
  for (const p of allPeersList) {
    const r = p?.myRating?.rating
    if (typeof r === 'number' && r > 0) {
      map.set(p.publickey, r)
    }
  }
  return map
}
