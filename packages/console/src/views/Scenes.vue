<!--
  Scenes.vue — the SCENES VIEW (Phase 3d) and, since POL-89/D93, the SCHEDULER.

  A scene is a named SNAPSHOT of one mural's whole wall — layout, grouping and content — re-appliable
  in one click. WHEN it plays used to be an `at HH:MM` box that stored a time and never fired (D24's
  illustrative clause). That decoy is gone. In its place:

    · a DAYPART LIBRARY  — named windows of the day ("Opening hours" 08:00–18:00, "Lunch" 12:00–13:30,
      "After hours" 18:00–08:00, which wraps past midnight);
    · a per-scene RECURRENCE EDITOR — this scene, in that daypart, on these weekdays, at this
      priority, optionally between two dates;
    · a "WHAT PLAYS WHEN" WEEK STRIP — the resolved schedule, priority conflicts marked, painted by
      the SAME resolver the server's ticker fires from (@polyptic/protocol), so the strip cannot
      promise the operator something the wall will not do;
    · the DEFAULT SCENE — the always-on floor that fills every gap — and the deployment's ONE
      timezone, both explicit, both here.

  All reads/writes go through the Pinia store; the server owns resolution and applies scenes through
  the ordinary apply path (instant WS fan-out, no reload).
-->
<script setup lang="ts">
import { computed, ref } from "vue";
import {
  isValidTimeZone,
  resolveWeek,
  shiftDate,
  startOfWeek,
  timeOfDay,
} from "@polyptic/protocol";
import type { Schedule, ScheduleSegment, ScheduleSet } from "@polyptic/protocol";
import { useConsoleStore } from "../stores/console";
import SceneDiffCard from "../components/canvas/SceneDiffCard.vue";

const store = useConsoleStore();

const activeMural = computed(() => store.activeMural);
const scenes = computed(() => store.activeMuralScenes);
const dayparts = computed(() => store.dayparts);
const scheduler = computed(() => store.scheduler);

/** The exact set the server's ticker resolves from — it rides `admin/state`. */
const scheduleSet = computed<ScheduleSet | null>(() =>
  scheduler.value
    ? { dayparts: store.dayparts, schedules: store.schedules, settings: scheduler.value }
    : null,
);

const sceneName = (id: string | null): string =>
  id ? (store.scenes.find((s) => s.id === id)?.name ?? "(deleted scene)") : "";
const daypartName = (id: string): string =>
  dayparts.value.find((d) => d.id === id)?.name ?? "(deleted daypart)";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS = [1, 2, 3, 4, 5];

/** Plain English for a schedule's recurrence — what the operator reads on the scene row. */
function recurrenceLabel(s: Schedule): string {
  const days =
    s.days.length === 7
      ? "Every day"
      : s.days.length === 5 && WEEKDAYS.every((d) => s.days.includes(d))
        ? "Weekdays"
        : s.days.length === 2 && s.days.includes(0) && s.days.includes(6)
          ? "Weekends"
          : s.days.map((d) => DAY_LABELS[d]).join(", ");
  const range = s.from || s.until ? ` · ${s.from ?? "…"} → ${s.until ?? "…"}` : "";
  return `${days}${range}`;
}

const schedulesForScene = (sceneId: string): Schedule[] =>
  store.schedules
    .filter((s) => s.sceneId === sceneId)
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));

// A stable colour per scene, so the week strip and the scene rows agree at a glance.
function sceneHue(sceneId: string): number {
  const index = store.scenes.findIndex((s) => s.id === sceneId);
  return ((index < 0 ? 0 : index) * 67) % 360;
}
const sceneColor = (sceneId: string | null): string =>
  sceneId ? `hsl(${sceneHue(sceneId)} 62% 48%)` : "transparent";

// ── the week strip ────────────────────────────────────────────────────────────

const todayInZone = computed<string>(() => {
  const tz = scheduler.value?.timezone;
  const zone = tz && isValidTimeZone(tz) ? tz : "UTC";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return parts; // en-CA formats as YYYY-MM-DD
});

