<!--
  MachineStats.vue — the per-machine system-stats strip (POL-92; the design deferred from POL-68 §1).

  One line under each approved machine card:

      CPU  [▬▬▬▬▬▬░░░░]  34%     MEMORY  [▬▬▬▬░░░░░░]  41%     DISK  [▬▬░░░░░░░░]  22%

  Thin 4px bars, tabular-nums values, per-meter tooltips with the detail ("4 cores", "3.3 / 8 GB",
  "92 GB free"), and the design's colour thresholds: < 70 ok · 70–89 warn · >= 90 bad. Bar widths
  animate between samples, so a heartbeat reads as movement rather than a jump.

  Three things the strip says that no other surface can:

   • OVERLOAD (amber banner, CPU or memory >= 90%): this box may drop frames on animated content —
     including the Ident flash an operator is about to rely on. The banner is HYSTERETIC (arms at 90,
     clears at 85) because the mock's version flickered on a box hovering at the threshold.
   • SOFTWARE RENDERING (red banner): the box's kiosk browser holds no `/dev/dri` handle — it is
     painting the wall on the CPU. This is the D77 failure that cost a field-debugging session with a
     remote shell and `top`; now it is a banner an operator sees without touching the box.
   • RESPAWNS: the agent has restarted this output's browser N times. The wall can look perfectly
     fine between crashes.

  OFFLINE machines get no meters at all — just "System stats unavailable while offline". Vitals
  describe a running box; a reading from a box that has gone dark is an epitaph, not health data.
-->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { MachineView } from "@polyptic/protocol";

import {
  cpuTooltip,
  diskTooltip,
  formatPercent,
  memoryTooltip,
  meterLevel,
  nextOverloaded,
  overloadPeak,
  softwareRenderingConnectors,
  totalRespawns,
} from "../vitals";

const props = defineProps<{ machine: MachineView }>();

const vitals = computed(() => (props.machine.online ? props.machine.vitals : undefined));
/** Online, but the box reports nothing: an older agent, or a backend that samples no host (dev-open). */
const noReadings = computed(
  () => props.machine.online && vitals.value === undefined,
);

const meters = computed(() => [
  {
    key: "cpu",
    label: "CPU",
    percent: vitals.value?.cpuPercent,
    tooltip: cpuTooltip(vitals.value),
  },
  {
    key: "memory",
    label: "Memory",
    percent: vitals.value?.memPercent,
    tooltip: memoryTooltip(vitals.value),
  },
  {
    key: "disk",
    label: "Disk",
    percent: vitals.value?.diskPercent,
    tooltip: diskTooltip(vitals.value),
  },
]);

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

const softwareRendering = computed(() => softwareRenderingConnectors(vitals.value));
const respawns = computed(() => totalRespawns(vitals.value));
</script>

<template>
  <div class="stats">
    <div v-if="!machine.online" class="unavailable">System stats unavailable while offline.</div>

    <div v-else-if="noReadings" class="unavailable">
      System stats unavailable — this machine's agent reports no host vitals.
    </div>

    <template v-else>
      <div class="strip">
        <div v-for="m in meters" :key="m.key" class="meter" :title="m.tooltip">
          <span class="meter-label">{{ m.label }}</span>
          <span class="bar">
            <span
              class="fill"
              :class="meterLevel(m.percent)"
              :style="{ width: `${m.percent ?? 0}%` }"
            ></span>
          </span>
          <span class="value" :class="meterLevel(m.percent)">{{ formatPercent(m.percent) }}</span>
        </div>

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
.stats {
  margin-top: 12px;
  padding-top: 11px;
  border-top: 1px dashed var(--line);
}

.unavailable {
  font-size: 11.5px;
  color: var(--muted2);
}

.strip {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 20px;
}

.meter {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: default;
}
.meter-label {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted2);
}
.bar {
  position: relative;
  display: block;
  width: 84px;
  height: 4px;
  border-radius: 999px;
  background: var(--muted-bg);
  overflow: hidden;
}
.fill {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 999px;
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
  font-size: 11.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  min-width: 34px;
  color: var(--fg2);
}
.value.warn {
  color: var(--warn);
}
.value.bad {
  color: var(--bad);
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
  margin-top: 10px;
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
