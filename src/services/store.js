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

/** @type {Store|null} */
let _instance = null
/** @type {Promise<Store|null>|null} */
let _connectPromise = null
/** @type {(() => void)|null} */
let _unwatch = null
/** @type {Set<(changed: string[]) => void>} */
const _changed = new Set()

/** @type {import('../types').StoreStatus} */
export const storeStatus = reactive({
  open: false,
  error: null, // { code, message } si no se pudo abrir
  vault: { state: 'off' } // respaldo en tu bóveda: off | syncing | synced | error
})

/**
 * El almacén compartido, o null si no se pudo abrir (y entonces `storeStatus.error` dice por qué).
 * @returns {Promise<Store|null>}
 */
export async function getStore () {
  if (_instance) return _instance
  if (_connectPromise) return _connectPromise
  _connectPromise = (async () => {
    try {
      // Si tu identidad está emparejada con tu vault, el store se respalda allí
      // (IndexedDB como caché). Si no, Store.connect cae a modo local (igual que hoy).
      const identity = await getIdentity().catch(() => null)
      // `?? undefined`: el almacén trata null y undefined igual (sin identidad), pero su
      // index.d.ts solo admite undefined.
      _instance = await Store.connect({ identity: identity ?? undefined })
      storeStatus.open = true
      storeStatus.error = null
      watchVault(_instance)
      return _instance
    } catch (e) {
      // La app sigue con lo que tenga en memoria, pero el fallo se registra y se ve.
      const err = /** @type {Error & { code?: string }} */ (e)
      console.error('[messenger] could not open the store:', err.code || '', err.message)
      storeStatus.open = false
      storeStatus.error = { code: err.code || 'store-unreachable', message: err.message }
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
 * @param {Store} store
 */
function watchVault (store) {
  if (!store.on || _unwatch) return
  Object.assign(storeStatus.vault, store.vault)
  _unwatch = store.on('vault', (s) => {
    Object.assign(storeStatus.vault, s)
    if (s.changed?.length) for (const fn of _changed) fn(s.changed)
  })
}

/**
 * Avisa cuando llegan hilos de otro aparato. Devuelve cómo dejar de escuchar.
 * @param {(changed: string[]) => void} fn
 * @returns {() => boolean}
 */
export function onVaultChanged (fn) {
  _changed.add(fn)
  return () => _changed.delete(fn)
}

/**
 * Ponerse al día con la bóveda ahora. Lanza con `code` si no se pudo.
 * @returns {Promise<import('@dotrino/store').VaultBackupStatus>}
 */
export async function vaultSyncNow () {
  const store = await getStore()
  if (!store) throw Object.assign(new Error(storeStatus.error?.message || 'store unreachable'), { code: storeStatus.error?.code })
  return store.vaultSync()
}
