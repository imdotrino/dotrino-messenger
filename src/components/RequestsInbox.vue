<script setup>
import { ref, onMounted } from 'vue'
import { lang } from '../i18n'
import { getFriends } from '../services/friends'
// La bandeja es la del ecosistema (@dotrino/profile): las que te llegan, con aceptar y descartar,
// y las que mandaste, esperando.
import '@dotrino/profile/friends-ui'

/** @type {import('vue').Ref<import('@dotrino/profile/friends-ui').DotrinoFriendRequests|null>} */
const el = ref(null)
// Montado, la referencia del template existe.
onMounted(() => { /** @type {import('@dotrino/profile/friends-ui').DotrinoFriendRequests} */ (el.value).friends = getFriends() })
</script>

<template>
  <dotrino-friend-requests ref="el" class="requests" :lang.attr="lang"></dotrino-friend-requests>
</template>

<style scoped>
.requests { border-bottom: 1px solid var(--border); }
</style>
