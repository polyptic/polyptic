<!--
  MachineStats.vue — the per-machine vitals band (POL-92 data, POL-137 design).

  The redesign from "Polyptych Console v2": under the machine card's header row the vitals are a
  TWO-ROW band inside one rounded --muted-bg container —

   1. Bar row.   CPU · MEMORY · DISK as labelled horizontal progress bars, the percentage at the
                 end of each bar. Healthy fill is green (--ok); the D112 thresholds still recolour
                 a stressed bar (< 70 ok · 70–89 warn · >= 90 bad) and widths animate between
                 samples so a heartbeat reads as movement, not a jump.
   2. Facts row. Uptime ("up 2d 1h"), load average, temperature and browser memory, each with a
                 small icon — and the running image id right-aligned in mono (how an operator
                 learns a box never took a roll-out). New facts join by appending to `factsFor`;
                 the row flex-wraps, so nothing else moves.

  Omitted-field discipline (D112): a vital the box didn't report renders NOTHING — no zeroed bar,
  no empty icon slot. Both rows are built as data in ../vitals.ts (metersFor / factsFor) so that
  rule is unit-tested; a row with no entries never renders, and a box with no vitals at all gets
  the quiet "unavailable" line instead of an empty band.

  Below the band, the two banners this surface exists for (unchanged from POL-92):

   • SOFTWARE RENDERING (red): the kiosk browser holds no /dev/dri handle — the D77 failure,
     called out in words. Outranks the overload banner, because it is the cause.
   • OVERLOAD (amber, hysteretic — arms at 90, clears at 85): this box may drop frames on
     animated content, including the Ident flash an operator is about to rely on.

  OFFLINE machines get no meters at all — vitals describe a running box; a reading from a box
  that has gone dark is an epitaph, not health data.
-->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { MachineView } from "@polyptic/protocol";

import {
  factsFor,
  formatPercent,
  metersFor,
  meterLevel,
  nextOverloaded,
  overloadPeak,
  softwareRenderingConnectors,
  totalRespawns,
} from "../vitals";

const props = defineProps<{ machine: MachineView }>();

const vitals = computed(() => (props.machine.online ? props.machine.vitals : undefined));
/** Online, but the box reports nothing: an older agent, or a backend that samples no host (dev-open). */
const noReadings = computed(() => props.machine.online && vitals.value === undefined);

const meters = computed(() => metersFor(vitals.value));
const facts = computed(() => factsFor(vitals.value));
const imageId = computed(() => vitals.value?.imageId);

const softwareRendering = computed(() => softwareRenderingConnectors(vitals.value));
const respawns = computed(() => totalRespawns(vitals.value));

/** The facts row renders only when something is in it — an empty row is not a design element. */
const factsRowShown = computed(
  () =>
    facts.value.length > 0 ||
    imageId.value !== undefined ||
    respawns.value > 0 ||
    softwareRendering.value.length > 0,
);
/** …and the band itself collapses when a box reported vitals but nothing we can draw. */
const bandShown = computed(() => meters.value.length > 0 || factsRowShown.value);

// The small icons for the facts row: inline strokes on currentColor — accent-coloured per the
// chosen design's facts row. Feather-style geometry on a 24-unit grid, drawn at 12px.
const ICON_PATHS: Record<string, string[]> = {
  clock: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 7v5l3 2"],
  gauge: ["M3 12h4l3-8 4 16 3-8h4"],
  thermometer: ["M14 14.76V5a2 2 0 0 0-4 0v9.76a4 4 0 1 0 4 0z"],
  browser: ["M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z", "M3 9h18"],
  // The image id's glyph — the design marks the running build with a stack of layers.
  layers: ["M12 2 2 7l10 5 10-5-10-5z", "M2 17l10 5 10-5", "M2 12l10 5 10-5"],
};

// The overload banner's state is HELD, not derived: hysteresis needs to know what it said last time
// (arm at 90, clear at 85). One component instance per machine card, so this is per machine.
const overloaded = ref(false);
watch(
  () => overloadPeak(vitals.value),
  (peak) => {
    overloaded.value = nextOverloaded(overloaded.value, peak);
  },
  { immediate: true },
);
</script>

