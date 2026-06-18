// Track which incoming DMs ya se mostraron como notificación centrada.
// Persistido en `chrome.storage.local` vía el bridge para no repetir el toast
// cuando el usuario cambia de pestaña (cada pestaña con FAB tiene su propio
// messenger iframe — sin esto cada uno mostraría el mismo mensaje).
//
// Fallback a localStorage si el bridge no responde (pestaña directa sin
// extensión).

import { kvGet, kvSet, onKvChanged } from './identityBridge'

const STORAGE_KEY = 'cc-displayed-msgs-v1'
const LS_KEY = 'cc_displayed_msgs_v1'
const MAX = 500

let cache = new Set()
let loaded = false

async function ensureLoaded () {
  if (loaded) return
  loaded = true
  try {
    const remote = await kvGet(STORAGE_KEY)
    if (Array.isArray(remote)) {
      cache = new Set(remote)
      return
    }
  } catch (_) {}
  try {
    const local = JSON.parse(localStorage.getItem(LS_KEY) || '[]')
    if (Array.isArray(local)) cache = new Set(local)
  } catch (_) {}
}

// Sincroniza ediciones desde otros contextos (otra pestaña marcó un mensaje).
onKvChanged((key, value) => {
  if (key !== STORAGE_KEY || !Array.isArray(value)) return
  cache = new Set(value)
})

export async function isDisplayed (id) {
  if (!id) return true
  await ensureLoaded()
  return cache.has(id)
}

/**
 * Marca un id como mostrado. Idempotente. Devuelve `true` si era nuevo,
 * `false` si ya estaba (esto sirve para race conditions: dos pestañas que
 * intentan mostrar el mismo DM al mismo tiempo, solo el primero verá `true`).
 */
export async function markDisplayed (id) {
  if (!id) return false
  await ensureLoaded()
  if (cache.has(id)) return false
  cache.add(id)
  // Cap el set para no crecer indefinido — keep most recent ids.
  let arr = [...cache]
  if (arr.length > MAX) arr = arr.slice(-MAX)
  cache = new Set(arr)
  // Persistencia: bridge primero, fallback a localStorage.
  try { await kvSet(STORAGE_KEY, arr) } catch (_) {}
  try { localStorage.setItem(LS_KEY, JSON.stringify(arr)) } catch (_) {}
  return true
}