const weekOffset = ref(0);
const weekStart = computed(() => shiftDate(startOfWeek(todayInZone.value), weekOffset.value * 7));
const week = computed(() =>
  scheduleSet.value ? resolveWeek(weekStart.value, scheduleSet.value) : [],
);
const HOUR_TICKS = [0, 6, 12, 18];

const segmentTitle = (seg: ScheduleSegment): string => {
  const window = `${timeOfDay(seg.startMinutes)}–${timeOfDay(seg.endMinutes)}`;
  if (seg.source === "none") return `${window} · nothing scheduled`;
  const who = seg.source === "default" ? `${sceneName(seg.sceneId)} (default scene)` : sceneName(seg.sceneId);
  const beaten = seg.overriddenScheduleIds.length
    ? ` · outranks ${seg.overriddenScheduleIds
        .map((id) => {
          const other = store.schedules.find((s) => s.id === id);
          return other ? `${sceneName(other.sceneId)} (p${other.priority})` : id;
        })
        .join(", ")}`
    : "";
  return `${window} · ${who}${beaten}`;
};

// ── scheduler settings ────────────────────────────────────────────────────────

const tzDraft = ref("");
const tzError = ref("");
const settingsBusy = ref(false);

function startTzEdit() {
  tzDraft.value = scheduler.value?.timezone ?? "UTC";
  tzError.value = "";
}
async function saveTimezone() {
  const tz = tzDraft.value.trim();
  if (!tz || tz === scheduler.value?.timezone) return;
  settingsBusy.value = true;
  tzError.value = (await store.updateSchedulerSettings({ timezone: tz })) ?? "";
  settingsBusy.value = false;
}
async function toggleScheduler(e: Event) {
  await store.updateSchedulerSettings({ enabled: (e.target as HTMLInputElement).checked });
}
async function setDefaultScene(e: Event) {
  const value = (e.target as HTMLSelectElement).value;
  await store.updateSchedulerSettings({ defaultSceneId: value === "" ? null : value });
}

// ── daypart library ───────────────────────────────────────────────────────────

const dpName = ref("");
const dpStart = ref("08:00");
const dpEnd = ref("18:00");
const dpError = ref("");
const dpBusy = ref(false);

async function addDaypart() {
  const name = dpName.value.trim();
  if (!name || dpBusy.value) return;
  dpBusy.value = true;
  dpError.value = (await store.createDaypart(name, dpStart.value, dpEnd.value)) ?? "";
  dpBusy.value = false;
  if (!dpError.value) dpName.value = "";
}
async function editDaypart(id: string, field: "name" | "start" | "end", e: Event) {
  const value = (e.target as HTMLInputElement).value;
  if (!value) return;
  dpError.value = (await store.updateDaypart(id, { [field]: value })) ?? "";
}
async function removeDaypart(id: string) {
  dpError.value = (await store.deleteDaypart(id)) ?? "";
}

// ── the per-scene recurrence editor ───────────────────────────────────────────

const editorSceneId = ref<string | null>(null);
const edDaypartId = ref("");
const edDays = ref<number[]>([...ALL_DAYS]);
const edPriority = ref(0);
const edFrom = ref("");
const edUntil = ref("");
const edError = ref("");
const edBusy = ref(false);

function openEditor(sceneId: string) {
  editorSceneId.value = sceneId;
  edDaypartId.value = dayparts.value[0]?.id ?? "";
  edDays.value = [...ALL_DAYS];
  edPriority.value = 0;
  edFrom.value = "";
  edUntil.value = "";
  edError.value = "";
}
function closeEditor() {
  editorSceneId.value = null;
  edBusy.value = false;
}
function toggleDay(day: number) {
  edDays.value = edDays.value.includes(day)
    ? edDays.value.filter((d) => d !== day)
    : [...edDays.value, day].sort((a, b) => a - b);
}
async function saveSchedule() {
  const sceneId = editorSceneId.value;
  if (!sceneId || edBusy.value) return;
  if (!edDaypartId.value) {
    edError.value = "add a daypart first — a schedule plays inside a named window of the day";
    return;
  }
  if (edDays.value.length === 0) {
    edError.value = "pick at least one day";
    return;
  }
  edBusy.value = true;
  edError.value =
    (await store.createSchedule({
      sceneId,
      daypartId: edDaypartId.value,
      days: edDays.value,
      priority: edPriority.value,
      enabled: true,
      from: edFrom.value || null,
      until: edUntil.value || null,
    })) ?? "";
  edBusy.value = false;
  if (!edError.value) closeEditor();
}

