// Pilares sin tipos: SOLO lo que usa el messenger, con la forma de su código. (Archivo de
// declaraciones globales, sin import/export arriba: si no, `declare module` sería un aumento.)

/** Versión de la app (package.json), la inyecta vite.config.js con `define`. */
declare const __APP_VERSION__: string

// @dotrino/compat 0.4.0 no publica tipos.
declare module '@dotrino/compat' {
  export interface Declaration { product: string, version: string, protocol: number, speaks: number[] }
  export interface BrokenEntry { product: string, versions: string | string[], why?: string, fix?: string }
  export interface Verdict {
    compatible: boolean
    code: 'ok' | 'incompatible-protocol' | 'broken-peer' | 'undeclared'
    peer: Declaration | null
    reason: string
  }
  export function declare (d: { product: string, version: string, protocol: number, speaks?: number[] }): Declaration
  export function check (o: { mine: Declaration, theirs: unknown, broken?: BrokenEntry[] }): Verdict
}

// @dotrino/identity 0.117.0: el subpath `./avatar` (vault/avatar.js) no publica tipos, y su
// index.d.ts tampoco declara estas dos, aunque index.js las reexporta.
declare module '@dotrino/identity/avatar' {
  /** El identicon determinista de una llave, como SVG. */
  export function avatarSvg (seed: string, opts?: { size?: number }): string
  /** El mismo identicon, como data URI listo para un `<img>`. */
  export function avatarDataUri (seed: string, opts?: { size?: number }): string
}
