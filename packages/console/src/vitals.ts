/**
 * vitals — the pure logic behind the Machines view's stats strip (POL-92, designed in POL-68 §1).
 *
 * Kept out of the component so the parts that are easy to get subtly wrong — the colour thresholds,
 * the overload banner's hysteresis, and the software-render verdict — are unit-testable without
 * mounting anything.
 *
 * The thresholds are the design's, verbatim: < 70% ok · 70–89% warn · >= 90% bad.
 */
import type { MachineVitals } from "@polyptic/protocol";

export type MeterLevel = "ok" | "warn" | "bad";

/** Bar colour for a percentage. An UNKNOWN reading is "ok"-neutral — it draws no bar at all. */
export function meterLevel(percent: number | undefined): MeterLevel {
  if (percent === undefined) return "ok";
  if (percent >= 90) return "bad";
  if (percent >= 70) return "warn";
  return "ok";
}

/** The threshold at which a machine is "under sustained load". */
export const OVERLOAD_ENTER = 90;
/**
 * …and the (lower) threshold at which it stops being. The mock's banner FLICKERED because it entered
 * and left on the same number: a box hovering at 89.6/90.1 flipped the banner every heartbeat. One
 * threshold to arm, a lower one to clear — the oldest trick in control theory, and the one the POL-68
 * hand-off explicitly asked for.
 */
export const OVERLOAD_EXIT = 85;

/** The worst of the two readings the banner watches (CPU and memory), or undefined if neither exists. */
export function overloadPeak(vitals: MachineVitals | undefined): number | undefined {
  if (!vitals) return undefined;
  const readings = [vitals.cpuPercent, vitals.memPercent].filter(
    (n): n is number => typeof n === "number",
  );
  return readings.length > 0 ? Math.max(...readings) : undefined;
}

/**
 * Next state of the overload banner, given its previous state. Sticky by design: it arms at
 * OVERLOAD_ENTER and only clears below OVERLOAD_EXIT, so a box sitting on the threshold shows a
 * steady warning instead of a strobe. An absent reading (offline, no vitals) clears it — we never
 * claim a machine is overloaded on the strength of a number we don't have.
 */
export function nextOverloaded(previous: boolean, peak: number | undefined): boolean {
  if (peak === undefined) return false;
  return previous ? peak >= OVERLOAD_EXIT : peak >= OVERLOAD_ENTER;
}

/**
 * The connectors whose kiosk browser is rendering IN SOFTWARE — it holds no `/dev/dri` handle (D77).
 * Only a definite `false` counts: an agent that could not tell us (`gpuAccel` absent — an older
 * agent, a backend that owns no browser, an unreadable /proc) must never be reported as broken.
 */
export function softwareRenderingConnectors(vitals: MachineVitals | undefined): string[] {
  return (vitals?.browsers ?? []).filter((b) => b.gpuAccel === false).map((b) => b.connector);
}

/** Total browser respawns across a machine's outputs (a climbing number = a crash loop). */
export function totalRespawns(vitals: MachineVitals | undefined): number {
  return (vitals?.browsers ?? []).reduce((sum, b) => sum + (b.respawns ?? 0), 0);
}

/** Human bytes, two significant-ish digits: "3.3 GB", "512 MB". */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 100 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

/** "34%" — or "—" when we have no reading (never "0%", which is a claim we can't make). */
export function formatPercent(percent: number | undefined): string {
  return percent === undefined ? "—" : `${Math.round(percent)}%`;
}

/** Detail line for the CPU meter's tooltip: "4 cores · load 1.20, 0.90, 0.70". */
export function cpuTooltip(vitals: MachineVitals | undefined): string {
  const parts: string[] = [];
  if (vitals?.cores) parts.push(`${vitals.cores} core${vitals.cores === 1 ? "" : "s"}`);
  const load = vitals?.loadavg;
  if (load) parts.push(`load ${load.map((n) => n.toFixed(2)).join(", ")}`);
  if (vitals?.tempC !== undefined) parts.push(`${vitals.tempC}°C`);
  return parts.join(" · ") || "CPU busy across all cores";
}

/** Detail line for the memory meter's tooltip: "3.3 / 8 GB". */
export function memoryTooltip(vitals: MachineVitals | undefined): string {
  if (vitals?.memUsedBytes === undefined || vitals.memTotalBytes === undefined) {
    return "Memory in use";
  }
  return `${formatBytes(vitals.memUsedBytes)} / ${formatBytes(vitals.memTotalBytes)}`;
}

