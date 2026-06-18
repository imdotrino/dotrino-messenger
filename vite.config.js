import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    // Los `dotrino-*` son Web Components (custom elements), no componentes
    // Vue: que el compilador no intente resolverlos como tal.
    vue({ template: { compilerOptions: { isCustomElement: (tag) => tag.startsWith('dotrino-') } } }),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico'],
      manifest: {
        name: 'Dotrino Messenger',
        short_name: 'CC Messenger',
        description: 'Mensajería P2P cifrada del ecosistema Dotrino',
        theme_color: '#2c3e50',
        background_color: '#1b2533',
        display: 'standalone',
        start_url: './',
        scope: './',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        globPatterns: [],
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        runtimeCaching: [],
        navigateFallback: null,
        // Inyecta los handlers de Web Push (push + notificationclick) en el SW
        // generado por Workbox, en vez de registrar un segundo SW que clobbearía
        // el scope. El archivo se sirve desde public/ (copialo desde el paquete
        // @dotrino/proxy-client/sw/).
        importScripts: ['dotrino-push-sw.js']
      }
    })
  ],
  base: './',
  server: {
    port: 5176,
    open: true
  }
})
