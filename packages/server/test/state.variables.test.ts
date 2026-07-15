/**
 * POL-111 — per-screen template variables, through the ControlPlane.
 *
 * The load-bearing property (the same one POL-24 credential stamping established, D63): substitution
 * happens ON THE WAY OUT. The DB and the stored slices always keep the CLEAN `{{placeholder}}` — so
 * ONE source really is one source, and fifty screens each get their own resolved copy for free.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import type { PageSurface, WebSurface } from "@polyptic/protocol";

import { ControlPlane, type RegisterMachineInput } from "../src/state";
import { MemoryStore } from "../src/store/memory";

function hello(machineId: string, hostname: string): RegisterMachineInput {
  return {
    machineId,
    agentVersion: "test",
    backend: "wayland-sway",
    outputs: [
      { connector: "DP-1", width: 1920, height: 1080 },
      { connector: "DP-2", width: 1920, height: 1080 },
    ],
    hostname,
  };
}

let store: MemoryStore;
let cp: ControlPlane;
let a: string; // screen on DP-1
let b: string; // screen on DP-2

beforeEach(async () => {
  store = new MemoryStore();
  cp = new ControlPlane(store);
  await cp.init();
  await cp.registerMachine(hello("box-1", "wall1"), undefined);
  const screens = cp.getScreens();
  a = screens.find((s) => s.connector === "DP-1")!.id;
  b = screens.find((s) => s.connector === "DP-2")!.id;
});

/** Assign one library dashboard source (with placeholders in its URL) to both screens. */
async function assignTemplatedDashboard(url: string): Promise<string> {
  const created = await cp.createContentSource({ name: "KPI", kind: "dashboard", url });
  if (!created.ok) throw new Error("create failed");
  await cp.setScreenContent(a, { sourceId: created.source.id });
  await cp.setScreenContent(b, { sourceId: created.source.id });
  return created.source.id;
}

function sentUrl(screenId: string): string {
  const slice = cp.decorateSliceForSend(cp.sliceForPlayer(screenId));
  return (slice.surfaces[0] as WebSurface).url;
}

describe("the map itself", () => {
  test("screens are born with no variables", () => {
    for (const s of cp.getScreens()) expect(s.variables).toEqual({});
  });

  test("set / replace / unknown screen", async () => {
    expect(await cp.setScreenVariables(a, { line: "Line 3" })).not.toBeNull();
    expect(cp.getScreen(a)?.variables).toEqual({ line: "Line 3" });
    // Whole-map semantics: the second call REPLACES, it does not merge.
    await cp.setScreenVariables(a, { site: "Sheffield" });
    expect(cp.getScreen(a)?.variables).toEqual({ site: "Sheffield" });
    expect(await cp.setScreenVariables("screen-nope", { x: "1" })).toBeNull();
  });

  test("variables persist across a restart, and a rename never disturbs them", async () => {
    await cp.setScreenVariables(a, { line: "Line 3" });
    await cp.renameScreen(a, "Line 3 Andon");
    const cp2 = new ControlPlane(store);
    await cp2.init();
    expect(cp2.getScreen(a)?.variables).toEqual({ line: "Line 3" });
    expect(cp2.getScreen(a)?.friendlyName).toBe("Line 3 Andon");
  });

  test("setting variables does NOT bump the revision (the slice is unchanged; only its decoration is)", async () => {
    const before = cp.state.revision;
    await cp.setScreenVariables(a, { line: "Line 3" });
    expect(cp.state.revision).toBe(before);
  });
});

