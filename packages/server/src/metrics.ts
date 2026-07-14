/**
 * metrics — a small Prometheus text-exposition registry (POL-92).
 *
 * Two kinds of number live in `/metrics`, and they need different machinery:
 *
 *   - GAUGES are read LIVE at scrape time from the things that already hold the truth (the registry,
 *     the hubs, Presence's vitals ring). Nothing to store: `gauge()`/`gaugeVec()` format them.
 *   - COUNTERS are cumulative and must survive between scrapes, so something has to hold them. That
 *     is `CounterRegistry` — a Map of label-sets to monotonic values, and nothing more.
 *
 * We format the exposition by hand rather than take a Prometheus client dependency: the output is a
 * few dozen lines of a stable, trivially-testable text format (v0.0.4), and the server's dependency
 * list is a thing we defend (D7's spirit — buy the substrate, build the brain; a metrics client is
 * neither).
 */

export type Labels = Record<string, string>;

/** One labelled sample of a metric family. */
export interface Sample {
  labels?: Labels;
  value: number;
}

/** Escape a Prometheus label value (backslash, double-quote, newline). */
export function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function labelStr(labels?: Labels): string {
  const entries = Object.entries(labels ?? {}).filter(([, v]) => v !== undefined && v !== "");
  if (entries.length === 0) return "";
  return `{${entries.map(([k, v]) => `${k}="${escapeLabel(String(v))}"`).join(",")}}`;
}

/** A metric family: HELP + TYPE + one line per sample. An EMPTY family emits nothing at all —
 *  a metric with no samples is not a metric with a zero. */
function family(name: string, help: string, type: "gauge" | "counter", samples: Sample[]): string {
  if (samples.length === 0) return "";
  const head = `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n`;
  const body = samples.map((s) => `${name}${labelStr(s.labels)} ${s.value}\n`).join("");
  return head + body;
}

/** A single-sample gauge block. */
export function gauge(name: string, help: string, value: number, labels?: Labels): string {
  return family(name, help, "gauge", [{ labels, value }]);
}

/** A multi-sample (labelled) gauge block — one line per machine, connector, arch, … */
export function gaugeVec(name: string, help: string, samples: Sample[]): string {
  return family(name, help, "gauge", samples);
}

/** A multi-sample counter block (cumulative, `_total` by convention). */
export function counterVec(name: string, help: string, samples: Sample[]): string {
  return family(name, help, "counter", samples);
}

/**
 * Cumulative counters, keyed by name + label set. Values only ever increase (and reset to zero on a
 * server restart, which is exactly what Prometheus's `rate()` expects and detects).
 */
export class CounterRegistry {
  private readonly families = new Map<string, { help: string; samples: Map<string, Sample> }>();

  /** Increment (creating on first touch). `help` is recorded once, from the first caller. */
  inc(name: string, help: string, labels: Labels = {}, by = 1): void {
    let fam = this.families.get(name);
    if (!fam) {
      fam = { help, samples: new Map() };
      this.families.set(name, fam);
    }
    const key = labelStr(labels);
    const existing = fam.samples.get(key);
    if (existing) existing.value += by;
    else fam.samples.set(key, { labels, value: by });
  }

  /** Current value of one label set (0 when never incremented) — for tests and diagnostics. */
  value(name: string, labels: Labels = {}): number {
    return this.families.get(name)?.samples.get(labelStr(labels))?.value ?? 0;
  }

  /** Render every counter family in the exposition format. */
  render(): string {
    let out = "";
    for (const [name, fam] of this.families) {
      out += counterVec(name, fam.help, [...fam.samples.values()]);
    }
    return out;
  }
}
