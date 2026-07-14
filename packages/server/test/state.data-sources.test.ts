/**
 * POL-99 — data sources in the control plane, driven against the MemoryStore.
 *
 * Pins the load-bearing claims:
 *   - a data source is CONFIG ONLY: the DB never holds a polled value, and a stamped token is never
 *     persisted (the fetch resolves the credential-profile token per request);
 *   - a page's bound rows ride in the send-time `data.datasets` bundle, keyed by DATA SOURCE id (one
 *     payload however many elements bind it) — the STORED slice stays clean;
 *   - a binding that names a missing field/row still ships the dataset (the element draws its hole);
 *     a binding to a source with no data yet ships NOTHING (same hole, no invented rows);
 *   - polling requirements only cover pages ON GLASS;
 *   - delete guards: a data source bound by a page, and a credential profile used by a data source,
 *     both refuse deletion rather than silently blanking / de-authing a live wall;
 *   - configs survive a restart.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import type { DataSet, Output, PageDefinition } from "@polyptic/protocol";
import { ControlPlane, type RegisterMachineInput } from "../src/state";
import { MemoryStore } from "../src/store/memory";

function hello(machineId: string, ...connectors: string[]): RegisterMachineInput {
  return {
    machineId,
    agentVersion: "test",
    backend: "wayland-sway",
    outputs: connectors.map((connector) => ({ connector, width: 1920, height: 1080 }) satisfies Output),
    hostname: "test-box",
  };
}

function definitionWith(elements: PageDefinition["elements"]): PageDefinition {
  return { aspect: "16:9", bg: "#0b0b0e", elements };
}

const ROWS: DataSet = {
  columns: ["line", "output", "delta"],
  rows: [
    { line: "A", output: 92, delta: 1.4 },
    { line: "B", output: 87, delta: -0.6 },
  ],
  fetchedAt: "2026-07-14T09:00:00.000Z",
  stale: false,
};

/** A stub poller: one dataset for `data-1`, nothing for anything else (`null` = nothing at all). */
function provider(set: DataSet | null = ROWS) {
  return {
    feedFor: () => undefined,
    weatherFor: () => undefined,
    datasetFor: (id: string) => (id === "data-1" ? (set ?? undefined) : undefined),
    dataSourceHealth: () => ({
      status: (set ? "ok" : "pending") as "ok" | "pending",
      rowCount: set?.rows.length ?? 0,
      columns: set?.columns ?? [],
      sample: set?.rows.slice(0, 5) ?? [],
    }),
  };
}

let store: MemoryStore;
let cp: ControlPlane;

beforeEach(async () => {
  store = new MemoryStore();
  cp = new ControlPlane(store);
  await cp.init();
});

async function oneScreen(): Promise<string> {
  const result = await cp.registerMachine(hello("box-1", "HDMI-1"));
  return result.assignments[0]!.screenId;
}

/** A page binding data-1 with a KPI, a table and a chart. */
function boundPage(): PageDefinition {
  return definitionWith([
    {
      id: "k1",
      kind: "kpi",
      x: 0,
      y: 0,
      w: 20,
      h: 16,
      props: { binding: { dataSourceId: "data-1", field: "output", row: 0 }, label: "Line A", unit: "%", deltaField: "delta", worseWhen: "below" },
    },
    { id: "t1", kind: "table", x: 30, y: 0, w: 40, h: 40, props: { dataSourceId: "data-1", columns: [], rows: 8, header: true } },
    { id: "c1", kind: "chart", x: 30, y: 50, w: 40, h: 30, props: { dataSourceId: "data-1", field: "output", labelField: "line", type: "line", color: "#3b82f6", points: 20 } },
  ]);
}

describe("data-source CRUD", () => {
  test("create assigns an id, defaults the cadence, and persists CONFIG only", async () => {
    const created = await cp.createDataSource({
      name: "Line output",
      url: "https://example.test/output.json",
      format: "json",
    });
    if ("error" in created) throw new Error("create failed");

    expect(created.id).toBe("data-1");
    expect(created.pollSeconds).toBe(60);
    expect(created.authIn).toBe("header");

    const persisted = (await store.load()).dataSources;
    expect(persisted).toEqual([
      {
        id: "data-1",
        name: "Line output",
        url: "https://example.test/output.json",
        format: "json",
        pollSeconds: 60,
        credentialProfileId: null,
        authIn: "header",
        rowsPath: "",
      },
    ]);
    // Nothing resembling a polled VALUE is stored on the row — the config carries no data at all.
    expect(JSON.stringify(persisted)).not.toContain("columns");
    expect(JSON.stringify(persisted)).not.toContain("fetchedAt");
  });

  test("update patches, and a create/update naming an unknown profile is refused", async () => {
    const created = await cp.createDataSource({ name: "A", url: "https://a.test/x.csv", format: "csv" });
    if ("error" in created) throw new Error("create failed");

    const bad = await cp.updateDataSource(created.id, { credentialProfileId: "credential-404" });
    expect(bad).toEqual({ error: "unknown-profile" });

    const updated = await cp.updateDataSource(created.id, { pollSeconds: 300, name: "B" });
    if ("error" in updated) throw new Error("update failed");
    expect(updated).toMatchObject({ name: "B", pollSeconds: 300, format: "csv" });

    expect(await cp.updateDataSource("data-404", { name: "x" })).toEqual({ error: "unknown-source" });
  });

  test("configs survive a restart (a new ControlPlane over the same store)", async () => {
    await cp.createDataSource({ name: "A", url: "https://a.test/x.json", format: "json", rowsPath: "data.items" });

    const restarted = new ControlPlane(store);
    await restarted.init();

    expect(restarted.getDataSources()).toHaveLength(1);
    expect(restarted.getDataSource("data-1")?.rowsPath).toBe("data.items");
    // The id counter resumes, so the next source doesn't collide.
    const next = await restarted.createDataSource({ name: "B", url: "https://b.test/y.json", format: "json" });
    if ("error" in next) throw new Error("create failed");
    expect(next.id).toBe("data-2");
  });
});

