<script setup>
import { ref, onMounted } from 'vue'
import { lang } from '../i18n'
import { getFriends } from '../services/friends'
// La bandeja es la del ecosistema (@dotrino/profile): las que te llegan, con aceptar y descartar,
// y las que mandaste, esperando.
import '@dotrino/profile/friends-ui'

const el = ref(null)
onMounted(() => { el.value.friends = getFriends() })
</script>

<template>
  <dotrino-friend-requests ref="el" class="requests" :lang.attr="lang"></dotrino-friend-requests>
</template>

<style scoped>
.requests { border-bottom: 1px solid var(--border); }
</style>
