<script setup>
import { ref, onMounted, watch } from 'vue'
import { t, lang } from '../i18n'
import { getFriends } from '../services/friends'
// La pantalla de añadir es la del ecosistema (@dotrino/profile): tu código y su QR, teclear,
// pegar o escanear el del otro. La solicitud la manda @dotrino/profile/friends.
import '@dotrino/profile/friends-ui'

// `code`: llega con el enlace `#add=…` (alguien escaneó el QR con la cámara del sistema). Se deja
// escrito para que el usuario vea qué va a hacer y ponga apodo, en vez de mandarlo a ciegas.
// `initialTab`: 'mine' cuando se llega tocando el código de la barra.
// `peer`: llega con el enlace `#to=…` ({ pubkey, nickname, card }): ya se sabe a quién.
const props = defineProps({
  code: { type: String, default: '' },
  peer: { type: Object, default: null },
  initialTab: { type: String, default: 'add' }
})
const emit = defineEmits(['close'])

const el = ref(null)
onMounted(() => {
  el.value.friends = getFriends()
  // Copia plana: el `peer` de la UI es un Proxy reactivo, y la bóveda (postMessage) no lo clona.
  if (props.peer) el.value.peer = JSON.parse(JSON.stringify(props.peer))
})
watch(() => props.peer, (p) => { if (el.value) el.value.peer = p ? JSON.parse(JSON.stringify(p)) : null })
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <div class="modal">
      <header class="head">
        <h2>{{ t.add.title }}</h2>
        <button class="x" data-testid="close-add" @click="emit('close')" :aria-label="t.add.close">×</button>
      </header>
      <div class="body">
        <dotrino-add-friend
          ref="el"
          :lang.attr="lang"
          :tab.attr="initialTab === 'mine' ? 'mine' : 'add'"
          :code.attr="code || null"
          @dotrino-friend-requested="emit('close')"
          @dotrino-friend-cancel="emit('close')"
        ></dotrino-add-friend>
      </div>
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
</style>
