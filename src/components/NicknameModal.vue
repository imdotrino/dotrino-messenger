<script setup>
import { ref, onMounted } from 'vue'
import { t } from '../i18n'
const emit = defineEmits(['set'])
const nick = ref('')
const inputEl = ref(null)
const valid = (v) => v.trim().length >= 3 && v.trim().length <= 20
const submit = () => { if (valid(nick.value)) emit('set', nick.value.trim()) }
// Foco programático en lugar de `autofocus`: Chrome bloquea autofocus en
// iframes cross-origin (extensión, embed). Esto sí funciona si el iframe
// tiene el foco, y si no, no rompe nada — solo no enfoca.
onMounted(() => { try { inputEl.value?.focus() } catch (_) {} })
</script>

<template>
  <div class="welcome">
    <div class="card">
      <div class="brand">
        <div class="logo">CC</div>
        <h1>Dotrino</h1>
        <p class="tagline">{{ t.welcome.tagline }}</p>
      </div>

      <p class="welcome-msg">{{ t.welcome.intro }}</p>

      <label class="field">
        <span class="label">{{ t.welcome.label }}</span>
        <input
          ref="inputEl"
          v-model="nick"
          @keyup.enter="submit"
          :placeholder="t.welcome.placeholder"
          maxlength="20"
        />
        <span class="counter">{{ nick.length }} / 20</span>
        <span class="helper">{{ t.welcome.helper }}</span>
      </label>

      <button class="btn primary-cta" :disabled="!valid(nick)" @click="submit">
        {{ t.welcome.submit }}
        <span class="arrow">→</span>
      </button>

      <div class="info">
        <span class="shield">⌬</span>
        <div>
          <p>{{ t.welcome.info }}</p>
          <a class="link" href="https://github.com/imdotrino/dotrino-identity#readme" target="_blank" rel="noopener">
            {{ t.welcome.link }}
          </a>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.welcome {
  position: fixed; inset: 0;
  display: flex; align-items: center; justify-content: center;
  background: var(--bg-1);
  padding: 24px;
  z-index: 50;
}
.card {
  width: 100%;
  max-width: 480px;
  padding: 40px;
  background: var(--bg-1);
}

.brand { text-align: center; margin-bottom: 32px; }
.logo {
  width: 64px; height: 64px;
  margin: 0 auto 16px;
  background: var(--accent); color: var(--on-accent);
  border-radius: 14px;
  display: flex; align-items: center; justify-content: center;
  font-family: var(--font-headline);
  font-weight: 700; font-size: 22px;
  letter-spacing: -0.02em;
  box-shadow: 0 4px 14px rgba(192, 57, 43, 0.25);
}
.brand h1 {
  margin: 0;
  font-family: var(--font-headline);
  font-size: 32px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--text);
}
.tagline {
  margin: 4px 0 0;
  color: var(--muted);
  font-size: 14px;
}

.welcome-msg {
  text-align: center;
  margin: 0 0 24px;
  font-size: 16px;
  color: var(--text);
  line-height: 1.5;
}

.field {
  display: block;
  position: relative;
  margin-bottom: 20px;
}
.label {
  display: block;
  font-size: 13px;
  font-weight: 500;
  color: var(--muted);
  margin-bottom: 6px;
}
.field input {
  width: 100%;
  padding: 14px 16px;
  font-size: 18px;
  font-family: var(--font-body);
}
.counter {
  position: absolute;
  right: 12px; top: 38px;
  font-size: 12px;
  color: var(--muted);
  pointer-events: none;
  background: #ffffff;
  padding: 0 4px;
}
.helper {
  display: block;
  margin-top: 8px;
  font-size: 13px;
  color: var(--muted);
  line-height: 1.5;
}

.primary-cta {
  width: 100%;
  padding: 14px;
  font-size: 16px;
  display: inline-flex; align-items: center; justify-content: center;
  gap: 8px;
}
.arrow { display: inline-block; transition: transform 150ms ease-out; }
.primary-cta:hover:not(:disabled) .arrow { transform: translateX(4px); }

.info {
  margin-top: 32px;
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px;
  display: flex;
  gap: 12px;
}
.info .shield {
  flex-shrink: 0;
  width: 28px; height: 28px;
  border-radius: 8px;
  background: var(--accent);
  color: var(--on-accent);
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 16px;
  font-family: var(--font-headline);
}
.info p {
  margin: 0;
  font-size: 12.5px;
  color: var(--muted);
  line-height: 1.5;
}
.info .link {
  display: inline-block;
  margin-top: 6px;
  font-size: 12.5px;
  color: var(--accent);
  text-decoration: none;
  font-weight: 500;
}
.info .link:hover { text-decoration: underline; }

@media (max-width: 540px) {
  .card { padding: 24px; }
  .brand h1 { font-size: 26px; }
}
</style>
