import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { key as accountKey } from '../services/account'

// SOLICITUDES de contacto, en los dos sentidos: las que te llegan (`dir: 'in'`, alguien
// canjeó tu código y quiere agregarte) y las que mandaste (`dir: 'out'`, esperando a que
// acepten). Son mensajes de CONTROL entre las dos puntas: nunca llevan texto y nunca entran
// a un chat. Nadie es contacto de nadie hasta que el otro acepta.
//
// EFÍMERA y local a este dispositivo: localStorage con TTL de 24 h (calza con la ventana
// offline del proxy) y se purga sola. Los desconocidos no entran al vault hasta que
// aceptas. Cada entrada guarda lo mínimo para contestar: la llave de cifrado (verificada)
// y el token.

// Namespaceada por cuenta (services/account.js): una solicitud es PARA una identidad,
// y sin esto las de una cuenta aparecían al entrar con otra. Función y no constante:
// al importar el módulo la cuenta todavía no está resuelta.
const lsKey = () => accountKey('cc-requests-v1')
const TTL_MS = 24 * 60 * 60 * 1000

function loadInitial () {
  try {
    const raw = localStorage.getItem(lsKey())
    const arr = raw ? JSON.parse(raw) : []
    const now = Date.now()
    return Array.isArray(arr) ? arr.filter(r => r && (now - (r.ts || 0)) < TTL_MS) : []
  } catch (_) { return [] }
}

export const useRequestsStore = defineStore('requests', () => {
  const requests = ref(loadInitial())

  const persist = () => {
    try { localStorage.setItem(lsKey(), JSON.stringify(requests.value)) } catch (_) {}
  }

  const prune = () => {
    const now = Date.now()
    const before = requests.value.length
    requests.value = requests.value.filter(r => (now - (r.ts || 0)) < TTL_MS)
    if (requests.value.length !== before) persist()
  }

  const dirOf = (r) => r.dir || 'in'

  // Inserta o actualiza una solicitud (conserva el ts original para el TTL).
  const upsert = (entry) => {
    prune()
    const dir = dirOf(entry)
    const i = requests.value.findIndex(r => r.pubkey === entry.pubkey && dirOf(r) === dir)
    if (i >= 0) {
      requests.value[i] = { ...requests.value[i], ...entry, dir, ts: requests.value[i].ts }
    } else {
      requests.value = [{ ...entry, dir, ts: entry.ts || Date.now() }, ...requests.value]
    }
    persist()
  }

  /** Quita las solicitudes de esa persona: las de un sentido, o las dos si no se dice. */
  const remove = (pubkey, dir) => {
    requests.value = requests.value.filter(r => !(r.pubkey === pubkey && (!dir || dirOf(r) === dir)))
    persist()
  }

  const get = (pubkey, dir = 'in') => { prune(); return requests.value.find(r => r.pubkey === pubkey && dirOf(r) === dir) || null }

  /** Las que te llegaron (las que se cuentan en la campana). */
  const incoming = computed(() => requests.value.filter(r => dirOf(r) === 'in'))

  return { requests, incoming, upsert, remove, get, prune }
})
