/**
 * POL-99 — the data-source / data-binding contract.
 *
 * Two promises live here. First, BACK-COMPAT: `admin/state.dataSources` and `PageData.datasets` are
 * optional, so an older console/player parses a newer server's frames (and vice versa) — a fleet is
 * upgraded one box at a time. Second, TOTALITY: a binding always carries all three of its parts (the
 * row defaults to 0), so "half a binding" is unrepresentable on the wire — a renderer only ever has
 * to handle "resolves" or "doesn't".
 */
import { describe, expect, test } from "bun:test";

import { DataBinding, DataSet, DataSource, PageData, PageElement, PageSurface } from "../src/index";

describe("DataSource", () => {
  test("defaults: 60s cadence, bearer auth, no rows path, no credential", () => {
    const parsed = DataSource.parse({
      id: "data-1",
      name: "Line output",
      url: "https://example.test/o.json",
      format: "json",
    });
    expect(parsed).toMatchObject({ pollSeconds: 60, authIn: "header", rowsPath: "" });
    expect(parsed.credentialProfileId).toBeUndefined();
  });

  test("the poll floor is 10s — a wall is not a trading desk", () => {
    expect(DataSource.safeParse({ id: "d", name: "n", url: "https://a.test/x", format: "json", pollSeconds: 1 }).success).toBe(false);
  });
});

describe("DataBinding — total by construction", () => {
  test("row defaults to 0, so a binding always has all three parts", () => {
    expect(DataBinding.parse({ dataSourceId: "data-1", field: "output" })).toEqual({
      dataSourceId: "data-1",
      field: "output",
      row: 0,
    });
  });

  test("an empty source id or field is not a binding at all", () => {
    expect(DataBinding.safeParse({ dataSourceId: "", field: "x" }).success).toBe(false);
    expect(DataBinding.safeParse({ dataSourceId: "data-1", field: "" }).success).toBe(false);
  });
});

describe("DataSet", () => {
  test("cells are string | number | null (nothing else reaches a wall)", () => {
    const set = DataSet.parse({
      columns: ["a", "b"],
      rows: [{ a: "x", b: 1 }, { a: null, b: 2 }],
      fetchedAt: "2026-07-14T09:00:00.000Z",
    });
    expect(set.stale).toBe(false); // absent = fresh
    expect(DataSet.safeParse({ columns: [], rows: [{ a: { nested: true } }], fetchedAt: "t" }).success).toBe(false);
  });
});

describe("the data-bound page elements", () => {
  test("a KPI parses with an optional binding (an unbound drop is legal — it draws its tell)", () => {
    const el = PageElement.parse({ id: "k1", kind: "kpi", x: 0, y: 0, w: 10, h: 10, props: {} });
    expect(el.kind).toBe("kpi");
    if (el.kind !== "kpi") throw new Error("kind");
    expect(el.props.worseWhen).toBe("above");
    expect(el.props.binding).toBeUndefined();
  });

  test("a page surface carries datasets keyed by data-source id — and parses WITHOUT them (back-compat)", () => {
    const surface = PageSurface.parse({
      id: "s1",
      type: "page",
      region: { x: 0, y: 0, w: 1920, h: 1080 },
      definition: {
        elements: [
          { id: "t1", kind: "table", x: 0, y: 0, w: 40, h: 40, props: { dataSourceId: "data-1" } },
        ],
      },
      data: {
        datasets: {
          "data-1": { columns: ["a"], rows: [{ a: 1 }], fetchedAt: "2026-07-14T09:00:00.000Z", stale: true },
        },
      },
    });
    expect(surface.data?.datasets?.["data-1"]?.stale).toBe(true);
    // An older server sends no datasets at all; the page still parses (elements draw their no-data tell).
    expect(PageData.parse({}).datasets).toBeUndefined();
  });
});
