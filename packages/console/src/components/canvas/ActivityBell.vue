<!--
  ActivityBell — the Live Activity feed as a bell icon + dropdown in the Wall top bar
  (POL-72, design handoff v3 §4; replaces the old always-visible ActivityFeed pane).

  Unread model: an entry is unread if it arrived while the dropdown was closed. On mount the
  current history is the baseline (read) — only events that land after that count toward the
  badge, which caps at "9+". Opening the dropdown marks everything read; any click outside
  (including the canvas) closes it.

  Source of truth is store.activity, mirrored from the OPTIONAL admin/state.activity
  (newest-first, pre-bounded by the server; defaults to [] against older servers).
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import type { ActivityEvent } from "@polyptic/protocol";
import { useConsoleStore } from "../../stores/console";
import { formatRelativeShort } from "../../time";

const store = useConsoleStore();

// Cap the visible list so a long-lived session's feed can't grow unbounded in the DOM. The server
// already bounds the log (~50); we show the freshest slice.
const MAX_VISIBLE = 40;

const open = ref(false);
const root = ref<HTMLElement | null>(null);

// Ids already seen with the dropdown open (or present at baseline). Everything else is unread.
const readIds = ref<Set<string>>(new Set(store.activity.map((ev) => ev.id)));

// History shouldn't badge: the baseline is whatever the feed holds when this view first syncs.
// If the store is already live (view remount) that's now; on a fresh page load it's the first
// admin/state snapshot, which lands AFTER setup — so the first activity assignment re-baselines.
let baselined = store.connected || store.activity.length > 0;

const events = computed(() => store.activity.slice(0, MAX_VISIBLE));
const unreadCount = computed(
  () => store.activity.filter((ev) => !readIds.value.has(ev.id)).length,
);
const badgeText = computed(() => (unreadCount.value > 9 ? "9+" : String(unreadCount.value)));

function markAllRead() {
  readIds.value = new Set(store.activity.map((ev) => ev.id));
}

function toggle() {
  open.value = !open.value;
  if (open.value) markAllRead();
}

// Events that land while the dropdown is OPEN are read immediately — the operator is looking at them.
watch(
  () => store.activity,
  () => {
    if (!baselined) {
      baselined = true;
      markAllRead();
    } else if (open.value) {
      markAllRead();
    }
  },
);

// Any click outside the bell/dropdown (canvas included) closes it. Capture phase, because the
// Vue Flow pane stops mousedown propagation for its own pan/select handling.
function onDocMouseDown(e: MouseEvent) {
  if (open.value && root.value && !root.value.contains(e.target as Node)) open.value = false;
}

// A ticking clock so the relative timestamps ("now" → "1m" → "2m") refresh on their own. 15s is
// fine-grained enough for the "now"→"1m" flip at 45s without busy-looping.
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

/** Map a severity to the console's colour token used for the leading dot. */
function severityColor(sev: ActivityEvent["severity"]): string {
  switch (sev) {
    case "good":
      return "var(--ok)";
    case "bad":
      return "var(--bad)";
    case "warn":
      return "var(--warn)";
    case "accent":
      return "var(--accent)"; // operator-initiated lifecycle events (POL-68)
    default:
      return "var(--muted2)"; // info
  }
}

// Connective keywords that separate an event's subject (which we bold) from its predicate. We bold
// the leading subject only when there's a clean, short head before one of these — verb-leading lines
// ("Applied scene …", "Combined 3 panels …") just render plain, which is safe and tidy.
const SPLIT_RE = /\s(?=went\b|connected\b|disconnected\b|renamed\b|approved\b|rejected\b|→|assigned\b|is\b|now\b)/i;

/** Split an event's text into a bold subject head and a plain tail. Falls back to an empty head
 *  (whole line plain) when no clean subject boundary is found or the head is implausibly long. */
function parts(text: string): { head: string; tail: string } {
  const m = SPLIT_RE.exec(text);
  if (m && m.index > 0 && m.index <= 40) {
    return { head: text.slice(0, m.index), tail: text.slice(m.index) };
  }
  return { head: "", tail: text };
}
</script>

<template>
  <div ref="root" class="bell-wrap">
    <button class="bell-btn" :class="{ open }" title="Live activity" @click="toggle">
      <svg
        width="17"
        height="17"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
      </svg>
      <span v-if="unreadCount > 0 && !open" class="badge">{{ badgeText }}</span>
    </button>

    <div v-if="open" class="dropdown">
      <div class="drop-head">
        <span class="drop-title">Live activity</span>
        <span class="pulse-dot"></span>
      </div>
      <div class="drop-body">
        <div v-for="ev in events" :key="ev.id" class="feed-row">
          <span class="feed-dot" :style="{ background: severityColor(ev.severity) }"></span>
          <span class="feed-time">{{ formatRelativeShort(ev.at, nowMs) }}</span>
          <div class="feed-text">
            <b v-if="parts(ev.text).head">{{ parts(ev.text).head }}</b>{{ parts(ev.text).tail }}
          </div>
        </div>
        <div v-if="!events.length" class="feed-empty">No activity yet</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bell-wrap {
  position: relative;
}
.bell-btn {
  position: relative;
  width: 34px;
  height: 34px;
  border-radius: 9px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}
.bell-btn:hover {
  background: var(--muted-bg);
}
.bell-btn.open {
  background: var(--muted-bg);
  color: var(--fg);
}
.badge {
  position: absolute;
  top: -3px;
  right: -3px;
  min-width: 15px;
  height: 15px;
  padding: 0 3px;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  font-size: 9px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}

.dropdown {
  position: absolute;
  top: 42px;
  right: 0;
  width: 296px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: var(--shadow-lg);
  z-index: 200;
  animation: bell-fadein 0.15s ease;
  overflow: hidden;
}
@keyframes bell-fadein {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
.drop-head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 12px 15px;
  border-bottom: 1px solid var(--line);
}
.drop-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--fg);
}
.pulse-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ok);
  animation: bell-pulse 2s infinite;
}
@keyframes bell-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.3;
  }
}
.drop-body {
  max-height: 320px;
  overflow-y: auto;
  padding: 13px 15px;
  display: flex;
  flex-direction: column;
  gap: 13px;
}
.feed-row {
  display: flex;
  gap: 9px;
}
.feed-dot {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  margin-top: 5px;
}
.feed-time {
  flex: 0 0 auto;
  min-width: 24px;
  padding-top: 1px;
  font-size: 10.5px;
  color: var(--muted2);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.feed-text {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  color: var(--fg2);
  line-height: 1.45;
  word-break: break-word;
}
.feed-text b {
  font-weight: 600;
  color: var(--fg);
}
.feed-empty {
  font-size: 11.5px;
  color: var(--muted2);
  line-height: 1.55;
  padding: 2px 0;
}
</style>
