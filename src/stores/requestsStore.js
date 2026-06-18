import { defineStore } from 'pinia'
import { ref } from 'vue'

// Bandeja de SOLICITUDES de contacto. Mensajes de pubkeys que NO están en tus
// contactos caen acá en vez de auto-agregarse. Es EFÍMERA y local a este
// dispositivo: vive en localStorage con TTL de 24h (calza con la ventana offline
// del proxy) y se purga sola. Los desconocidos no entran al vault hasta que
// aceptás. Cada entrada guarda lo mínimo para poder responder si aceptás
// (encryptionPubkey + token) + el primer mensaje + si está "avalado por tu red".

const LS_KEY = 'cc-requests-v1'
const TTL_MS = 24 * 60 * 60 * 1000

function loadInitial () {
  try {
    const raw = localStorage.getItem(LS_KEY)
    const arr = raw ? JSON.parse(raw) : []
    const now = Date.now()
    return Array.isArray(arr) ? arr.filter(r => r && (now - (r.ts || 0)) < TTL_MS) : []
  } catch (_) { return [] }
}

export const useRequestsStore = defineStore('requests', () => {
  const requests = ref(loadInitial())

  const persist = () => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(requests.value)) } catch (_) {}
  }

  const prune = () => {
    const now = Date.now()
    const before = requests.value.length
    requests.value = requests.value.filter(r => (now - (r.ts || 0)) < TTL_MS)
    if (requests.value.length !== before) persist()
  }

  // Inserta o actualiza una solicitud (conserva el ts original para el TTL).
  const upsert = (entry) => {
    prune()
    const i = requests.value.findIndex(r => r.pubkey === entry.pubkey)
    if (i >= 0) {
      requests.value[i] = { ...requests.value[i], ...entry, ts: requests.value[i].ts }
    } else {
      requests.value = [{ ...entry, ts: entry.ts || Date.now() }, ...requests.value]
    }
    persist()
  }

  const remove = (pubkey) => {
    requests.value = requests.value.filter(r => r.pubkey !== pubkey)
    persist()
  }

  const get = (pubkey) => requests.value.find(r => r.pubkey === pubkey) || null

  return { requests, upsert, remove, get, prune }
})
