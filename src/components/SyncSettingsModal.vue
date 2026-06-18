<script setup>
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { getIdentity } from '../services/identity'
import { getStore } from '../services/store'
import { useNotificationsStore } from '../stores/notificationsStore'
import { useConnectionStore } from '../stores/connectionStore'

const emit = defineEmits(['close'])

const notif = useNotificationsStore()
async function toggleNotifications () {
  if (notif.enabled) await notif.disable()
  else await notif.enable()
}

// Selector de proxio (home). Los proxios están federados → cambiar de nodo no
// te aísla: seguís alcanzando contactos en otros proxios.
const conn = useConnectionStore()
const customProxy = ref('')
async function pickProxy (url) { await conn.setProxyUrl(url) }
async function addCustomProxy () {
  const u = customProxy.value.trim()
  if (!u) return
  await conn.setProxyUrl(u.startsWith('ws') ? u : 'wss://' + u)
  customProxy.value = ''
}
const shortProxy = (u) => u.replace(/^wss?:\/\//, '')

const CLIENT_ID = import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_ID || ''

const passphrase = ref('')
const passphrase2 = ref('')
const showPassphrase = ref(false)
const busy = ref(false)
const error = ref('')
const idStatus = ref({ connected: false, unlocked: false, dirty: false })
const stStatus = ref({ connected: false, unlocked: false, dirty: false })
const lastEvent = ref(null)

let unsubId = null
let unsubSt = null

async function refresh () {
  const id = await getIdentity()
  const st = await getStore()
  if (id) idStatus.value = await id.syncStatus()
  if (st) stStatus.value = await st.syncStatus()
}

onMounted(async () => {
  const id = await getIdentity()
  const st = await getStore()
  if (id) unsubId = id.onSync((ev) => { lastEvent.value = ev; refresh() })
  if (st) unsubSt = st.onSync((ev) => { lastEvent.value = ev; refresh() })
  await refresh()
})
onUnmounted(() => { unsubId?.(); unsubSt?.() })

async function connectGoogle () {
  if (!CLIENT_ID) { error.value = 'Falta VITE_GOOGLE_OAUTH_CLIENT_ID en build'; return }
  error.value = ''; busy.value = true
  try {
    const id = await getIdentity()
    const st = await getStore()
    if (id) await id.syncConnect(CLIENT_ID)
    if (st) await st.syncConnect(CLIENT_ID)
    await refresh()
  } catch (e) { error.value = e.message || String(e) }
  finally { busy.value = false }
}

async function disconnectGoogle () {
  busy.value = true
  try {
    const id = await getIdentity(); const st = await getStore()
    if (id) await id.syncDisconnect()
    if (st) await st.syncDisconnect()
    await refresh()
  } finally { busy.value = false }
}

async function unlock () {
  error.value = ''
  if (passphrase.value.length < 12) { error.value = 'Mínimo 12 caracteres'; return }
  if (passphrase2.value && passphrase.value !== passphrase2.value) {
    error.value = 'Las contraseñas no coinciden'; return
  }
  busy.value = true
  try {
    const id = await getIdentity(); const st = await getStore()
    if (id) await id.syncUnlock(passphrase.value)
    if (st) await st.syncUnlock(passphrase.value)
    passphrase.value = ''; passphrase2.value = ''
    await refresh()
  } catch (e) { error.value = e.message || String(e) }
  finally { busy.value = false }
}

async function lock () {
  busy.value = true
  try {
    const id = await getIdentity(); const st = await getStore()
    if (id) await id.syncLock()
    if (st) await st.syncLock()
    await refresh()
  } finally { busy.value = false }
}

async function syncNow () {
  busy.value = true; error.value = ''
  try {
    const id = await getIdentity(); const st = await getStore()
    if (id) await id.syncNow()
    if (st) await st.syncNow()
    await refresh()
  } catch (e) { error.value = e.message || String(e) }
  finally { busy.value = false }
}

const allConnected = computed(() => idStatus.value.connected && stStatus.value.connected)
const allUnlocked = computed(() => idStatus.value.unlocked && stStatus.value.unlocked)

function vaultStatus (s) {
  if (!s.connected) return { label: 'Sin cuenta', tone: 'neutral' }
  if (!s.unlocked)  return { label: 'Bloqueado',  tone: 'amber' }
  if (s.dirty)      return { label: 'Guardando…', tone: 'amber' }
  return { label: 'Al día', tone: 'green' }
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <div class="modal">
      <header class="head">
        <h2>Tu cuenta</h2>
        <button class="x" @click="emit('close')" aria-label="Cerrar">×</button>
      </header>

      <div class="body">
        <p class="intro">
          Inicia sesión con Google para que tus claves, contactos e historial vivan en
          <strong>tu Drive privado</strong> y estén disponibles en cualquier dispositivo
          donde entres con la misma cuenta. Tus datos se cifran con tu contraseña personal
          antes de subir — ni Google ni nosotros podemos leerlos.
        </p>

        <!-- Vault status row -->
        <div class="vaults">
          <div class="vault-card">
            <div class="vault-name">Identidad</div>
            <div :class="['vault-status', vaultStatus(idStatus).tone]">
              <span class="dot"></span>
              {{ vaultStatus(idStatus).label }}
            </div>
          </div>
          <div class="vault-card">
            <div class="vault-name">Mensajes</div>
            <div :class="['vault-status', vaultStatus(stStatus).tone]">
              <span class="dot"></span>
              {{ vaultStatus(stStatus).label }}
            </div>
          </div>
        </div>

        <!-- Step 1: connect Google -->
        <div v-if="!allConnected" class="step">
          <button :disabled="busy" class="btn primary-cta" @click="connectGoogle">
            <span class="g">G</span> Iniciar sesión con Google
          </button>
        </div>

        <!-- Step 2: unlock with passphrase -->
        <div v-else-if="!allUnlocked" class="step">
          <label class="field">
            <span class="field-label">Contraseña personal</span>
            <input
              :type="showPassphrase ? 'text' : 'password'"
              v-model="passphrase"
              autocomplete="off"
              placeholder="Mínimo 12 caracteres"
              class="mono"
            />
          </label>
          <label class="field">
            <span class="field-label">Confirmar (solo primera vez)</span>
            <input
              :type="showPassphrase ? 'text' : 'password'"
              v-model="passphrase2"
              autocomplete="off"
              class="mono"
            />
          </label>
          <label class="show-pw">
            <input type="checkbox" v-model="showPassphrase" />
            Mostrar contraseña
          </label>

          <div class="warning">
            <span class="warn-icon">⚠</span>
            <p>
              Si la olvidas, tus datos cifrados son <strong>irrecuperables</strong>.
              Anótala en un lugar seguro.
            </p>
          </div>

          <div class="actions">
            <button class="btn secondary" :disabled="busy" @click="disconnectGoogle">Cerrar sesión Google</button>
            <button class="btn" :disabled="busy" @click="unlock">Entrar</button>
          </div>
        </div>

        <!-- Step 3: synced -->
        <div v-else class="step">
          <div class="chips">
            <span class="chip">📥 Sincronización automática</span>
            <span class="chip">⌬ AES-256-GCM</span>
            <span class="chip">☁️ Drive privado</span>
          </div>
          <div class="actions">
            <button class="btn secondary" :disabled="busy" @click="lock">Bloquear</button>
            <button class="btn secondary" :disabled="busy" @click="disconnectGoogle">Cerrar sesión</button>
            <button class="btn" :disabled="busy" @click="syncNow">Actualizar ahora</button>
          </div>
        </div>

        <!-- Servidor (proxio / home) -->
        <div class="notif-section">
          <div class="notif-head">
            <div>
              <div class="notif-title">Servidor (proxio)</div>
              <div class="notif-sub">
                Tu nodo de transporte. Los proxios están <strong>federados</strong>:
                cambiar de nodo no te aísla — sigues alcanzando contactos en otros.
              </div>
            </div>
            <span :class="['conn-dot', { on: conn.isConnected }]" :title="conn.isConnected ? 'conectado' : 'desconectado'"></span>
          </div>
          <div class="proxy-list">
            <button
              v-for="p in conn.KNOWN_PROXIES" :key="p"
              :class="['proxy-opt', { on: conn.wsUrl === p }]"
              @click="pickProxy(p)"
            >
              <span class="proxy-radio"></span>{{ shortProxy(p) }}
            </button>
            <button
              v-if="!conn.KNOWN_PROXIES.includes(conn.wsUrl)"
              :class="['proxy-opt', 'on']"
            >
              <span class="proxy-radio"></span>{{ shortProxy(conn.wsUrl) }} <small>(custom)</small>
            </button>
          </div>
          <div class="proxy-custom">
            <input v-model="customProxy" placeholder="otro proxio: proxy.tudominio.com" @keyup.enter="addCustomProxy" />
            <button class="btn" @click="addCustomProxy">Usar</button>
          </div>
        </div>

        <!-- Notificaciones push -->
        <div class="notif-section">
          <div class="notif-head">
            <div>
              <div class="notif-title">Notificaciones</div>
              <div class="notif-sub">
                Recibe un aviso cuando te llegan mensajes con la app cerrada. El
                contenido viaja cifrado por el proxy; el aviso no lleva tus datos.
              </div>
            </div>
            <button
              :class="['toggle', { on: notif.enabled }]"
              :disabled="notif.busy || !notif.supported"
              @click="toggleNotifications"
              :aria-pressed="notif.enabled"
            >
              <span class="knob"></span>
            </button>
          </div>
          <p v-if="!notif.supported" class="notif-note">
            Tu navegador no soporta notificaciones push. En iOS, instala la app
            en la pantalla de inicio primero.
          </p>
          <p v-else-if="notif.permission === 'denied'" class="notif-note">
            Bloqueaste las notificaciones para este sitio. Habilitalas desde los
            ajustes del navegador.
          </p>
          <p v-if="notif.error" class="error">{{ notif.error }}</p>
        </div>

        <p v-if="error" class="error">{{ error }}</p>
        <p v-if="lastEvent" class="event">
          <code>{{ lastEvent.kind }} → {{ lastEvent.status }}</code>
          <span v-if="lastEvent.error"> — {{ lastEvent.error }}</span>
        </p>
      </div>

      <footer class="foot">
        <span class="foot-text">
          Tus datos viven en una carpeta privada de tu Drive (<code>appDataFolder</code>, oculta).
        </span>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.modal { max-width: 480px; }

.head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 18px 24px;
  border-bottom: 1px solid var(--border);
}
.x {
  background: transparent; border: 0;
  font-size: 24px; cursor: pointer;
  color: var(--muted);
  width: 32px; height: 32px;
  border-radius: 8px;
}
.x:hover { background: var(--bg-3); color: var(--text); }

.body { padding: 20px 24px; display: flex; flex-direction: column; gap: 18px; }

.intro {
  margin: 0;
  font-size: 13.5px;
  color: var(--muted);
  line-height: 1.55;
}
.intro strong { color: var(--text); }

/* Vault status cards */
.vaults { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.vault-card {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 12px 14px;
}
.vault-name {
  font-family: var(--font-headline);
  font-weight: 600;
  font-size: 14px;
  color: var(--text);
  margin-bottom: 4px;
}
.vault-status {
  display: flex; align-items: center; gap: 6px;
  font-size: 12.5px;
}
.vault-status .dot {
  width: 8px; height: 8px;
  border-radius: 50%;
}
.vault-status.green   .dot { background: var(--online); }
.vault-status.amber   .dot { background: var(--gold); }
.vault-status.neutral .dot { background: var(--bg-4); }
.vault-status.green   { color: var(--online); }
.vault-status.amber   { color: #a87c1d; }
.vault-status.neutral { color: var(--muted); }

/* Step (CTA / form / synced) */
.step { display: flex; flex-direction: column; gap: 12px; }

.primary-cta {
  width: 100%;
  padding: 14px;
  font-size: 15px;
  display: inline-flex; align-items: center; justify-content: center;
  gap: 10px;
}
.primary-cta .g {
  display: inline-flex; align-items: center; justify-content: center;
  width: 22px; height: 22px;
  background: #ffffff; color: var(--accent);
  border-radius: 50%;
  font-family: var(--font-headline);
  font-weight: 700;
  font-size: 13px;
}

.field { display: block; }
.field-label {
  display: block;
  font-size: 13px;
  font-weight: 500;
  color: var(--muted);
  margin-bottom: 6px;
}
.field input { width: 100%; }
.mono { font-family: var(--font-mono); }

.show-pw {
  display: flex; align-items: center; gap: 8px;
  font-size: 12.5px;
  color: var(--muted);
}
.show-pw input { width: auto; }

.warning {
  display: flex; gap: 10px;
  background: #f7e6d2;
  border-left: 3px solid #c89738;
  border-radius: 8px;
  padding: 10px 12px;
}
.warn-icon { color: #a87c1d; font-size: 16px; flex-shrink: 0; }
.warning p {
  margin: 0;
  font-size: 12.5px;
  color: var(--text);
  line-height: 1.5;
}
.warning strong { color: var(--accent); }

.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip {
  background: #ffffff;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 11.5px;
  color: var(--muted);
}

.actions {
  display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end;
}
.actions .btn { font-size: 13px; padding: 8px 14px; }

.error {
  margin: 0;
  font-size: 13px;
  color: var(--accent);
  font-weight: 500;
}
.event {
  margin: 0;
  font-size: 11.5px;
  color: var(--muted);
}
.event code {
  background: var(--bg-3);
  padding: 1px 5px;
  border-radius: 3px;
  font-family: var(--font-mono);
  font-size: 11px;
}

/* Notificaciones */
.notif-section {
  border-top: 1px solid var(--border);
  padding-top: 16px;
  display: flex; flex-direction: column; gap: 8px;
}
.notif-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
.notif-title {
  font-family: var(--font-headline);
  font-weight: 600; font-size: 14px; color: var(--text);
  margin-bottom: 3px;
}
.notif-sub { font-size: 12.5px; color: var(--muted); line-height: 1.5; }
.notif-note { margin: 0; font-size: 12px; color: var(--muted); }

.toggle {
  flex-shrink: 0;
  width: 44px; height: 26px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--bg-3);
  position: relative; cursor: pointer;
  transition: background .15s ease;
  padding: 0;
}
.toggle .knob {
  position: absolute; top: 2px; left: 2px;
  width: 20px; height: 20px;
  border-radius: 50%;
  background: #fff;
  transition: transform .15s ease;
}
.toggle.on { background: var(--online, #2e9e5b); border-color: var(--online, #2e9e5b); }
.toggle.on .knob { transform: translateX(18px); }
.toggle:disabled { opacity: .5; cursor: not-allowed; }

.conn-dot { width: 10px; height: 10px; border-radius: 50%; background: #777; flex: none; }
.conn-dot.on { background: var(--online, #2e9e5b); }
.proxy-list { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
.proxy-opt {
  display: flex; align-items: center; gap: 8px; text-align: left;
  padding: 8px 10px; border-radius: 8px; cursor: pointer;
  background: var(--bg-3, #1b2536); border: 1px solid var(--line, #2a3550); color: var(--text, #e7edf6);
}
.proxy-opt .proxy-radio { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--line, #55617a); flex: none; }
.proxy-opt.on { border-color: var(--accent, #2dd4bf); }
.proxy-opt.on .proxy-radio { border-color: var(--accent, #2dd4bf); background: var(--accent, #2dd4bf); }
.proxy-opt small { color: var(--muted, #8aa0bd); }
.proxy-custom { display: flex; gap: 6px; margin-top: 8px; }
.proxy-custom input { flex: 1; min-width: 0; }

.foot {
  padding: 14px 24px;
  background: var(--bg-2);
  border-top: 1px solid var(--border);
}
.foot-text {
  font-size: 11.5px;
  color: var(--muted);
}
.foot-text code {
  background: var(--bg-3);
  padding: 1px 5px;
  border-radius: 3px;
  font-family: var(--font-mono);
  font-size: 11px;
}
</style>
