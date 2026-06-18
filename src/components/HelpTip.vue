<script setup>
import { ref, onMounted, onUnmounted, watch, nextTick } from 'vue'

const props = defineProps({
  targetSelector: { type: String, required: true },
  message: { type: String, required: true },
  placement: { type: String, default: 'bottom' } // 'bottom' | 'top'
})
const emit = defineEmits(['dismiss'])

const pos = ref({ top: 0, left: 0, arrowLeft: 0, ready: false })
const tipRef = ref(null)

const recalc = async () => {
  await nextTick()
  const target = document.querySelector(props.targetSelector)
  const tip = tipRef.value
  if (!target || !tip) { pos.value.ready = false; return }
  const r = target.getBoundingClientRect()
  const tipW = tip.offsetWidth || 280
  const tipH = tip.offsetHeight || 80
  const margin = 10
  const vw = window.innerWidth

  let top = props.placement === 'top'
    ? r.top - tipH - margin
    : r.bottom + margin
  let left = r.left + (r.width / 2) - (tipW / 2)
  left = Math.max(8, Math.min(left, vw - tipW - 8))
  const arrowLeft = (r.left + r.width / 2) - left
  pos.value = { top, left, arrowLeft, ready: true }
}

let raf = null
const onScrollResize = () => {
  if (raf) cancelAnimationFrame(raf)
  raf = requestAnimationFrame(recalc)
}

onMounted(async () => {
  await recalc()
  // re-check after layout settles
  setTimeout(recalc, 50)
  setTimeout(recalc, 250)
  window.addEventListener('resize', onScrollResize)
  window.addEventListener('scroll', onScrollResize, true)
})
onUnmounted(() => {
  window.removeEventListener('resize', onScrollResize)
  window.removeEventListener('scroll', onScrollResize, true)
})
watch(() => props.targetSelector, recalc)
</script>

<template>
  <div class="help-overlay" @click.self="emit('dismiss')">
    <div
      ref="tipRef"
      class="help-tip"
      :class="['placement-' + placement, { ready: pos.ready }]"
      :style="{ top: pos.top + 'px', left: pos.left + 'px' }"
    >
      <span class="arrow" :style="{ left: pos.arrowLeft + 'px' }"></span>
      <p class="msg">{{ message }}</p>
      <button class="ok" @click="emit('dismiss')">Entendido</button>
    </div>
  </div>
</template>

<style scoped>
.help-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  z-index: 9999;
}
.help-tip {
  position: fixed;
  width: 280px;
  max-width: calc(100vw - 16px);
  background: var(--bg-2, #fff);
  color: var(--text, #2b2118);
  border: 1px solid var(--border, #d8c9b6);
  border-radius: 12px;
  padding: 14px 16px 12px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
  opacity: 0;
  transform: translateY(-4px);
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.help-tip.ready { opacity: 1; transform: translateY(0); }
.arrow {
  position: absolute;
  width: 14px;
  height: 14px;
  background: var(--bg-2, #fff);
  border-left: 1px solid var(--border, #d8c9b6);
  border-top: 1px solid var(--border, #d8c9b6);
  transform: translateX(-50%) rotate(45deg);
}
.placement-bottom .arrow { top: -8px; }
.placement-top .arrow {
  bottom: -8px;
  transform: translateX(-50%) rotate(225deg);
}
.msg {
  margin: 0 0 10px;
  font-size: 13px;
  line-height: 1.45;
}
.ok {
  background: var(--accent, #c0392b);
  color: var(--on-accent, #fff);
  border: 0;
  padding: 6px 14px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  float: right;
}
.ok:hover { filter: brightness(1.05); }
</style>
