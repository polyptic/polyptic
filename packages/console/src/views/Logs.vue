<!--
  Logs.vue — the place you go the morning after (POL-187).

  THE PROBLEM THIS VIEW ANSWERS: a wall was left asleep and working, some panels were dark in the
  morning, and there was nothing to look at. The boxes had narrated themselves perfectly well — into
  a systemd user journal on a diskless box, which the reboot took with it.

  So: one merged timeline, fleet-wide by default, over all three emitters — the AGENT (what the box
  launched, which panel it slept), the PLAYER (what the glass saw) and the SERVER (what the schedule
  decided and what it sent). Filters narrow it; Download exports EXACTLY the view on screen, as the
  plain text you paste into a ticket.

  TWO CLOCKS, ON PURPOSE. Every line shows the SERVER's arrival time (which is what the range and
  the ordering run on — a box mid-cold-boot can be years out, and "show me last night" must not
  silently miss it) and flags any line whose box clock disagrees by more than a couple of minutes.
  That skew is not noise: a box that thinks it is 1970 is a box whose schedule fired at the wrong
  time, which is itself a candidate explanation for a dark panel.

  NO LIVE TAIL. "Watch it now" is what the remote shell (POL-59) is for; this place is for reading
  back what already happened. Refresh is a button, deliberately.
-->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import type { LogLevel, LogQuery, LogSource, StoredLogEvent } from "@polyptic/protocol";

import { fetchLogs, logsExportUrl } from "../api";
import { useConsoleStore } from "../stores/console";

const store = useConsoleStore();

// ── the query ───────────────────────────────────────────────────────────────

/**
 * Time ranges, in the operator's own words. "Last night" is the one this ticket was written for:
 * 18:00 yesterday → 09:00 today, in the BROWSER's local time (which is the operator's, and the one
 * they mean when they say "last night"), converted to absolute ISO instants for the server.
 */
const RANGES = [
  { id: "1h", label: "Last hour" },
  { id: "8h", label: "Last 8 hours" },
  { id: "night", label: "Last night (18:00–09:00)" },
  { id: "24h", label: "Last 24 hours" },
  { id: "7d", label: "Last 7 days" },
] as const;
type RangeId = (typeof RANGES)[number]["id"];

const range = ref<RangeId>("night");
const machineId = ref("");
const minLevel = ref<LogLevel | "">("");
const source = ref<LogSource | "">("");
const search = ref("");
const limit = ref(500);

const lines = ref<StoredLogEvent[]>([]);
const machines = ref<string[]>([]);
const truncated = ref(false);
const loading = ref(false);
const errorMsg = ref<string | null>(null);
const loaded = ref(false);

/** The absolute [since, until) the chosen range means right now. */
function resolveRange(id: RangeId): { since: string; until: string } {
  const now = new Date();
  const until = now.toISOString();
  if (id === "night") {
    // 09:00 today (or 09:00 yesterday, if it is still before nine and "last night" is still running)
    // back to 18:00 the evening before it.
    const end = new Date(now);
    end.setHours(9, 0, 0, 0);
    if (end.getTime() > now.getTime()) end.setTime(now.getTime());
    const start = new Date(end);
    start.setDate(start.getDate() - 1);
    start.setHours(18, 0, 0, 0);
    return { since: start.toISOString(), until: end.toISOString() };
  }
  const hours = id === "1h" ? 1 : id === "8h" ? 8 : id === "24h" ? 24 : 24 * 7;
  return { since: new Date(now.getTime() - hours * 3600_000).toISOString(), until };
}

/** The query the list and the Download link both use — so the export is exactly what is on screen. */
const query = computed<LogQuery>(() => {
  const { since, until } = resolveRange(range.value);
  return {
    since,
    until,
    limit: limit.value,
    ...(machineId.value ? { machineId: machineId.value } : {}),
    ...(minLevel.value ? { minLevel: minLevel.value } : {}),
    ...(source.value ? { source: source.value } : {}),
    ...(search.value.trim() ? { search: search.value.trim() } : {}),
  };
});

const downloadUrl = computed(() => logsExportUrl(query.value));

