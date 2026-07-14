/**
 * POL-99 — resolving a data BINDING against the send-time dataset bundle, plus the SVG geometry the
 * chart element draws.
 *
 * The binding language is total by construction (see the protocol's `DataBinding`): three lookups,
 * no expressions, nothing that can throw. So every function here is total too — it returns a value
 * or `undefined`, and `undefined` is a RENDER STATE the elements draw explicitly (an em-dash plus a
 * "no data" tell), never a blank box. A field that the endpoint stopped sending must be VISIBLE as a
 * hole on the wall; silently blanking the element is the failure we are designing against (D78).
 *
 * The same rule covers rows: a dataset row always carries every column (the poller null-fills), so a
 * table can never paint a half-filled row — the worst case is a row of visible em-dashes.
 */
import type { DataBinding, DataSet, DataValue, PageData, PageDefinition } from "@polyptic/protocol";

/** Why a binding did not resolve — the words the element (and the player's diag line) use. */
export type BindingMiss = "no-source" | "no-data" | "no-row" | "no-field";

export interface BindingResolution {
  /** The value, when everything resolved. */
  value?: DataValue;
  /** Set when it did not — the element draws its tell and says WHY in the studio. */
  miss?: BindingMiss;
  /** True when the dataset on glass is the poller's last-good after a failed poll. */
  stale: boolean;
}

/** The dataset a binding/element points at, if the send-time bundle carries one. */
export function datasetFor(data: PageData | undefined, dataSourceId: string | undefined): DataSet | undefined {
  if (!dataSourceId) return undefined;
  return data?.datasets?.[dataSourceId];
}

/** Resolve one cell. Total: a value, or a miss with a reason. Never throws. */
export function resolveBinding(
  data: PageData | undefined,
  binding: DataBinding | undefined,
): BindingResolution {
  if (!binding?.dataSourceId) return { miss: "no-source", stale: false };
  const set = datasetFor(data, binding.dataSourceId);
  if (!set) return { miss: "no-data", stale: false };
  const row = set.rows[binding.row];
  if (!row) return { miss: "no-row", stale: set.stale };
  if (!(binding.field in row)) return { miss: "no-field", stale: set.stale };
  return { value: row[binding.field] ?? null, stale: set.stale };
}

/** A cell as wall text. `null` (an absent value the endpoint DID send) reads as an em-dash — the same
 *  glyph as a miss, because on a wall both mean "no number here" and neither may be blank. */
export function formatValue(value: DataValue | undefined): string {
  if (value === undefined || value === null) return "—";
  if (typeof value === "number") {
    return Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  return value;
}

/** The numeric reading of a cell, for thresholds and charts (text cells are simply not numbers). */
export function numericValue(value: DataValue | undefined): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const n = Number(value.replace(/[,\s%£$€]/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** The columns a table element actually draws: the authored list, else the dataset's own first six. */
export function tableColumns(
  authored: { field: string; label: string; align: "left" | "right" }[],
  set: DataSet | undefined,
): { field: string; label: string; align: "left" | "right" }[] {
  if (authored.length > 0) return authored;
  return (set?.columns ?? []).slice(0, 6).map((field) => ({ field, label: field, align: "left" as const }));
}

/** Points for the chart element: the numeric column, in dataset order, capped. Non-numeric rows are
 *  dropped (a chart cannot plot "n/a") — an EMPTY result is the element's no-data tell, not a crash. */
export function chartPoints(
  set: DataSet | undefined,
  field: string,
  labelField: string,
  cap: number,
): { value: number; label: string }[] {
  if (!set || !field) return [];
  const points: { value: number; label: string }[] = [];
  for (const row of set.rows.slice(0, cap)) {
    const value = numericValue(row[field] ?? null);
    if (value === undefined) continue;
    const label = labelField ? formatValue(row[labelField] ?? null) : "";
    points.push({ value, label });
  }
  return points;
}

/** An SVG polyline `points` attribute for a line/spark chart drawn in a 100×100 viewBox. A single
 *  point draws a flat line (rather than nothing) so the element still reads as a chart. */
export function linePoints(values: number[]): string {
  if (values.length === 0) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = values.length > 1 ? 100 / (values.length - 1) : 0;
  return values
    .map((v, i) => `${(i * step).toFixed(2)},${(100 - ((v - min) / span) * 92 - 4).toFixed(2)}`)
    .join(" ");
}

/** Bars for a bar chart in a 100×100 viewBox (x, width, y, height), baselined at the lowest value. */
export function barRects(values: number[]): { x: number; y: number; w: number; h: number }[] {
  if (values.length === 0) return [];
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const slot = 100 / values.length;
  const width = Math.max(1, slot * 0.68);
  return values.map((v, i) => {
    const height = Math.max(1, ((v - min) / span) * 92);
    return { x: i * slot + (slot - width) / 2, y: 100 - height - 4, w: width, h: height };
  });
}

/** Every binding in a page that CANNOT resolve against the data it was sent with, as one human line
 *  each. The player writes these to its `player.diag` trail (POL-86/D78), so a wall showing dashes is
 *  diagnosable from `kubectl logs` alone — no guessing, no shell on the box. */
export function unresolvedBindings(definition: PageDefinition, data: PageData | undefined): string[] {
  const lines: string[] = [];
  for (const el of definition.elements) {
    if (el.kind === "data-text" || el.kind === "kpi") {
      const resolution = resolveBinding(data, el.props.binding);
      if (resolution.miss) {
        const binding = el.props.binding;
        lines.push(
          `binding unresolved (${resolution.miss}) — element ${el.id} [${el.kind}] → ${
            binding ? `${binding.dataSourceId}.${binding.field}[row ${binding.row}]` : "(unbound)"
          }`,
        );
      } else if (resolution.stale) {
        lines.push(`binding stale — element ${el.id} [${el.kind}] is showing last-good values`);
      }
    } else if (el.kind === "table" || el.kind === "chart") {
      const set = datasetFor(data, el.props.dataSourceId);
      if (!set) {
        lines.push(
          `binding unresolved (${el.props.dataSourceId ? "no-data" : "no-source"}) — element ${el.id} [${el.kind}]`,
        );
      } else if (set.stale) {
        lines.push(`binding stale — element ${el.id} [${el.kind}] is showing last-good rows`);
      }
    }
  }
  return lines;
}
