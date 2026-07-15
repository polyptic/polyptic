/**
 * POL-132 — the page-side update discipline (ShellUpdater), pinned against fakes.
 *
 * The invariants that keep a fleet healthy:
 *   - a newer build NEVER swaps in mid-outage or mid-anything: only at a safe moment — a server
 *     CONTACT (proof of reachability in itself; it must not re-consult a polled gate that may lag
 *     the very event that fired it — the review-caught bug), or an install completing while the
 *     gate reads open (the reload either way repaints instantly from the last-good slice);
 *   - every server contact revalidates (registration.update()), so a wall is never pinned to an
 *     old shell past the next successful contact (D107 version discipline);
 *   - the swap is written to player.diag ("shell from cache (vX) → updating to vY") — D78: the
 *     trail is how walls get debugged, silent swaps don't exist;
 *   - exactly ONE reload per swap, and a first-install claim (controllerchange with no swap
 *     requested) never reloads a freshly-loaded wall.
 */
import { describe, expect, test } from "bun:test";

import { ShellUpdater, scopeFor } from "../src/sw-register";
import type { RegistrationLike, WorkerLike } from "../src/sw-register";

function makeWorld(opts?: { safe?: boolean; controller?: boolean; nextVersion?: string | null }) {
  const log: string[] = [];
  const posted: unknown[] = [];
  let safe = opts?.safe ?? true;
  let updateCalls = 0;
  let reloads = 0;

  const waiting: WorkerLike = {
    postMessage: (m) => posted.push(m),
  };

  const updatefound: Array<() => void> = [];
  const registration: RegistrationLike & { waiting: WorkerLike | null; installing: WorkerLike | null } = {
    waiting: null,
    installing: null,
    addEventListener: (_t, fn) => updatefound.push(fn),
    update: async () => {
      updateCalls += 1;
    },
  };

  const updater = new ShellUpdater({
    log: (m) => log.push(m),
    version: "1.0.0",
    safeToSwap: () => safe,
    hasController: () => opts?.controller ?? true,
    versionOf: async () => (opts && "nextVersion" in opts ? (opts.nextVersion ?? null) : "2.0.0"),
    reload: () => {
      reloads += 1;
    },
  });

  return {
    updater,
    registration,
    waiting,
    log,
    posted,
    setSafe: (v: boolean) => {
      safe = v;
    },
    updateCalls: () => updateCalls,
    reloads: () => reloads,
    fireUpdatefound: () => updatefound.forEach((f) => f()),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("ShellUpdater", () => {
  test("a waiting build + safe moment → diag line names both versions, worker told to take over", async () => {
    const w = makeWorld({ safe: true });
    w.registration.waiting = w.waiting;
    w.updater.attach(w.registration);
    await flush();
    expect(w.log).toEqual(["shell from cache (v1.0.0) → updating to v2.0.0 — reloading"]);
    expect(w.posted).toEqual([{ t: "polyptic/skip-waiting" }]);
  });

  test("install completes with NO contact and the gate closed → announces once, waits", async () => {
    const w = makeWorld({ safe: false });
    // A background install finishing is not a server contact — it must respect the gate.
    w.updater.attach(w.registration);
    const listeners: Array<() => void> = [];
    w.registration.installing = {
      state: "installing",
      postMessage: () => {},
      addEventListener: (_t: string, fn: () => void) => listeners.push(fn),
    };
    w.fireUpdatefound();
    (w.registration.installing as { state?: string }).state = "installed";
    w.registration.waiting = w.waiting;
    listeners.forEach((f) => f());
    listeners.forEach((f) => f()); // a repeat statechange must not repeat the announcement
    await flush();
    expect(w.posted).toHaveLength(0);
    expect(w.log.filter((l) => l.includes("waiting for server contact"))).toHaveLength(1);

    w.setSafe(true);
    w.updater.serverContact(); // the safe moment
    await flush();
    expect(w.posted).toEqual([{ t: "polyptic/skip-waiting" }]);
    expect(w.updateCalls()).toBe(1); // the contact revalidated the registration too
  });

  // THE REGRESSION PIN (found in review): the WS open handler once called serverContact() BEFORE
  // updating the reactive state safeToSwap() polls — so at every contact the gate read a stale
  // "connecting" and the swap deferred forever, while the trail kept claiming it was "waiting for
  // server contact". A server contact IS the safe moment by definition: it must swap even when the
  // polled gate hasn't caught up with the event that triggered it.
  test("a server contact arriving AFTER the worker installed swaps even if the polled gate reads stale", async () => {
    const w = makeWorld({ safe: false }); // the gate NEVER reads open — the stale-callback world
    w.registration.waiting = w.waiting; // the new build already finished installing
    w.updater.attach(w.registration);
    await flush();
    expect(w.posted).toHaveLength(0); // attach alone is not a contact — still gated

    w.updater.serverContact(); // WS open: the contact itself is the proof of reachability
    await flush();
    expect(w.posted).toEqual([{ t: "polyptic/skip-waiting" }]);
    expect(w.log.some((l) => l.includes("updating to v2.0.0"))).toBe(true);
  });

  test("an unknown next version still swaps, honestly labelled", async () => {
    const w = makeWorld({ nextVersion: null });
    w.registration.waiting = w.waiting;
    w.updater.attach(w.registration);
    await flush();
    expect(w.log[0]).toBe("shell from cache (v1.0.0) → updating to a newer build — reloading");
  });

  test("controllerchange after OUR swap reloads exactly once", async () => {
    const w = makeWorld();
    w.registration.waiting = w.waiting;
    w.updater.attach(w.registration);
    await flush();
    w.updater.controllerChanged();
    w.updater.controllerChanged(); // a second event must never double-reload
    expect(w.reloads()).toBe(1);
  });

  test("a first-install claim (no swap requested) never reloads a fresh wall", () => {
    const w = makeWorld();
    w.updater.attach(w.registration); // nothing waiting
    w.updater.controllerChanged(); // clients.claim() fired this
    expect(w.reloads()).toBe(0);
  });

  test("no controller → no swap (nothing is being replaced)", async () => {
    const w = makeWorld({ controller: false });
    w.registration.waiting = w.waiting;
    w.updater.attach(w.registration);
    await flush();
    expect(w.posted).toHaveLength(0);
  });

  test("an install that dies before `installed` (precache failed) writes a diag line — never silent", () => {
    const w = makeWorld();
    w.updater.attach(w.registration);
    const listeners: Array<() => void> = [];
    w.registration.installing = {
      state: "installing",
      postMessage: () => {},
      addEventListener: (_t: string, fn: () => void) => listeners.push(fn),
    };
    w.fireUpdatefound();
    // addAll() rejected mid-outage: the worker goes straight to redundant, register() already
    // resolved — without the diag line the wall's next reload is unprotected with no trace.
    (w.registration.installing as { state?: string }).state = "redundant";
    listeners.forEach((f) => f());
    expect(w.log.some((l) => l.includes("install FAILED"))).toBe(true);
  });

  test("a worker that DID install and is later superseded is not misreported as an install failure", () => {
    const w = makeWorld({ safe: false });
    w.updater.attach(w.registration);
    const listeners: Array<() => void> = [];
    w.registration.installing = {
      state: "installing",
      postMessage: () => {},
      addEventListener: (_t: string, fn: () => void) => listeners.push(fn),
    };
    w.fireUpdatefound();
    (w.registration.installing as { state?: string }).state = "installed";
    listeners.forEach((f) => f());
    // …and later an even newer build replaces it while it still waits.
    (w.registration.installing as { state?: string }).state = "redundant";
    listeners.forEach((f) => f());
    expect(w.log.some((l) => l.includes("install FAILED"))).toBe(false);
  });

  test("a background install completing (updatefound → installed) triggers the same safe-swap path", async () => {
    const w = makeWorld({ safe: true });
    w.updater.attach(w.registration);
    // The browser found a new sw.js and starts installing it…
    const listeners: Array<() => void> = [];
    w.registration.installing = {
      state: "installing",
      postMessage: () => {},
      addEventListener: (_t: string, fn: () => void) => listeners.push(fn),
    };
    w.fireUpdatefound();
    // …then it finishes: state flips to installed and the worker moves to `waiting`.
    (w.registration.installing as { state?: string }).state = "installed";
    w.registration.waiting = w.waiting;
    listeners.forEach((f) => f());
    await flush();
    expect(w.posted).toEqual([{ t: "polyptic/skip-waiting" }]);
  });
});

describe("scopeFor", () => {
  test("the /player/ base registers the wider no-trailing-slash scope; root stays root", () => {
    expect(scopeFor("/player/")).toBe("/player");
    expect(scopeFor("/")).toBe("/");
  });
});
