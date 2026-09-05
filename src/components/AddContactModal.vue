<script setup>
import { ref, computed } from 'vue'
import { useConnectionStore } from '../stores/connectionStore'
import { useContactsStore } from '../stores/contactsStore'
import { useThreadsStore } from '../stores/threadsStore'
import { t, lang } from '../i18n'
// QR del ecosistema (@dotrino/qr): <dotrino-qr> muestra, <dotrino-qr-scan> lee.
// Ni el dibujo ni la cámara salen del dispositivo.
import '@dotrino/qr'

// `code`: llega con el enlace `#add=…` (alguien escaneó el QR con la cámara del
// sistema). Se deja escrito para que el usuario vea qué va a hacer y ponga alias,
// en vez de mandar un saludo a ciegas.
const props = defineProps({ code: { type: String, default: '' } })
const emit = defineEmits(['close'])
const connection = useConnectionStore()
const contacts = useContactsStore()
const threads = useThreadsStore()

const tab = ref('add')   // 'add' | 'mine'
const tokenInput = ref(props.code || '')
const nicknameInput = ref('')
// Guardamos la CLAVE del error, no el texto ya traducido: así el mensaje sigue al
// idioma si el usuario cambia el toggle con el modal abierto.
const errorKey = ref('')
const errorText = computed(() => (errorKey.value ? t.value.add[errorKey.value] : ''))

// Lo que se muestra y se comparte es la CITA, no la instancia: la instancia es
// el identificador interno de la conexión (34 caracteres, sensible a mayúsculas)
// y no hay forma de dictarla ni de teclearla.
const myToken = () => connection.pairingCode

// El QR lleva un ENLACE, no el código pelado: quien lo apunta con la cámara del
// teléfono abre el messenger con el código puesto, sin teclear nada. El código
// viaja en el #fragment, que no llega al servidor.
const myLink = computed(() => {
  const code = connection.pairingCode
  if (!code) return ''
  try { return new URL('#add=' + code, location.href).toString() } catch (_) { return '' }
})

const scanOpen = ref(false)
// En vuelo: el botón se apaga mientras se canjea, para que dos toques no manden
// dos saludos (y para que se vea que está pasando algo).
const enviando = ref(false)

// Mismo criterio que el proxio: se traduce lo que se confunde al leer o al
// dictar. Solo se traduce lo que NUNCA se emite, para no romper un código bueno.
const CONFUSABLES = { I: '1', L: '1', S: '5', Z: '2', B: '8', G: '6', 0: 'O' }
const normalizar = (raw) => [...String(raw || '').toUpperCase()]
  .filter((c) => c !== ' ' && c !== '-' && c !== '_')
  .map((c) => CONFUSABLES[c] ?? c)
  .join('')

// El alfabeto del proxio, sin los caracteres que se confunden al leer o dictar.
const CODE_RE = /^[1-9ACDEFHJKMNOPQRTUVWXY]{6}$/

/**
 * Saca el código de lo que devolvió el escáner: nuestro QR lleva un enlace con
 * `#add=`, pero alguien puede enseñar el código pelado en cualquier otro QR.
 */
