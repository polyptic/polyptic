/**
 * POL-175 — structured source addresses, server side.
 *
 * The dialog sends a COMPOSITION (proto + address + passthrough query + Grafana display controls);
 * the server composes the canonical `url` from it on every write and stores both. `url` stays what
 * everything downstream consumes — probe, send-time stamping, players, scenes — so the properties
 * proven here are: create composes, update recomposes (and drops the stale framing verdict), a raw
 * `url` patch drops a stored composition, a kind change sheds `gf`, legacy url-only rows keep
 * working, and the whole thing survives a persist/reload round trip.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { gfDefaults, type SourceComposition } from "@polyptic/protocol";
import { ControlPlane } from "../src/state";
import { MemoryStore } from "../src/store/memory";

const COMPOSITION: SourceComposition = {
  proto: "https",
  address: "grafana.example.com/d/abc123/factory-overview",
  keep: "orgId=1",
  gf: { ...gfDefaults(), kiosk: true, picker: true, refresh: "5m" },
  auth: "none",
};
const COMPOSED =
  "https://grafana.example.com/d/abc123/factory-overview?orgId=1&kiosk=tv&hideLogo=1&_dash.hideTimePicker=true&refresh=5m";

let store: MemoryStore;
let cp: ControlPlane;

beforeEach(async () => {
  store = new MemoryStore();
  cp = new ControlPlane(store);
  await cp.init();
});

describe("create with a composition", () => {
  test("composes and stores the canonical url beside the breakdown", async () => {
    const created = await cp.createContentSource({
      name: "Factory overview",
      kind: "dashboard",
      composition: COMPOSITION,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.source.url).toBe(COMPOSED);
    expect(created.source.composition).toEqual(COMPOSITION);
  });

  test("an address that composes to a non-URL is refused, named", async () => {
    const created = await cp.createContentSource({
      name: "Broken",
      kind: "web",
      composition: { proto: "https", address: "not a host" },
    });
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error).toBe("invalid-address");
  });

  test("a plain url still works (legacy clients)", async () => {
    const created = await cp.createContentSource({
      name: "Legacy",
      kind: "dashboard",
      url: "https://g.test/d/x/y?kiosk",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.source.url).toBe("https://g.test/d/x/y?kiosk");
    expect(created.source.composition).toBeUndefined();
  });
});

describe("update", () => {
  test("a composition patch recomposes the url and drops the stale framing verdict", async () => {
    const created = await cp.createContentSource({
      name: "Factory overview",
      kind: "dashboard",
      composition: COMPOSITION,
    });
    if (!created.ok) throw new Error("create failed");
    await cp.setSourceFraming(created.source.id, "ok");

    const patched = await cp.updateContentSource(created.source.id, {
      composition: { ...COMPOSITION, gf: { ...gfDefaults(), kiosk: true, picker: false } },
    });
    expect(patched.ok).toBe(true);
    if (!patched.ok) return;
    expect(patched.source.url).toBe(
      "https://grafana.example.com/d/abc123/factory-overview?orgId=1&kiosk=1&hideLogo=1&_dash.hideTimePicker=true",
    );
    // The verdict described the old address — it must not survive the recomposition.
    expect(patched.source.framing).toBeUndefined();
  });

  test("a raw url patch drops the stored composition (the breakdown no longer describes it)", async () => {
    const created = await cp.createContentSource({
      name: "Factory overview",
      kind: "dashboard",
      composition: COMPOSITION,
    });
    if (!created.ok) throw new Error("create failed");

    const patched = await cp.updateContentSource(created.source.id, {
      url: "https://elsewhere.test/d/z/other",
    });
    expect(patched.ok).toBe(true);
    if (!patched.ok) return;
    expect(patched.source.url).toBe("https://elsewhere.test/d/z/other");
    expect(patched.source.composition).toBeUndefined();
  });

  test("a kind change away from dashboard sheds the Grafana controls but keeps the address", async () => {
    const created = await cp.createContentSource({
      name: "Factory overview",
      kind: "dashboard",
      composition: COMPOSITION,
    });
    if (!created.ok) throw new Error("create failed");

    const patched = await cp.updateContentSource(created.source.id, { kind: "web" });
    expect(patched.ok).toBe(true);
    if (!patched.ok) return;
    expect(patched.source.composition).toEqual({
      proto: "https",
      address: "grafana.example.com/d/abc123/factory-overview",
      keep: "orgId=1",
      auth: "none",
    });
    // The url recomposes WITHOUT the Grafana flags — a web page gets no kiosk param.
    expect(patched.source.url).toBe(
      "https://grafana.example.com/d/abc123/factory-overview?orgId=1",
    );
  });

  test("a name-only patch keeps composition and url untouched", async () => {
    const created = await cp.createContentSource({
      name: "Factory overview",
      kind: "dashboard",
      composition: COMPOSITION,
    });
    if (!created.ok) throw new Error("create failed");

    const patched = await cp.updateContentSource(created.source.id, { name: "Renamed" });
    expect(patched.ok).toBe(true);
    if (!patched.ok) return;
    expect(patched.source.url).toBe(COMPOSED);
    expect(patched.source.composition).toEqual(COMPOSITION);
  });

  test("a legacy url-only source patches exactly as before", async () => {
    const created = await cp.createContentSource({
      name: "Legacy",
      kind: "dashboard",
      url: "https://g.test/d/x/y?kiosk",
    });
    if (!created.ok) throw new Error("create failed");

    const patched = await cp.updateContentSource(created.source.id, {
      url: "https://g.test/d/x/y?kiosk=tv",
    });
    expect(patched.ok).toBe(true);
    if (!patched.ok) return;
    expect(patched.source.url).toBe("https://g.test/d/x/y?kiosk=tv");
    expect(patched.source.composition).toBeUndefined();
  });
});

describe("persistence", () => {
  test("composition survives a persist/reload round trip", async () => {
    const created = await cp.createContentSource({
      name: "Factory overview",
      kind: "dashboard",
      composition: COMPOSITION,
    });
    if (!created.ok) throw new Error("create failed");

    const reloaded = new ControlPlane(store);
    await reloaded.init();
    const source = reloaded.getContentSource(created.source.id);
    expect(source?.url).toBe(COMPOSED);
    expect(source?.composition).toEqual(COMPOSITION);
  });

  test("a legacy row with no composition loads as before", async () => {
    const created = await cp.createContentSource({
      name: "Legacy",
      kind: "web",
      url: "https://example.com/page?a=b",
    });
    if (!created.ok) throw new Error("create failed");

    const reloaded = new ControlPlane(store);
    await reloaded.init();
    const source = reloaded.getContentSource(created.source.id);
    expect(source?.url).toBe("https://example.com/page?a=b");
    expect(source?.composition).toBeUndefined();
  });
});
