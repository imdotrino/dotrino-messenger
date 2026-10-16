<script setup>
import { ref, nextTick, watch, computed, onUnmounted } from 'vue'
import { useThreadsStore } from '../stores/threadsStore'
import { useContactsStore } from '../stores/contactsStore'
import { t, locale } from '../i18n'
// El AVATAR es el del ecosistema, no uno de la app. Se importa del pilar por su
// subpath barato (`@dotrino/identity/avatar`, sin arrastrar el vault): es un identicon
// DETERMINISTA del pubkey, el mismo que pintan <dotrino-topbar> y <dotrino-profile>.
//
// Antes cada vista dibujaba las iniciales del apodo sobre un disco de color de una
// paleta propia. Dos consecuencias, las dos vistas: el mismo contacto se veía distinto
// en la lista que en su ficha, y el avatar CAMBIABA al cambiar el apodo (que cambia
// solo, en el saludo). El identicon no se mueve: la llave no cambia.
import { avatarDataUri } from '@dotrino/identity/avatar'
import { useConnectionStore } from '../stores/connectionStore'
import { INLINE_IMAGE, LIMITS, fitsRoute, humanSize, downloadFile } from '../utils/file'


const threads = useThreadsStore()
const contacts = useContactsStore()
const connection = useConnectionStore()
const emit = defineEmits(['back', 'rate'])

const text = ref('')
const scroller = ref(null)
const fileInput = ref(null)
const sendingFile = ref(false)
const fileError = ref('')
// Aviso de tope: el archivo no cabe por el camino de ahora y va a esperar (no es un error).
const fileNotice = ref('')
// La foto que se abre a pantalla completa (data URI), o null.
const viewing = ref(null)


const c = computed(() => threads.activeContact)
const online = computed(() => c.value && contacts.isOnline(c.value.publickey))
const rating = computed(() => c.value ? contacts.ratingFor(c.value.publickey) : null)
// Versión de la otra punta (§14). No bloquea nada: se enseña aquí, pegado a la
// conversación, porque es donde la incompatibilidad se nota como «no me contesta».
const compat = computed(() => c.value ? (threads.peerCompat[c.value.publickey] || '') : '')
// Una cuenta de la que aún no se conoce ningún aparato (Dotrino antes de escribir): no hay
// a quién mandarle nada. El campo se ve, apagado, con el motivo.
const noDevices = computed(() => {
  contacts.ratingTick
  return !!c.value && contacts.recipientsOf(c.value.publickey).length === 0
})

// POR DÓNDE VA ESTE CONTACTO AHORA, y con qué tope (dueño, 2026-10-15). Se vuelve a
// preguntar al cambiar de contacto, cuando el pilar avisa de un cambio de camino, al
// conectarse o irse el contacto, y cada pocos segundos por si el canal pasó a ir por relevo.
const route = ref('offline')
const refreshRoute = async () => {
  const pk = c.value?.publickey
  if (!pk) return
  const r = await threads.routeOf(pk).catch(() => 'offline')
  if (c.value?.publickey === pk) route.value = r
}
watch(() => [c.value?.publickey, connection.routeTick, online.value, connection.isConnected], refreshRoute, { immediate: true })
const routeTimer = setInterval(refreshRoute, 5000)
onUnmounted(() => clearInterval(routeTimer))
const routeLimit = computed(() => LIMITS[route.value] == null ? t.value.conv.route.noLimit : t.value.conv.route.upTo.replace('{size}', humanSize(LIMITS[route.value])))

const stars = (val) => {
  if (val == null) return ''
  const full = Math.round(val)
  return '★'.repeat(full) + '☆'.repeat(5 - full)
}

const send = async () => {
  const v = text.value
  if (!v.trim()) return
  text.value = ''
  await threads.sendDM(c.value.publickey, v)
  scrollDown()
}

const pickFile = () => { fileError.value = ''; fileNotice.value = ''; fileInput.value?.click() }