const codeFromScan = (text) => {
  const raw = String(text || '').trim()
  const m = raw.match(/[#&?]add=([^&\s]+)/i)
  return normalizar(m ? m[1] : raw).slice(0, 6)
}

const onScanned = async (ev) => {
  scanOpen.value = false
  const code = codeFromScan(ev?.detail?.text)
  if (!CODE_RE.test(code)) { errorKey.value = 'errNoCode'; return }
  tokenInput.value = code
  await submit()
}

const submit = async () => {
  errorKey.value = ''
  const code = normalizar(tokenInput.value)
  if (!CODE_RE.test(code)) {
    errorKey.value = 'errInvalid'
    return
  }
  if (code === connection.pairingCode) {
    errorKey.value = 'errOwn'
    return
  }
  // Canjear la cita da la instancia de esa persona (esté en el proxio que esté).
  // Antes se usaba el texto tecleado como si fuera la dirección: eso dejó de
  // funcionar cuando la dirección pasó a ser la instancia.
  enviando.value = true
  try {
    const res = await connection.redeemPairingCode(code)
    if (!res?.ok || !res.instance) {
      // Sin conexión no es lo mismo que un código malo: si decimos «no vale», la
      // persona va a pedir otro código y a fallar otra vez con el mismo problema.
      errorKey.value = res?.reason === 'offline' ? 'errOffline' : 'errInvalid'
      return
    }
    const tk = res.instance
    // Recordamos el apodo elegido para aplicarlo cuando el peer responda al
    // handshake y se promueva a contacto (antes el campo se ignoraba).
    threads.rememberAlias(tk, (nicknameInput.value || '').trim())
    await threads.sendHello(tk)
    // Challenge con nonce REGISTRADO por el vault (makeChallenge). Antes se
    // mandaba un nonce 'probe-' a mano que el vault no reconocía → la respuesta
    // del peer se rechazaba (isFreshNonce) y el contacto no se agregaba nunca.
    await threads.sendChallenge(tk)
    emit('close')
  } catch (e) {
    // El mensaje crudo de la excepción es jerga técnica (§9.1) y no se puede
    // traducir: al usuario le damos el texto llano y el detalle va a la consola.
    console.warn('[cc-add-contact] sendHello failed', e)
    errorKey.value = 'errSend'
  } finally {
    enviando.value = false
  }
}

const copyToken = async () => {
  if (!myToken()) return
  try { await navigator.clipboard.writeText(myToken()) } catch {}
}
const pasteToken = async () => {
  try {
    const v = await navigator.clipboard.readText()
    if (v) tokenInput.value = v
  } catch {}
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <div class="modal">
      <header class="head">
        <h2>{{ t.add.title }}</h2>
        <button class="x" @click="emit('close')" :aria-label="t.add.close">×</button>
      </header>

      <div class="body">
        <div class="tabs">
          <button :class="['tab', tab === 'add'  && 'active']" @click="tab = 'add'">{{ t.add.tabAdd }}</button>
          <button :class="['tab', tab === 'mine' && 'active']" @click="tab = 'mine'" data-testid="share-my-token-tab">{{ t.add.tabMine }}</button>
        </div>

        <div v-if="tab === 'add'" class="tab-pane">
          <div class="info-card">
            <span class="info-icon">⌬</span>
            <p>{{ t.add.info }}</p>
          </div>

          <label class="field">
            <span class="field-label">{{ t.add.fieldToken }}</span>
            <div class="token-input-wrap">
              <input
                data-testid="code-input"
                v-model="tokenInput"
                :placeholder="t.add.phToken"
                maxlength="8"
                class="mono"
                @keyup.enter="submit"
              />
              <button type="button" class="paste-btn" @click="pasteToken" :title="t.add.paste">📋</button>
            </div>
          </label>

          <button type="button" class="scan-btn" @click="scanOpen = true" data-testid="scan-qr">
            {{ t.add.scan }}
          </button>

          <label class="field">
            <span class="field-label">{{ t.add.fieldAlias }}</span>
            <input v-model="nicknameInput" :placeholder="t.add.phAlias" maxlength="40" />
          </label>

          <p v-if="errorText" class="error">{{ errorText }}</p>
          <p class="hint">{{ t.add.hint }}</p>
        </div>

        <div v-else class="tab-pane">
          <div class="info-card">
            <span class="info-icon">⤴</span>
            <p>{{ t.add.mineInfo }}</p>
          </div>
          <div class="my-token">
            <code data-testid="my-pairing-code">{{ myToken() || '…' }}</code>
            <button class="btn secondary" @click="copyToken" :disabled="!myToken()">{{ t.add.copy }}</button>
          </div>
          <div class="qr-wrap" v-if="myLink">
            <dotrino-qr :value.prop="myLink" size="190" data-testid="my-qr"></dotrino-qr>
            <p class="hint">{{ t.add.qrHint }}</p>
          </div>
        </div>
      </div>

      <dotrino-qr-scan
        :open.prop="scanOpen"
        :lang.attr="lang"
        @dotrino-qr-scanned="onScanned"
        @dotrino-qr-cancelled="scanOpen = false"
      ></dotrino-qr-scan>

      <footer class="foot">
        <button class="btn secondary" @click="emit('close')">{{ t.add.cancel }}</button>
        <button v-if="tab === 'add'" class="btn" data-testid="send-hello" :disabled="enviando" @click="submit">{{ enviando ? t.add.sending : t.add.send }}</button>
        <button v-else class="btn" @click="emit('close')">{{ t.add.done }}</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.modal { max-width: 440px; }

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
  transition: background 150ms ease-out, color 150ms ease-out;
}
.x:hover { background: var(--bg-3); color: var(--text); }

.body { padding: 20px 24px; }

/* ----- Tabs ----- */
.tabs {
  display: flex; gap: 4px;
  background: var(--bg-3);
  padding: 4px;
  border-radius: 12px;
  margin-bottom: 20px;
}
.tab {
  flex: 1;
  background: transparent;
  border: 0;
  padding: 9px 14px;
  font-size: 13.5px;
  font-weight: 500;
  color: var(--muted);
  cursor: pointer;
  border-radius: 9px;
  transition: background 150ms ease-out, color 150ms ease-out;
}
.tab:hover { color: var(--text); }
.tab.active {
  background: #ffffff;
  color: var(--text);
  box-shadow: 0 1px 2px rgba(120, 80, 50, 0.08);
}

.tab-pane { display: flex; flex-direction: column; gap: 16px; }

/* ----- Info card ----- */
.info-card {
  display: flex; gap: 12px; align-items: flex-start;
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 14px;
}
.info-icon {
  flex-shrink: 0;
  width: 28px; height: 28px;
  border-radius: 8px;
  background: var(--accent); color: var(--on-accent);
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 14px;
  font-family: var(--font-headline);
}
.info-card p {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--muted);
}

/* ----- Field ----- */
.field { display: block; }
.field-label {
  display: block;
  font-size: 13px;
  font-weight: 500;
  color: var(--muted);
  margin-bottom: 6px;
}
.field input {
  width: 100%;
}
.mono {
  font-family: var(--font-mono);
  font-size: 16px;
  letter-spacing: 4px;
  text-transform: uppercase;
  text-align: center;
}
.token-input-wrap {
  position: relative;
}
.paste-btn {
  position: absolute;
  top: 50%; right: 8px; transform: translateY(-50%);
  background: var(--bg-3);
  border: 0;
  width: 30px; height: 30px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 14px;
  color: var(--muted);
  transition: background 150ms ease-out;
}
.paste-btn:hover { background: var(--bg-4); color: var(--text); }

.error {
  margin: 0;
  font-size: 13px;
  color: var(--accent);
  font-weight: 500;
}
.hint {
  margin: 0;
  font-size: 12.5px;
  color: var(--muted);
  line-height: 1.5;
}

.scan-btn {
  align-self: flex-start;
  font: inherit; font-size: 14px; cursor: pointer;
  padding: 9px 14px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg-3);
  color: var(--text);
}
.scan-btn:hover { border-color: var(--accent); }

/* ----- My token tab ----- */
.my-token {
  display: flex; gap: 12px; align-items: center;
  margin-top: 4px;
}
.my-token code {
  flex: 1;
  background: #ffffff;
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px;
  font-size: 28px;
  font-family: var(--font-mono);
  font-weight: 500;
  letter-spacing: 8px;
  text-align: center;
  color: var(--text);
}

.qr-wrap {
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  margin-top: 14px;
}
.qr-wrap dotrino-qr {
  --dqr-border: var(--border);
  --dqr-radius: 12px;
}
.qr-wrap .hint { text-align: center; }

/* ----- Footer ----- */
.foot {
  display: flex; gap: 10px; justify-content: flex-end;
  padding: 14px 24px;
  background: var(--bg-2);
  border-top: 1px solid var(--border);
}
</style>
