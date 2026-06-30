<!--
  ActivityFeed — the Live Activity panel (D25), shown in the Wall view's right rail beneath the
  Inspector. Mirrors docs/design/console.dc.html's "Live activity" stream: a scrollable, newest-first
  list of human-readable events, each with a severity dot, the event text (subject bolded when it's
  cheap to detect), and a compact relative timestamp ("now", "4m", "1h") that stays fresh via a
  ticking clock.

  Source of truth is store.activity, mirrored from the OPTIONAL admin/state.activity (newest-first,
  pre-bounded by the server). When a server omits the field the store defaults it to [], so this
  panel simply shows its empty state — nothing breaks for older servers.
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { ActivityEvent } from "@polyptic/protocol";
import { useConsoleStore } from "../../stores/console";
import { formatRelativeShort } from "../../time";

const store = useConsoleStore();

// Cap the visible list so a long-lived session's feed can't grow unbounded in the DOM. The server
// already bounds the log (~50); we show the freshest slice.
const MAX_VISIBLE = 40;

// A ticking clock so the relative timestamps ("now" → "1m" → "2m") refresh on their own. 15s is
// fine-grained enough for the "now"→"1m" flip at 45s without busy-looping.
const nowMs = ref(Date.now());
let timer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  timer = setInterval(() => {
    nowMs.value = Date.now();
  }, 15_000);
});
onUnmounted(() => {
  if (timer !== null) clearInterval(timer);
});

const events = computed(() => store.activity.slice(0, MAX_VISIBLE));

/** Map a severity to the console's colour token used for the leading dot. */
function severityColor(sev: ActivityEvent["severity"]): string {
  switch (sev) {
    case "good":
      return "var(--ok)";
    case "bad":
      return "var(--bad)";
    case "warn":
      return "var(--warn)";
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
  <section class="feed">
    <div class="feed-head">Live activity</div>

    <div v-if="events.length" class="feed-list">
      <div v-for="ev in events" :key="ev.id" class="feed-row">
        <span class="feed-time">{{ formatRelativeShort(ev.at, nowMs) }}</span>
        <span class="feed-dot" :style="{ background: severityColor(ev.severity) }"></span>
        <div class="feed-text">
          <b v-if="parts(ev.text).head">{{ parts(ev.text).head }}</b>{{ parts(ev.text).tail }}
        </div>
      </div>
    </div>

    <div v-else class="feed-empty">No activity yet</div>
  </section>
</template>

<style scoped>
.feed {
  flex: 1 1 auto;
  min-height: 140px;
  display: flex;
  flex-direction: column;
  padding: 18px 16px;
  border-top: 1px solid var(--line);
  border-left: 1px solid var(--line);
  background: var(--surface);
  overflow-y: auto;
}
.feed-head {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  margin-bottom: 15px;
  flex: 0 0 auto;
}
.feed-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.feed-row {
  display: flex;
  align-items: baseline;
  gap: 9px;
}
.feed-time {
  flex: 0 0 26px;
  min-width: 26px;
  padding-top: 1px;
  font-size: 10.5px;
  color: var(--muted2);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.feed-dot {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  transform: translateY(-1px);
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
