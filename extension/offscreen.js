// Offscreen bridge: escucha postMessage del messenger PWA cargado en el
// iframe, y reenvía los eventos al service worker via chrome.runtime.

const PWA_ORIGIN = 'https://messenger.dotrino.com'

window.addEventListener('message', (event) => {
  if (event.origin !== PWA_ORIGIN) return
  const msg = event.data
  if (!msg || msg.source !== 'cc-messenger') return

  if (msg.type === 'dm-arrived' && msg.dm) {
    chrome.runtime.sendMessage({ kind: 'cc-dm-arrived', dm: msg.dm }).catch(() => {})
  }
})
