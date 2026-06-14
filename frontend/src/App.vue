<script setup lang="ts">
import { computed } from 'vue';
import { RouterView } from 'vue-router';
import { useAuthStore } from './stores/auth';
import ChatPanel from './components/common/ChatPanel.vue';

const auth = useAuthStore();
const showChat = computed(() => auth.user !== null);
</script>

<template>
  <RouterView />
  <ChatPanel v-if="showChat" />
</template>