describe("send-time substitution (the DoD)", () => {
  test("ONE source renders differently on TWO screens", async () => {
    await assignTemplatedDashboard("https://g.test/d/kpi?var-line={{line}}&var-site={{site}}");
    await cp.setScreenVariables(a, { line: "3", site: "Sheffield" });
    await cp.setScreenVariables(b, { line: "4", site: "Rotherham" });

    expect(sentUrl(a)).toBe("https://g.test/d/kpi?var-line=3&var-site=Sheffield");
    expect(sentUrl(b)).toBe("https://g.test/d/kpi?var-line=4&var-site=Rotherham");
  });

  test("built-ins resolve with no operator configuration at all", async () => {
    await assignTemplatedDashboard(
      "https://g.test/d/kpi?s={{screen.name}}&id={{screen.id}}&h={{machine.hostname}}",
    );
    await cp.renameScreen(a, "Sheffield Lobby");
    const url = new URL(sentUrl(a));
    expect(url.searchParams.get("s")).toBe("Sheffield Lobby");
    expect(url.searchParams.get("id")).toBe(a);
    expect(url.searchParams.get("h")).toBe("wall1");
  });

  test("an undefined placeholder sends EMPTY — never literal braces — and is reported as unresolved", async () => {
    await assignTemplatedDashboard("https://g.test/d/kpi?line={{lien}}");
    expect(sentUrl(a)).toBe("https://g.test/d/kpi?line=");
    expect(cp.unresolvedVariablesFor(a)).toEqual(["lien"]);

    await cp.setScreenVariables(a, { lien: "3" });
    expect(cp.unresolvedVariablesFor(a)).toEqual([]);
  });

  test("PROPERTY: nothing substituted is ever persisted — stored slice + DB keep the CLEAN url", async () => {
    const template = "https://g.test/d/kpi?var-line={{line}}";
    const sourceId = await assignTemplatedDashboard(template);
    await cp.setScreenVariables(a, { line: "3" });

    // The send-time copy is resolved …
    expect(sentUrl(a)).toBe("https://g.test/d/kpi?var-line=3");

    // … the in-memory slice, the library source, and the persisted rows are NOT.
    expect((cp.getSlice(a)!.surfaces[0] as WebSurface).url).toBe(template);
    expect(cp.getContentSource(sourceId)?.url).toBe(template);

    const persisted = await store.load();
    for (const row of persisted.content) {
      for (const surface of row.surfaces) {
        if (surface.type === "web" || surface.type === "dashboard") expect(surface.url).toBe(template);
      }
    }
    expect(persisted.contentSources.find((s) => s.id === sourceId)?.url).toBe(template);

    // And a restart still holds the template, not one screen's resolution of it.
    const cp2 = new ControlPlane(store);
    await cp2.init();
    expect((cp2.getSlice(b)!.surfaces[0] as WebSurface).url).toBe(template);
  });

  test("a wall member's own variables win: one spanning source, per-panel flavour", async () => {
    await assignTemplatedDashboard("https://g.test/d/kpi?p={{panel}}");
    await cp.setScreenVariables(a, { panel: "left" });
    await cp.setScreenVariables(b, { panel: "right" });
    expect(new URL(sentUrl(a)).searchParams.get("p")).toBe("left");
    expect(new URL(sentUrl(b)).searchParams.get("p")).toBe("right");
  });

  test("page text and tickers are substituted in the SENT definition only", async () => {
    const created = await cp.createContentSource({
      name: "Andon",
      kind: "page",
      definition: {
        aspect: "16:9",
        bg: "#000000",
        elements: [
          {
            id: "t1",
            kind: "text",
            x: 5,
            y: 5,
            w: 50,
            h: 10,
            props: { text: "{{site}} — {{line}}", size: 40, color: "#fff", align: "left" },
          },
          {
            id: "k1",
            kind: "ticker",
            x: 0,
            y: 90,
            w: 100,
            h: 10,
            props: { text: "Now showing on {{screen.name}}", speed: 60, fg: "#fff", bg: "#000" },
          },
        ],
      },
    });
    if (!created.ok) throw new Error("create failed");
    await cp.setScreenContent(a, { sourceId: created.source.id });
    await cp.setScreenVariables(a, { site: "Sheffield", line: "Line 3" });
    await cp.renameScreen(a, "Lobby");

    const sent = cp.decorateSliceForSend(cp.sliceForPlayer(a)).surfaces[0] as PageSurface;
    const els = sent.definition.elements;
    expect(els[0]?.kind === "text" && els[0].props.text).toBe("Sheffield — Line 3");
    expect(els[1]?.kind === "ticker" && els[1].props.text).toBe("Now showing on Lobby");

    // The STORED page keeps its templates — that is what makes the source reusable.
    const stored = cp.getContentSource(created.source.id)?.definition?.elements[0];
    expect(stored?.kind === "text" && stored.props.text).toBe("{{site}} — {{line}}");
    const storedSurface = cp.getSlice(a)!.surfaces[0] as PageSurface;
    expect(storedSurface.definition.elements[0]?.kind === "text").toBe(true);
    const storedText = storedSurface.definition.elements[0];
    expect(storedText?.kind === "text" && storedText.props.text).toBe("{{site}} — {{line}}");
  });

  test("a hostile value cannot add a query parameter to the URL a kiosk browser loads", async () => {
    await assignTemplatedDashboard("https://g.test/d/kpi?line={{line}}");
    await cp.setScreenVariables(a, { line: "3&orgId=666" });
    const url = new URL(sentUrl(a));
    expect(url.searchParams.get("orgId")).toBeNull();
    expect(url.searchParams.get("line")).toBe("3&orgId=666");
  });

  test("substitution runs BEFORE the credential stamp, and the token is never mangled", async () => {
    const profile = await cp.createCredentialProfile({
      name: "grafana",
      tokenEndpoint: "https://idp.test/token",
      clientId: "id",
      clientSecret: "secret",
      tokenParam: "auth_token",
    });
    cp.setTokenProvider({
      getToken: () => "tok-123",
      statusFor: () => ({ tokenStatus: "ok" as const }),
    });
    const created = await cp.createContentSource({
      name: "KPI",
      kind: "dashboard",
      url: "https://g.test/d/kpi?var-line={{line}}",
      credentialProfileId: profile.id,
    });
    if (!created.ok) throw new Error("create failed");
    await cp.setScreenContent(a, { sourceId: created.source.id });
    await cp.setScreenVariables(a, { line: "3" });

    const url = new URL(sentUrl(a));
    expect(url.searchParams.get("var-line")).toBe("3");
    expect(url.searchParams.get("auth_token")).toBe("tok-123");
    // Clean at rest, still: neither the token nor the value reached the store.
    expect(cp.getContentSource(created.source.id)?.url).toBe("https://g.test/d/kpi?var-line={{line}}");
  });
});
