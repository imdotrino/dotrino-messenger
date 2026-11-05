// Formas de datos del messenger. Solo tipos: no hay código que importar.

import type { SignedRating } from '@dotrino/identity'

/** Descripción de un archivo de un mensaje (los bytes van aparte, en `file:<contacto>`). */
export interface FileMeta {
  name: string
  mime: string
  size: number
  w: number
  h: number
}

/** Un archivo con sus bytes, listo para mandar o recién llegado. */
export interface ChatFile extends FileMeta {
  data: Uint8Array
}

/** Por qué un mensaje todavía no salió: el contacto conectado, canal directo o que se actualice. */
export type Waits = 'online' | 'direct' | 'version'

/** Una entrada del hilo de un contacto (en memoria, en el espejo local y en el almacén). */
export interface ThreadEntry {
  id: string
  dir: 'in' | 'out'
  text: string
  ts: number
  /** enviado, sin acuse todavía */
  pending?: boolean
  file?: FileMeta
  waits?: Waits | null
  /** llegó por la cola offline del proxio */
  queued?: boolean
  queuedAt?: number | null
  _read?: boolean
}

/** Hilos por pubkey del contacto. */
export type Threads = Record<string, ThreadEntry[]>

/** Un DM que todavía no salió (o que espera su acuse). */
export interface OutboxItem {
  pubkey: string
  entryId: string
  text: string
  ts: number
  file?: ChatFile
}

/** El aviso centrado de un mensaje o una solicitud que acaba de llegar. */
export interface IncomingNotice {
  id: string
  fromPubkey: string
  fromNickname: string
  text: string
  ts: number
  /** nombre del archivo, si el mensaje traía uno */
  file?: string | null
  request?: boolean
}

/** Un registro de la libreta (`@dotrino/profile/friends` la devuelve sin tipar): lo que lee el messenger. */
export interface Peer {
  publickey: string
  nickname?: string
  encryptionPubkey?: string
  isContact?: boolean
  lastSeen?: number
  lastToken?: string
  myRating?: { rating: number, notes?: string } | null
  endorsements?: SignedRating[]
  [k: string]: unknown
}

/** Lo que dice la reputación de alguien (computeDerivedRating). */
export interface DerivedRating {
  value: number | null
  source: 'mine' | 'derived' | null
  count: number
}

// --- Lo que llega por el cable, SIN validar: cada manejador comprueba lo que usa. ---

export interface HelloPayload { type: 'HELLO', nickname?: unknown, v?: unknown, card?: unknown }
export interface DmPayload { type: 'DM', text?: unknown, ts?: unknown, mid?: unknown, file?: unknown }
export interface DmAckPayload { type: 'DM_ACK', id?: unknown }
export interface RatingQueryPayload { type: 'RATING_QUERY', queryId?: unknown, subject?: unknown }
export interface RatingReplyPayload { type: 'RATING_REPLY', queryId?: unknown, subject?: unknown, mine?: SignedRating | null, endorsements?: unknown }
export type WirePayload = HelloPayload | DmPayload | DmAckPayload | RatingQueryPayload | RatingReplyPayload

/** Lo que el pilar del transporte dice de un mensaje entrante. */
export interface IncomingMeta {
  sealed?: boolean
  queued?: boolean
  queuedAt?: number | null
  [k: string]: unknown
}

/** Estado del almacén, para enseñarlo. */
export interface StoreStatus {
  open: boolean
  error: { code: string, message: string } | null
  vault: { state: string, [k: string]: unknown }
}