/** Detail line for the disk meter's tooltip: "92 GB free". On a netbooted box that is the RAM image. */
export function diskTooltip(vitals: MachineVitals | undefined): string {
  if (vitals?.diskUsedBytes === undefined || vitals.diskTotalBytes === undefined) {
    return "Root filesystem in use";
  }
  const free = Math.max(0, vitals.diskTotalBytes - vitals.diskUsedBytes);
  return `${formatBytes(free)} free of ${formatBytes(vitals.diskTotalBytes)}`;
}

/** "6d 4h" / "3h 12m" / "45m" — the two most significant units only. */
export function formatUptime(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Resident set across every kiosk browser on the box, or undefined if no browser reported one. */
export function totalBrowserRss(vitals: MachineVitals | undefined): number | undefined {
  const readings = (vitals?.browsers ?? [])
    .map((b) => b.rssBytes)
    .filter((n): n is number => typeof n === "number");
  return readings.length > 0 ? readings.reduce((sum, n) => sum + n, 0) : undefined;
}

// ── The vitals band's view-model (POL-137) ──────────────────────────────────
//
// The redesigned strip is a two-row band: labelled progress bars (CPU · MEMORY · DISK) over a
// facts row (uptime, load, temperature, browser memory — each with a small icon — and the running
// image id right-aligned in mono). Both rows are built HERE, as data, so the omitted-field
// discipline (D112) is a pure function with tests: a vital the box didn't report simply isn't in
// the array — no zeroed bar, no empty icon slot, and a row with nothing in it never renders.

export type Meter = {
  key: "cpu" | "memory" | "disk";
  label: string;
  percent: number;
  tooltip: string;
};

/**
 * The bar row: only the meters the box actually reported. A pre-POL-92 agent yields [], a box that
 * knows its CPU but not its disk yields two bars — the row reflows, it never draws a dead track.
 */
export function metersFor(vitals: MachineVitals | undefined): Meter[] {
  if (!vitals) return [];
  const all: (Meter | undefined)[] = [
    vitals.cpuPercent === undefined
      ? undefined
      : { key: "cpu", label: "CPU", percent: vitals.cpuPercent, tooltip: cpuTooltip(vitals) },
    vitals.memPercent === undefined
      ? undefined
      : {
          key: "memory",
          label: "MEMORY",
          percent: vitals.memPercent,
          tooltip: memoryTooltip(vitals),
        },
    vitals.diskPercent === undefined
      ? undefined
      : { key: "disk", label: "DISK", percent: vitals.diskPercent, tooltip: diskTooltip(vitals) },
  ];
  return all.filter((m): m is Meter => m !== undefined);
}

/** One entry in the facts row. `icon` names a glyph the component owns; text is the fact itself. */
export type Fact = {
  key: string;
  icon: "clock" | "gauge" | "thermometer" | "browser";
  text: string;
  title?: string;
};

/**
 * The facts row's left-hand group, in the design's order: uptime · load · temperature · browser
 * memory. Only what the heartbeat carried — and the list is the extension point: a new vital joins
 * the row by pushing another entry here (the layout flex-wraps; nothing else moves).
 */
export function factsFor(vitals: MachineVitals | undefined): Fact[] {
  const v = vitals;
  if (!v) return [];
  const facts: Fact[] = [];
  if (v.uptimeSec !== undefined) {
    facts.push({ key: "up", icon: "clock", text: `up ${formatUptime(v.uptimeSec)}` });
  }
  const load1 = v.loadavg?.[0];
  if (v.loadavg && load1 !== undefined) {
    facts.push({
      key: "load",
      icon: "gauge",
      text: `load ${load1.toFixed(2)}`,
      title: `1/5/15 min load: ${v.loadavg.map((n) => n.toFixed(2)).join(", ")}`,
    });
  }
  if (v.tempC !== undefined) {
    facts.push({
      key: "temp",
      icon: "thermometer",
      text: `${Math.round(v.tempC)}°C`,
      title: "Hottest thermal zone",
    });
  }
  const rss = totalBrowserRss(v);
  if (rss !== undefined) {
    facts.push({
      key: "rss",
      icon: "browser",
      text: `browser ${formatBytes(rss)}`,
      title: (v.browsers ?? [])
        .filter((b) => b.rssBytes !== undefined)
        .map((b) => `${b.connector}: ${formatBytes(b.rssBytes)}`)
        .join(" · "),
    });
  }
  return facts;
}

/** How stale is this sample? (The strip greys out if a box stops sampling but stays connected.) */
export function sampleAgeSeconds(vitals: MachineVitals | undefined, now: number): number | null {
  if (!vitals?.at) return null;
  const at = Date.parse(vitals.at);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.round((now - at) / 1000));
}