async function toggleSchedule(s: Schedule) {
  await store.updateSchedule(s.id, { enabled: !s.enabled });
}
async function bumpPriority(s: Schedule, delta: number) {
  const next = Math.min(999, Math.max(0, s.priority + delta));
  if (next !== s.priority) await store.updateSchedule(s.id, { priority: next });
}
async function removeSchedule(id: string) {
  await store.deleteSchedule(id);
}

// ── save-current-wall modal ───────────────────────────────────────────────────

const saveOpen = ref(false);
const newSceneName = ref("");
const saving = ref(false);

function openSave() {
  newSceneName.value = "";
  saveOpen.value = true;
}
function closeSave() {
  saveOpen.value = false;
  saving.value = false;
}
async function confirmSave() {
  const muralId = store.activeMuralId;
  if (!muralId || saving.value) return;
  const name = newSceneName.value.trim() || `Scene ${scenes.value.length + 1}`;
  saving.value = true;
  const ok = await store.saveScene(name, muralId);
  saving.value = false;
  if (ok) saveOpen.value = false;
}

// ── per-scene row actions ─────────────────────────────────────────────────────

function onRename(id: string, e: Event) {
  store.renameSceneTo(id, (e.target as HTMLInputElement).value);
}
function apply(id: string) {
  store.applyScene(id);
}

// ── apply preview (POL-95) ─────────────────────────────────────────────────────
// Hover or keyboard-focus Apply and the server says what would change on the wall before the wall
// visibly jumps. A read-out, never a gate — Apply is still one click.
const previewId = ref<string | null>(null);
let previewTimer: ReturnType<typeof setTimeout> | null = null;

function previewSoon(id: string) {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    previewId.value = id;
  }, 220);
}
function previewOff() {
  if (previewTimer) clearTimeout(previewTimer);
  previewId.value = null;
}
async function remove(id: string) {
  const scene = store.sceneById(id);
  const bound = schedulesForScene(id).length;
  const warning = bound
    ? `Delete scene "${scene?.name ?? id}"? Its ${bound} schedule${bound === 1 ? "" : "s"} will go with it.`
    : `Delete scene "${scene?.name ?? id}"? This can't be undone.`;
  if (window.confirm(warning)) await store.deleteScene(id);
}
</script>

