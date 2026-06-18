// Content script — la salsa secreta de la extensión.
// Inyecta un Shadow DOM en cualquier página con:
//  • toast efímero al recibir un DM (fade in/out, mouse pass-through)
//  • panel deslizable que es un iframe al messenger PWA (toda la lógica vive ahí)
//  • FAB flotante para abrir el panel a demanda
//
// Antes de mostrar el FAB hacemos un handshake con el PWA: precargamos el
// iframe oculto y esperamos un postMessage `{source:'cc-messenger', type:'ready'}`.
// Si el postMessage llega → CSP del site permite el iframe → mostramos UI.
// Si no llega antes del timeout (CSP estricta tipo whatsapp/gmail bloquea
// el iframe por completo) → no inyectamos nada visible. Toasts vienen del
// service worker así que pueden funcionar igual si el SW se las apaña por su
// cuenta; aquí preferimos no mostrarlos tampoco para evitar UX rota.

(function () {
  if (window.__cc_messenger_injected) return
  window.__cc_messenger_injected = true
  if (location.protocol === 'chrome-extension:' || location.protocol === 'chrome:') return
  if (location.host === 'messenger.dotrino.com') return

  const PWA_URL = 'https://messenger.dotrino.com/?embed=overlay'
  const READY_TIMEOUT_MS = 6000

  // Iframe oculto fuera de la pantalla — Chrome ejecuta su JS igual.
  const probe = document.createElement('iframe')
  probe.src = PWA_URL
  probe.style.cssText = 'position:fixed;width:1px;height:1px;left:-9999px;top:-9999px;visibility:hidden;border:0'
  let pwaReady = false
  let probeOrigin = null
  try { probeOrigin = new URL(PWA_URL).origin } catch (_) {}

  const onReady = (ev) => {
    if (ev.source !== probe.contentWindow) return
    if (probeOrigin && ev.origin !== probeOrigin) return
    const data = ev.data
    if (!data || data.source !== 'cc-messenger' || data.type !== 'ready') return
    if (pwaReady) return
    pwaReady = true
    window.removeEventListener('message', onReady)
    mountUI()
  }
  window.addEventListener('message', onReady)

  function attachProbe () {
    if (!document.documentElement) { setTimeout(attachProbe, 50); return }
    document.documentElement.appendChild(probe)
  }
  attachProbe()

  setTimeout(() => {
    if (pwaReady) return
    window.removeEventListener('message', onReady)
    try { probe.remove() } catch (_) {}
    console.warn('[cc-overlay] PWA did not signal ready in', READY_TIMEOUT_MS, 'ms — likely blocked by site CSP. Skipping FAB.')
  }, READY_TIMEOUT_MS)

  function mountUI () {
    const host = document.createElement('div')
    host.id = 'cc-messenger-host'
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;'
    const shadow = host.attachShadow({ mode: 'closed' })

    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = chrome.runtime.getURL('overlay.css')
    shadow.appendChild(link)

    const root = document.createElement('div')
    root.className = 'cc-root'
    shadow.appendChild(root)

    // ----- notificación centrada de DM entrante -----
    // Vive en el Shadow DOM del content script (mismo viewport que la página
    // padre) → `position:fixed` centra realmente en la ventana del navegador,
    // no en el iframe del messenger (que es solo el panel pequeño).
    function showCenteredCard (dm) {
      const overlay = document.createElement('div')
      overlay.className = 'cc-incoming-overlay phase-hidden'
      const card = document.createElement('div')
      card.className = 'cc-incoming-card'
      const from = document.createElement('div')
      from.className = 'cc-incoming-from'
      from.textContent = dm.fromNickname || 'Mensaje nuevo'
      const text = document.createElement('div')
      text.className = 'cc-incoming-text'
      text.textContent = dm.text || ''
      card.appendChild(from)
      card.appendChild(text)
      overlay.appendChild(card)
      root.appendChild(overlay)
      // fade-in 1s → visible 5s → fade-out 1s → remove
      requestAnimationFrame(() => {
        overlay.classList.remove('phase-hidden')
        overlay.classList.add('phase-shown')
      })
      setTimeout(() => {
        overlay.classList.remove('phase-shown')
        overlay.classList.add('phase-out')
      }, 1000 + 5000)
      setTimeout(() => { try { overlay.remove() } catch (_) {} }, 1000 + 5000 + 1000 + 50)
    }

    // ----- floating action button -----
    const fab = document.createElement('button')
    fab.className = 'cc-fab'
    fab.title = 'Dotrino Messenger'
    const fabIcon = document.createElement('img')
    fabIcon.src = chrome.runtime.getURL('icons/icon-192.png')
    fabIcon.alt = ''
    fabIcon.className = 'cc-fab-icon'
    fab.appendChild(fabIcon)
    fab.addEventListener('click', () => togglePanel())
    root.appendChild(fab)

    // ----- panel = iframe al PWA -----
    // Reutilizamos el iframe que ya cargó (probe). Lo movemos del lugar
    // oculto al panel sin recrearlo: así conserva todo el estado (sesión,
    // WebSocket, etc.) y abrir el panel es instantáneo.
    const panel = document.createElement('div')
    panel.className = 'cc-panel'
    const closeBtn = document.createElement('button')
    closeBtn.className = 'cc-close'
    closeBtn.title = 'Cerrar'
    closeBtn.textContent = '×'
    closeBtn.addEventListener('click', () => panel.classList.remove('open'))
    probe.style.cssText = ''
    probe.className = 'cc-frame'
    probe.title = 'Messenger'
    panel.appendChild(closeBtn)
    panel.appendChild(probe)
    root.appendChild(panel)

    function togglePanel () {
      if (panel.classList.contains('open')) panel.classList.remove('open')
      else openPanel()
    }
    function openPanel () { panel.classList.add('open') }

    // ----- runtime events del SW -----
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg) return
      if (msg.kind === 'incoming_dm' && msg.dm) showCenteredCard(msg.dm)
    })

    if (!document.body) {
      // raro, pero por si acaso esperamos un tick
      const obs = new MutationObserver(() => {
        if (document.body) { obs.disconnect(); document.body.appendChild(host) }
      })
      obs.observe(document.documentElement, { childList: true })
    } else {
      document.body.appendChild(host)
    }
  }
})()
