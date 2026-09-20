// Singleton compartido del Identity vault para toda la app.
//
// Importar `Identity` desde `@dotrino/identity` directamente
// en varios stores funcionaba mientras Vite los metía en el mismo chunk.
// `connectionStore` hace `import()` dinámico de `threadsStore` y
// `contactsStore` (para evitar dependencia circular en setup), lo que
// puede empujar a Rollup a duplicar el módulo `dotrino-identity` en
// chunks separados — y si pasa, cada copia tiene su propia variable
// `singleton`, su propio `_pending` Map y su propio iframe handler. El
// resultado: `listPeers` queda colgado porque la respuesta llega a otra
// instancia.
//
// Forzando que TODOS los stores usen este wrapper, el lib se importa una
// sola vez en este módulo y todos comparten el mismo objeto Identity.

import { Identity } from '@dotrino/identity'

let _instance = null
let _connectPromise = null

/**
 * Devuelve la instancia compartida del Identity vault, esperando a que
 * `ready` haya completado. Reutiliza la promesa entre llamadas concurrentes.
 * Devuelve `null` si el vault no está alcanzable (e.g. iframe blocked) en
 * lugar de tirar — los stores tienen fallbacks para ese caso.
 */
export async function getIdentity () {
  if (_instance) return _instance
  if (_connectPromise) return _connectPromise
  _connectPromise = (async () => {
    try {
      _instance = await Identity.connect()
      return _instance
    } catch (e) {
      console.warn('Identity vault unreachable:', e)
      _instance = null
      return null
    } finally {
      _connectPromise = null
    }
  })()
  return _connectPromise
}

/** Acceso síncrono (puede devolver null si aún no completó connect). */
export function currentIdentity () {
  return _instance
}
