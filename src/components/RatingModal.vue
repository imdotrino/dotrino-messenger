<script setup>
// Wrapper delgado sobre el Web Component compartido <dotrino-profile>
// (@dotrino/profile). La UI/UX del perfil + reputación vive en
// el paquete del ecosistema; aquí solo cableamos los datos del messenger
// (vault + registro) vía el provider y refrescamos los stores tras calificar.
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import '@dotrino/profile'
import { createVaultProfileProvider } from '@dotrino/profile'
import { getIdentity } from '../services/identity'
import { getReputation } from '../services/reputation'
import { useContactsStore } from '../stores/contactsStore'
import { useThreadsStore } from '../stores/threadsStore'

const props = defineProps({
  pubkey: { type: String, required: true },
  // `self` = mi propio perfil (modo self, sin calificar); por defecto califica a otro.
  self: { type: Boolean, default: false }
})
const emit  = defineEmits(['close'])

const contacts = useContactsStore()
const threads = useThreadsStore()

const el = ref(null)
const contact = computed(() => contacts.findByPubkey(props.pubkey))
const peer = computed(() => contacts.peerFor(props.pubkey))
const name = computed(() => contact.value?.nickname || '')
const since = computed(() => peer.value?.firstSeen || null)
const online = computed(() => contacts.isOnline(props.pubkey))

const onClose = () => emit('close')
const onRate = () => { contacts.refresh(); contacts.refreshPeers() }
const onRefresh = () => threads.askRatingsAbout(props.pubkey)

onMounted(async () => {
  contacts.refreshPeers()
  threads.askRatingsAbout(props.pubkey)
  const node = el.value
  if (!node) return
  node.addEventListener('cc-profile-close', onClose)
  node.addEventListener('cc-profile-rate', onRate)
  node.addEventListener('cc-profile-refresh', onRefresh)
  try {
    const [identity, reputation] = await Promise.all([getIdentity(), getReputation()])
    node.provider = createVaultProfileProvider({ identity, reputation })
  } catch (_) { /* sin provider el componente muestra "registro no disponible" */ }
})

onBeforeUnmount(() => {
  const node = el.value
  if (!node) return
  node.removeEventListener('cc-profile-close', onClose)
  node.removeEventListener('cc-profile-rate', onRate)
  node.removeEventListener('cc-profile-refresh', onRefresh)
})
</script>

<template>
  <dotrino-profile
    ref="el"
    modal
    :mode="self ? 'self' : 'edit'"
    :pubkey="pubkey"
    :name="name"
    :since="since || undefined"
    :online="online || undefined"
  />
</template>
