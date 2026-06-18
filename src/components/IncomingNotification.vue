<script setup>
import { ref, watch } from 'vue'

const props = defineProps({
  // { id, fromNickname, text } | null
  dm: { type: Object, default: null }
})
const emit = defineEmits(['done'])

const visible = ref(false)
const phase = ref('hidden')   // 'hidden' | 'in' | 'shown' | 'out'

const FADE_IN_MS = 1000
const VISIBLE_MS = 5000
const FADE_OUT_MS = 1000

let timers = []
function clearTimers () {
  for (const t of timers) clearTimeout(t)
  timers = []
}

watch(() => props.dm, (next) => {
  if (!next) return
  clearTimers()
  visible.value = true
  phase.value = 'in'
  timers.push(setTimeout(() => { phase.value = 'shown' }, FADE_IN_MS))
  timers.push(setTimeout(() => { phase.value = 'out' }, FADE_IN_MS + VISIBLE_MS))
  timers.push(setTimeout(() => {
    visible.value = false
    phase.value = 'hidden'
    emit('done', next.id)
  }, FADE_IN_MS + VISIBLE_MS + FADE_OUT_MS))
}, { immediate: true })
</script>

<template>
  <div
    v-if="visible"
    :class="['cc-incoming', 'phase-' + phase]"
    aria-live="polite"
  >
    <div class="cc-incoming-card">
      <div class="cc-incoming-from">{{ dm?.fromNickname || 'Mensaje nuevo' }}</div>
      <div class="cc-incoming-text">{{ dm?.text }}</div>
    </div>
  </div>
</template>

<style scoped>
.cc-incoming {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;   /* solo el card responde a hover/click */
  z-index: 99999;
  background: transparent;
  opacity: 0;
  transition: opacity 1s ease;
}
.cc-incoming.phase-in,
.cc-incoming.phase-shown { opacity: 1; }
.cc-incoming.phase-out   { opacity: 0; }

.cc-incoming-card {
  background: var(--bg-2, #fff);
  color: var(--text, #2b2118);
  border: 1px solid var(--border, #d8c9b6);
  border-radius: 18px;
  padding: 24px 30px;
  max-width: min(460px, 82vw);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.32);
  pointer-events: auto;
  text-align: center;
  transform: translateY(0);
}
.cc-incoming.phase-in .cc-incoming-card {
  animation: cc-pop-in 1s ease both;
}
.cc-incoming.phase-out .cc-incoming-card {
  animation: cc-pop-out 1s ease both;
}
@keyframes cc-pop-in {
  from { transform: translateY(12px) scale(0.96); }
  to   { transform: translateY(0) scale(1); }
}
@keyframes cc-pop-out {
  from { transform: translateY(0) scale(1); }
  to   { transform: translateY(-8px) scale(0.98); }
}

.cc-incoming-from {
  font-family: var(--font-headline);
  font-weight: 600;
  font-size: 14px;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--accent, #c0392b);
  margin-bottom: 10px;
}
.cc-incoming-text {
  font-size: 17px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-wrap: break-word;
  color: var(--text, #2b2118);
}
</style>
