// Espejo de threads vía chrome.storage.local. Igual que el identity bridge:
// los contextos con conexión real al proxy (pestaña directa, popup pineado,
// offscreen) escriben los threads aquí; el overlay (en sites HTTPS sin
// conexión propia) los LEE para mostrar histórico.
//
// Sin esto el overlay muestra el chat vacío porque su `messenger.dotrino.com`
// localStorage está particionado por el site visitado.

import { kvGet, kvSet, onKvChanged } from './identityBridge'

const BRIDGE_KEY = 'cc-threads-v1'
const PUSH_DEBOUNCE_MS = 600

let _pushTimer = null
let _lastHash = ''
let _pendingThreads = null

function hashThreads (threads) {
  try {
    const s = JSON.stringify(threads)
    let h = 0
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
    return s.length + ':' + h
  } catch { return Math.random().toString(36) }
}

/** Encola un push debounced al bridge con el snapshot actual de threads. */
export function pushThreadsToBridge (threads) {
  _pendingThreads = threads
  if (_pushTimer) clearTimeout(_pushTimer)
  _pushTimer = setTimeout(async () => {
    _pushTimer = null
    const snap = _pendingThreads
    _pendingThreads = null
    if (!snap) return
    const h = hashThreads(snap)
    if (h === _lastHash) return
    _lastHash = h
    try { await kvSet(BRIDGE_KEY, snap) } catch (_) {}
  }, PUSH_DEBOUNCE_MS)
}

/** Lee el snapshot del bridge (objeto pubkey → array de entries). */
export async function pullThreadsFromBridge () {
  try {
    const v = await kvGet(BRIDGE_KEY)
    if (v) _lastHash = hashThreads(v)
    return v && typeof v === 'object' ? v : null
  } catch { return null }
}

/** Suscribe a cambios remotos del snapshot. */
export function onThreadsChanged (handler) {
  return onKvChanged((key, value) => {
    if (key !== BRIDGE_KEY) return
    if (value) _lastHash = hashThreads(value)
    handler(value || {})
  })
}
