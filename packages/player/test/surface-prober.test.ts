/**
 * Surface prober (POL-86) — the wall paints only PROVEN-reachable content and re-proves on doubt.
 *
 * The behaviours worth pinning are the ones whose absence shipped a broken wall:
 *   - nothing is painted until the probe passes (the sad face / broken-image icon never appears);
 *   - a probe that fails keeps retrying forever — a wall with no human must converge on its own;
 *   - a network hint re-probes and reloads EVEN a surface that looks healthy (in-flight loads may
 *     have been aborted with no event we can see);
 *   - a warranted-but-rate-limited heal is queued, never dropped — dropping one is exactly how the
 *     signal-driven watchdog this replaces stayed blind on real hardware.
 */
import { describe, expect, mock, test } from "bun:test";

import { SurfaceProber } from "../src/surface-prober";
import type { SurfaceProberOptions } from "../src/surface-prober";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A controllable probe: per-URL scripted outcomes, resolved in call order. */
function scriptedProbe(script: (url: string, call: number) => Promise<void>): {
  probe: (url: string) => Promise<void>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    probe: (url: string) => {
      calls.push(url);
      return script(url, calls.length);
    },
  };
}

function harness(overrides: Partial<SurfaceProberOptions> = {}) {
  const painted: Array<[string, string]> = [];
  const cleared: string[] = [];
  const reloaded: string[] = [];
  const health: Array<[string, string, string | undefined]> = [];
  const prober = new SurfaceProber({
    paint: (id, url) => painted.push([id, url]),
    clear: (id) => cleared.push(id),
    reload: (id) => reloaded.push(id),
    onHealth: (c) => health.push([c.id, c.state, c.detail]),
    probe: () => Promise.resolve(),
    probeBackoffMinMs: 10,
    probeBackoffMaxMs: 40,
    verifyDelaysMs: [], // most tests do not exercise verification; the ones that do override this
    minReloadIntervalMs: 0,
    recheckDebounceMs: 1,
    errorRetryMinMs: 5,
    ...overrides,
  });
  return { prober, painted, cleared, reloaded, health };
}

