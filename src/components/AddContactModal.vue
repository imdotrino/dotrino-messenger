<script setup>
import { ref } from 'vue'
import { useConnectionStore } from '../stores/connectionStore'
import { useContactsStore } from '../stores/contactsStore'
import { useThreadsStore } from '../stores/threadsStore'

const emit = defineEmits(['close'])
const connection = useConnectionStore()
const contacts = useContactsStore()
const threads = useThreadsStore()

const tab = ref('add')   // 'add' | 'mine'
const tokenInput = ref('')
const nicknameInput = ref('')
const error = ref('')

const myToken = () => connection.token

const submit = async () => {
  error.value = ''
  const tk = (tokenInput.value || '').trim().toUpperCase()
  if (!/^[A-Z0-9]{4,8}$/.test(tk)) {
    error.value = 'Token inválido (4-8 caracteres alfanuméricos en mayúsculas).'
    return
  }
  if (tk === connection.token) {
    error.value = 'Ese es tu propio token.'
    return
  }
  try {
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
    error.value = e.message || 'Error enviando saludo'
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
        <h2>Añadir contacto</h2>
        <button class="x" @click="emit('close')" aria-label="Cerrar">×</button>
      </header>

      <div class="body">
        <div class="tabs">
          <button :class="['tab', tab === 'add'  && 'active']" @click="tab = 'add'">🔗 Por token</button>
          <button :class="['tab', tab === 'mine' && 'active']" @click="tab = 'mine'" data-testid="share-my-token-tab">📤 Mi token</button>
        </div>

        <div v-if="tab === 'add'" class="tab-pane">
          <div class="info-card">
            <span class="info-icon">⌬</span>
            <p>
              Pega aquí el token que tu contacto te compartió. Verificaremos su clave
              criptográfica al primer mensaje.
            </p>
          </div>

          <label class="field">
            <span class="field-label">Token del contacto</span>
            <div class="token-input-wrap">
              <input
                v-model="tokenInput"
                placeholder="ej. A4F2"
                maxlength="8"
                class="mono"
                @keyup.enter="submit"
              />
              <button type="button" class="paste-btn" @click="pasteToken" title="Pegar">📋</button>
            </div>
          </label>

          <label class="field">
            <span class="field-label">Apodo (opcional)</span>
            <input v-model="nicknameInput" placeholder="ej. Bob de chess" maxlength="40" />
          </label>

          <p v-if="error" class="error">{{ error }}</p>
          <p class="hint">
            Le enviaremos un saludo cifrado con tu identidad. Cuando responda, aparecerá
            automáticamente en tu lista.
          </p>
        </div>

        <div v-else class="tab-pane">
          <div class="info-card">
            <span class="info-icon">⤴</span>
            <p>
              Comparte este token con tu contacto. Cambia cada vez que te conectas, pero
              tu identidad permanece.
            </p>
          </div>
          <div class="my-token">
            <code>{{ myToken() || '…' }}</code>
            <button class="btn secondary" @click="copyToken" :disabled="!myToken()">Copiar</button>
          </div>
        </div>
      </div>

      <footer class="foot">
        <button class="btn secondary" @click="emit('close')">Cancelar</button>
        <button v-if="tab === 'add'" class="btn" @click="submit">Enviar saludo</button>
        <button v-else class="btn" @click="emit('close')">Listo</button>
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

/* ----- Footer ----- */
.foot {
  display: flex; gap: 10px; justify-content: flex-end;
  padding: 14px 24px;
  background: var(--bg-2);
  border-top: 1px solid var(--border);
}
</style>