<template>
  <div class="page">
    <div class="page-inner">
      <!-- header -->
      <header class="head">
        <div class="head-text">
          <h1 class="title">Scenes</h1>
          <p class="subtitle">
            Saved presets of the whole wall. Apply one in a click, or give it a window of the day and
            the wall runs itself.
            <span v-if="activeMural" class="mural-tag">· {{ activeMural.name }}</span>
          </p>
        </div>
        <button v-if="store.canAuthor" class="save-btn" :disabled="!store.activeMuralId" @click="openSave">
          + Save current wall
        </button>
      </header>

      <!-- ── the scheduler: master switch, timezone, default scene ─────────────── -->
      <section v-if="scheduler" class="card">
        <div class="card-head">
          <h2 class="card-title">Scheduler</h2>
          <label class="switch">
            <input type="checkbox" :checked="scheduler.enabled" @change="toggleScheduler" />
            <span>{{ scheduler.enabled ? "On" : "Off" }}</span>
          </label>
        </div>
        <div class="settings-grid">
          <label class="field-row">
            <span class="field-label">Timezone</span>
            <input
              class="input"
              :value="scheduler.timezone"
              :disabled="settingsBusy"
              @focus="startTzEdit"
              @input="tzDraft = ($event.target as HTMLInputElement).value"
              @change="saveTimezone"
              @keyup.enter="($event.target as HTMLInputElement).blur()"
            />
            <span class="hint">Every window is read in this zone. Clock changes never double-fire.</span>
          </label>
          <label class="field-row">
            <span class="field-label">Default scene</span>
            <select class="input" :value="scheduler.defaultSceneId ?? ''" @change="setDefaultScene">
              <option value="">— none (leave the wall alone) —</option>
              <option v-for="s in store.scenes" :key="s.id" :value="s.id">{{ s.name }}</option>
            </select>
            <span class="hint">The always-on floor: it fills every gap no window covers.</span>
          </label>
        </div>
        <div v-if="tzError" class="error">{{ tzError }}</div>
      </section>

      <!-- ── what plays when (the week strip) ──────────────────────────────────── -->
      <section v-if="scheduleSet" class="card">
        <div class="card-head">
          <h2 class="card-title">What plays when</h2>
          <div class="week-nav">
            <button class="nav-btn" @click="weekOffset -= 1">‹</button>
            <span class="week-label">{{ weekStart }} → {{ shiftDate(weekStart, 6) }}</span>
            <button class="nav-btn" @click="weekOffset += 1">›</button>
            <button v-if="weekOffset !== 0" class="nav-btn today" @click="weekOffset = 0">Today</button>
          </div>
        </div>

        <div class="strip">
          <div class="hours">
            <span v-for="h in HOUR_TICKS" :key="h" class="hour" :style="{ top: `${(h / 24) * 100}%` }">
              {{ String(h).padStart(2, "0") }}:00
            </span>
          </div>
          <div v-for="day in week" :key="day.date" class="day">
            <div class="day-head" :class="{ today: day.date === todayInZone }">
              <span class="day-name">{{ DAY_LABELS[day.weekday] }}</span>
              <span class="day-date">{{ day.date.slice(8) }}</span>
            </div>
            <div class="day-body">
              <div
                v-for="seg in day.segments"
                :key="`${day.date}-${seg.startMinutes}`"
                class="seg"
                :class="{ empty: seg.source === 'none', conflict: seg.overriddenScheduleIds.length > 0 }"
                :style="{
                  top: `${(seg.startMinutes / 1440) * 100}%`,
                  height: `${((seg.endMinutes - seg.startMinutes) / 1440) * 100}%`,
                  background: seg.sceneId ? sceneColor(seg.sceneId) : undefined,
                }"
                :title="segmentTitle(seg)"
              >
                <span v-if="seg.endMinutes - seg.startMinutes >= 75" class="seg-label">
                  {{ seg.source === "none" ? "—" : sceneName(seg.sceneId) }}
                </span>
              </div>
            </div>
          </div>
        </div>
        <div class="legend">
          <span class="legend-item"><span class="swatch conflict-swatch"></span> striped = a lower-priority window is being outranked here (hover for who)</span>
          <span v-if="!scheduler?.enabled" class="legend-item warn">The scheduler is OFF — this is what it would play.</span>
        </div>
      </section>

      <!-- ── daypart library ───────────────────────────────────────────────────── -->
      <section class="card">
        <div class="card-head">
          <h2 class="card-title">Dayparts</h2>
          <span class="card-sub">Named windows of the day. A window whose end is at or before its start wraps past midnight.</span>
        </div>
        <div v-if="dayparts.length" class="dp-list">
          <div v-for="d in dayparts" :key="d.id" class="dp-row">
            <input class="dp-name" :value="d.name" @change="editDaypart(d.id, 'name', $event)" />
            <input type="time" class="dp-time" :value="d.start" @change="editDaypart(d.id, 'start', $event)" />
            <span class="dp-dash">→</span>
            <input type="time" class="dp-time" :value="d.end" @change="editDaypart(d.id, 'end', $event)" />
            <span v-if="d.end <= d.start" class="dp-wrap">wraps midnight</span>
            <button class="del-btn" title="Delete daypart" @click="removeDaypart(d.id)">✕</button>
          </div>
        </div>
        <div class="dp-add">
          <input v-model="dpName" class="dp-name" placeholder="Daypart name…" @keyup.enter="addDaypart" />
          <input v-model="dpStart" type="time" class="dp-time" />
          <span class="dp-dash">→</span>
          <input v-model="dpEnd" type="time" class="dp-time" />
          <button class="apply-btn" :disabled="dpBusy || !dpName.trim()" @click="addDaypart">+ Add daypart</button>
        </div>
        <div v-if="dpError" class="error">{{ dpError }}</div>
      </section>

      <!-- ── scenes ────────────────────────────────────────────────────────────── -->
      <div v-if="scenes.length" class="list">
        <div v-for="s in scenes" :key="s.id" class="row">
          <div class="row-main">
            <span class="dot" :style="{ background: sceneColor(s.id) }"></span>
            <input
              class="name"
              :value="s.name"
              @change="onRename(s.id, $event)"
              @keyup.enter="($event.target as HTMLInputElement).blur()"
            />
            <span class="summary">{{ store.sceneSummary(s.id) }}</span>
            <span v-if="s.id === store.activeSceneId" class="active-badge">Active</span>
            <span v-if="s.id === scheduler?.defaultSceneId" class="default-badge">Default</span>
            <button v-if="store.canAuthor" class="apply-btn" @click="openEditor(s.id)">+ Schedule</button>
            <!-- POL-107: Apply is the ONE mutation a viewer holds — recalling a layout someone else
                 authored. Scheduling and deleting are operator verbs. POL-95: hovering/focusing Apply
                 previews the diff of what applying would change on the live wall. -->
            <div class="apply-wrap" @mouseenter="previewSoon(s.id)" @mouseleave="previewOff">
              <button
                class="apply-btn"
                @click="apply(s.id)"
                @focus="previewSoon(s.id)"
                @blur="previewOff"
              >
                Apply
              </button>
              <div v-if="previewId === s.id" class="preview">
                <SceneDiffCard :scene-id="s.id" />
              </div>
            </div>
            <button v-if="store.canAuthor" class="del-btn" title="Delete scene" @click="remove(s.id)">✕</button>
          </div>

          <div v-if="schedulesForScene(s.id).length" class="sched-list">
            <div v-for="sc in schedulesForScene(s.id)" :key="sc.id" class="sched-row" :class="{ off: !sc.enabled }">
              <span class="sched-daypart">{{ daypartName(sc.daypartId) }}</span>
              <span class="sched-rec">{{ recurrenceLabel(sc) }}</span>
              <span class="prio">
                <button class="prio-btn" title="Lower priority" @click="bumpPriority(sc, -1)">−</button>
                <span class="prio-value" title="Higher priority wins an overlap">p{{ sc.priority }}</span>
                <button class="prio-btn" title="Raise priority" @click="bumpPriority(sc, 1)">+</button>
              </span>
              <button class="sched-toggle" @click="toggleSchedule(sc)">{{ sc.enabled ? "On" : "Off" }}</button>
              <button class="del-btn small" title="Delete schedule" @click="removeSchedule(sc.id)">✕</button>
            </div>
          </div>
        </div>
      </div>

      <!-- empty -->
      <div v-else class="empty">
        <span class="empty-glyph">▦</span>
        <span class="empty-title">No scenes saved for this mural yet</span>
        <span class="empty-sub">
          Lay out the wall on the Wall view, then save it here as a scene you can re-apply in one
          click — or hand to the scheduler.
        </span>
        <button v-if="store.canAuthor" class="save-btn ghost" :disabled="!store.activeMuralId" @click="openSave">
          + Save current wall
        </button>
      </div>
    </div>

    <!-- ── recurrence editor ───────────────────────────────────────────────────── -->
    <div v-if="editorSceneId" class="scrim" @mousedown.self="closeEditor">
      <div class="modal wide" role="dialog" aria-modal="true">
        <div class="modal-title">Schedule “{{ sceneName(editorSceneId) }}”</div>
        <div class="modal-sub">
          The scene plays inside a daypart, on the days you pick. Where two windows overlap, the
          higher priority wins.
        </div>

        <label class="field-row">
          <span class="field-label">Daypart</span>
          <select v-model="edDaypartId" class="input">
            <option v-for="d in dayparts" :key="d.id" :value="d.id">
              {{ d.name }} ({{ d.start }}–{{ d.end }})
            </option>
          </select>
        </label>

        <div class="field-row">
          <span class="field-label">Days</span>
          <div class="days">
            <button
              v-for="d in ALL_DAYS"
              :key="d"
              class="day-btn"
              :class="{ on: edDays.includes(d) }"
              @click="toggleDay(d)"
            >
              {{ DAY_LABELS[d] }}
            </button>
            <button class="day-preset" @click="edDays = [...ALL_DAYS]">Every day</button>
            <button class="day-preset" @click="edDays = [...WEEKDAYS]">Weekdays</button>
          </div>
        </div>

        <label class="field-row">
          <span class="field-label">Priority</span>
          <input v-model.number="edPriority" type="number" min="0" max="999" class="input narrow" />
          <span class="hint">Higher wins an overlap. Ties go to the window that started most recently, then the shorter one, then the older schedule.</span>
        </label>

        <div class="field-row">
          <span class="field-label">Dates (optional)</span>
          <div class="range">
            <input v-model="edFrom" type="date" class="input" />
            <span class="dp-dash">→</span>
            <input v-model="edUntil" type="date" class="input" />
          </div>
        </div>

        <div v-if="edError" class="error">{{ edError }}</div>
        <div class="modal-actions">
          <button class="btn-secondary" @click="closeEditor">Cancel</button>
          <button class="btn-primary" :disabled="edBusy" @click="saveSchedule">Save schedule</button>
        </div>
      </div>
    </div>

    <!-- ── save-current-wall modal ─────────────────────────────────────────────── -->
    <div v-if="saveOpen" class="scrim" @mousedown.self="closeSave">
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-title">Save current wall as scene</div>
        <div class="modal-sub">
          Captures every screen &amp; surface's content and layout. Switch back in one click.
        </div>
        <input
          v-model="newSceneName"
          class="field"
          placeholder="Scene name…"
          autofocus
          @keyup.enter="confirmSave"
        />
        <div class="modal-actions">
          <button class="btn-secondary" @click="closeSave">Cancel</button>
          <button class="btn-primary" :disabled="saving" @click="confirmSave">Save scene</button>
        </div>
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
  max-width: 980px;
  margin: 0 auto;
  padding: 30px 32px 60px;
}

