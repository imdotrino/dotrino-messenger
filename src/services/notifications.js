// Notificaciones del messenger sobre el paquete compartido del ecosistema
// (@dotrino/notifications). Reemplaza los stores caseros
// notifPrefsStore (preferencias) y notificationsStore (Web Push): ahora ambos
// viven en el paquete común, con scope 'messenger'.
import { createNotifications, createVaultPushProvider } from '@dotrino/notifications'
import { getWebSocketProxyClient } from '@dotrino/proxy-client'
import { getIdentity } from './identity'

// Mismas categorías que el messenger ya ofrecía (bilingüe; antes solo ES).
const CATEGORIES = [
  { key: 'contactMessages', label: { es: 'Mensajes de contactos', en: 'Contact messages' }, hint: { es: 'Avisar cuando un contacto te escribe.', en: 'Alert when a contact messages you.' } },
  { key: 'vouchedRequests', label: { es: 'Solicitudes avaladas', en: 'Vouched requests' }, hint: { es: 'Desconocidos avalados por tu red de confianza.', en: 'Strangers vouched by your trust network.' } },
  { key: 'strangerRequests', label: { es: 'Solicitudes de desconocidos', en: 'Stranger requests' }, hint: { es: 'Sin aval de tu red. Apágalo si recibes spam.', en: 'No vouch from your network. Turn it off if you get spam.' } },
  { key: 'helloRequests', label: { es: 'Cuando alguien te agrega', en: 'When someone adds you' }, hint: { es: 'Avisar al recibir un saludo, aunque no haya mensaje aún.', en: 'Alert on a new hello, even without a message yet.' } },
]

// Migra las claves legacy del messenger a las del paquete (mismos nombres de
// categorías, así que basta copiar el JSON). One-time, idempotente.
function migrateLegacy () {
  try {
    if (localStorage.getItem('cc-notif:messenger') == null) {
      const old = localStorage.getItem('cc-notif-prefs-v1')
      if (old) localStorage.setItem('cc-notif:messenger', old)
    }
    if (localStorage.getItem('cc-push:messenger') == null && localStorage.getItem('messenger_push_enabled') === '1') {
      localStorage.setItem('cc-push:messenger', '1')
    }
  } catch (_) {}
}

let _ctrl = null
export function getNotifications () {
  if (_ctrl) return _ctrl
  migrateLegacy()
  _ctrl = createNotifications({
    storageKey: 'messenger',
    categories: CATEGORIES,
    sound: true,
    push: createVaultPushProvider({
      proxyClient: () => getWebSocketProxyClient(),
      identity: () => getIdentity(),
      storageKey: 'messenger',
    }),
  })
  return _ctrl
}

// Mapea el evento entrante del messenger (kind + vouched) a las categorías.
// kind: 'message' | 'request' | 'hello'.
export function shouldNotifyKind (kind, vouched = false) {
  const c = getNotifications()
  if (kind === 'message') return c.shouldNotify('contactMessages')
  if (kind === 'hello') return c.shouldNotify('helloRequests') && c.shouldNotify(vouched ? 'vouchedRequests' : 'strangerRequests')
  if (kind === 'request') return c.shouldNotify(vouched ? 'vouchedRequests' : 'strangerRequests')
  return true
}

export function notifSoundEnabled () { return getNotifications().soundEnabled }

// Re-registra la push subscription tras identify (endpoints rotan). Silencioso.
export function ensurePushSubscribed () {
  const p = getNotifications().push
  return p ? p.ensureSubscribed() : Promise.resolve()
}