// El archivo sale TAL CUAL; el texto escrito va como pie. Si no cabe por el camino de ahora,
// se dice antes de mandarlo, con el tope de ese camino, y queda esperando al que le sirve.
const onFilePicked = async (ev) => {
  const file = ev.target.files?.[0]
  ev.target.value = ''
  if (!file || !c.value) return
  sendingFile.value = true
  fileError.value = ''
  fileNotice.value = ''
  await refreshRoute()
  if (!fitsRoute(file.size, route.value)) {
    const n = t.value.conv.notice
    fileNotice.value = (route.value === 'proxy' ? n.proxy : n.offline)
      .replace('{size}', humanSize(file.size))
      .replace('{limit}', humanSize(LIMITS[route.value]))
  }
  try {
    await threads.sendFile(c.value.publickey, file, text.value)
    text.value = ''
    scrollDown()
  } catch (e) {
    console.warn('[messenger] file not sent:', e?.code || '', e?.message)
    fileError.value = t.value.conv.fileError
  } finally {
    sendingFile.value = false
  }
}

const isInline = (item) => INLINE_IMAGE.test(item.file?.mime || '')
const fileIcon = (mime) => /^image\//.test(mime) ? '🖼' : /^video\//.test(mime) ? '🎞' : /^audio\//.test(mime) ? '🎵' : /pdf$/.test(mime) ? '📕' : '📄'

const scrollDown = () => nextTick(() => {
  if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight
})

watch(() => threads.activeThread.length, scrollDown)
watch(() => threads.activePubkey, (pk) => { threads.loadFiles(pk); scrollDown() }, { immediate: true })

// Los separadores de día son texto visible: siguen el idioma de la app.
const fmtTime = (ts) => new Date(ts).toLocaleTimeString(locale.value, { hour: '2-digit', minute: '2-digit' })
const fmtDay = (ts) => {
  const d = new Date(ts)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return t.value.conv.today
  const yest = new Date(now); yest.setDate(now.getDate() - 1)
  if (d.toDateString() === yest.toDateString()) return t.value.conv.yesterday
  return d.toLocaleDateString(locale.value, { day: '2-digit', month: 'short', year: 'numeric' })
}

// Group messages by day for the separators.
const grouped = computed(() => {
  const out = []
  let lastDay = null
  for (const m of threads.activeThread) {
    const day = new Date(m.ts).toDateString()
    if (day !== lastDay) {
      out.push({ kind: 'sep', ts: m.ts, key: 'sep-' + day })
      lastDay = day
    }
    out.push({ kind: 'msg', ...m })
  }
  return out
})
</script>