describe("SurfaceProber", () => {
  test("onProbeFail reports each failed probe (POL-108: a live surface says 'cannot reach the source')", async () => {
    const failures: Array<[string, number, string]> = [];
    const h = harness({
      probe: () => Promise.reject(new Error("dns is not ready")),
      onProbeFail: (id, attempts, error) => failures.push([id, attempts, error]),
    });
    h.prober.sync([{ id: "s1", url: "http://cam/live.m3u8" }]);

    await sleep(40);
    expect(failures.length).toBeGreaterThanOrEqual(2);
    expect(failures[0]).toEqual(["s1", 1, "dns is not ready"]);
    expect(failures[1]![1]).toBe(2); // the streak is what tells the player to stop saying "connecting"
    h.prober.stop();
  });

  test("nothing is painted until the probe passes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness({ probe: () => gate });
    h.prober.sync([{ id: "s1", url: "http://c/x" }]);

    await sleep(20);
    expect(h.painted).toEqual([]); // probe still in flight — the element must stay dark

    release();
    await sleep(20);
    expect(h.painted).toEqual([["s1", "http://c/x"]]);
    h.prober.stop();
  });

  test("a failing probe retries with backoff and paints when the network arrives", async () => {
    // The TEST 8 boot: DNS/route not ready when the player starts, settles a moment later.
    const { probe, calls } = scriptedProbe((_url, call) =>
      call < 3 ? Promise.reject(new TypeError("Failed to fetch")) : Promise.resolve(),
    );
    const h = harness({ probe });
    h.prober.sync([{ id: "s1", url: "http://c/x" }]);

    await sleep(100);
    expect(calls.length).toBe(3);
    expect(h.painted).toEqual([["s1", "http://c/x"]]);
    h.prober.stop();
  });

  test("a changed url keeps the OLD content painted until the NEW url proves", async () => {
    let failNew = true;
    const h = harness({
      probe: (url) =>
        url === "http://c/new" && failNew ? Promise.reject(new Error("down")) : Promise.resolve(),
    });
    h.prober.sync([{ id: "s1", url: "http://c/old" }]);
    await sleep(20);
    expect(h.painted).toEqual([["s1", "http://c/old"]]);

    h.prober.sync([{ id: "s1", url: "http://c/new" }]);
    await sleep(20);
    // New url unreachable: no new paint AND no clear — the old content keeps the wall alive.
    expect(h.painted).toEqual([["s1", "http://c/old"]]);
    expect(h.cleared).toEqual([]);

    failNew = false;
    await sleep(60);
    expect(h.painted).toEqual([
      ["s1", "http://c/old"],
      ["s1", "http://c/new"],
    ]);
    h.prober.stop();
  });

  test("a failed verify re-proves and then reloads IN PLACE (no clear — content may be fine)", async () => {
    // Paint succeeds; the network then moves (verify fails); when it settles, the element is
    // re-fetched in place, because its load may have been aborted invisibly (SOP).
    let phase: "up" | "down" | "back" = "up";
    const h = harness({
      probe: () => (phase === "down" ? Promise.reject(new Error("moved")) : Promise.resolve()),
      verifyDelaysMs: [20],
    });
    h.prober.sync([{ id: "s1", url: "http://c/x" }]);
    await sleep(10);
    expect(h.painted.length).toBe(1);

    phase = "down";
    await sleep(25); // verify fires and fails → back to proving
    phase = "back";
    await sleep(40);
    expect(h.reloaded).toEqual(["s1"]);
    expect(h.cleared).toEqual([]); // never blanked a possibly-fine page
    h.prober.stop();
  });

  test("a media element error clears the corpse and re-proves with its own backoff", async () => {
    const h = harness({ verifyDelaysMs: [] });
    h.prober.sync([{ id: "s1", url: "http://c/img" }]);
    await sleep(10);
    expect(h.painted.length).toBe(1);

    // The img fired `error` (e.g. its fetch was killed by ERR_NETWORK_CHANGED).
    h.prober.elementError("s1");
    expect(h.cleared).toEqual(["s1"]); // broken-image icon must not stay on the wall

    await sleep(30); // errorRetryMinMs passes, probe passes → painted again
    expect(h.painted.length).toBe(2);
    h.prober.stop();
  });

  test("a reachable-but-undecodable asset backs off instead of spinning", async () => {
    // Probe always passes (the URL is reachable); the element always errors (404/corrupt asset).
    const h = harness({ errorRetryMinMs: 20, verifyDelaysMs: [] });
    h.prober.sync([{ id: "s1", url: "http://c/broken" }]);
    await sleep(10);

    h.prober.elementError("s1");
    await sleep(30);
    const paintsAfterFirstError = h.painted.length;
    h.prober.elementError("s1"); // streak 2 → 40ms wait
    await sleep(25);
    // Backoff doubled: the second retry must NOT have happened yet.
    expect(h.painted.length).toBe(paintsAfterFirstError);
    await sleep(30);
    expect(h.painted.length).toBe(paintsAfterFirstError + 1);
    h.prober.stop();
  });

  test("a network signal reloads even a surface that looks healthy", async () => {
    // In-flight loads may have been aborted with NO event we can see; reachable-now is not
    // proof the element survived. This is the watchdog behaviour, now probe-backed.
    const h = harness();
    h.prober.sync([{ id: "s1", url: "http://c/x" }]);
    await sleep(10);
    expect(h.painted.length).toBe(1);

    h.prober.recheck("browser reported online");
    await sleep(20);
    expect(h.reloaded).toEqual(["s1"]);
    h.prober.stop();
  });

  test("a burst of signals collapses into one recheck", async () => {
    const h = harness({ recheckDebounceMs: 10 });
    h.prober.sync([{ id: "s1", url: "http://c/x" }]);
    await sleep(10);

    h.prober.recheck("online");
    h.prober.recheck("socket reconnected");
    h.prober.recheck("resource error");
    await sleep(30);
    expect(h.reloaded).toEqual(["s1"]);
    h.prober.stop();
  });

  test("a rate-limited heal is QUEUED and fires later — never dropped", async () => {
    const h = harness({ minReloadIntervalMs: 60, recheckDebounceMs: 1 });
    h.prober.sync([{ id: "s1", url: "http://c/x" }]);
    await sleep(10);

    h.prober.recheck("first");
    await sleep(10);
    expect(h.reloaded).toEqual(["s1"]); // first heal is immediate (a paint is not a reload)

    h.prober.recheck("second");
    await sleep(10);
    expect(h.reloaded).toEqual(["s1"]); // refused for now…
    await sleep(80);
    expect(h.reloaded).toEqual(["s1", "s1"]); // …but fires once the interval passes
    h.prober.stop();
  });

  test("a removed surface is forgotten mid-probe", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness({ probe: () => gate });
    h.prober.sync([{ id: "s1", url: "http://c/x" }]);
    h.prober.sync([]); // operator removed it while its first probe was in flight

    release();
    await sleep(20);
    expect(h.painted).toEqual([]);
    h.prober.stop();
  });

  test("re-syncing identical targets does not restart probe loops or repaint", async () => {
    const { probe, calls } = scriptedProbe(() => Promise.resolve());
    const h = harness({ probe });
    h.prober.sync([{ id: "s1", url: "http://c/x" }]);
    await sleep(10);
    h.prober.sync([{ id: "s1", url: "http://c/x" }]); // server re-pushed the same render
    h.prober.sync([{ id: "s1", url: "http://c/x" }]);
    await sleep(10);

    expect(calls.length).toBe(1);
    expect(h.painted.length).toBe(1);
    h.prober.stop();
  });

  test("stop() is final — a torn-down player never touches the DOM again", async () => {
    const h = harness({
      probe: () => Promise.reject(new Error("down")),
    });
    h.prober.sync([{ id: "s1", url: "http://c/x" }]);
    h.prober.stop();
    h.prober.recheck("online");

    await sleep(60);
    expect(h.painted).toEqual([]);
    expect(h.reloaded).toEqual([]);
  });
});

