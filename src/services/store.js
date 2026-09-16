// Singleton compartido del Message Store (iframe a store.dotrino.com).
// Mismo patrón que services/identity.js, para evitar duplicación del módulo
// entre chunks dinámicos.
//
// Lo que le pasa al almacén SE ENSEÑA (`storeStatus`). Antes un fallo moría en un
// `console.warn` y la app seguía como si nada: sin almacén no hay historial, y el
// respaldo en tu bóveda puede quedarse caído sin que nadie se entere.

import { reactive } from 'vue'
import { Store } from '@dotrino/store'
import { getIdentity } from './identity.js'

let _instance = null
let _connectPromise = null
let _unwatch = null
const _changed = new Set()

export const storeStatus = reactive({
  open: false,
  error: null, // { code, message } si no se pudo abrir
  vault: { state: 'off' } // respaldo en tu bóveda: off | syncing | synced | error
})

export async function getStore () {
  if (_instance) return _instance
  if (_connectPromise) return _connectPromise
  _connectPromise = (async () => {
    try {
      // Si tu identidad está emparejada con tu vault, el store se respalda allí
      // (IndexedDB como caché). Si no, Store.connect cae a modo local (igual que hoy).
      const identity = await getIdentity().catch(() => null)
      _instance = await Store.connect({ identity })
      storeStatus.open = true
      storeStatus.error = null
      watchVault(_instance)
      return _instance
    } catch (e) {
      // La app sigue con lo que tenga en memoria, pero el fallo se registra y se ve.
      console.error('[messenger] could not open the store:', e.code || '', e.message)
      storeStatus.open = false
      storeStatus.error = { code: e.code || 'store-unreachable', message: e.message }
      _instance = null
      return null
    } finally {
      _connectPromise = null
    }
  })()
  return _connectPromise
}

/**
 * El respaldo en la bóveda va por detrás y por partes (@dotrino/store ≥ 0.11): las
 * lecturas son LOCALES, así que lo que se escribió en otro aparato llega por este
 * evento. Sin escucharlo, un mensaje escrito en el móvil no se vería aquí hasta
 * recargar la página.
 */
function watchVault (store) {
  if (!store.on || _unwatch) return
  Object.assign(storeStatus.vault, store.vault)
  _unwatch = store.on('vault', (s) => {
    Object.assign(storeStatus.vault, s)
    if (s.changed?.length) for (const fn of _changed) fn(s.changed)
  })
}

/** Avisa cuando llegan hilos de otro aparato. Devuelve cómo dejar de escuchar. */
export function onVaultChanged (fn) {
  _changed.add(fn)
  return () => _changed.delete(fn)
}

/** Ponerse al día con la bóveda ahora. Lanza con `code` si no se pudo. */
export async function vaultSyncNow () {
  const store = await getStore()
  if (!store) throw Object.assign(new Error(storeStatus.error?.message || 'store unreachable'), { code: storeStatus.error?.code })
  return store.vaultSync()
}
