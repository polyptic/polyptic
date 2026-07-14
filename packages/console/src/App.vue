<script setup lang="ts">
import { watchEffect } from "vue";
import { useConsoleStore } from "./stores/console";
import ToastHost from "./components/ToastHost.vue";
import ConfirmDialog from "./components/ConfirmDialog.vue";

// Reflect the chosen theme onto <html> so the design tokens (and any teleported overlays) cascade
// across the whole document, sign-in screen included.
const store = useConsoleStore();
watchEffect(() => {
  document.documentElement.setAttribute("data-theme", store.theme);
});
</script>

<template>
  <router-view />
  <!-- POL-93 — mounted ONCE, above every route: the feedback rail every store action speaks
       through, and the in-app confirm/prompt that replaced window.confirm/prompt/alert. -->
  <ToastHost />
  <ConfirmDialog />
</template>
