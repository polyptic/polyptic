<!--
  AlertsChip — the Wall top bar's health chip, and the drawer behind it (POL-91).

  The chip has always read "N screens · 2 alerts" and done nothing: the number was computed on the
  spot from offline screens and led nowhere. Now it reads the server's ACTUAL alerts (admin/state
  .alerts — debounced, deduped, resolved when they clear), and clicking it opens a drawer that lists
  them and NAVIGATES to the thing that is broken:

    - an alert about a SCREEN  → switch to that screen's mural and select it on the canvas (the
      Inspector then shows exactly the screen the alert is about);
    - an alert about a MACHINE → the Machines view, with the box highlighted (?machine=<id>);
    - an alert about neither (an image rebuild) → Settings.

  "Healthy" is a real state, not the absence of a number — the chip says so, and stays quiet.
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";
import type { Alert } from "@polyptic/protocol";

import { useConsoleStore } from "../../stores/console";
import { formatRelativeShort } from "../../time";

const store = useConsoleStore();
const router = useRouter();

const open = ref(false);
const root = ref<HTMLElement | null>(null);

const alerts = computed<Alert[]>(() => store.alerts);
const count = computed(() => alerts.value.length);
const screenCount = computed(() => store.screens.length);

const chipText = computed(() =>
  count.value > 0 ? `· ${count.value} ${count.value === 1 ? "alert" : "alerts"}` : "· healthy",
);
const chipColor = computed(() => (count.value > 0 ? "var(--bad)" : "var(--ok)"));

function toggle() {
  open.value = !open.value;
}

/** Take the operator to the thing the alert is about — the whole point of a clickable alert. */
function jumpTo(alert: Alert) {
  open.value = false;
  const screenId = alert.subject.screenId;
  if (screenId) {
    const placement = store.placementForScreen(screenId);
    if (placement) {
      store.setActiveMural(placement.muralId);
      const wall = store.wallForScreen(screenId);
      if (wall) store.selectWall(wall.id);
      else store.select([screenId]);
      void router.push({ name: "wall" });
      return;
    }
    // Unplaced screens have nowhere to be selected on the canvas — its machine is the next best thing.
  }
  const machineId = alert.subject.machineId;
  if (machineId) {
    void router.push({ name: "machines", query: { machine: machineId } });
    return;
  }
  void router.push({ name: "settings" });
}

/** Where clicking this alert lands — shown on the row so the click is never a surprise. */
function destination(alert: Alert): string {
  if (alert.subject.screenId && store.placementForScreen(alert.subject.screenId)) return "Show on the wall";
  if (alert.subject.machineId) return "Open the machine";
  return "Open settings";
}

function onDocMouseDown(e: MouseEvent) {
  if (open.value && root.value && !root.value.contains(e.target as Node)) open.value = false;
}

const nowMs = ref(Date.now());
let timer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  document.addEventListener("mousedown", onDocMouseDown, true);
  timer = setInterval(() => {
    nowMs.value = Date.now();
  }, 15_000);
});
onUnmounted(() => {
  document.removeEventListener("mousedown", onDocMouseDown, true);
  if (timer !== null) clearInterval(timer);
});
</script>

<template>
  <div ref="root" class="chip-wrap">
    <button
      class="screens-chip"
      :class="{ open, firing: count > 0 }"
      :title="count > 0 ? 'Show the active alerts' : 'Every screen is healthy'"
      @click="toggle"
    >
      {{ screenCount }} screens
      <span class="alert-text" :style="{ color: chipColor }">{{ chipText }}</span>
    </button>

    <div v-if="open" class="dropdown">
      <div class="drop-head">
        <span class="drop-title">Alerts</span>
        <router-link class="drop-link" :to="{ name: 'settings' }" @click="open = false">
          Notifications →
        </router-link>
      </div>

      <div class="drop-body">
        <button v-for="a in alerts" :key="a.id" class="alert-row" @click="jumpTo(a)">
          <span class="alert-dot"></span>
          <span class="alert-meta">
            <span class="alert-title">{{ a.title }}</span>
            <span v-if="a.detail" class="alert-detail">{{ a.detail }}</span>
            <span class="alert-foot">
              {{ formatRelativeShort(a.firedAt ?? a.since, nowMs) }} · {{ destination(a) }}
            </span>
          </span>
          <span class="alert-go">→</span>
        </button>

        <div v-if="!alerts.length" class="alert-empty">
          Nothing is broken. Screens and boxes that go dark show up here — and, if you have set up a
          notification rule, they call you.
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chip-wrap {
  position: relative;
}
.screens-chip {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: var(--muted-bg);
  font-size: 12px;
  color: var(--fg2);
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
}
.screens-chip:hover,
.screens-chip.open {
  border-color: var(--line);
}
.screens-chip.firing {
  background: var(--bad-soft, var(--muted-bg));
}
.alert-text {
  font-weight: 600;
}

.dropdown {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  width: 340px;
  max-height: 420px;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: 0 12px 32px rgb(0 0 0 / 18%);
  z-index: 40;
  overflow: hidden;
}
.drop-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
}
.drop-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--fg2);
}
.drop-link {
  font-size: 11px;
  color: var(--accent-fg);
  text-decoration: none;
  font-weight: 500;
}
.drop-link:hover {
  text-decoration: underline;
}
.drop-body {
  overflow-y: auto;
  padding: 6px;
}
.alert-row {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  width: 100%;
  padding: 9px;
  border: 1px solid transparent;
  border-radius: 9px;
  background: transparent;
  text-align: left;
  font-family: inherit;
  cursor: pointer;
}
.alert-row:hover {
  background: var(--muted-bg);
  border-color: var(--line);
}
.alert-dot {
  width: 7px;
  height: 7px;
  margin-top: 5px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--bad);
}
.alert-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}
.alert-title {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--fg2);
}
.alert-detail {
  font-size: 11px;
  color: var(--muted);
  line-height: 1.45;
}
.alert-foot {
  font-size: 10.5px;
  color: var(--muted2);
}
.alert-go {
  color: var(--muted2);
  font-size: 13px;
  margin-top: 2px;
}
.alert-empty {
  padding: 14px 10px;
  font-size: 11.5px;
  color: var(--muted2);
  line-height: 1.6;
}
</style>