.head {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 24px;
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
}
.mural-tag {
  color: var(--fg2);
  font-weight: 500;
}
.save-btn {
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
}
.save-btn:hover {
  opacity: 0.92;
}
.save-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.save-btn.ghost {
  background: transparent;
  border: 1px solid var(--line2);
  color: var(--fg2);
  margin-top: 4px;
}

/* cards */
.card {
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--card);
  box-shadow: var(--shadow-sm);
  padding: 16px 18px;
  margin-bottom: 16px;
}
.card-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 12px;
}
.card-title {
  font-size: 14.5px;
  font-weight: 600;
  margin: 0;
}
.card-sub {
  font-size: 11.5px;
  color: var(--muted2);
  flex: 1;
}
.switch {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
  color: var(--fg2);
  cursor: pointer;
}
.settings-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.field-row {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-bottom: 12px;
}
.field-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--fg2);
}
.input {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 7px 9px;
  font-size: 13px;
  color: var(--fg);
  outline: none;
  font-family: inherit;
}
.input:focus {
  border-color: var(--accent);
}
.input.narrow {
  width: 90px;
}
.hint {
  font-size: 11px;
  color: var(--muted2);
  line-height: 1.4;
}
.error {
  margin-top: 8px;
  font-size: 12px;
  color: var(--bad);
}

