// Un archivo para mandar por el chat: foto, PDF, lo que sea. VA TAL CUAL: el contenido del
// usuario no se toca (dueño, 2026-10-15). Ni se reduce, ni se recomprime, ni se le quitan
// los metadatos: lo que lleve dentro es decisión de quien lo manda.
//
// El tamaño lo resuelve el transporte (`@dotrino/proxy-client` ≥ 0.34.0), que lo parte y
// tiene un tope por camino. Aquí solo se traducen esos topes a bytes de archivo para
// decírselos a la persona ANTES de intentarlo.
//
// Y VIAJA COMO BYTES (`@dotrino/proxy-client` ≥ 0.35.0): `data` es un `Uint8Array`, y el
// pilar lo manda sin base64. Antes ocupaba 1,78 veces el archivo en el cable. El base64 solo
// queda para guardarlo en el almacén, que guarda JSON.
import { QUEUE_MAX_BYTES, RELAY_MAX_BYTES } from '@dotrino/proxy-client'

export const toBase64 = (bytes) => {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

/** Lo que se pinta dentro del chat: mapa de bits. Nada de SVG, que es un documento con scripts. */
export const INLINE_IMAGE = /^image\/(png|jpeg|gif|webp|avif|bmp)$/

// Lo que va alrededor del archivo en el mensaje (nombre, tipo, pie de foto), para comparar con
// los topes del pilar, que se miden sobre el mensaje entero.
const AROUND = 4096

/** El tope, en bytes de archivo, de cada camino. `null` = sin tope. */
export const LIMITS = {
  socket: null,
  direct: null,
  turn: null,
  webrtc: null,
  proxy: RELAY_MAX_BYTES - AROUND,
  offline: QUEUE_MAX_BYTES - AROUND
}

/** ¿Cabe un archivo de `bytes` por este camino? */
export const fitsRoute = (bytes, route) => LIMITS[route] == null || bytes <= LIMITS[route]

/** Un nombre que se puede enseñar y usar para guardar: sin rutas ni caracteres de control. */
export function cleanName (name) {
  const base = String(name || '').split(/[\\/]/).pop() || ''
  // eslint-disable-next-line no-control-regex
  const n = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200)
  return n || 'archivo'
}

export const humanSize = (bytes) => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1048576).toFixed(bytes < 10 * 1048576 ? 1 : 0)} MB`
}

/**
 * @param {File} file
 * @returns {Promise<{ name: string, mime: string, size: number, data: Uint8Array, w: number, h: number }>}
 */
export async function readFile (file) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const mime = file.type || 'application/octet-stream'
  // Las medidas solo sirven para reservar el hueco de una foto. Leerlas no cambia nada.
  let w = 0
  let h = 0
  if (INLINE_IMAGE.test(mime)) {
    try { const bmp = await createImageBitmap(file); w = bmp.width; h = bmp.height; bmp.close?.() } catch (_) { /* sin medidas */ }
  }
  return { name: cleanName(file.name), mime, size: bytes.length, data: bytes, w, h }
}

/** Lo que llega de otro lado. */
export function validIncomingFile (f) {
  if (!f || typeof f !== 'object') return null
  if (!(f.data instanceof Uint8Array) || f.data.length === 0) return null
  const mime = typeof f.mime === 'string' && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(f.mime) ? f.mime.toLowerCase() : 'application/octet-stream'
  return {
    name: cleanName(f.name),
    mime,
    size: f.data.length,
    data: f.data,
    w: Number(f.w) || 0,
    h: Number(f.h) || 0
  }
}

/**
 * Guardar un archivo recibido. Se descarga SIEMPRE como binario, nunca se abre aquí: un HTML
 * o un SVG abierto dentro de la app correría con sus permisos.
 */
export function downloadFile (dataUri, name) {
  const b64 = dataUri.slice(dataUri.indexOf(',') + 1)
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }))
  const a = document.createElement('a')
  a.href = url
  a.download = cleanName(name)
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30000)
}
