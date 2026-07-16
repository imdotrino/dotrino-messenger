<script setup>
import { computed } from 'vue'
import { useThreadsStore } from '../stores/threadsStore'
import { t } from '../i18n'

const threads = useThreadsStore()

// Avaladas (cerca de tu red) arriba; el resto, desconocidos, debajo.
const list = computed(() =>
  [...threads.requests.requests].sort((a, b) => (b.vouched - a.vouched) || (b.ts - a.ts))
)

const short = (pk) => (pk || '').slice(0, 8) + '…'
const accept = (pk) => threads.acceptRequest(pk)
const dismiss = (pk) => threads.dismissRequest(pk)
</script>

<template>
  <div class="requests">
    <div class="req-head">{{ t.requests.title }} <span v-if="list.length" class="count">{{ list.length }}</span></div>
    <p v-if="!list.length" class="req-empty">{{ t.requests.empty }}</p>
    <ul v-else class="req-list">
      <li v-for="r in list" :key="r.pubkey" class="req" :class="{ vouched: r.vouched }">
        <div class="req-info">
          <div class="req-name">
            {{ r.nickname || short(r.pubkey) }}
            <span v-if="r.vouched" class="vouch" :title="t.requests.vouchedTitle">{{ t.requests.vouched }}</span>
            <span v-else class="stranger" :title="t.requests.strangerTitle">{{ t.requests.stranger }}</span>
          </div>
          <div class="req-msg">{{ r.text || t.requests.defaultMsg }}</div>
        </div>
        <div class="req-actions">
          <button class="ok" @click="accept(r.pubkey)" :title="t.requests.accept">✓</button>
          <button class="no" @click="dismiss(r.pubkey)" :title="t.requests.dismiss">✕</button>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.requests { border-bottom: 1px solid var(--line, #2a3550); }
.req-empty { font-size: 12.5px; color: var(--muted, #8aa0bd); padding: 4px 12px 12px; margin: 0; }
.req-head {
  font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em;
  color: var(--muted, #8aa0bd); padding: 10px 12px 6px; display: flex; align-items: center; gap: 6px;
}
.count { background: var(--accent, #2dd4bf); color: #04221d; border-radius: 999px; padding: 0 7px; font-size: 11px; }
.req-list { list-style: none; margin: 0; padding: 0; }
.req {
  display: flex; align-items: center; gap: 8px; padding: 8px 12px;
  border-top: 1px solid rgba(255,255,255,.04);
}
.req.vouched { background: rgba(45,212,191,.06); }
.req-info { flex: 1; min-width: 0; }
.req-name { font-weight: 600; font-size: 14px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.vouch { font-size: 10px; font-weight: 700; color: #04221d; background: var(--accent, #2dd4bf); border-radius: 4px; padding: 1px 5px; text-transform: uppercase; }
.stranger { font-size: 10px; color: var(--muted, #8aa0bd); border: 1px solid var(--line, #2a3550); border-radius: 4px; padding: 0 5px; text-transform: uppercase; }
.req-msg { font-size: 13px; color: var(--muted, #8aa0bd); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
.req-actions { display: flex; gap: 6px; }
.req-actions button {
  width: 30px; height: 30px; border-radius: 8px; border: 1px solid var(--line, #2a3550);
  background: var(--panel2, #1b2536); color: var(--text, #e7edf6); cursor: pointer; font-size: 15px;
}
.req-actions .ok { color: #34d399; }
.req-actions .no { color: #f87171; }
</style>