<template>
  <div class="stats">
    <div v-if="!machine.online" class="unavailable">System stats unavailable while offline.</div>

    <div v-else-if="noReadings" class="unavailable">
      System stats unavailable — this machine's agent reports no host vitals.
    </div>

    <template v-else>
      <div v-if="bandShown" class="band">
        <!-- Row 1 — the labelled progress bars. Only meters the box reported: an absent reading
             is absent, never a dead track at 0%. -->
        <div v-if="meters.length" class="bars">
          <div v-for="m in meters" :key="m.key" class="meter" :title="m.tooltip">
            <span class="meter-label">{{ m.label }}</span>
            <span class="bar">
              <span
                class="fill"
                :class="meterLevel(m.percent)"
                :style="{ width: `${m.percent}%` }"
              ></span>
            </span>
            <span class="value" :class="meterLevel(m.percent)">{{ formatPercent(m.percent) }}</span>
          </div>
        </div>

        <!-- Row 2 — the facts: icon + reading, and the running image id pinned to the right in
             mono. Wraps when a card gets narrow or facts multiply. -->
        <div v-if="factsRowShown" class="facts">
          <span v-for="f in facts" :key="f.key" class="fact" :title="f.title">
            <svg
              class="fact-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path v-for="(d, i) in ICON_PATHS[f.icon]" :key="i" :d="d" />
            </svg>
            {{ f.text }}
          </span>

          <span
            v-if="respawns > 0"
            class="chip warn"
            :title="`The agent has respawned this machine's kiosk browser ${respawns} time(s) since it started. A climbing count is a crash loop — the wall can look fine between respawns.`"
          >
            {{ respawns }} browser respawn{{ respawns === 1 ? "" : "s" }}
          </span>
          <span
            v-if="softwareRendering.length"
            class="chip bad"
            :title="`No /dev/dri handle on ${softwareRendering.join(', ')} — the browser is rendering on the CPU.`"
          >
            Software rendering
          </span>

          <span v-if="imageId !== undefined" class="image-id" title="The OS image this box is running">
            <svg
              class="fact-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path v-for="(d, i) in ICON_PATHS.layers" :key="i" :d="d" />
            </svg>
            <span class="image-id-text">{{ imageId }}</span>
          </span>
        </div>
      </div>

      <!-- The D77 tell, in words. It OUTRANKS the overload banner (v-else-if below) on purpose: a
           software-rendering box is nearly always a pegged box, and "your GPU path is broken" is the
           cause, where "under sustained load" is only the symptom. Two banners saying the same thing
           twice is how a card stops being read at all. -->
      <div v-if="softwareRendering.length" class="banner bad">
        <strong>Rendering in software</strong> on
        {{ softwareRendering.join(", ") }} — the kiosk browser holds no GPU device handle
        (<code>/dev/dri</code>), so it is painting the wall on the CPU. Expect a pegged processor, a
        hot box and dropped frames. Usually a broken graphics path on this machine (driver, session
        or browser flavour), not a Polyptic setting.
      </div>

      <div v-else-if="overloaded" class="banner warn">
        Under sustained load — this machine may drop frames on animated content, including Ident
        flashes.
      </div>
    </template>
  </div>
</template>

<style scoped>
/* The band sits directly under the machine row — the design draws no divider above it; the
   --muted-bg container IS the separation. */

.unavailable {
  margin-top: 12px;
  padding: 10px 14px;
  background: var(--muted-bg);
  border-radius: 9px;
  font-size: 12px;
  color: var(--muted2);
}

.band {
  display: flex;
  flex-direction: column;
  gap: 9px;
  margin-top: 11px;
  padding: 8px 13px;
  background: var(--muted-bg);
  border-radius: 8px;
}

/* Row 1 — the labelled progress bars. */
.bars {
  display: flex;
  align-items: center;
  gap: 24px;
}
.meter {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  cursor: default;
}
.meter-label {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.05em;
  color: var(--muted);
  flex: 0 0 auto;
}
.bar {
  position: relative;
  display: block;
  flex: 1;
  height: 4px;
  border-radius: 2px;
  background: var(--line);
  overflow: hidden;
}
.fill {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 2px;
  /* The design's one animation: the bar slides between samples instead of jumping. */
  transition: width 0.9s ease;
}
.fill.ok {
  background: var(--ok);
}
.fill.warn {
  background: var(--warn);
}
.fill.bad {
  background: var(--bad);
}
.value {
  font-size: 10.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  flex: 0 0 auto;
  min-width: 30px;
  text-align: right;
}
.value.ok {
  color: var(--ok);
}
.value.warn {
  color: var(--warn);
}
.value.bad {
  color: var(--bad);
}

/* Row 2 — the icon'd facts, image id pinned right. */
.facts {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px 16px;
  min-height: 16px;
}
.fact {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--muted2);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  cursor: default;
}
.fact-icon {
  width: 12px;
  height: 12px;
  flex: 0 0 auto;
  color: var(--accent);
}
.image-id {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
  cursor: default;
}
.image-id-text {
  font-size: 10.5px;
  font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  color: var(--muted);
}

.chip {
  font-size: 11px;
  font-weight: 600;
  padding: 3px 9px;
  border-radius: 20px;
  white-space: nowrap;
  cursor: default;
}
.chip.warn {
  color: var(--warn);
  background: var(--warn-soft);
}
.chip.bad {
  color: var(--bad);
  background: var(--bad-soft);
}

.banner {
  margin-top: 8px;
  font-size: 12px;
  line-height: 1.5;
  padding: 8px 11px;
  border-radius: 8px;
}
.banner.warn {
  color: var(--warn);
  background: var(--warn-soft);
}
.banner.bad {
  color: var(--bad);
  background: var(--bad-soft);
}
.banner code {
  font-size: 11px;
  font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
</style>
