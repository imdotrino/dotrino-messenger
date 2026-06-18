<script setup>
import { onMounted, ref, computed, watch } from 'vue'
import { useConnectionStore } from './stores/connectionStore'
import { useContactsStore } from './stores/contactsStore'
import { useThreadsStore } from './stores/threadsStore'
import NicknameModal from './components/NicknameModal.vue'
import ContactList from './components/ContactList.vue'
import RequestsInbox from './components/RequestsInbox.vue'
import Conversation from './components/Conversation.vue'
import AddContactModal from './components/AddContactModal.vue'
import RatingModal from './components/RatingModal.vue'
import { startAppTutorial } from './lib/tutorial'
import IncomingNotification from './components/IncomingNotification.vue'
import '@dotrino/notifications'
import { getNotifications, notifSoundEnabled } from './services/notifications'
import { getIdentity } from './services/identity'
import { isDisplayed, markDisplayed } from './services/displayedMessages'
import { useBackLayer } from '@dotrino/nav/vue'

const booting = ref(true)

// El antiguo HelpTip ad-hoc (un solo coach-mark sobre el token) fue reemplazado
// por el tutorial guiado compartido (@dotrino/tutorial); su
// mensaje del token vive ahora en el paso 'token' de src/lib/tutorial.js.

const connection = useConnectionStore()
const contacts = useContactsStore()
const threads = useThreadsStore()
const showAdd = ref(false)
const showNotif = ref(false)
const ratingFor = ref(null)

// Panel de notificaciones = Web Component compartido <dotrino-notifications>.
const bindNotif = (el) => { if (el) el.controller = getNotifications() }

// Cantidad de solicitudes pendientes — para el badge de la campana.
const requestCount = computed(() => threads.requests.requests.length)

// Pitido corto (WebAudio, sin assets) al notificar, si el usuario lo dejó on.
const playBeep = () => {
  if (!notifSoundEnabled()) return
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    const o = ctx.createOscillator(); const g = ctx.createGain()
    o.type = 'sine'; o.frequency.value = 880
    o.connect(g); g.connect(ctx.destination)
    g.gain.setValueAtTime(0.0001, ctx.currentTime)
    g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.01)
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25)
    o.start(); o.stop(ctx.currentTime + 0.26)
    o.onended = () => { try { ctx.close() } catch (_) {} }
  } catch (_) { /* autoplay bloqueado hasta interacción: ignorar */ }
}

// Notificación centrada de DM entrante. Solo el primer contexto que vea un
// DM nuevo (chequeo atómico contra `cc-displayed-msgs-v1` en chrome.storage)
// lo muestra; los demás (otras pestañas con FAB, popup, offscreen) skip.
const incomingNotification = ref(null)
const onIncomingDone = (id) => {
  if (incomingNotification.value?.id === id) incomingNotification.value = null
}
watch(() => threads.lastIncomingDM, async (dm) => {
  if (!dm?.id) return
  const wasNew = await markDisplayed(dm.id)
  if (!wasNew) return  // otra pestaña ya lo mostró
  incomingNotification.value = dm
  playBeep()
})
// En mobile, si ya hay conversación restaurada del refresh, abrimos directo
// el panel de chat; si no, mostramos la lista de contactos.
const showSidebarMobile = ref(!threads.activePubkey)

