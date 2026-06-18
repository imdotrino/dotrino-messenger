import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { getWebSocketProxyClient } from '@dotrino/proxy-client'
import { getIdentity } from '../services/identity'

const LS_KEY = 'messenger_push_enabled'

// Web Push: el usuario opta por recibir un "timbre" cuando le llegan mensajes
// estando la app cerrada/offline. El SW de la PWA (Workbox + importScripts del
// handler de push) muestra la notificación; al abrir, identify() drena la cola
// cifrada del proxy. La subscription se liga a la MISMA pubkey del vault que
// usa identify, con un sobre firmado por el vault.
export const useNotificationsStore = defineStore('notifications', () => {
  const wsProxyClient = getWebSocketProxyClient()

  const supported = computed(() =>
    typeof navigator !== 'undefined' && 'serviceWorker' in navigator &&
    typeof window !== 'undefined' && 'PushManager' in window && 'Notification' in window
  )

  const enabled = ref(localStorage.getItem(LS_KEY) === '1')
  const permission = ref(typeof Notification !== 'undefined' ? Notification.permission : 'default')
  const busy = ref(false)
  const error = ref('')

  async function _vaultPubkeyAndSign () {
    const id = await getIdentity()
    const publicKey = id?.me?.publickey
    if (!id || !publicKey) throw new Error('Vault de identidad no disponible')
    return { publicKey, sign: (d) => id.signData(d) }
  }

  async function enable () {
    error.value = ''
    if (!supported.value) { error.value = 'Tu navegador no soporta notificaciones push'; return false }
    busy.value = true
    try {
      const perm = await Notification.requestPermission()
      permission.value = perm
      if (perm !== 'granted') { error.value = 'Permiso de notificaciones denegado'; return false }
      const { publicKey, sign } = await _vaultPubkeyAndSign()
      // Sin swPath: reutiliza el SW de la PWA (los handlers de push se
      // inyectaron vía workbox.importScripts).
      await wsProxyClient.enablePush({ publicKey, sign })
      enabled.value = true
      localStorage.setItem(LS_KEY, '1')
      return true
    } catch (e) {
      error.value = e?.message || String(e)
      return false
    } finally {
      busy.value = false
    }
  }

  async function disable () {
    error.value = ''
    busy.value = true
    try {
      let publicKey, sign
      try { ({ publicKey, sign } = await _vaultPubkeyAndSign()) } catch (_) { /* igual cancelamos local */ }
      await wsProxyClient.disablePush({ publicKey, sign })
      enabled.value = false
      localStorage.removeItem(LS_KEY)
      return true
    } catch (e) {
      error.value = e?.message || String(e)
      return false
    } finally {
      busy.value = false
    }
  }

  // Re-registra la subscription tras cada identify (los endpoints pueden rotar).
  // Silencioso: si el usuario no optó o el permiso no está, no hace nada.
  async function ensureSubscribed () {
    if (!enabled.value || !supported.value) return
    if (typeof Notification !== 'undefined') permission.value = Notification.permission
    if (permission.value !== 'granted') return
    try {
      const { publicKey, sign } = await _vaultPubkeyAndSign()
      await wsProxyClient.enablePush({ publicKey, sign })
    } catch (e) {
      console.warn('[push] ensureSubscribed falló:', e?.message || e)
    }
  }

  return { supported, enabled, permission, busy, error, enable, disable, ensureSubscribed }
})
