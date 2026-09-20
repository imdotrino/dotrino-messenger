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
import { resolveAccount } from './services/account'

// Navegación "volver" unificada del ecosistema (botón físico de Android / gesto
// de iOS / atrás del navegador / chevron del header → cierra modal o conversación,
// y si no hay nada → dotrino.com).
createBackNav()

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

// DE QUÉ CUENTA ES ESTO, ANTES DE PINTAR NADA. Los stores leen su estado local al
// construirse, y ese estado cuelga de la cuenta activa (services/account.js). Si se
// montara primero, cada store abriría el cajón equivocado —el de la cuenta anterior—
// y después ya no hay forma de deshacerlo sin recargar.
resolveAccount()
  .catch((e) => { console.warn('[cc-messenger] could not resolve the active account:', e?.message || e) })
  .finally(() => {
    const app = createApp(App)
    app.use(createPinia())
    app.mount('#app')
  })

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
