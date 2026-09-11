/**
 * QUÉ VERSIÓN SOY Y SI PODEMOS HABLAR (CONVENCIONES §14).
 *
 * Una incompatibilidad de versiones se manifiesta como SILENCIO: el que llama reintenta
 * para siempre y el que atiende no sabe que le hablan. Por eso cada saludo dice qué es y
 * qué versión corre, y quien lo recibe lo juzga.
 *
 * NO BLOQUEA, se VE: bloquear sería código nuevo decidiendo si algo funciona, y lo que
 * faltó en los incidentes que originaron esta norma fue enterarse, no parar. El aviso va
 * pegado a la conversación con esa persona, que es donde se pierde el tiempo.
 *
 * `protocol` sube solo cuando cambia el cable (el formato `TIPO|json` y el sobre del
 * vault); `version` identifica esta build. La lista de rotas va por versión EXACTA,
 * nunca por rango.
 */
import { declare, check } from '@dotrino/compat'

/** Lo que soy. Viaja dentro del HELLO. */
export const MINE = declare({
  product: 'messenger',
  version: __APP_VERSION__,
  protocol: 1,
  speaks: [1]
})

/**
 * Versiones que sabemos rotas. Vacía a propósito: se llena cuando se detecta un fallo
 * en una versión YA publicada, y solo con versiones exactas.
 */
const BROKEN = []

/**
 * ¿Entiendo a quien me habla? Devuelve `null` si todo bien, o el motivo en llano.
 * Quien no se declara es una versión anterior a §14: se deja pasar y se dice.
 */
export function revisar (theirs) {
  if (!theirs) return 'unknown'
  try {
    const v = check({ mine: MINE, theirs, broken: BROKEN })
    return v.compatible ? null : 'incompatible'
  } catch (_) { return 'unknown' }
}
