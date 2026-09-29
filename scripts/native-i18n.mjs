// Los textos de las versiones NATIVAS salen de los de la PWA (src/i18n.js), que va delante
// (CONVENCIONES §16.1): una sola fuente y ninguna traducción copiada a mano. Se aplanan a
// `seccion.clave` (`add.title`, `conv.compat.unknown`) y se escribe el mismo i18n.json para
// Android (assets) y para iOS (recurso del bundle).
//
//   node scripts/native-i18n.mjs
import { writeFileSync } from 'node:fs'
import { messages } from '../src/i18n.js'

export const TARGETS = ['../android/app/src/main/assets/i18n.json', '../ios/Messenger/i18n.json']

function flatten (o, prefix, out) {
  for (const [k, v] of Object.entries(o)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'string') out[key] = v
    else if (v && typeof v === 'object') flatten(v, key, out)
    else throw new Error(`i18n: ${key} is neither text nor a section`)
  }
  return out
}

export function build () {
  const out = {}
  for (const [lang, dict] of Object.entries(messages)) out[lang] = flatten(dict, '', {})
  const es = Object.keys(out.es).sort().join('|'), en = Object.keys(out.en).sort().join('|')
  if (es !== en) throw new Error('i18n: es and en do not have the same keys')
  return JSON.stringify(out, null, 1) + '\n'
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const text = build()
  for (const t of TARGETS) writeFileSync(new URL(t, import.meta.url), text)
  console.log(`i18n.json → ${TARGETS.join(', ')}`)
}