onMounted(async () => {
  // Bootstrap: fuerza el getIdentity() inicial para que en modo iframe el
  // bridge intente hidratar el vault desde chrome.storage.local antes de
  // decidir si mostramos NicknameModal o CTA. Si la vault tiene me.nickname
  // (después de importar el blob), tomamos ese nick automáticamente.
  // Si estamos en overlay sobre página HTTP, ni siquiera tratamos de cargar
  // la vault: crypto.subtle no existe → falla seguro.
  if (!blockedByInsecureTop) {
    try {
      const id = await getIdentity()
      console.log('[cc-app] boot id.me=', id?.me, 'connection.nickname=', connection.nickname)
      if (id) {
        const vaultNick = id.me?.nickname
        const havePubkey = !!id.me?.publickey
        if (vaultNick && vaultNick !== connection.nickname) {
          // El vault es la fuente de verdad: si trae nickname y difiere del
          // local (incluido un placeholder pegado de sesiones previas), lo
          // aplicamos. En overlay no escribe al vault para no contaminar.
          console.log('[cc-app] boot: applying nickname from vault →', vaultNick)
          connection.setNickname(vaultNick, { writeToVault: !isReadOnlyEmbed })
        } else if (!vaultNick && connection.nicknameSet && !isReadOnlyEmbed) {
          console.log('[cc-app] boot: backfilling vault.me.nickname from localStorage →', connection.nickname)
          await id.setMyNickname(connection.nickname).catch(e => console.warn('backfill failed', e))
        } else if (!vaultNick && !connection.nicknameSet && havePubkey && isReadOnlyEmbed) {
          // Overlay con vault hidratado pero sin nickname — el blob fue
          // publicado por una versión vieja que no sincronizaba el nickname.
          // Aceptamos un placeholder derivado del pubkey para desbloquear la
          // UI; el usuario puede actualizar su nick en messenger.dotrino.com
          // directo y se propagará al overlay.
          let derived = 'Yo'
          try {
            const pk = JSON.parse(id.me.publickey)
            derived = (pk?.x || '').slice(0, 6).toUpperCase() || 'Yo'
          } catch (_) {}
          console.log('[cc-app] boot: overlay placeholder nickname →', derived)
          connection.setNickname(derived, { writeToVault: false })
        }
      }
    } catch (e) { console.warn('[cc-app] boot identity failed:', e) }
  }
  booting.value = false
  // Overlay no abre conexión propia ni hace announceToKnown — el offscreen
  // mantiene una sola conexión por usuario y procesa los sends de overlays
  // vía cc-outbound-v1. Popup/offscreen/direct tab sí conectan normalmente.
  if (connection.nicknameSet && !isReadOnlyEmbed) {
    await connection.connect()
    await contacts.refreshPeers()
    setTimeout(announceToKnown, 500)
  } else if (connection.nicknameSet && isReadOnlyEmbed) {
    // Mark connected (UI dot) — los sends salen por relay.
    await connection.connect()
    await contacts.refreshPeers()
  }
  maybeStartTutorial()
})

// Avisamos a todos los contactos por pubkey: si están conectados el proxy
// les entrega ya, si no queda en cola 24h. Su HELLO de respuesta marcará
// presencia (markOnline) y la UI deja de decir "offline".
const announceToKnown = async () => {
  for (const c of contacts.contacts) {
    threads.sendHelloByPubkey(c.publickey)
  }
}

const handleNicknameSet = async (nick) => {
  connection.setNickname(nick)
  await connection.connect()
  await contacts.refreshPeers()
  setTimeout(announceToKnown, 500)
  maybeStartTutorial()
}

const onSelectContact = (pubkey) => {
  threads.setActive(pubkey)
  showSidebarMobile.value = false
}

const backToList = () => { showSidebarMobile.value = true; threads.setActive(null) }
const openRating = (pubkey) => { ratingFor.value = pubkey }

// "Mi perfil": botón del header (a la izquierda de la moneda de soporte) que abre
// el MISMO Web Component compartido en modo self con mi identidad del vault.
const myProfilePk = ref(null)
const openMyProfile = async () => {
  try {
    const id = await getIdentity()
    const pk = id?.me?.publickey
    if (pk) myProfilePk.value = pk
  } catch (_) { /* sin identidad no abre */ }
}

// Volver unificado (@dotrino/nav): el botón físico de Android /
// gesto de iOS / atrás del navegador / chevron del header cierra el modal abierto
// o la conversación activa (vuelve a la lista) antes de salir hacia dotrino.com.
useBackLayer(showAdd)
useBackLayer(showNotif)
useBackLayer(ratingFor, { onClose: () => { ratingFor.value = null } })
useBackLayer(myProfilePk, { onClose: () => { myProfilePk.value = null } })
// La conversación abierta es una "vista": volver regresa a la lista de contactos.
const convoOpen = computed(() => !!threads.activePubkey)
useBackLayer(convoOpen, { onClose: backToList })

