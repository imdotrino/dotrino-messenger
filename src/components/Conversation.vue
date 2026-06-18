<script setup>
import { ref, nextTick, watch, computed } from 'vue'
import { useThreadsStore } from '../stores/threadsStore'
import { useContactsStore } from '../stores/contactsStore'

const threads = useThreadsStore()
const contacts = useContactsStore()
const emit = defineEmits(['back', 'rate'])

const text = ref('')
const scroller = ref(null)

const c = computed(() => threads.activeContact)
const online = computed(() => c.value && contacts.isOnline(c.value.publickey))
const rating = computed(() => c.value ? contacts.ratingFor(c.value.publickey) : null)

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

const scrollDown = () => nextTick(() => {
  if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight
})

watch(() => threads.activeThread.length, scrollDown)
watch(() => threads.activePubkey, scrollDown, { immediate: true })

const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const fmtDay = (ts) => {
  const d = new Date(ts)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return 'Hoy'
  const yest = new Date(now); yest.setDate(now.getDate() - 1)
  if (d.toDateString() === yest.toDateString()) return 'Ayer'
  return d.toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' })
}

const initials = (s) => (s || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase()

const palette = [
  '#9c7a8c', '#c89738', '#5a8a3a', '#a37a45',
  '#6b8a9c', '#c0392b', '#7a6b5d', '#b8773d'
]
const avatarBg = (key) => {
  const s = key || ''
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return palette[h % palette.length]
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
      <button class="back" @click="emit('back')" title="Volver">←</button>
      <div class="avatar-wrap" @click="emit('rate', c.publickey)" title="Calificar">
        <div class="avatar" :style="{ background: avatarBg(c.publickey) }">
          {{ initials(c.nickname) }}
        </div>
        <span v-if="online" class="online-dot"></span>
      </div>
      <div class="who">
        <div class="row">
          <strong class="name">{{ c.nickname }}</strong>
          <span
            v-if="rating.value != null"
            :class="['stars', rating.source]"
            @click="emit('rate', c.publickey)"
            :title="rating.source === 'mine' ? 'Tu calificación' : 'Web of trust'"
          >{{ stars(rating.value) }}</span>
        </div>
        <div class="sub">
          <span :class="['status-text', online ? 'on' : 'off']">
            {{ online ? 'en línea' : 'offline · mensajes en cola' }}
          </span>
          <code v-if="c.lastToken">{{ c.lastToken }}</code>
        </div>
      </div>
      <button class="rate-btn" @click="emit('rate', c.publickey)" title="Calificar">★</button>
    </header>

    <div class="messages" ref="scroller">
      <div v-if="threads.activeThread.length === 0" class="empty">
        <div class="empty-content">
          <p class="big">Aún no hay mensajes</p>
          <p class="small">Saluda y empieza la conversación 👋</p>
        </div>
      </div>
      <template v-else>
        <div v-for="item in grouped" :key="item.key || item.id">
          <div v-if="item.kind === 'sep'" class="day-sep">
            <span>{{ fmtDay(item.ts) }}</span>
          </div>
          <div v-else :class="['msg', item.dir]">
            <div class="bubble">
              <div class="text">{{ item.text }}</div>
              <div class="meta">
                <span class="time">{{ fmtTime(item.ts) }}</span>
                <span v-if="item.dir === 'out'" class="check">{{ item.pending ? '⌛' : '✓' }}</span>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>

    <form class="composer" @submit.prevent="send">
      <button type="button" class="clip" title="Adjuntar (próximamente)">📎</button>
      <textarea
        v-model="text"
        rows="1"
        placeholder="Escribe un mensaje…"
        data-testid="composer-input"
        @keydown.enter.exact.prevent="send"
      />
      <button class="send" :disabled="!text.trim()" type="submit" title="Enviar">
        <span>➤</span>
      </button>
    </form>
  </div>
</template>

<style scoped>
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
  display: flex; align-items: center; justify-content: center;
  color: #ffffff;
  font-family: var(--font-headline);
  font-weight: 600;
  font-size: 13px;
  letter-spacing: -0.02em;
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
  display: flex; gap: 8px; align-items: center;
  font-size: 12px;
  margin-top: 1px;
}
.status-text.on  { color: var(--online); font-weight: 500; }
.status-text.off { color: var(--muted); font-style: italic; }
.sub code {
  background: var(--bg-3);
  padding: 1px 6px;
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
}

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
  background: #ffffff;
  color: var(--text);
  border: 1px solid var(--border);
  box-shadow: 0 1px 1px rgba(120, 80, 50, 0.04);
  position: relative;
  line-height: 1.45;
}
.msg.in .bubble  { border-bottom-left-radius: 4px; }
.msg.out .bubble {
  background: var(--accent);
  color: var(--on-accent);
  border: 0;
  border-bottom-right-radius: 4px;
  box-shadow: 0 1px 2px rgba(192, 57, 43, 0.25);
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
.msg.out .meta { color: rgba(255, 255, 255, 0.85); }
.msg.in  .meta { color: var(--muted); }
.check { font-size: 12px; }

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
  background: #ffffff;
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
  box-shadow: 0 1px 3px rgba(192, 57, 43, 0.25);
}
.send:hover:not(:disabled) { background: var(--accent-2); }
.send:active:not(:disabled) { transform: scale(0.95); }
.send:disabled { opacity: 0.4; cursor: not-allowed; }
.send span { display: inline-block; transform: translateX(1px); }
</style>