describe("send-time datasets (decorateSliceForSend)", () => {
  test("bound rows ride in data.datasets keyed by SOURCE id — once, however many elements bind it", async () => {
    const screenId = await oneScreen();
    await cp.createDataSource({ name: "Output", url: "https://example.test/o.json", format: "json" });
    cp.setPageDataProvider(provider());

    const page = await cp.createContentSource({ name: "Ops", kind: "page", definition: boundPage() });
    if (!page.ok) throw new Error("create failed");
    const assigned = await cp.setScreenContent(screenId, { sourceId: page.source.id });
    if (!assigned.ok) throw new Error("assign failed");

    const surface = cp.decorateSliceForSend(assigned.slice).surfaces[0]!;
    if (surface.type !== "page") throw new Error("expected a page surface");
    expect(Object.keys(surface.data?.datasets ?? {})).toEqual(["data-1"]); // ONE payload for 3 elements
    expect(surface.data?.datasets?.["data-1"]?.rows).toEqual(ROWS.rows);

    // The STORED slice never carries values — the DB holds no live numbers (D19's clean-at-rest rule).
    const stored = cp.state.slices[screenId]!.surfaces[0]!;
    expect(stored.type === "page" && stored.data).toBeFalsy();
  });

  test("a binding naming a MISSING FIELD still ships the dataset — the element draws the hole", async () => {
    const screenId = await oneScreen();
    await cp.createDataSource({ name: "Output", url: "https://example.test/o.json", format: "json" });
    cp.setPageDataProvider(provider());

    const page = await cp.createContentSource({
      name: "Typo",
      kind: "page",
      definition: definitionWith([
        {
          id: "k1",
          kind: "kpi",
          x: 0,
          y: 0,
          w: 20,
          h: 16,
          props: { binding: { dataSourceId: "data-1", field: "nonexistent", row: 0 }, label: "?", unit: "", deltaField: "", worseWhen: "above" },
        },
      ]),
    });
    if (!page.ok) throw new Error("create failed");
    const assigned = await cp.setScreenContent(screenId, { sourceId: page.source.id });
    if (!assigned.ok) throw new Error("assign failed");

    const surface = cp.decorateSliceForSend(assigned.slice).surfaces[0]!;
    if (surface.type !== "page") throw new Error("expected a page surface");
    // The DATA is there (the page renders); only the field is absent — resolution (and the visible
    // hole) is the renderer's job, and the server never guesses a substitute value.
    expect(surface.data?.datasets?.["data-1"]?.columns).toEqual(["line", "output", "delta"]);
  });

  test("a bound source with NO data yet ships nothing at all (no invented rows)", async () => {
    const screenId = await oneScreen();
    await cp.createDataSource({ name: "Output", url: "https://example.test/o.json", format: "json" });
    cp.setPageDataProvider(provider(null));

    const page = await cp.createContentSource({ name: "Ops", kind: "page", definition: boundPage() });
    if (!page.ok) throw new Error("create failed");
    const assigned = await cp.setScreenContent(screenId, { sourceId: page.source.id });
    if (!assigned.ok) throw new Error("assign failed");

    const surface = cp.decorateSliceForSend(assigned.slice).surfaces[0]!;
    if (surface.type !== "page") throw new Error("expected a page surface");
    expect(surface.data?.datasets).toBeUndefined();
  });

  test("a STALE dataset travels with its flag — the wall keeps the numbers AND shows the tell", async () => {
    const screenId = await oneScreen();
    await cp.createDataSource({ name: "Output", url: "https://example.test/o.json", format: "json" });
    cp.setPageDataProvider(provider({ ...ROWS, stale: true }));

    const page = await cp.createContentSource({ name: "Ops", kind: "page", definition: boundPage() });
    if (!page.ok) throw new Error("create failed");
    const assigned = await cp.setScreenContent(screenId, { sourceId: page.source.id });
    if (!assigned.ok) throw new Error("assign failed");

    const surface = cp.decorateSliceForSend(assigned.slice).surfaces[0]!;
    if (surface.type !== "page") throw new Error("expected a page surface");
    expect(surface.data?.datasets?.["data-1"]?.stale).toBe(true);
    expect(surface.data?.datasets?.["data-1"]?.rows).toEqual(ROWS.rows);
  });
});

