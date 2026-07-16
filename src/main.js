import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { registerSW } from 'virtual:pwa-register'
import './style.css'
import App from './App.vue'
// <dotrino-support> ya NO se importa aquí: lo trae <dotrino-topbar> (§5), que es
// el dueño de la moneda. Así la app no fija su versión.
import '@dotrino/install'
import '@dotrino/tutorial'
import { createBackNav } from '@dotrino/nav'

// Modo embed: cuando la PWA se carga como iframe desde la extensión
// (popup/overlay/offscreen), recibimos `?embed=popup` o similar y aplicamos
// estilos compactos vía la clase `cc-embed` en el <html>.
const embed = new URLSearchParams(location.search).get('embed')
if (embed) document.documentElement.classList.add('cc-embed')

// Navegación "volver" unificada del ecosistema (botón físico de Android / gesto
// de iOS / atrás del navegador / chevron del header → cierra modal o conversación,
// y si no hay nada → dotrino.com). No en iframe embebido: ahí no manejamos el
// history del padre.
if (!embed || window === window.top) createBackNav()

// Diagnóstico: imprime contexto al arrancar. Útil para entender si estamos
// en secure context, qué origen tenemos, quién es el top-level, etc.
try {
  let topOrigin = null
  let topAccessible = false
  try { topOrigin = window.top.location.origin; topAccessible = true }
  catch (_) { topOrigin = '(cross-origin, blocked)' }
  console.log('[cc-messenger] context', {
    origin: location.origin,
    href: location.href,
    embed: embed || null,
    isSecureContext: window.isSecureContext,
    inIframe: window !== window.top,
    topOrigin,
    topAccessible,
    parentOrigin: window.parent !== window ? '(cross-origin)' : location.origin,
    cryptoRandomUUID: typeof crypto?.randomUUID === 'function',
    cryptoSubtle: !!crypto?.subtle,
    userAgent: navigator.userAgent
  })
} catch (e) { console.warn('[cc-messenger] context log failed', e) }

// Polyfill de crypto.randomUUID: requiere "secure context", que NO se cumple
// cuando esta PWA va en un iframe dentro de una página padre HTTP (overlay
// de la extensión sobre sitios http://). En ese caso `crypto.randomUUID` es
// undefined y libs como `dotrino-store` (sync.js getDeviceId) revientan.
// Lo emulamos con `crypto.getRandomValues`, que sí está disponible siempre.
if (typeof crypto !== 'undefined' && typeof crypto.randomUUID !== 'function') {
  crypto.randomUUID = function () {
    const b = new Uint8Array(16)
    crypto.getRandomValues(b)
    b[6] = (b[6] & 0x0f) | 0x40
    b[8] = (b[8] & 0x3f) | 0x80
    const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('')
    return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`
  }
}

const app = createApp(App)
app.use(createPinia())
app.mount('#app')

registerSW({ immediate: true })

// Web Push: el SW (dotrino-push-sw.js, inyectado en el SW de Workbox vía
// workbox.importScripts) hace postMessage('cc-push-ring') al recibir el timbre.
// Si la app está abierta, re-identificamos para drenar la cola cifrada del proxy.
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (ev) => {
    if (ev.data && ev.data.type === 'cc-push-ring') {
      import('./stores/connectionStore.js')
        .then(m => m.useConnectionStore().identifyWithVault())
        .catch(() => {})
    }
  })
}

// Handshake con el embedder: cuando esta PWA se carga como iframe (popup,
// overlay, offscreen), avisamos al parent que arrancamos. El content script
// del overlay usa esto para distinguir "cargado correctamente" de "bloqueado
// por CSP" (en el segundo caso ningún script corre y el postMessage nunca
// llega → timeout en el padre).
if (embed && window !== window.top) {
  try {
    window.parent.postMessage({ source: 'cc-messenger', type: 'ready', embed }, '*')
  } catch (_) {}
}
