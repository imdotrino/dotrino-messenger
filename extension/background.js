// Service worker thin: solo orquesta el offscreen y reenvía eventos.
//
// El cerebro de la extensión es el messenger PWA cargado dentro del
// offscreen document como iframe (modo `?embed=offscreen`). El PWA hace
// identify, recibe DMs, los descifra y los persiste contra
// id.dotrino.com + store.dotrino.com. Cuando llega un DM, el PWA emite
// un postMessage al parent (=offscreen) que reenvía aquí.

const OFFSCREEN_URL = 'offscreen.html'

async function ensureOffscreen () {
  try {
    const url = chrome.runtime.getURL(OFFSCREEN_URL)
    if (chrome.runtime.getContexts) {
      const existing = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [url]
      })
      if (existing.length > 0) return
    }
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['IFRAME_SCRIPTING'],
      justification: 'Hosts messenger PWA iframe so it can keep a WebSocket connection to the proxy and receive/decrypt incoming DMs even when no browser tab is visible.'
    })
  } catch (e) {
    if (!/single offscreen/i.test(e.message)) console.warn('offscreen failed:', e)
  }
}

function notifyDM (dm) {
  if (!dm) return
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon-192.png',
    title: dm.fromNickname || 'Dotrino Messenger',
    message: (dm.text || '').slice(0, 200),
    priority: 1
  }).catch(() => {})
}

async function broadcast (msg) {
  // Push to all tabs (overlay) + popup if open.
  try {
    const tabs = await chrome.tabs.query({})
    for (const t of tabs) {
      if (!t.id) continue
      chrome.tabs.sendMessage(t.id, msg).catch(() => {})
    }
  } catch (_) {}
  chrome.runtime.sendMessage(msg).catch(() => {})
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false

  if (msg.kind === 'cc-dm-arrived' && msg.dm) {
    // From offscreen (PWA). Fan out to overlays + native notification.
    notifyDM(msg.dm)
    broadcast({ kind: 'incoming_dm', dm: msg.dm })
    return false
  }

  if (msg.kind === 'kick_offscreen') {
    ensureOffscreen()
    sendResponse({ ok: true })
    return false
  }

  return false
})

// Periodic heartbeat — keeps the SW alive enough to relay incoming events
// after the browser idles. The offscreen page stays loaded as long as the
// chrome.offscreen API was used to create it.
chrome.alarms.create('cc_keepalive', { periodInMinutes: 1 })
chrome.alarms.onAlarm.addListener(() => {
  ensureOffscreen()
})

// Bootstrap on install/start
ensureOffscreen().catch(e => console.warn('initial offscreen:', e))
