<script setup>
import { computed } from 'vue'
import { useContactsStore } from '../stores/contactsStore'
import { useThreadsStore } from '../stores/threadsStore'

const contacts = useContactsStore()
const threads = useThreadsStore()
const emit = defineEmits(['select', 'rate'])

const items = computed(() => {
  contacts.ratingTick // dependency
  return contacts.contacts
    .map(c => {
      const thread = threads.threads[c.publickey] || []
      const last = thread.length ? thread[thread.length - 1] : null
      const r = contacts.ratingFor(c.publickey)
      return {
        ...c,
        online: contacts.isOnline(c.publickey),
        lastText: last?.text || null,
        lastTs: last?.ts || c.lastSeen,
        unread: thread.filter(e => e.dir === 'in' && !e._read).length,
        rating: r
      }
    })
    .sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0))
})

const stars = (val) => {
  if (val == null) return ''
  const full = Math.round(val)
  return '★'.repeat(full) + '☆'.repeat(5 - full)
}

const initials = (s) => (s || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase()

// Color hash for avatar background — deterministic by pubkey/nickname.
// Picks from a warm palette consistent with the design system.
const palette = [
  '#9c7a8c', // dusty violet
  '#c89738', // amber
  '#5a8a3a', // olive
  '#a37a45', // bronze
  '#6b8a9c', // muted blue
  '#c0392b', // terracotta (rare)
  '#7a6b5d', // taupe
  '#b8773d'  // ochre
]
const avatarBg = (key) => {
  const s = key || ''
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return palette[h % palette.length]
}

const fmtTime = (ts) => {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  const diffDays = Math.floor((now - d) / 86400000)
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'short' })
  return d.toLocaleDateString([], { day: '2-digit', month: 'short' })
}
</script>

<template>
  <div class="list">
    <div v-if="items.length === 0" class="empty">
      Aún no tienes contactos.<br>Pulsa <strong>+</strong> para añadir uno.
    </div>
    <div
      v-for="c in items"
      :key="c.publickey"
      class="item"
      data-testid="contact-item"
      :class="{ active: threads.activePubkey === c.publickey }"
      @click="emit('select', c.publickey)"
    >
      <div class="avatar-wrap" @click.stop="emit('rate', c.publickey)" title="Calificar">
        <div class="avatar" :style="{ background: avatarBg(c.publickey) }">
          {{ initials(c.nickname) }}
        </div>
        <span v-if="c.online" class="online-dot"></span>
      </div>
      <div class="body">
        <div class="row1">
          <span class="name">{{ c.nickname }}</span>
          <span class="time">{{ fmtTime(c.lastTs) }}</span>
        </div>
        <div class="row2">
          <span class="snippet" v-if="c.lastText">{{ c.lastText }}</span>
          <span class="snippet muted" v-else>Sin mensajes</span>
          <span v-if="c.unread > 0" class="unread">{{ c.unread }}</span>
        </div>
        <div v-if="c.rating.value != null" class="row3">
          <span
            :class="['stars', c.rating.source]"
            @click.stop="emit('rate', c.publickey)"
            :title="c.rating.source === 'mine' ? 'Tu calificación' : 'Calificación derivada (web of trust)'"
          >{{ stars(c.rating.value) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.list { flex: 1; overflow-y: auto; }
.empty {
  padding: 32px 24px;
  text-align: center;
  color: var(--muted);
  font-size: 14px;
  line-height: 1.5;
}
.empty strong { color: var(--accent); }

.item {
  display: flex;
  gap: 12px;
  padding: 14px 16px;
  cursor: pointer;
  border-bottom: 1px solid var(--border);
  border-left: 3px solid transparent;
  transition: background 150ms ease-out, border-left-color 150ms ease-out;
}
.item:hover { background: var(--bg-3); }
.item.active {
  background: var(--bg-3);
  border-left-color: var(--accent);
}

.avatar-wrap {
  position: relative;
  flex-shrink: 0;
  cursor: pointer;
}
.avatar-wrap:hover .avatar { filter: brightness(1.1); }
.avatar {
  width: 42px; height: 42px;
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  color: #ffffff;
  font-family: var(--font-headline);
  font-weight: 600;
  font-size: 14px;
  letter-spacing: -0.02em;
}
.online-dot {
  position: absolute;
  right: -1px; bottom: -1px;
  width: 12px; height: 12px;
  border-radius: 50%;
  background: var(--online);
  border: 2px solid var(--bg-2);
}

.body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.row1 {
  display: flex; align-items: center; gap: 8px;
}
.name {
  font-weight: 600;
  flex: 1;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--text);
}
.time {
  font-size: 11px;
  color: var(--muted);
  flex-shrink: 0;
}

.row2 { display: flex; align-items: center; gap: 8px; }
.snippet {
  flex: 1;
  font-size: 13px;
  color: var(--muted);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.snippet.muted { font-style: italic; }
.unread {
  flex-shrink: 0;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 11px;
  font-weight: 600;
  min-width: 18px;
  height: 18px;
  padding: 0 6px;
  border-radius: 9px;
  display: inline-flex; align-items: center; justify-content: center;
}

.row3 { margin-top: 2px; }
.stars { font-size: 13px; cursor: pointer; letter-spacing: 1px; }
.stars.mine    { color: var(--gold); }
.stars.derived { color: var(--derived); }
</style>