/* week strip */
.week-nav {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
}
.week-label {
  font-size: 11.5px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.nav-btn {
  border: 1px solid var(--line);
  background: var(--surface);
  border-radius: 7px;
  padding: 3px 8px;
  font-size: 12px;
  color: var(--fg2);
  cursor: pointer;
  font-family: inherit;
}
.nav-btn:hover {
  background: var(--muted-bg);
}
.strip {
  display: flex;
  gap: 4px;
  height: 260px;
}
.hours {
  position: relative;
  width: 42px;
  flex: 0 0 auto;
  padding-top: 22px;
}
.hour {
  position: absolute;
  right: 4px;
  font-size: 9.5px;
  color: var(--muted2);
  font-variant-numeric: tabular-nums;
  transform: translateY(-50%);
}
.day {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.day-head {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 4px;
  height: 22px;
  font-size: 11px;
  color: var(--muted);
}
.day-head.today {
  color: var(--fg);
  font-weight: 600;
}
.day-date {
  font-size: 10px;
  color: var(--muted2);
  font-variant-numeric: tabular-nums;
}
.day-body {
  position: relative;
  flex: 1;
  border: 1px solid var(--line);
  border-radius: 7px;
  overflow: hidden;
  background: var(--surface);
}
.seg {
  position: absolute;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-top: 1px solid rgba(255, 255, 255, 0.18);
}
.seg.empty {
  background: transparent;
  border-top-color: transparent;
}
.seg.conflict {
  background-image: repeating-linear-gradient(
    45deg,
    rgba(0, 0, 0, 0.22) 0 4px,
    rgba(0, 0, 0, 0) 4px 8px
  );
}
.seg-label {
  font-size: 10px;
  font-weight: 600;
  color: #fff;
  padding: 0 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
}
.legend {
  display: flex;
  gap: 16px;
  margin-top: 10px;
  flex-wrap: wrap;
}
.legend-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--muted2);
}
.legend-item.warn {
  color: var(--warn, var(--muted));
}
.swatch {
  width: 14px;
  height: 10px;
  border-radius: 3px;
  background: var(--muted2);
}
.conflict-swatch {
  background-image: repeating-linear-gradient(
    45deg,
    rgba(0, 0, 0, 0.3) 0 3px,
    rgba(0, 0, 0, 0) 3px 6px
  );
}