<template>
  <div class="conv" v-if="c">
    <header class="head">
      <button class="back" @click="emit('back')" :title="t.conv.back">←</button>
      <div class="avatar-wrap" @click="emit('rate', c.publickey)" :title="t.conv.rate">
        <img class="avatar" :src="avatarDataUri(c.publickey, { size: 76 })" alt="" />
        <span v-if="online" class="online-dot"></span>
      </div>
      <div class="who">
        <div class="row">
          <strong class="name">{{ c.nickname }}</strong>
          <span
            v-if="rating.value != null"
            :class="['stars', rating.source]"
            @click="emit('rate', c.publickey)"
            :title="rating.source === 'mine' ? t.list.ratingMine : t.list.ratingDerived"
          >{{ stars(rating.value) }}</span>
        </div>
        <div class="sub">
          <span :class="['status-text', online ? 'on' : 'off']">
            {{ online ? t.conv.online : t.conv.offline }}
          </span>
          <span
            :class="['route', 'route-' + route]" data-testid="route" :data-route="route"
            :title="t.conv.route[route].label + ' · ' + routeLimit"
          >
            <span class="route-icon" aria-hidden="true">{{ t.conv.route[route].icon }}</span>
            {{ t.conv.route[route].label }} · {{ routeLimit }}
          </span>
        </div>
      </div>
      <button class="rate-btn" data-testid="rate-contact" @click="emit('rate', c.publickey)" :title="t.conv.rate">★</button>
    </header>

    <div v-if="compat" class="compat-note" role="status">{{ t.conv.compat[compat] }}</div>

    <div class="messages" ref="scroller">
      <div v-if="threads.activeThread.length === 0" class="empty">
        <div class="empty-content">
          <p class="big">{{ t.conv.emptyBig }}</p>
          <p class="small">{{ t.conv.emptySmall }}</p>
        </div>
      </div>
      <template v-else>
        <div v-for="item in grouped" :key="item.key || item.id">
          <div v-if="item.kind === 'sep'" class="day-sep">
            <span>{{ fmtDay(item.ts) }}</span>
          </div>
          <div v-else :class="['msg', item.dir]" :data-testid="'msg-' + item.dir">
            <div class="bubble">
              <template v-if="item.file">
                <template v-if="isInline(item) && threads.files[item.id]">
                  <button
                    type="button" class="photo" data-testid="msg-image"
                    :aria-label="item.file.name"
                    @click="viewing = threads.files[item.id]"
                  >
                    <img :src="threads.files[item.id]" :width="item.file.w || undefined" :height="item.file.h || undefined" alt="" />
                  </button>
                </template>
                <div v-else class="file-chip" data-testid="msg-file">
                  <span class="file-icon" aria-hidden="true">{{ fileIcon(item.file.mime) }}</span>
                  <span class="file-meta">
                    <span class="file-name" data-testid="msg-file-name">{{ item.file.name }}</span>
                    <span class="file-size">{{ humanSize(item.file.size || 0) }}</span>
                  </span>
                  <button
                    type="button" class="file-dl" data-testid="msg-file-download"
                    :disabled="!threads.files[item.id]"
                    :title="threads.files[item.id] ? t.conv.download : t.conv.fileMissing"
                    :aria-label="t.conv.download"
                    @click="downloadFile(threads.files[item.id], item.file.name)"
                  >⬇</button>
                </div>
              </template>
              <div v-if="item.text" class="text" data-testid="msg-text">{{ item.text }}</div>
              <div v-if="item.waits && item.pending" class="waits" data-testid="msg-waits" :data-waits="item.waits">{{ t.conv.waits[item.waits] }}</div>
              <div class="meta">
                <span class="time">{{ fmtTime(item.ts) }}</span>
                <span v-if="item.dir === 'out'" class="check">{{ item.pending ? '⌛' : '✓' }}</span>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>

    <p v-if="noDevices" class="no-devices" role="status" data-testid="no-devices">{{ t.conv.noDevices }}</p>
    <p v-if="fileNotice" class="file-notice" role="status" data-testid="file-notice">{{ fileNotice }}</p>
    <p v-if="fileError" class="image-error" role="alert" data-testid="file-error">{{ fileError }}</p>
    <form class="composer" @submit.prevent="send">
      <input ref="fileInput" type="file" hidden data-testid="file-input" @change="onFilePicked" />
      <button
        type="button" class="clip" data-testid="attach-file"
        :disabled="noDevices || sendingFile"
        :title="t.conv.attach + ' · ' + routeLimit" :aria-label="t.conv.attach"
        @click="pickFile"
      >{{ sendingFile ? '⌛' : '📎' }}</button>
      <textarea
        v-model="text"
        :disabled="noDevices"
        rows="1"
        :placeholder="t.conv.placeholder"
        data-testid="composer-input"
        @keydown.enter.exact.prevent="send"
      />
      <button class="send" data-testid="send-message" :disabled="noDevices || !text.trim()" type="submit" :title="t.conv.send">
        <span>➤</span>
      </button>
    </form>

    <div v-if="viewing" class="viewer" data-testid="image-viewer" @click="viewing = null">
      <img :src="viewing" alt="" />
    </div>
  </div>
</template>

<style scoped>
.no-devices {
  margin: 0;
  padding: 10px 20px;
  font-size: 13px;
  color: var(--muted);
  background: var(--bg-2);
  border-top: 1px solid var(--border);
}
.conv { display: flex; flex-direction: column; flex: 1; min-height: 0; background: var(--bg-1); }

