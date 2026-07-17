<script setup lang="ts">
// A styled "coming soon" placeholder for the nav routes that land in later console sub-phases.
defineProps<{ title: string; subtitle: string }>();
</script>

<template>
  <div class="page">
    <div class="page-inner">
      <h1 class="page-title">{{ title }}</h1>
      <p class="page-subtitle">{{ subtitle }}</p>

      <div class="card cs">
        <span class="cs-badge">Coming soon</span>
        <p class="cs-text">This view arrives in a later sub-phase of the console.</p>
        <router-link class="btn btn-ghost" :to="{ name: 'wall' }">Open the Wall</router-link>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}
.page-inner {
  max-width: 840px;
  margin: 0 auto;
  padding: 30px 32px 60px;
}
.page-title {
  font-size: 21px;
  font-weight: 600;
  letter-spacing: -0.02em;
  margin: 0 0 4px;
}
.page-subtitle {
  font-size: 13.5px;
  color: var(--muted);
  margin: 0 0 24px;
}
.cs {
  padding: 28px 24px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 14px;
}
.cs-badge {
  background: var(--accent-soft);
  color: var(--accent-fg);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  padding: 4px 10px;
  border-radius: 20px;
}
.cs-text {
  font-size: 13px;
  color: var(--fg2);
  line-height: 1.55;
  margin: 0;
  max-width: 52ch;
}
</style>