/* dayparts */
.dp-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 10px;
}
.dp-row,
.dp-add {
  display: flex;
  align-items: center;
  gap: 8px;
}
.dp-name {
  flex: 1;
  min-width: 0;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 7px;
  padding: 6px 8px;
  font-size: 13px;
  color: var(--fg);
  outline: none;
  font-family: inherit;
}
.dp-time {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 7px;
  padding: 5px 7px;
  font-size: 12px;
  color: var(--fg2);
  outline: none;
  font-family: inherit;
}
.dp-dash {
  color: var(--muted2);
  font-size: 12px;
}
.dp-wrap {
  font-size: 10.5px;
  color: var(--muted2);
  white-space: nowrap;
}

/* scenes */
.list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.row {
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 13px 15px;
  background: var(--card);
  box-shadow: var(--shadow-sm);
}
.row-main {
  display: flex;
  align-items: center;
  gap: 12px;
}
.dot {
  width: 8px;
  height: 8px;
  flex: 0 0 auto;
  border-radius: 50%;
}
.name {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 7px;
  padding: 6px 8px;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--fg);
  outline: none;
  font-family: inherit;
}
.name:hover {
  border-color: var(--line);
}
.name:focus {
  border-color: var(--accent);
  background: var(--surface);
}
.summary {
  font-size: 11.5px;
  color: var(--muted2);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.active-badge,
.default-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 3px 9px;
  border-radius: 20px;
  white-space: nowrap;
}
.active-badge {
  background: var(--ok-soft);
  color: var(--ok);
}
.default-badge {
  background: var(--muted-bg);
  color: var(--muted);
}
.apply-wrap {
  position: relative;
  display: inline-flex;
}
.preview {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 250;
}
.apply-btn {
  padding: 7px 13px;
  border-radius: 8px;
  border: 1px solid var(--line2);
  background: var(--surface);
  font-size: 12px;
  font-weight: 500;
  color: var(--fg);
  cursor: pointer;
  white-space: nowrap;
  font-family: inherit;
}
.apply-btn:hover {
  background: var(--muted-bg);
}
.apply-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.del-btn {
  width: 32px;
  height: 32px;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--surface);
  font-size: 13px;
  color: var(--muted);
  cursor: pointer;
  font-family: inherit;
}
.del-btn:hover {
  background: var(--bad-soft);
  color: var(--bad);
}
.del-btn.small {
  width: 26px;
  height: 26px;
  font-size: 11px;
}

