// Qué DMs entrantes ya se enseñaron como notificación centrada. Persistido en
// localStorage, namespaceado por la cuenta activa: así un refresco no vuelve a
// mostrar el mismo mensaje.

import { key as accountKey } from './account'

// Función, no constante: al importar el módulo la cuenta aún no está resuelta.
const lsKey = () => accountKey('cc_displayed_msgs_v1')
const MAX = 500

let cache = new Set()
let loaded = false

function ensureLoaded () {
  if (loaded) return
  loaded = true
  try {
    const local = JSON.parse(localStorage.getItem(lsKey()) || '[]')
    if (Array.isArray(local)) cache = new Set(local)
  } catch (_) {}
}

export async function isDisplayed (id) {
  if (!id) return true
  ensureLoaded()
  return cache.has(id)
}

/**
 * Marca un id como mostrado. Idempotente. Devuelve `true` si era nuevo,
 * `false` si ya estaba.
 */
export async function markDisplayed (id) {
  if (!id) return false
  ensureLoaded()
  if (cache.has(id)) return false
  cache.add(id)
  // Cap el set para no crecer indefinido — keep most recent ids.
  let arr = [...cache]
  if (arr.length > MAX) arr = arr.slice(-MAX)
  cache = new Set(arr)
  try { localStorage.setItem(lsKey(), JSON.stringify(arr)) } catch (_) {}
  return true
}
