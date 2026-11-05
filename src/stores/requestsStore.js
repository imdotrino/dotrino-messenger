import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { getFriends } from '../services/friends'

// SOLICITUDES de amistad, en los dos sentidos. Las guarda la bandeja de `@dotrino/profile/friends`
// (24 h, por cuenta, local a este aparato); esto es su vista reactiva para el messenger.
export const useRequestsStore = defineStore('requests', () => {
  const inbox = getFriends().inbox
  const requests = ref(inbox.all)
  inbox.onChange(() => { requests.value = inbox.all })

  const incoming = computed(() => requests.value.filter(r => (r.dir || 'in') === 'in'))

  /** @typedef {import('@dotrino/profile/friends').FriendRequest} FriendRequest */
  return {
    requests,
    incoming,
    /** @param {Partial<FriendRequest> & { pubkey: string }} entry */
    upsert: (entry) => inbox.upsert(entry),
    /**
     * @param {string} pubkey
     * @param {'in'|'out'} [dir]
     */
    remove: (pubkey, dir) => inbox.remove(pubkey, dir),
    /**
     * @param {string} pubkey
     * @param {'in'|'out'} [dir]
     */
    get: (pubkey, dir = 'in') => inbox.get(pubkey, dir),
    prune: () => inbox.prune(),
  }
})
