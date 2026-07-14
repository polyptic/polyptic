<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useConsoleStore } from "../stores/console";
import Logo from "./Logo.vue";

const route = useRoute();
const router = useRouter();
const store = useConsoleStore();

// Pending-approval badge on the Machines item (machines awaiting an operator decision).
const pendingCount = computed(() => store.machines.filter((m) => m.status === "pending").length);
const themeIcon = computed(() => (store.theme === "light" ? "☾" : "☼"));

function go(name: string): void {
  if (route.name !== name) router.push({ name });
}
function isActive(name: string): boolean {
  return route.name === name;
}
</script>

<template>
  <nav class="rail">
    <Logo :size="34" :rounded="9" style="margin-bottom: 8px" />

    <button class="nav" :class="{ active: isActive('wall') }" title="Wall" @click="go('wall')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
      </svg>
      <span class="label">Wall</span>
    </button>

    <button class="nav" :class="{ active: isActive('machines') }" title="Machines" @click="go('machines')">
      <span class="icon-wrap">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="4" width="18" height="7" rx="1.5" />
          <rect x="3" y="13" width="18" height="7" rx="1.5" />
          <circle cx="7" cy="7.5" r=".7" fill="currentColor" stroke="none" />
          <circle cx="7" cy="16.5" r=".7" fill="currentColor" stroke="none" />
        </svg>
        <span v-if="pendingCount > 0" class="badge">{{ pendingCount }}</span>
      </span>
      <span class="label">Machines</span>
    </button>

    <button class="nav" :class="{ active: isActive('content') }" title="Content" @click="go('content')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 3 2 9l10 6 10-6-10-6Z" />
        <path d="m2 15 10 6 10-6" />
      </svg>
      <span class="label">Content</span>
    </button>

    <button class="nav" :class="{ active: isActive('playlists') }" title="Playlists" @click="go('playlists')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 5h13" />
        <path d="M3 10h13" />
        <path d="M3 15h7" />
        <path d="M14 14.5v6l5-3z" fill="currentColor" stroke="none" />
      </svg>
      <span class="label">Playlists</span>
    </button>

    <button class="nav" :class="{ active: isActive('overlays') }" title="Overlays" @click="go('overlays')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="6" width="14" height="12" rx="2" />
        <rect x="9" y="10" width="12" height="8" rx="2" fill="currentColor" fill-opacity="0.18" />
      </svg>
      <span class="label">Overlays</span>
    </button>

    <button class="nav" :class="{ active: isActive('scenes') }" title="Scenes" @click="go('scenes')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <rect x="2" y="4" width="20" height="14" rx="2" />
        <path d="M10 9l4 2.5-4 2.5z" fill="currentColor" stroke="none" />
        <path d="M8 21h8" />
      </svg>
      <span class="label">Scenes</span>
    </button>

    <div class="spacer"></div>

    <button class="theme-toggle" title="Toggle theme" @click="store.toggleTheme()">{{ themeIcon }}</button>

    <button class="nav" :class="{ active: isActive('settings') }" title="Settings" @click="go('settings')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <line x1="4" x2="4" y1="21" y2="14" />
        <line x1="4" x2="4" y1="10" y2="3" />
        <line x1="12" x2="12" y1="21" y2="12" />
        <line x1="12" x2="12" y1="8" y2="3" />
        <line x1="20" x2="20" y1="21" y2="16" />
        <line x1="20" x2="20" y1="12" y2="3" />
        <line x1="2" x2="6" y1="14" y2="14" />
        <line x1="10" x2="14" y1="8" y2="8" />
        <line x1="18" x2="22" y1="16" y2="16" />
      </svg>
      <span class="label">Settings</span>
    </button>

    <button class="avatar" title="Account" @click="go('settings')">OP</button>
  </nav>
</template>

<style scoped>
.rail {
  width: 74px;
  flex: 0 0 74px;
  border-right: 1px solid var(--line);
  background: var(--surface);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 14px 0;
  gap: 6px;
}

.logo {
  width: 34px;
  height: 34px;
  border-radius: 9px;
  background: var(--primary);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--primary-fg);
  font-size: 17px;
  font-weight: 700;
  margin-bottom: 8px;
}

.nav {
  width: 56px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 8px 0;
  border: none;
  border-radius: 12px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}
.nav:hover {
  background: var(--muted-bg);
  color: var(--fg2);
}
.nav.active {
  background: var(--accent-soft);
  color: var(--accent-fg);
}
.nav svg {
  width: 20px;
  height: 20px;
}
.label {
  font-size: 9.5px;
  font-weight: 500;
}

.icon-wrap {
  position: relative;
  display: flex;
}
.badge {
  position: absolute;
  top: -5px;
  right: -7px;
  min-width: 15px;
  height: 15px;
  padding: 0 3px;
  border-radius: 8px;
  background: var(--warn);
  color: #fff;
  font-size: 9px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}

.spacer {
  flex: 1;
}

.theme-toggle {
  width: 40px;
  height: 40px;
  border: none;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: var(--muted);
  background: transparent;
  font-size: 15px;
}
.theme-toggle:hover {
  background: var(--muted-bg);
}

.avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--muted-bg);
  border: 1px solid var(--line);
  margin-top: 4px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 600;
  color: var(--muted);
}
.avatar:hover {
  border-color: var(--line2);
}
</style>
