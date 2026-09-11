<script setup>
import { computed } from 'vue'
import { useContactsStore } from '../stores/contactsStore'
import { useThreadsStore } from '../stores/threadsStore'
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

// El día ("lun"/"Mon") y el mes ("ene"/"Jan") son texto VISIBLE: van en el idioma
// de la app, no en el del navegador (antes `[]` = locale del navegador).
const fmtTime = (ts) => {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString(locale.value, { hour: '2-digit', minute: '2-digit' })
  }
  const diffDays = Math.floor((now - d) / 86400000)
  if (diffDays < 7) return d.toLocaleDateString(locale.value, { weekday: 'short' })
  return d.toLocaleDateString(locale.value, { day: '2-digit', month: 'short' })
}
</script>

<template>
  <div class="list">
    <div v-if="items.length === 0" class="empty">
      {{ t.list.emptyBefore }}<br>{{ t.list.emptyPress }} <strong>+</strong> {{ t.list.emptyAfter }}
    </div>
    <div
      v-for="c in items"
      :key="c.publickey"
      class="item"
      data-testid="contact-item"
      :class="{ active: threads.activePubkey === c.publickey }"
      @click="emit('select', c.publickey)"
    >
      <div class="avatar-wrap" @click.stop="emit('rate', c.publickey)" :title="t.list.rate">
        <img class="avatar" :src="avatarDataUri(c.publickey, { size: 84 })" alt="" />
        <span v-if="c.online" class="online-dot"></span>
      </div>
      <div class="body">
        <div class="row1">
          <span class="name">{{ c.nickname }}</span>
          <span class="time">{{ fmtTime(c.lastTs) }}</span>
        </div>
        <div class="row2">
          <span class="snippet" v-if="c.lastText">{{ c.lastText }}</span>
          <span class="snippet muted" v-else>{{ t.list.noMessages }}</span>
          <span v-if="c.unread > 0" class="unread">{{ c.unread }}</span>
        </div>
        <div v-if="c.rating.value != null" class="row3">
          <span
            :class="['stars', c.rating.source]"
            @click.stop="emit('rate', c.publickey)"
            :title="c.rating.source === 'mine' ? t.list.ratingMine : t.list.ratingDerived"
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
  display: block;
  background: var(--bg-4);
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
