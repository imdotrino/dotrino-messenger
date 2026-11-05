/**
 * Lo que llega a un `catch` es `unknown`: puede ser un Error con `code` (los pilares lo
 * ponen), un string o cualquier cosa. Esto lo deja leer como `e?.code` / `e?.message`, sin
 * inventar nada: lo que no es un objeto no tiene ni `code` ni `message`.
 * @param {unknown} e
 * @returns {{ code?: string, message?: string }}
 */
export const asError = (e) => (e && typeof e === 'object' ? /** @type {{ code?: string, message?: string }} */ (e) : {})