/* a scene's schedules */
.sched-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin: 10px 0 0 20px;
  padding-left: 12px;
  border-left: 2px solid var(--line);
}
.sched-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.sched-row.off {
  opacity: 0.55;
}
.sched-daypart {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--fg2);
}
.sched-rec {
  flex: 1;
  font-size: 11.5px;
  color: var(--muted);
}
.prio {
  display: flex;
  align-items: center;
  gap: 3px;
}
.prio-btn {
  width: 20px;
  height: 20px;
  border-radius: 5px;
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--fg2);
  font-size: 11px;
  cursor: pointer;
  font-family: inherit;
  line-height: 1;
}
.prio-value {
  font-size: 11px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  min-width: 26px;
  text-align: center;
}
.sched-toggle {
  padding: 3px 9px;
  border-radius: 6px;
  border: 1px solid var(--line);
  background: var(--surface);
  font-size: 11px;
  color: var(--fg2);
  cursor: pointer;
  font-family: inherit;
}

/* empty */
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 9px;
  padding: 44px 20px;
  border: 1.5px dashed var(--line2);
  border-radius: 13px;
  text-align: center;
}
.empty-glyph {
  font-size: 26px;
  color: var(--muted2);
}
.empty-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--fg2);
}
.empty-sub {
  font-size: 12.5px;
  color: var(--muted);
  line-height: 1.5;
  max-width: 46ch;
}

/* modal */
.scrim {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
}
.modal {
  width: 360px;
  max-width: calc(100vw - 32px);
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 22px;
  box-shadow: var(--shadow-lg);
}
.modal.wide {
  width: 460px;
}
.modal-title {
  font-size: 15.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
  margin-bottom: 6px;
}
.modal-sub {
  font-size: 12.5px;
  color: var(--muted);
  margin-bottom: 16px;
  line-height: 1.5;
}
.field {
  width: 100%;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 11px 13px;
  font-size: 14px;
  color: var(--fg);
  outline: none;
  margin-bottom: 16px;
  font-family: inherit;
}
.field:focus {
  border-color: var(--accent);
}
.days {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.day-btn {
  padding: 5px 9px;
  border-radius: 7px;
  border: 1px solid var(--line);
  background: var(--surface);
  font-size: 11.5px;
  color: var(--muted);
  cursor: pointer;
  font-family: inherit;
}
.day-btn.on {
  background: var(--primary);
  border-color: var(--primary);
  color: var(--primary-fg);
  font-weight: 600;
}
.day-preset {
  padding: 5px 9px;
  border-radius: 7px;
  border: 1px dashed var(--line2);
  background: transparent;
  font-size: 11.5px;
  color: var(--muted2);
  cursor: pointer;
  font-family: inherit;
}
.range {
  display: flex;
  align-items: center;
  gap: 8px;
}
.modal-actions {
  display: flex;
  gap: 9px;
  justify-content: flex-end;
  margin-top: 6px;
}
.btn-secondary {
  padding: 9px 16px;
  border-radius: 9px;
  border: 1px solid var(--line);
  background: var(--surface);
  font-size: 13px;
  font-weight: 500;
  color: var(--fg2);
  cursor: pointer;
  font-family: inherit;
}
.btn-primary {
  padding: 9px 18px;
  border-radius: 9px;
  border: none;
  background: var(--primary);
  color: var(--primary-fg);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
}
.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
