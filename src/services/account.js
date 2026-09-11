/**
 * DE QUÉ CUENTA ES LO QUE HAY GUARDADO AQUÍ.
 *
 * Un dispositivo puede tener varias cuentas (multi-perfil), y la activa cambia sin
 * avisar a las apps: al emparejar con una bóveda, al adoptar un perfil, al crear
 * otro — y también sola, cuando a este aparato lo echan de la cuenta y el arranque
 * del vault estrena una nueva en su lugar.
 *
 * El messenger guardaba su estado (apodo, hilos, conversación abierta, solicitudes)
 * en claves GLOBALES de localStorage, sin ligarlas a ninguna cuenta. El resultado, que
 * es el fallo que esto viene a arreglar: al cambiar la cuenta, la app seguía enseñando
 * el apodo de la anterior sobre una identidad nueva y vacía —avatar distinto, sin
 * contactos, sin chats— y encima le ESCRIBÍA ese apodo viejo a la cuenta nueva, así
 * que la confusión quedaba grabada en el vault y aparecían dos cuentas con el mismo
 * nombre y distinta llave.
 *
 * Aquí se resuelve una sola vez, ANTES de montar la app, y todo lo local cuelga de
 * `key(...)`. Si la cuenta cambió respecto de la última visita, se dice —`changed()`—
 * en vez de disimularlo.
 */

import { getIdentity } from './identity'

// Última cuenta con la que se usó esta app en este navegador.
const ACCOUNT_KEY = 'messenger_account_v1'
// Claves de la versión que no namespaceaba nada. Se adoptan UNA vez para la cuenta
// activa (si no, quien ya usaba el messenger perdería sus hilos al actualizar).
const LEGACY_KEYS = [
  'messenger_nickname',
  'messenger_threads_cache_v1',
  'messenger_active_pubkey_v1',
  'cc-requests-v1',
  'cc_displayed_msgs_v1'
]

let _id = null        // id de la cuenta activa ('pXXXXXXXX'), o null si no hay vault
let _previous = null  // la que había la última vez, si es otra
let _changed = false
let _resolved = false

/** Id de la cuenta activa. `null` si el vault no contestó (modo degradado). */
export function accountId () { return _id }

/** ¿La cuenta activa NO es la de la última visita? */
export function changed () { return _changed }

/** La cuenta anterior, cuando cambió. Para poder decir qué pasó. */
export function previousAccount () { return _previous }

/**
 * Clave de almacenamiento de ESTA cuenta. Sin cuenta resuelta se devuelve la clave
 * pelada: es el modo degradado (vault inalcanzable), y ahí es preferible seguir
 * funcionando en un cajón común a no funcionar.
 */
export function key (base) { return _id ? `${base}::${_id}` : base }

/**
 * Resuelve la cuenta activa y adopta el estado de la versión sin namespace.
 * Idempotente; se llama una vez desde `main.js` antes de montar.
 */
export async function resolveAccount () {
  if (_resolved) return { id: _id, changed: _changed }
  _resolved = true
  let id = null
  try {
    const identity = await getIdentity()
    const cur = await identity?.currentProfile?.()
    id = cur?.id || null
  } catch (_) { /* sin vault: modo degradado, claves peladas */ }
  _id = id
  if (!id) return { id: null, changed: false }

  let saved = null
  try { saved = localStorage.getItem(ACCOUNT_KEY) } catch (_) {}

  if (!saved) {
    // Primera vez con esta versión: lo que hay en las claves globales es de ESTA
    // cuenta (era la única que la app conocía), así que se adopta tal cual.
    adoptLegacy(id)
  } else if (saved !== id) {
    _previous = saved
    _changed = true
    // No se toca nada de la otra cuenta: su estado se queda en SUS claves y vuelve
    // a aparecer si el usuario vuelve a ella.
  }
  try { localStorage.setItem(ACCOUNT_KEY, id) } catch (_) {}
  return { id: _id, changed: _changed }
}

/** Mueve el estado sin namespace al de la cuenta `id`. No pisa lo que ya exista. */
function adoptLegacy (id) {
  for (const base of LEGACY_KEYS) {
    try {
      const viejo = localStorage.getItem(base)
      if (viejo == null) continue
      const nuevo = `${base}::${id}`
      if (localStorage.getItem(nuevo) == null) localStorage.setItem(nuevo, viejo)
      localStorage.removeItem(base)
    } catch (_) { /* cajón lleno o modo privado: se sigue */ }
  }
}

/**
 * Borra lo local de una cuenta. Se usa cuando el vault avisa —FIRMADO— de que a este
 * aparato lo echaron: el store del ecosistema ya limpia sus hilos, y esto limpia el
 * espejo del messenger, que si no se quedaría enseñando los mensajes de una cuenta
 * que ya no es de nadie.
 */
export function forgetAccount (id) {
  if (!id) return
  for (const base of LEGACY_KEYS) {
    try { localStorage.removeItem(`${base}::${id}`) } catch (_) {}
  }
}