describe("polling requirements + auth", () => {
  test("only pages ON GLASS create a requirement; an unassigned draft polls nothing", async () => {
    await cp.createDataSource({ name: "Output", url: "https://example.test/o.json", format: "json" });
    const page = await cp.createContentSource({ name: "Ops", kind: "page", definition: boundPage() });
    if (!page.ok) throw new Error("create failed");

    expect(cp.pageDataRequirements().dataSources.size).toBe(0);

    const screenId = await oneScreen();
    await cp.setScreenContent(screenId, { sourceId: page.source.id });

    const req = cp.pageDataRequirements();
    expect([...req.dataSources]).toEqual(["data-1"]);
    expect([...(req.sourcesByDataSource.get("data-1") ?? [])]).toEqual([page.source.id]);
  });

  test("dataSourceAuth resolves the profile's CURRENT token per fetch (nothing is stamped at rest)", async () => {
    const profile = await cp.createCredentialProfile({
      name: "IdP",
      tokenEndpoint: "https://idp.test/token",
      clientId: "kiosk",
      clientSecret: "s3cret",
      tokenParam: "access_token",
    });
    const created = await cp.createDataSource({
      name: "Private",
      url: "https://example.test/private.json",
      format: "json",
      credentialProfileId: profile.id,
      authIn: "query",
    });
    if ("error" in created) throw new Error("create failed");

    let current = "tok-1";
    cp.setTokenProvider({ getToken: () => current, statusFor: () => ({ tokenStatus: "ok" as const }) });

    expect(cp.dataSourceAuth("data-1")).toEqual({ in: "query", param: "access_token", token: "tok-1" });
    current = "tok-2"; // a refresh: the NEXT fetch simply picks up the new token
    expect(cp.dataSourceAuth("data-1")?.token).toBe("tok-2");

    // The persisted row carries the profile REFERENCE, never a token.
    const persisted = (await store.load()).dataSources[0]!;
    expect(persisted.credentialProfileId).toBe(profile.id);
    expect(JSON.stringify(persisted)).not.toContain("tok-");
  });

  test("no usable token → no auth (the fetch goes out unauthenticated and fails VISIBLY)", async () => {
    const profile = await cp.createCredentialProfile({
      name: "IdP",
      tokenEndpoint: "https://idp.test/token",
      clientId: "kiosk",
      clientSecret: "s3cret",
    });
    await cp.createDataSource({
      name: "Private",
      url: "https://example.test/p.json",
      format: "json",
      credentialProfileId: profile.id,
    });
    cp.setTokenProvider({ getToken: () => undefined, statusFor: () => ({ tokenStatus: "error" as const }) });

    expect(cp.dataSourceAuth("data-1")).toBeUndefined();
  });
});

describe("delete guards", () => {
  test("a data source bound by a page cannot be deleted (unbind first)", async () => {
    await cp.createDataSource({ name: "Output", url: "https://example.test/o.json", format: "json" });
    const page = await cp.createContentSource({ name: "Ops", kind: "page", definition: boundPage() });
    if (!page.ok) throw new Error("create failed");

    expect(await cp.deleteDataSource("data-1")).toEqual({ ok: false, error: "in-use", inUseBy: 1 });
    expect(cp.getDataSourceViews()[0]?.inUseBy).toBe(1);

    // Unbind (an empty page) and it goes.
    await cp.updateContentSource(page.source.id, { definition: definitionWith([]) });
    expect(await cp.deleteDataSource("data-1")).toEqual({ ok: true });
    expect(await cp.deleteDataSource("data-1")).toEqual({ ok: false, error: "unknown-source" });
  });

  test("a credential profile used by a DATA SOURCE counts as in-use (deleting it would 401 a wall)", async () => {
    const profile = await cp.createCredentialProfile({
      name: "IdP",
      tokenEndpoint: "https://idp.test/token",
      clientId: "kiosk",
      clientSecret: "s3cret",
    });
    await cp.createDataSource({
      name: "Private",
      url: "https://example.test/p.json",
      format: "json",
      credentialProfileId: profile.id,
    });

    expect(await cp.deleteCredentialProfile(profile.id)).toEqual({ ok: false, error: "in-use", inUseBy: 1 });
  });
});

describe("live re-push", () => {
  test("slicesShowingDataSource finds every screen showing a page bound to it", async () => {
    const screenId = await oneScreen();
    await cp.createDataSource({ name: "Output", url: "https://example.test/o.json", format: "json" });
    const page = await cp.createContentSource({ name: "Ops", kind: "page", definition: boundPage() });
    if (!page.ok) throw new Error("create failed");
    await cp.setScreenContent(screenId, { sourceId: page.source.id });

    expect(cp.slicesShowingDataSource("data-1").map((s) => s.screenId)).toEqual([screenId]);
    expect(cp.slicesShowingDataSource("data-2")).toEqual([]);
  });
});