async function load(): Promise<void> {
  loading.value = true;
  errorMsg.value = null;
  try {
    const result = await fetchLogs(query.value);
    lines.value = result.lines;
    machines.value = result.machines;
    truncated.value = result.truncated;
    loaded.value = true;
  } catch (err) {
    errorMsg.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
}

onMounted(load);
// Re-run on any filter change EXCEPT the free-text box, which would fire a query per keystroke.
watch([range, machineId, minLevel, source, limit], () => void load());

/** "Load older" widens the cap rather than paging — the range is the real bound, the cap is a guard. */
function loadMore(): void {
  limit.value = Math.min(2000, limit.value * 2);
}

// ── presentation ────────────────────────────────────────────────────────────

/** Machines the sink holds lines for, labelled with the friendly name the console knows them by. */
const machineOptions = computed(() =>
  machines.value.map((id) => ({
    id,
    label: id === "server" ? "Control plane" : (store.machines.find((m) => m.id === id)?.label ?? id),
  })),
);

/** A screen's friendly name, so a line reads "Atrium Left" rather than `screen-7`. */
function screenLabel(id: string | undefined): string | null {
  if (!id) return null;
  return store.screens.find((s) => s.id === id)?.friendlyName ?? id;
}

function machineLabel(id: string | undefined): string {
  if (!id) return "control plane";
  if (id === "server") return "control plane";
  return store.machines.find((m) => m.id === id)?.label ?? id;
}

/** Server-clock time, shown to the second — the clock everything here is ordered and ranged by. */
function stamp(line: StoredLogEvent): string {
  const d = new Date(line.receivedAt);
  return Number.isNaN(d.getTime()) ? line.receivedAt : d.toLocaleString();
}

/** More than two minutes between the box's clock and ours is worth saying out loud. */
const SKEW_TOLERANCE_MS = 120_000;

function skew(line: StoredLogEvent): string | null {
  const at = Date.parse(line.at);
  const received = Date.parse(line.receivedAt);
  if (!Number.isFinite(at) || !Number.isFinite(received)) return null;
  const delta = at - received;
  if (Math.abs(delta) < SKEW_TOLERANCE_MS) return null;
  const minutes = Math.round(Math.abs(delta) / 60_000);
  if (minutes < 120) return `box clock ${delta > 0 ? "ahead" : "behind"} by ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `box clock ${delta > 0 ? "ahead" : "behind"} by ${hours} h`;
  return `box clock reads ${new Date(at).toLocaleString()}`;
}

function fieldPairs(line: StoredLogEvent): string {
  if (!line.fields) return "";
  return Object.entries(line.fields)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join("  ");
}
</script>

<template>
  <div class="page">
    <div class="page-inner">
      <div class="head">
        <div class="head-text">
          <h1 class="title">Logs</h1>
          <p class="subtitle">
            What the boxes, the screens and the control plane said. Times are the server's, so a box
            with a wrong clock still lands in the right range — its own clock is flagged where the two
            disagree.
          </p>
        </div>
        <div class="head-actions">
          <button class="btn ghost" :disabled="loading" @click="load">
            {{ loading ? "Loading…" : "Refresh" }}
          </button>
          <a class="btn" :href="downloadUrl" download>Download this view</a>
        </div>
      </div>

      <!-- ── filters ─────────────────────────────────────────────────────── -->
      <div class="filters">
        <select v-model="range" class="field">
          <option v-for="r in RANGES" :key="r.id" :value="r.id">{{ r.label }}</option>
        </select>

        <select v-model="machineId" class="field">
          <option value="">All machines</option>
          <option v-for="m in machineOptions" :key="m.id" :value="m.id">{{ m.label }}</option>
        </select>

        <select v-model="minLevel" class="field">
          <option value="">Every level</option>
          <option value="info">Info and above</option>
          <option value="warn">Warnings and errors</option>
          <option value="error">Errors only</option>
        </select>

        <select v-model="source" class="field">
          <option value="">Everything</option>
          <option value="agent">Boxes</option>
          <option value="player">Screens</option>
          <option value="server">Control plane</option>
        </select>

        <input
          v-model="search"
          class="field grow"
          placeholder="Search the text…"
          @keyup.enter="load"
        />
        <button class="btn ghost" @click="load">Search</button>
      </div>

      <div v-if="errorMsg" class="query-error">⚠ {{ errorMsg }}</div>

      <!-- ── the timeline ────────────────────────────────────────────────── -->
      <div v-if="lines.length" class="lines">
        <div v-for="(line, i) in lines" :key="`${line.receivedAt}-${i}`" class="line" :class="line.level">
          <span class="when">{{ stamp(line) }}</span>
          <span class="level" :class="line.level">{{ line.level }}</span>
          <span class="who">
            {{ machineLabel(line.machineId) }}
            <span v-if="screenLabel(line.screenId)" class="screen">· {{ screenLabel(line.screenId) }}</span>
          </span>
          <span class="subsystem">{{ line.subsystem }}</span>
          <span class="msg">
            {{ line.msg }}
            <span v-if="fieldPairs(line)" class="fields">{{ fieldPairs(line) }}</span>
            <span v-if="skew(line)" class="skew" title="This box's own clock disagrees with the server's">
              ⏱ {{ skew(line) }}
            </span>
          </span>
        </div>
      </div>

      <div v-else-if="loaded && !loading" class="empty">
        <span class="empty-glyph">☰</span>
        <span class="empty-title">Nothing in this range</span>
        <span class="empty-sub">
          Widen the range or clear the filters. A box only ships once it has an encrypted channel to
          the server — until then it keeps its lines spooled locally and says so in its own journal.
        </span>
      </div>

      <div v-if="truncated" class="more">
        <span class="more-text">Showing the newest {{ lines.length }} lines in this range.</span>
        <button class="btn ghost" :disabled="limit >= 2000" @click="loadMore">Load older</button>
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
  max-width: 1180px;
  margin: 0 auto;
  padding: 30px 32px 60px;
}

.head {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 20px;
}
.head-text {
  flex: 1;
}
.title {
  font-size: 21px;
  font-weight: 600;
  letter-spacing: -0.02em;
  margin: 0 0 4px;
}
.subtitle {
  font-size: 13.5px;
  color: var(--muted);
  margin: 0;
  line-height: 1.5;
  max-width: 70ch;
}
.head-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.btn {
  padding: 9px 16px;
  border-radius: 9px;
  border: none;
  background: var(--primary);
  color: var(--primary-fg);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  font-family: inherit;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
}
.btn:hover {
  opacity: 0.92;
}
.btn.ghost {
  background: transparent;
  border: 1px solid var(--line2);
  color: var(--fg2);
}
.btn.ghost:hover:not(:disabled) {
  background: var(--muted-bg);
  opacity: 1;
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
}
.field {
  padding: 8px 11px;
  border-radius: 9px;
  border: 1px solid var(--line2);
  background: var(--card);
  color: var(--fg);
  font-size: 13px;
  font-family: inherit;
}
.field.grow {
  flex: 1;
  min-width: 200px;
}

/* The failed-query banner. Named `query-error` and NOT `error`, because the level classes on each
   row (`.line.error`, `.level.error`) come from `line.level` — a bare `.error` rule would draw a red
   box around every error LINE as well as the banner. */
.query-error {
  border: 1px solid var(--bad);
  background: var(--bad-soft);
  color: var(--bad);
  border-radius: 9px;
  padding: 10px 13px;
  font-size: 13px;
  margin-bottom: 14px;
}

/* the timeline */
.lines {
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--card);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
}
.line {
  display: grid;
  grid-template-columns: 160px 46px 190px 92px 1fr;
  gap: 10px;
  padding: 7px 14px;
  font-size: 12px;
  line-height: 1.5;
  border-bottom: 1px solid var(--line);
  align-items: baseline;
}
.line:last-child {
  border-bottom: none;
}
.line.warn {
  background: var(--warn-soft);
}
.line.error {
  background: var(--bad-soft);
}

.when {
  color: var(--muted2);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.level {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted2);
}
.level.warn {
  color: var(--warn);
}
.level.error {
  color: var(--bad);
}
.who {
  color: var(--fg2);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.screen {
  font-weight: 400;
  color: var(--muted);
}
.subsystem {
  color: var(--muted);
  font-family: var(--mono, ui-monospace, SFMono-Regular, monospace);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.msg {
  color: var(--fg);
  font-family: var(--mono, ui-monospace, SFMono-Regular, monospace);
  font-size: 11.5px;
  word-break: break-word;
}
.fields {
  color: var(--muted2);
  margin-left: 8px;
}
.skew {
  display: inline-block;
  margin-left: 8px;
  padding: 0 6px;
  border-radius: 6px;
  background: var(--warn-soft);
  color: var(--warn);
  font-size: 10.5px;
  font-weight: 600;
  white-space: nowrap;
}

.more {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 16px 0 0;
}
.more-text {
  font-size: 12.5px;
  color: var(--muted);
}

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 6px;
  padding: 60px 20px;
  border: 1px dashed var(--line2);
  border-radius: 12px;
}
.empty-glyph {
  font-size: 26px;
  color: var(--muted2);
}
.empty-title {
  font-size: 14px;
  font-weight: 600;
}
.empty-sub {
  font-size: 12.5px;
  color: var(--muted);
  max-width: 52ch;
  line-height: 1.55;
}

@media (max-width: 900px) {
  .line {
    grid-template-columns: 1fr;
    gap: 2px;
    padding: 10px 14px;
  }
}
</style>
