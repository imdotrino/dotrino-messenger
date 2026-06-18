// Singleton compartido del Message Store (iframe a store.dotrino.com).
// Mismo patrón que services/identity.js, para evitar duplicación del módulo
// entre chunks dinámicos.

import { Store } from '@dotrino/store'

let _instance = null
let _connectPromise = null

export async function getStore () {
  if (_instance) return _instance
  if (_connectPromise) return _connectPromise
  _connectPromise = (async () => {
    try {
      _instance = await Store.connect()
      return _instance
    } catch (e) {
      console.warn('Store unreachable:', e)
      _instance = null
      return null
    } finally {
      _connectPromise = null
    }
  })()
  return _connectPromise
}