/* ----- Header ----- */
.head {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 20px;
  background: var(--bg-2);
  border-bottom: 1px solid var(--border);
}
.back {
  background: transparent; border: 0;
  color: var(--text); font-size: 22px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 8px;
  transition: background 150ms ease-out;
}
.back:hover { background: var(--bg-3); }
@media (min-width: 701px) { .back { display: none; } }

.avatar-wrap { position: relative; flex-shrink: 0; cursor: pointer; }
.avatar-wrap:hover .avatar { filter: brightness(1.1); }
.avatar {
  width: 38px; height: 38px;
  border-radius: 50%;
  display: block;
  background: var(--bg-4);
}
.compat-note {
  padding: 8px 16px;
  background: var(--bg-3);
  border-bottom: 1px solid var(--border);
  color: var(--muted);
  font-size: 12.5px;
  line-height: 1.45;
}
.online-dot {
  position: absolute;
  right: -1px; bottom: -1px;
  width: 11px; height: 11px;
  border-radius: 50%;
  background: var(--online);
  border: 2px solid var(--bg-2);
}

.who { flex: 1; min-width: 0; }
.row { display: flex; align-items: center; gap: 8px; }
.name {
  font-family: var(--font-headline);
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
}
.stars { font-size: 13px; cursor: pointer; letter-spacing: 1px; }
.stars.mine    { color: var(--gold); }
.stars.derived { color: var(--derived); }

.sub {
  display: flex; flex-wrap: wrap; gap: 2px 8px; align-items: center;
  font-size: 12px;
  margin-top: 1px;
}
.status-text { white-space: nowrap; }
.status-text.on  { color: var(--online); font-weight: 500; }
.status-text.off { color: var(--muted); font-style: italic; }
.rate-btn {
  background: transparent;
  color: var(--gold);
  border: 0;
  font-size: 22px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 8px;
  transition: background 150ms ease-out;
}
.rate-btn:hover { background: var(--bg-3); }

/* ----- Messages ----- */
.messages {
  flex: 1; overflow-y: auto;
  padding: 24px;
  display: flex; flex-direction: column;
  gap: 4px;
}
.empty {
  flex: 1; display: flex; align-items: center; justify-content: center;
}
.empty-content { text-align: center; color: var(--muted); }
.empty-content .big { margin: 0 0 4px; font-family: var(--font-headline); font-size: 16px; color: var(--text); }
.empty-content .small { margin: 0; font-size: 14px; }

