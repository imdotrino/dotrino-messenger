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

  return {
    requests,
    incoming,
    upsert: (entry) => inbox.upsert(entry),
    remove: (pubkey, dir) => inbox.remove(pubkey, dir),
    get: (pubkey, dir = 'in') => inbox.get(pubkey, dir),
    prune: () => inbox.prune(),
  }
})
