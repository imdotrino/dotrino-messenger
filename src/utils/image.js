// Una imagen para mandar por el chat: se reduce y se recomprime EN EL APARATO.
//
// Por qué así:
//   - Viaja como un mensaje sellado más, y un mensaje tiene techo: la trama del proxio es
//     de 1 MB y el sellado infla (base64 sobre JSON). Por debajo de ~200 KB de imagen el
//     sobre queda holgado.
//   - Recodificarla en un canvas BORRA LOS METADATOS (EXIF): la foto de un teléfono suele
//     llevar dónde se tomó, y eso no tiene por qué salir con ella.
//   - El redimensionado es el del pilar de contenido (`makeThumbnail`), no uno propio.
//     JPEG y no WebP: Safari no codifica WebP en canvas y devolvería un PNG enorme.
import { makeThumbnail } from '@dotrino/content-client/thumb'

export const IMAGE_MAX_BYTES = 200 * 1024
// De mejor a peor: se usa el primer intento que cabe.
const ATTEMPTS = [
  { maxSide: 1600, quality: 0.82 },
  { maxSide: 1280, quality: 0.75 },
  { maxSide: 1024, quality: 0.7 },
  { maxSide: 800, quality: 0.62 },
  { maxSide: 640, quality: 0.55 }
]

const toBase64 = (bytes) => {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

/**
 * @param {File|Blob} file
 * @returns {Promise<{ mime: string, data: string, w: number, h: number }>} `data` en base64
 * @throws con `code`: `not-image` (no es una imagen que el navegador sepa abrir) o
 *   `image-too-big` (ni en el intento más pequeño cabe).
 */
export async function prepareImage (file) {
  if (!/^image\//.test(file?.type || '')) throw Object.assign(new Error('not an image'), { code: 'not-image' })
  for (const a of ATTEMPTS) {
    let out
    try { out = await makeThumbnail(file, { ...a, type: 'image/jpeg' }) }
    catch (e) { throw Object.assign(new Error('the browser could not open this image: ' + e.message), { code: 'not-image' }) }
    if (out.bytes.length <= IMAGE_MAX_BYTES) {
      return { mime: out.mime, data: toBase64(out.bytes), w: out.width, h: out.height }
    }
  }
  throw Object.assign(new Error('image too big even at the smallest size'), { code: 'image-too-big' })
}

/** Lo que llega de otro lado: solo JPEG/PNG/WebP/GIF en base64, y con techo. */
export function validIncomingImage (img) {
  if (!img || typeof img !== 'object') return null
  if (!/^image\/(jpeg|png|webp|gif)$/.test(img.mime || '')) return null
  if (typeof img.data !== 'string' || img.data.length > IMAGE_MAX_BYTES * 2 || !/^[A-Za-z0-9+/=]+$/.test(img.data)) return null
  const w = Number(img.w) || 0
  const h = Number(img.h) || 0
  return { mime: img.mime, data: img.data, w, h }
}