.day-sep {
  display: flex; align-items: center; justify-content: center;
  margin: 16px 0 8px;
}
.day-sep span {
  font-size: 11px;
  color: var(--muted);
  background: var(--bg-3);
  padding: 4px 12px;
  border-radius: 999px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.msg { display: flex; }
.msg.out { justify-content: flex-end; }
.bubble {
  max-width: 65%;
  padding: 10px 14px;
  border-radius: 14px;
  background: var(--dt-surface);
  color: var(--text);
  border: 1px solid var(--border);
  box-shadow: 0 1px 1px color-mix(in srgb, var(--dt-accent) 4%, transparent);
  position: relative;
  line-height: 1.45;
}
.msg.in .bubble  { border-bottom-left-radius: 4px; }
.msg.out .bubble {
  background: var(--accent);
  color: var(--on-accent);
  border: 0;
  border-bottom-right-radius: 4px;
  box-shadow: 0 1px 2px color-mix(in srgb, var(--dt-accent) 25%, transparent);
}
.text {
  white-space: pre-wrap;
  word-wrap: break-word;
  font-size: 14.5px;
}
.meta {
  display: flex; gap: 6px; align-items: center;
  justify-content: flex-end;
  font-size: 11px;
  margin-top: 4px;
  opacity: 0.75;
}
.msg.out .meta { color: color-mix(in srgb, var(--dt-accent-ink) 85%, transparent); }
.msg.in  .meta { color: var(--muted); }
.check { font-size: 12px; }

/* ----- Fotos ----- */
.photo {
  display: block; padding: 0; border: 0; background: none; cursor: zoom-in;
  margin: -2px -4px 4px; border-radius: 12px; overflow: hidden;
}
.photo img {
  display: block; max-width: min(280px, 60vw); max-height: 320px;
  width: auto; height: auto; object-fit: cover;
}
.photo-missing { font-size: 13px; opacity: 0.7; padding: 4px 0; }
.waits { font-size: 11px; opacity: 0.8; margin-top: 2px; }
.file-chip {
  display: flex; align-items: center; gap: 10px; min-width: 200px; max-width: min(320px, 70vw);
  padding: 6px 4px 8px;
}
.file-icon { font-size: 26px; }
.file-meta { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.file-name { font-weight: 600; font-size: 13.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-size { font-size: 11.5px; opacity: 0.75; }
.file-dl {
  width: 34px; height: 34px; border-radius: 50%; border: 1px solid currentColor;
  background: transparent; color: inherit; cursor: pointer; flex-shrink: 0;
}
.file-dl:disabled { opacity: 0.35; cursor: not-allowed; }
.file-notice { margin: 0; padding: 8px 20px; font-size: 12px; color: var(--muted); }
.route {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 1px 8px; border-radius: 999px; font-size: 11px;
  border: 1px solid var(--border); color: var(--muted); white-space: nowrap;
}
.route-direct, .route-socket, .route-turn, .route-webrtc { color: var(--dt-accent); border-color: color-mix(in srgb, var(--dt-accent) 45%, transparent); }
.route-icon { font-size: 12px; }
@media (max-width: 700px) {
  .route { margin-left: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
}
.image-error { margin: 0; padding: 8px 20px; font-size: 12px; color: var(--dt-danger, #b3261e); }
.clip:disabled { opacity: 0.4; cursor: not-allowed; }
.viewer {
  position: fixed; inset: 0; z-index: 50;
  background: color-mix(in srgb, #000 88%, transparent);
  display: flex; align-items: center; justify-content: center;
  padding: env(safe-area-inset-top, 0) 12px env(safe-area-inset-bottom, 0);
  cursor: zoom-out;
}
.viewer img { max-width: 100%; max-height: 100%; object-fit: contain; }

/* ----- Composer ----- */
.composer {
  display: flex; gap: 10px; align-items: flex-end;
  padding: 14px 20px;
  padding-bottom: calc(14px + env(safe-area-inset-bottom, 0px));
  background: var(--bg-2);
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}
@media (max-width: 700px) {
  .composer { padding: 12px 14px; padding-bottom: calc(14px + env(safe-area-inset-bottom, 0px)); }
  .composer textarea {
    min-height: 48px;
    padding: 13px 18px;
    font-size: 16px; /* evita zoom en iOS al enfocar */
  }
  .clip { width: 44px; height: 44px; font-size: 22px; }
  .send { width: 48px; height: 48px; font-size: 16px; }
}
.clip {
  background: transparent;
  border: 0;
  font-size: 20px;
  color: var(--muted);
  cursor: pointer;
  width: 38px; height: 38px;
  border-radius: 50%;
  transition: background 150ms ease-out, color 150ms ease-out;
}
.clip:hover { background: var(--bg-3); color: var(--text); }
.composer textarea {
  flex: 1;
  resize: none;
  min-height: 38px;
  max-height: 120px;
  padding: 9px 16px;
  border-radius: 999px;
  background: var(--dt-surface);
  border: 1px solid var(--border);
  font-size: 14.5px;
  line-height: 1.4;
}
.send {
  width: 40px; height: 40px;
  border-radius: 50%;
  border: 0;
  background: var(--accent);
  color: var(--on-accent);
  cursor: pointer;
  font-size: 14px;
  display: inline-flex; align-items: center; justify-content: center;
  flex-shrink: 0;
  transition: background 150ms ease-out, transform 100ms ease-out;
  box-shadow: 0 1px 3px color-mix(in srgb, var(--dt-accent) 25%, transparent);
}
.send:hover:not(:disabled) { background: var(--accent-2); }
.send:active:not(:disabled) { transform: scale(0.95); }
.send:disabled { opacity: 0.4; cursor: not-allowed; }
.send span { display: inline-block; transform: translateX(1px); }
</style>
