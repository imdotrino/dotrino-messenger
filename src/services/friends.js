// LOS AMIGOS del messenger son los del ecosistema: el protocolo (pedir, aceptar, escribirle a un
// amigo en todos sus aparatos) y la libreta por cuenta viven en `@dotrino/profile/friends`, y aquí solo
// se monta. Lo que es del messenger —hilos, mensajes, versión, avisos— entra por los `hooks`,
// que rellenan los stores al arrancar.
import { createFriends } from '@dotrino/profile/friends'
import { getWebSocketProxyClient } from '@dotrino/proxy-client'
import { getIdentity } from './identity'
import { key as accountKey } from './account'
import { MINE as MY_VERSION } from './compat'

/**
 * LA CUENTA DE DOTRINO: contacto fijo de todo messenger. Por ahí llegan las respuestas a lo que
 * se pide por correo (feedback.dotrino.com), así que no se puede quitar ni bloquear: si falta en
 * la libreta, vuelve. Es la llave del PERFIL (la que sella su acta), no la de un aparato.
 */
export const DOTRINO_ACCOUNT = '{"key_ops":["verify"],"ext":true,"kty":"EC","x":"McyhKieRw_Jcl3TY9EvLovL-ALzGoWqMOrfnFjT7XpA","y":"V7tfpDWN37tPnhXnIFUlMaTepcTzzxPWTj_72PkpKPw","crv":"P-256"}'

// La bóveda es un iframe que se abre con calma: la libreta la pide en cada llamada.
const need = async () => {
  const id = await getIdentity()
  if (!id) throw Object.assign(new Error('identity vault unreachable'), { code: 'no-identity' })
  return id
}
const identity = new Proxy({}, {
  // `then` no: si no, `await identity` lo tomaría por una promesa.
  get: (_t, name) => (name === 'then' ? undefined : async (...args) => (await need())[name]?.(...args)),
})

/** Lo que el messenger pone en cada momento: los stores lo rellenan al crearse. */
export const hooks = {}
/** El apodo de la cuenta (lo pone connectionStore). */
export const nickname = { value: '' }

let instance = null
/** El montaje único de `@dotrino/profile/friends` para esta app. */
export function getFriends () {
  if (instance) return instance
  instance = createFriends({
    identity,
    client: getWebSocketProxyClient({ app: 'messenger' }),
    nickname: () => nickname.value,
    version: MY_VERSION,
    // Las solicitudes son de UNA cuenta: van namespaceadas, como todo lo local (services/account.js).
    inboxKey: () => accountKey('cc-requests-v1'),
    pinned: [{ publickey: DOTRINO_ACCOUNT, nickname: 'Dotrino' }],
    hooks,
  })
  return instance
}
