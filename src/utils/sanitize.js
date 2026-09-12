/**
 * Saneado de lo que escribe el usuario.
 *
 * AQUÍ NO SE ESCAPA HTML, Y ES A PROPÓSITO.
 *
 * Todo lo que esta app pinta pasa por la interpolación de Vue (`{{ … }}`) o por
 * `textContent` (la extensión): las dos tratan el valor como TEXTO y nunca como
 * marcado, así que la protección contra HTML inyectado vive en el pintado, no
 * aquí. No hay un solo `v-html` ni un solo `innerHTML` con datos del usuario en
 * todo el repo, y el test `tests/texto-literal.spec.js` lo fija.
 *
 * Escapar además en este punto no protegía de nada y rompía el texto dos veces:
 *
 *   1. El emisor escapaba ANTES de cifrar y de guardar, así que `?x=1&y=2` salía
 *      al cable como `?x=1&amp;y=2`: el dato viajaba y se guardaba corrompido.
 *   2. El receptor volvía a escapar lo que descifraba, y acababa pintando
 *      `?x=1&amp;amp;y=2` — medido en producción el 2026-09-11.
 *
 * O sea que un enlace con parámetros llegaba roto al otro lado. Si alguien
 * vuelve a meter un escapado aquí, vuelve el mismo fallo: lo que hay que mirar
 * es que el sitio donde se pinta siga siendo texto.
 */

/**
 * Apodo: sin espacios de sobra y sin los caracteres que lo vuelven ambiguo al
 * viajar por el protocolo y al colarse en una notificación del sistema.
 * (Este filtro existía desde siempre, pero era código muerto: el escapado
 * corría antes y convertía `<` en `&lt;`, que ya no casaba con el filtro.)
 */
export function sanitizeNickname (nick) {
  if (!nick || typeof nick !== 'string') {
    return ''
  }

  return nick.trim().replace(/[<>"'`]/g, '')
}

/**
 * Mensaje: se recorta y se limita el largo. Nada más — el texto del usuario
 * llega al otro lado letra por letra.
 */
export function sanitizeMessage (text) {
  if (!text || typeof text !== 'string') {
    return ''
  }

  return text.trim().slice(0, 1000)
}
