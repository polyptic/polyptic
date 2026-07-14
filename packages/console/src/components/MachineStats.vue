<!--
  MachineStats.vue — the per-machine system-stats strip (POL-92; the design deferred from POL-68 §1).

  A full-width muted strip under each approved machine card, per the "Polyptych Console v2" mock,
  verbatim: three equal meters (CPU · MEMORY · DISK), each a full-width 4px bar with the value at the
  end, inside a rounded --muted-bg container. Values are ALWAYS coloured by level (green when ok —
  the mock colours the healthy state, it doesn't mute it). Thresholds: < 70 ok · 70–89 warn ·
  >= 90 bad. Bar widths animate between samples, so a heartbeat reads as movement, not a jump.
  Per-meter tooltips carry the detail ("4 cores", "3.3 / 8 GB", "92 GB free").

  Below the strip, one quiet meta line surfaces the rest of the heartbeat's vitals when they exist
  (up · load · temp · browser RSS · running image) — facts, not judgements, so they stay muted.

  Three things this surface says that no other can:

   • OVERLOAD (amber banner, CPU or memory >= 90%): this box may drop frames on animated content —
     including the Ident flash an operator is about to rely on. The banner is HYSTERETIC (arms at 90,
     clears at 85) because the mock's version flickered on a box hovering at the threshold.
   • SOFTWARE RENDERING (red banner): the box's kiosk browser holds no `/dev/dri` handle — it is
     painting the wall on the CPU. This is the D77 failure that cost a field-debugging session with a
     remote shell and `top`; now it is a banner an operator sees without touching the box.
   • RESPAWNS: the agent has restarted this output's browser N times. The wall can look perfectly
     fine between crashes.

  OFFLINE machines get no meters at all — just the mock's grey "System stats unavailable while
  offline." box. Vitals describe a running box; a reading from a box that has gone dark is an
  epitaph, not health data.
-->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { MachineView } from "@polyptic/protocol";

import {
  cpuTooltip,
  diskTooltip,
  formatBytes,
  formatPercent,
  formatUptime,
  memoryTooltip,
  meterLevel,
  nextOverloaded,
  overloadPeak,
  softwareRenderingConnectors,
  totalBrowserRss,
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
    label: "MEMORY",
    percent: vitals.value?.memPercent,
    tooltip: memoryTooltip(vitals.value),
  },
  {
    key: "disk",
    label: "DISK",
    percent: vitals.value?.diskPercent,
    tooltip: diskTooltip(vitals.value),
  },
]);

/** The rest of the heartbeat's vitals, as quiet "label value" facts — only what actually exists. */
const meta = computed(() => {
  const v = vitals.value;
  if (!v) return [];
  const parts: { key: string; text: string; title?: string }[] = [];
  if (v.uptimeSec !== undefined) parts.push({ key: "up", text: `up ${formatUptime(v.uptimeSec)}` });
  const load1 = v.loadavg?.[0];
  if (v.loadavg && load1 !== undefined) {
    parts.push({
      key: "load",
      text: `load ${load1.toFixed(2)}`,
      title: `1/5/15 min load: ${v.loadavg.map((n) => n.toFixed(2)).join(", ")}`,
    });
  }
  if (v.tempC !== undefined) {
    parts.push({ key: "temp", text: `${Math.round(v.tempC)}°C`, title: "Hottest thermal zone" });
  }
  const rss = totalBrowserRss(v);
  if (rss !== undefined) {
    parts.push({
      key: "rss",
      text: `browser ${formatBytes(rss)}`,
      title: (v.browsers ?? [])
        .filter((b) => b.rssBytes !== undefined)
        .map((b) => `${b.connector}: ${formatBytes(b.rssBytes)}`)
        .join(" · "),
    });
  }
  if (v.imageId) {
    parts.push({ key: "image", text: `image ${v.imageId}`, title: "The OS image this box is running" });
  }
  return parts;
});

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
      </div>

      <div v-if="meta.length || respawns > 0 || softwareRendering.length" class="meta">
        <span v-for="p in meta" :key="p.key" class="meta-item" :title="p.title">{{ p.text }}</span>

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
/* The strip sits directly under the machine row — the design draws no divider above it; the
   --muted-bg container IS the separation. */

.unavailable {
  margin-top: 12px;
  padding: 10px 14px;
  background: var(--muted-bg);
  border-radius: 9px;
  font-size: 12px;
  color: var(--muted2);
}

.strip {
  display: flex;
  align-items: center;
  gap: 24px;
  margin-top: 11px;
  padding: 8px 13px;
  background: var(--muted-bg);
  border-radius: 8px;
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

/* The quiet facts row — POL-92's extra vitals, muted so the meters keep the eye. */
.meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 14px;
  margin-top: 8px;
  padding: 0 2px;
}
.meta-item {
  font-size: 11px;
  color: var(--muted2);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  cursor: default;
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