/**
 * POL-94 — the prober's verdicts leave the box: the console's library badge is exactly this knowledge,
 * addressed per content source. The load-bearing property is CHEAPNESS: a report on every state
 * CHANGE, never on every probe — a dead URL retried forever must cost one frame, not one per retry.
 */
describe("SurfaceProber health reporting (POL-94)", () => {
  test("a proven URL reports reachable exactly once, however many probes it takes", async () => {
    let call = 0;
    const h = harness({
      probe: () => (++call < 3 ? Promise.reject(new Error("Failed to fetch")) : Promise.resolve()),
    });
    h.prober.sync([{ id: "s1", url: "http://c/x" }]);
    await sleep(80);

    // Two failures → ONE "unreachable"; then success → ONE "reachable". Not five reports.
    expect(h.health).toEqual([
      ["s1", "unreachable", "Failed to fetch"],
      ["s1", "reachable", undefined],
    ]);
    h.prober.stop();
  });

  test("a URL that stays dead is reported once, not once per retry", async () => {
    const h = harness({ probe: () => Promise.reject(new Error("Failed to fetch")) });
    h.prober.sync([{ id: "s1", url: "http://c/x" }]);
    await sleep(120); // several retries have run by now (backoff 10ms → 40ms)

    expect(h.health).toEqual([["s1", "unreachable", "Failed to fetch"]]);
    h.prober.stop();
  });

  test("a verify failure after a good paint reports the break", async () => {
    let call = 0;
    const h = harness({
      // 1: prove (ok) → paint. 2: verify (fails) → the network moved after the paint.
      probe: () => (++call === 2 ? Promise.reject(new Error("Failed to fetch")) : Promise.resolve()),
      verifyDelaysMs: [10],
    });
    h.prober.sync([{ id: "s1", url: "http://c/x" }]);
    await sleep(60);

    expect(h.health[0]).toEqual(["s1", "reachable", undefined]);
    expect(h.health[1]).toEqual(["s1", "unreachable", "Failed to fetch"]);
    h.prober.stop();
  });

  test("a media element that fails to load is unreachable even though the URL probes fine", async () => {
    const h = harness({ probe: () => Promise.resolve() });
    h.prober.sync([{ id: "s1", url: "http://c/x.png" }]);
    await sleep(10);
    expect(h.health).toEqual([["s1", "reachable", undefined]]);

    // A 404 image is perfectly "reachable" — and a broken-image icon on the wall. The element wins.
    h.prober.elementError("s1");
    await sleep(40);
    expect(h.health[1]).toEqual(["s1", "unreachable", "element failed to load"]);
    // The re-prove SUCCEEDS (the URL was never the problem) — and must NOT report a false green.
    expect(h.health.filter(([, state]) => state === "reachable")).toHaveLength(1);

    // Only a real load clears it.
    h.prober.elementLoaded("s1");
    expect(h.health[h.health.length - 1]).toEqual(["s1", "reachable", undefined]);
    h.prober.stop();
  });

  test("a retargeted surface forgets its old verdict (the answer was about another URL)", async () => {
    const h = harness({
      probe: (url: string) =>
        url.endsWith("/dead") ? Promise.reject(new Error("Failed to fetch")) : Promise.resolve(),
    });
    h.prober.sync([{ id: "s1", url: "http://c/dead" }]);
    await sleep(40);
    expect(h.health).toEqual([["s1", "unreachable", "Failed to fetch"]]);

    h.prober.sync([{ id: "s1", url: "http://c/live" }]); // operator repointed the source
    await sleep(40);
    expect(h.health[1]).toEqual(["s1", "reachable", undefined]);
    expect(h.prober.snapshot()).toEqual([{ id: "s1", url: "http://c/live", state: "reachable" }]);
    h.prober.stop();
  });

  test("snapshot() is what a reconnecting player re-states (the server forgot it when it dropped)", async () => {
    const h = harness({
      probe: (url: string) =>
        url.endsWith("/dead") ? Promise.reject(new Error("Failed to fetch")) : Promise.resolve(),
    });
    h.prober.sync([
      { id: "s1", url: "http://c/live" },
      { id: "s2", url: "http://c/dead" },
    ]);
    await sleep(60);

    expect(h.prober.snapshot()).toEqual([
      { id: "s1", url: "http://c/live", state: "reachable" },
      { id: "s2", url: "http://c/dead", state: "unreachable" },
    ]);
    h.prober.stop();
  });
});
