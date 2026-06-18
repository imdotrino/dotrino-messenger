// Identity bridge — host side.
//
// Se incluye en cualquier contexto de la extensión que aloja un iframe del
// messenger PWA: content scripts (overlay), popup, offscreen. Su trabajo es
// responder a mensajes `cc-id-bridge:*` desde el iframe leyendo/escribiendo
// `chrome.storage.local`.
//
// Storage shape (chrome.storage.local):
//   { 'cc-identity-blob-v1': <blob from id.exportIdentity()> }
//
// El offscreen es la fuente de verdad: vive en chrome-extension:// y por
// host_permissions tiene acceso unpartitioned a id.dotrino.com. Cuando hace
// `id.exportIdentity()` y `setBlob()`, todos los demás contextos
// (overlay particionado en seyanim.com / cualquier otro site) pueden hacer
// `getBlob()` al arrancar e `id.importIdentity(blob)` para empezar con la
// identidad real en lugar de generar una nueva en su partition aislado.

(function () {
  if (window.__cc_identity_bridge_host) return
  window.__cc_identity_bridge_host = true

  const STORAGE_KEY = 'cc-identity-blob-v1'
  // Solo registramos listeners si tenemos chrome.storage real. Hay copias del
  // bridge host que cargan en contextos sin storage (p.ej. content scripts en
  // iframes raros); si esas copias atendieran las requests, responderían
  // "chrome.storage unavailable" antes que la copia útil → todo el bridge
  // queda roto.
  if (!chrome?.storage?.local) {
    console.log('[cc-id-bridge:host] skipped (no chrome.storage)', { href: location.href })
    return
  }
  const LOG = (...a) => console.log('[cc-id-bridge:host]', ...a)
  LOG('loaded', {
    href: location.href,
    hasOnChanged: !!chrome?.storage?.onChanged
  })

  function reply (source, origin, id, payload) {
    try { source.postMessage({ source: 'cc-id-bridge', type: 'response', id, ...payload }, origin) }
    catch (_) {}
  }

  window.addEventListener('message', async (event) => {
    const msg = event.data
    if (!msg || msg.source !== 'cc-id-bridge' || msg.type !== 'request') return
    const { id, op, blob, key, value, item } = msg
    try {
      // Identity-blob ops (compat con la API original).
      if (op === 'get') {
        const r = await chrome.storage.local.get(STORAGE_KEY)
        reply(event.source, event.origin, id, { result: r?.[STORAGE_KEY] || null })
      } else if (op === 'set') {
        await chrome.storage.local.set({ [STORAGE_KEY]: blob })
        reply(event.source, event.origin, id, { result: true })
      } else if (op === 'clear') {
        await chrome.storage.local.remove(STORAGE_KEY)
        reply(event.source, event.origin, id, { result: true })
      // KV genérico — usado por el outbound queue y futuros mirrors. Las
      // claves deben prefijarse con `cc-` (sanity check).
      } else if (op === 'kv-get') {
        if (typeof key !== 'string' || !key.startsWith('cc-')) throw new Error('key must start with cc-')
        const r = await chrome.storage.local.get(key)
        reply(event.source, event.origin, id, { result: r?.[key] ?? null })
      } else if (op === 'kv-set') {
        if (typeof key !== 'string' || !key.startsWith('cc-')) throw new Error('key must start with cc-')
        await chrome.storage.local.set({ [key]: value })
        reply(event.source, event.origin, id, { result: true })
      } else if (op === 'kv-append-array') {
        if (typeof key !== 'string' || !key.startsWith('cc-')) throw new Error('key must start with cc-')
        const r = await chrome.storage.local.get(key)
        const arr = Array.isArray(r?.[key]) ? r[key] : []
        arr.push(item)
        await chrome.storage.local.set({ [key]: arr })
        reply(event.source, event.origin, id, { result: arr.length })
      } else {
        reply(event.source, event.origin, id, { error: `unknown op: ${op}` })
      }
    } catch (e) {
      LOG('error', e)
      reply(event.source, event.origin, id, { error: e?.message || String(e) })
    }
  })

  // Notifica cambios de storage SOLO a iframes del messenger. Antes
  // broadcasteábamos a `document.querySelectorAll('iframe')`, lo que metía
  // postMessages en iframes ajenos (p.ej. AWS Console) y rompía sus propios
  // protocolos de MessageChannel.
  if (chrome?.storage?.onChanged?.addListener) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return
      const messengerFrames = []
      for (const f of document.querySelectorAll('iframe')) {
        const src = f.src || ''
        if (src.startsWith('https://messenger.dotrino.com/')) messengerFrames.push(f)
      }
      if (messengerFrames.length === 0) return
      // Identity blob — formato legacy 'changed'.
      if (changes[STORAGE_KEY]) {
        for (const f of messengerFrames) {
          try { f.contentWindow?.postMessage(
            { source: 'cc-id-bridge', type: 'changed', blob: changes[STORAGE_KEY].newValue || null },
            'https://messenger.dotrino.com'
          ) } catch (_) {}
        }
      }
      // KV genérico — cualquier otra clave cc-*.
      for (const key in changes) {
        if (key === STORAGE_KEY || !key.startsWith('cc-')) continue
        for (const f of messengerFrames) {
          try { f.contentWindow?.postMessage(
            { source: 'cc-id-bridge', type: 'kv-changed', key, value: changes[key].newValue ?? null },
            'https://messenger.dotrino.com'
          ) } catch (_) {}
        }
      }
    })
  }
})()
