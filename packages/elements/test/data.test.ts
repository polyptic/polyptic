/**
 * POL-99 — the binding language is TOTAL: every lookup either yields a value or a named MISS, and a
 * miss is a render state (a visible hole), never a crash and never a blank element. These tests pin
 * that totality, the stale flag, and the chart/table geometry helpers.
 */
import { describe, expect, test } from "bun:test";

import type { DataSet, PageData, PageDefinition } from "@polyptic/protocol";
import {
  barRects,
  chartPoints,
  formatValue,
  linePoints,
  numericValue,
  resolveBinding,
  tableColumns,
  unresolvedBindings,
} from "../src/data";

const SET: DataSet = {
  columns: ["line", "output", "note"],
  rows: [
    { line: "A", output: 92, note: null },
    { line: "B", output: 87, note: "held" },
  ],
  fetchedAt: "2026-07-14T09:00:00.000Z",
  stale: false,
};

const DATA: PageData = { datasets: { "data-1": SET } };

describe("resolveBinding — total by construction", () => {
  test("resolves a cell", () => {
    expect(resolveBinding(DATA, { dataSourceId: "data-1", field: "output", row: 1 })).toEqual({
      value: 87,
      stale: false,
    });
  });

  test("an UNBOUND element misses with 'no-source' (not an exception)", () => {
    expect(resolveBinding(DATA, undefined).miss).toBe("no-source");
  });

  test("a binding to a source with no data misses with 'no-data'", () => {
    expect(resolveBinding(DATA, { dataSourceId: "data-404", field: "x", row: 0 }).miss).toBe("no-data");
  });

  test("a MISSING FIELD misses with 'no-field' — the wall shows a hole, never a blank", () => {
    expect(resolveBinding(DATA, { dataSourceId: "data-1", field: "nope", row: 0 }).miss).toBe("no-field");
  });

  test("a row past the end misses with 'no-row'", () => {
    expect(resolveBinding(DATA, { dataSourceId: "data-1", field: "output", row: 9 }).miss).toBe("no-row");
  });

  test("a NULL cell resolves (to null) — 'the endpoint sent nothing here' is not a miss", () => {
    const resolution = resolveBinding(DATA, { dataSourceId: "data-1", field: "note", row: 0 });
    expect(resolution.miss).toBeUndefined();
    expect(resolution.value).toBeNull();
    expect(formatValue(resolution.value)).toBe("—"); // …and it still renders as a visible hole
  });

  test("a stale dataset resolves its values AND reports staleness", () => {
    const stale: PageData = { datasets: { "data-1": { ...SET, stale: true } } };
    expect(resolveBinding(stale, { dataSourceId: "data-1", field: "output", row: 0 })).toEqual({
      value: 92,
      stale: true,
    });
  });

  test("no data bundle at all (a page sent before the first poll) is a miss, not a throw", () => {
    expect(resolveBinding(undefined, { dataSourceId: "data-1", field: "output", row: 0 }).miss).toBe("no-data");
  });
});

describe("formatting + numbers", () => {
  test("undefined/null both read as an em-dash", () => {
    expect(formatValue(undefined)).toBe("—");
    expect(formatValue(null)).toBe("—");
  });

  test("numericValue reads a number out of a formatted string, and refuses text", () => {
    expect(numericValue(42)).toBe(42);
    expect(numericValue("1,234")).toBe(1234);
    expect(numericValue("n/a")).toBeUndefined();
  });
});

describe("table + chart geometry", () => {
  test("with no authored columns a table falls back to the dataset's own first columns", () => {
    expect(tableColumns([], SET).map((c) => c.field)).toEqual(["line", "output", "note"]);
    expect(tableColumns([{ field: "output", label: "Out", align: "right" }], SET)).toEqual([
      { field: "output", label: "Out", align: "right" },
    ]);
  });

  test("chartPoints drops NON-NUMERIC rows rather than plotting a lie", () => {
    const mixed: DataSet = { ...SET, rows: [{ output: 1 }, { output: "n/a" }, { output: 3 }] };
    expect(chartPoints(mixed, "output", "", 10).map((p) => p.value)).toEqual([1, 3]);
    expect(chartPoints(undefined, "output", "", 10)).toEqual([]);
    expect(chartPoints(SET, "", "", 10)).toEqual([]); // unbound field → no points → the no-data tell
  });

  test("line/bar geometry stays inside the 100×100 viewBox, and a single point still draws", () => {
    const points = linePoints([1, 5, 3]).split(" ");
    expect(points).toHaveLength(3);
    for (const p of points) {
      const [x, y] = p.split(",").map(Number) as [number, number];
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(100);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(100);
    }
    expect(linePoints([7])).toBe("0.00,96.00"); // one point → a flat line at the baseline, still a chart
    expect(linePoints([])).toBe("");
    expect(barRects([2, 4]).every((b) => b.h >= 1 && b.y >= 0)).toBe(true);
  });
});

describe("unresolvedBindings — the player's diag trail (POL-86/D78)", () => {
  const definition: PageDefinition = {
    aspect: "16:9",
    bg: "#000",
    elements: [
      {
        id: "k1",
        kind: "kpi",
        x: 0,
        y: 0,
        w: 10,
        h: 10,
        props: { binding: { dataSourceId: "data-1", field: "nope", row: 0 }, label: "", unit: "", deltaField: "", worseWhen: "above" },
      },
      { id: "t1", kind: "table", x: 0, y: 0, w: 10, h: 10, props: { dataSourceId: "data-404", columns: [], rows: 8, header: true } },
      { id: "ok", kind: "table", x: 0, y: 0, w: 10, h: 10, props: { dataSourceId: "data-1", columns: [], rows: 8, header: true } },
    ],
  };

  test("names each element that cannot resolve, and WHY", () => {
    const lines = unresolvedBindings(definition, DATA);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("no-field");
    expect(lines[0]).toContain("data-1.nope[row 0]");
    expect(lines[1]).toContain("no-data");
    expect(lines[1]).toContain("t1");
  });

  test("a stale dataset is reported too — a wall showing yesterday's numbers must say so", () => {
    const stale: PageData = { datasets: { "data-1": { ...SET, stale: true } } };
    const lines = unresolvedBindings(definition, stale);
    expect(lines.some((l) => l.includes("binding stale") && l.includes("ok"))).toBe(true);
  });
});