// Modo overlay: storage particionado, no podemos crear identidad útil aquí.
// Si no llega blob por el bridge, mostramos un CTA al messenger directo en vez
// del NicknameModal. El usuario crea/usa su cuenta en messenger.dotrino.com
// (top-level real, unpartitioned) y la extensión propaga el blob al overlay.
const embed = new URLSearchParams(location.search).get('embed')
const isReadOnlyEmbed = embed === 'overlay'
// Si la página padre es HTTP, el iframe HTTPS queda non-secure-context y
// `crypto.subtle` no existe — la vault no puede arrancar, así que ni siquiera
// intentamos. CTA inmediato.
const blockedByInsecureTop = isReadOnlyEmbed && !window.isSecureContext
const openMessengerTab = () => {
  try { window.open('https://messenger.dotrino.com/', '_blank', 'noopener') }
  catch (_) { location.href = 'https://messenger.dotrino.com/' }
}

// Tutorial guiado (una sola vez por dispositivo). Solo en la app real: con apodo,
// fuera del overlay/iframe, y en visita "limpia" (sin enlace entrante).
const maybeStartTutorial = () => {
  if (isReadOnlyEmbed || blockedByInsecureTop) return
  if (typeof window !== 'undefined' && window.self !== window.top) return
  if ((location.hash || '').replace(/^#/, '')) return
  if (!connection.nicknameSet) return
  startAppTutorial({
    lang: () => 'es',
    openAdd: (b) => { showAdd.value = b },
    setSidebarMobile: (b) => { showSidebarMobile.value = b },
    hasContact: () => contacts.contacts.length > 0,
    openConvo: () => { const c = contacts.contacts[0]; if (c) onSelectContact(c.publickey) },
  })
}
</script>

<template>
  <!-- Boot: esperamos al getIdentity() inicial antes de decidir qué pintar. -->
  <div v-if="booting" class="login-cta"><div class="login-card"><p>Cargando…</p></div></div>

  <!-- Overlay sin identidad: no permitimos crear cuenta aquí (storage
       particionado por el site visitado). En su lugar, CTA al messenger real. -->
  <div v-else-if="!connection.nicknameSet && isReadOnlyEmbed" class="login-cta">
    <div class="login-card">
      <img class="login-logo" src="/icons/icon-192.png" alt="Dotrino" />
      <h2>Inicia sesión</h2>
      <p v-if="blockedByInsecureTop">
        Esta página usa HTTP. El navegador desactiva las APIs criptográficas en iframes embebidos en sitios no seguros, así que el messenger no puede correr aquí. Ábrelo en su pestaña directa.
      </p>
      <p v-else>
        Crea o entra a tu cuenta en messenger.dotrino.com. Tu identidad se sincroniza con la extensión automáticamente.
      </p>
      <button class="btn primary-cta" @click="openMessengerTab">Login</button>
    </div>
  </div>

  <NicknameModal v-else-if="!connection.nicknameSet" @set="handleNicknameSet" />

  <div v-else class="app">
    <header class="topbar">
      <dotrino-back class="cc-back" lang="es"></dotrino-back>
      <div class="brand">
        <img class="logo" src="/icons/icon-192.png" alt="Dotrino" />
        <span class="brand-name">Dotrino</span>
      </div>
      <div class="status">
        <dotrino-install class="cc-install" lang="es"></dotrino-install>
        <div class="me">
          <span :class="['dot', connection.isConnected ? 'on' : 'off']"></span>
          <span class="who">@{{ connection.nickname }}</span>
          <code class="tok" v-if="connection.token" data-testid="my-token">{{ connection.token }}</code>
        </div>
        <button class="bell-btn" @click="showNotif = true" title="Notificaciones y solicitudes">
          🔔
          <span v-if="requestCount" class="bell-badge">{{ requestCount }}</span>
        </button>
        <button class="profile-btn" data-testid="my-profile" @click="openMyProfile" title="Mi perfil" aria-label="Mi perfil">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="8" r="4" /><path d="M4 20c0-4 3.6-6 8-6s8 2 8 6" />
          </svg>
        </button>
        <dotrino-support
          class="topbar-coin"
          href="https://ko-fi.com/dotrino"
          repo="dotrino/dotrino-messenger"
          discord="https://discord.gg/D648uq7cth"
        ></dotrino-support>
      </div>
    </header>

    <main class="layout" :class="{ 'show-side': showSidebarMobile }">
      <aside class="sidebar">
        <div class="side-head">
          <h3>Contactos</h3>
          <button class="add-btn" @click="showAdd = true" title="Añadir contacto" data-testid="add-contact">+</button>
        </div>
        <RequestsInbox />
        <ContactList @select="onSelectContact" @rate="openRating" />
      </aside>

      <section class="main-pane">
        <Conversation
          v-if="threads.activePubkey"
          @back="backToList"
          @rate="openRating"
        />
        <div v-else class="empty">
          <div class="empty-card">
            <div class="empty-mark">CC</div>
            <h4>Selecciona un contacto</h4>
            <p>Para empezar una conversación, elige a alguien de la lista,
               o pulsa <strong>+</strong> para añadir un nuevo contacto por token.</p>
          </div>
        </div>
      </section>
    </main>

    <AddContactModal v-if="showAdd" @close="showAdd = false" />
    <RatingModal v-if="ratingFor" :pubkey="ratingFor" @close="ratingFor = null" />
    <RatingModal v-if="myProfilePk" :pubkey="myProfilePk" self @close="myProfilePk = null" />
    <dotrino-notifications v-if="showNotif" :ref="bindNotif" modal @cc-notif-close="showNotif = false"></dotrino-notifications>

    <IncomingNotification :dm="incomingNotification" @done="onIncomingDone" />
  </div>
</template>

<style scoped>
.app {
  display: flex; flex-direction: column;
  height: 100vh;
  height: 100svh;
  height: 100dvh;
  min-height: 0;
  overflow: hidden;
}

.login-cta {
  display: flex; align-items: center; justify-content: center;
  height: 100%;
  padding: 24px;
  background: var(--bg-1);
}
.login-card {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 28px 24px;
  text-align: center;
  max-width: 340px;
}
.login-logo { width: 56px; height: 56px; margin-bottom: 14px; }
.login-card h2 { margin: 0 0 8px; font-family: var(--font-headline); font-size: 20px; }
.login-card p { margin: 0 0 18px; color: var(--muted); font-size: 14px; line-height: 1.5; }
.login-card .btn { width: 100%; }

.topbar {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 20px;
  background: var(--bg-2);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
/* Chevron de volver (Web Component @dotrino/nav). */
.cc-back { color: var(--text, currentColor); --cc-back-size: 38px; margin-left: -6px; }
.brand { display: flex; align-items: center; gap: 12px; }
.status { margin-left: auto; }
.logo {
  width: 36px; height: 36px;
  object-fit: contain;
  display: block;
}
.brand-name {
  font-family: var(--font-headline);
  font-weight: 600;
  font-size: 17px;
  color: var(--text);
}

.status { display: flex; gap: 12px; align-items: center; }

.me {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px;
  background: var(--bg-3);
  border-radius: 999px;
  font-size: 13px;
}
.dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.dot.on  { background: var(--online); box-shadow: 0 0 0 2px rgba(90, 138, 58, 0.18); }
.dot.off { background: var(--accent); opacity: 0.6; }
.who { color: var(--text); font-weight: 500; }
.tok {
  background: var(--bg-1);
  padding: 2px 8px;
  border-radius: 6px;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--muted);
  border: 1px solid var(--border);
}

/* Botón "Instalar App" unificado (Web Component @dotrino/install).
   Reusa el estilo del antiguo .install-btn: ghost con borde y acento de messenger. */
.cc-install {
  --cc-install-color: var(--accent);
  --cc-install-accent: var(--accent);
  --cc-install-bg-hover: rgba(192, 57, 43, 0.08);
  --cc-install-radius: 8px;
  --cc-install-font-size: 13px;
}
.cc-install::part(button) {
  background: transparent;
  border: 1px solid var(--accent);
  padding: 6px 12px;
  font-weight: 500;
  transition: background 150ms ease-out;
}

/* "Mi perfil": botón circular ghost a la izquierda de la moneda de soporte. */
.profile-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 36px; height: 36px; padding: 0; flex-shrink: 0;
  border-radius: 50%; background: var(--bg-4); color: var(--text);
  border: 1px solid var(--border); cursor: pointer;
  transition: transform 150ms ease-out, border-color 150ms ease-out;
}
.profile-btn svg { width: 19px; height: 19px; display: block; }
.profile-btn:hover { border-color: var(--accent); transform: translateY(-1px); }

.topbar-coin { display: inline-flex; align-items: center; }

.bell-btn {
  position: relative;
  width: 36px; height: 36px;
  border-radius: 50%;
  background: var(--bg-4); color: var(--text);
  border: 1px solid var(--border);
  cursor: pointer; font-size: 16px;
  display: inline-flex; align-items: center; justify-content: center;
  transition: transform 150ms ease-out, border-color 150ms ease-out;
}
.bell-btn:hover { border-color: var(--accent); transform: translateY(-1px); }
.bell-badge {
  position: absolute; top: -4px; right: -4px;
  min-width: 18px; height: 18px; padding: 0 5px;
  border-radius: 999px; background: var(--accent, #2dd4bf); color: #04221d;
  font-size: 11px; font-weight: 700; line-height: 18px;
}

.layout { flex: 1; display: flex; min-height: 0; }
.sidebar {
  width: 320px;
  max-width: 35%;
  background: var(--bg-2);
  border-right: 1px solid var(--border);
  display: flex; flex-direction: column;
}
.side-head {
  display: flex; justify-content: space-between; align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
}
.side-head h3 {
  margin: 0;
  font-family: var(--font-headline);
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
}
.add-btn {
  background: var(--accent); color: var(--on-accent);
  border: 0;
  width: 32px; height: 32px;
  border-radius: 50%;
  font-size: 18px;
  font-weight: 700;
  cursor: pointer;
  transition: background 150ms ease-out, transform 100ms ease-out;
  box-shadow: 0 1px 3px rgba(192, 57, 43, 0.25);
}
.add-btn:hover { background: var(--accent-2); }
.add-btn:active { transform: translateY(1px); }

.main-pane {
  flex: 1;
  display: flex; flex-direction: column;
  min-width: 0;
  background: var(--bg-1);
}
.empty {
  flex: 1;
  display: flex; align-items: center; justify-content: center;
  padding: 32px;
}
.empty-card {
  text-align: center;
  max-width: 380px;
  padding: 32px;
  background: var(--bg-2);
  border-radius: 12px;
  border: 1px solid var(--border);
}
.empty-mark {
  width: 56px; height: 56px;
  margin: 0 auto 16px;
  background: var(--accent); color: var(--on-accent);
  border-radius: 14px;
  display: flex; align-items: center; justify-content: center;
  font-family: var(--font-headline); font-weight: 700; font-size: 18px;
}
.empty-card h4 {
  margin: 0 0 8px;
  font-family: var(--font-headline);
  font-size: 18px;
  font-weight: 600;
}
.empty-card p {
  margin: 0;
  color: var(--muted);
  font-size: 14px;
  line-height: 1.5;
}

@media (max-width: 700px) {
  .sidebar { max-width: 100%; width: 100%; }
  .layout { position: relative; }
  .layout .sidebar  { display: none; }
  .layout .main-pane { display: flex; }
  .layout.show-side .sidebar  { display: flex; }
  .layout.show-side .main-pane { display: none; }
  .topbar { padding: 10px 14px; }
  .brand-name { display: none; }
  .me { padding: 4px 8px; gap: 6px; font-size: 12px; }
  .me .tok { font-size: 11px; padding: 2px 6px; }
}
</style>
