/**
 * POL-132 — the shell service worker, pinned by EXECUTING the generated sw.js against a fake
 * ServiceWorker global scope. What matters (and what these tests exist to keep true):
 *
 *   - SCOPE DISCIPLINE: the worker answers ONLY player-page navigations and this build's precached
 *     asset paths. /api, /media, cross-origin dashboards, POSTs and Range requests (media
 *     byte-ranges are D83's IndexedDB cache's business) must pass through UNTOUCHED — a worker that
 *     intercepts the wrong request class is a wall-wide outage amplifier.
 *   - CACHE-FIRST: a navigation answers from the versioned cache (a stale player that paints beats
 *     a fresh 502) and kicks a background update check — the revalidation half of the deal.
 *   - VERSION DISCIPLINE (D107): a new build's activation retires every older shell cache, and the
 *     worker never skipWaiting()s on its own — only when the page says the moment is safe.
 */
import { describe, expect, test } from "bun:test";

import { buildShellSw, fingerprint, shellCacheName } from "../sw/build-sw";

const ORIGIN = "http://wall.example:8080";
const CONFIG = {
  version: "1.2.3",
  shellUrl: "/player/",
  precache: ["/player/", "/player/assets/index-abc123.js", "/player/assets/index-def456.css"],
};

// ── A minimal ServiceWorkerGlobalScope stand-in ───────────────────────────────

type Listener = (event: unknown) => unknown;

/** Requests are plain shapes (the worker only reads method/url/headers/mode). */
function req(opts: { url: string; method?: string; mode?: string; range?: boolean }) {
  const headers = new Headers();
  if (opts.range) headers.set("range", "bytes=0-1023");
  return { url: opts.url, method: opts.method ?? "GET", mode: opts.mode ?? "no-cors", headers };
}

/** The worker's `new Request(url, {cache:"reload"})` — capture, don't resolve (bun needs absolute URLs). */
class FakeRequest {
  constructor(
    public url: string,
    public init?: { cache?: string },
  ) {}
}

function makeHarness(overrides?: { seedCaches?: Record<string, Map<string, unknown>> }) {
  const listeners = new Map<string, Listener[]>();
  const stores = new Map<string, Map<string, unknown>>(
    Object.entries(overrides?.seedCaches ?? {}).map(([k, v]) => [k, v]),
  );
  const state = {
    skipWaitingCalls: 0,
    claimed: 0,
    updateCalls: 0,
    fetched: [] as unknown[],
    deleted: [] as string[],
  };

  const caches = {
    async open(name: string) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name)!;
      return {
        async addAll(requests: FakeRequest[]) {
          for (const r of requests) {
            if (r.init?.cache !== "reload") throw new Error("precache must bypass the HTTP cache");
            store.set(r.url, `cached:${r.url}`);
          }
        },
        async match(key: string) {
          return store.get(key);
        },
      };
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name: string) {
      state.deleted.push(name);
      return stores.delete(name);
    },
  };

  const self: Record<string, unknown> = {
    location: { href: `${ORIGIN}/player/sw.js`, origin: ORIGIN },
    addEventListener(type: string, fn: Listener) {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    skipWaiting() {
      state.skipWaitingCalls += 1;
    },
    clients: {
      async claim() {
        state.claimed += 1;
      },
    },
    registration: {
      async update() {
        state.updateCalls += 1;
      },
    },
  };

  const fetchFake = async (request: unknown) => {
    state.fetched.push(request);
    return `network:${(request as { url: string }).url}`;
  };

  const source = buildShellSw(CONFIG);
  // Execute the worker with OUR scope bound to its globals — same code path as a real install.
  new Function("self", "caches", "fetch", "Request", source)(self, caches, fetchFake, FakeRequest);

  async function dispatchFetch(request: ReturnType<typeof req>) {
    let responded: Promise<unknown> | null = null;
    const waited: Promise<unknown>[] = [];
    for (const fn of listeners.get("fetch") ?? []) {
      fn({
        request,
        respondWith(p: Promise<unknown>) {
          responded = p;
        },
        waitUntil(p: Promise<unknown>) {
          waited.push(p);
        },
      });
    }
    await Promise.all(waited);
    return responded === null ? null : await responded;
  }

  async function install() {
    const waited: Promise<unknown>[] = [];
    for (const fn of listeners.get("install") ?? []) fn({ waitUntil: (p: Promise<unknown>) => waited.push(p) });
    await Promise.all(waited);
  }

  async function activate() {
    const waited: Promise<unknown>[] = [];
    for (const fn of listeners.get("activate") ?? []) fn({ waitUntil: (p: Promise<unknown>) => waited.push(p) });
    await Promise.all(waited);
  }

  function message(data: unknown, port?: { postMessage(m: unknown): void }) {
    for (const fn of listeners.get("message") ?? []) fn({ data, ports: port ? [port] : [] });
  }

  return { listeners, stores, state, dispatchFetch, install, activate, message };
}

const CACHE = shellCacheName(CONFIG);

// ── The tests ────────────────────────────────────────────────────────────────

describe("shell-sw install/activate", () => {
  test("install precaches exactly this build's list, bypassing the HTTP cache; no self-skipWaiting", async () => {
    const h = makeHarness();
    await h.install();
    const store = h.stores.get(CACHE)!;
    expect([...store.keys()].sort()).toEqual([...CONFIG.precache].sort());
    // Swap timing belongs to the PAGE (safe moment = server contact) — never the worker itself.
    expect(h.state.skipWaitingCalls).toBe(0);
  });

  test("activate retires every OLDER shell cache (never pinning a wall to an old build) and claims pages", async () => {
    const h = makeHarness({
      seedCaches: {
        "polyptic-player-shell-1.0.0-old": new Map([["/player/", "stale"]]),
        "someone-elses-cache": new Map(),
      },
    });
    await h.install();
    await h.activate();
    expect(h.state.deleted).toEqual(["polyptic-player-shell-1.0.0-old"]);
    expect(h.stores.has("someone-elses-cache")).toBe(true); // D83's media cache is not ours to touch
    expect(h.state.claimed).toBe(1);
  });
});

describe("shell-sw scope discipline — what it must NEVER intercept", () => {
  test.each([
    ["a POST", req({ url: `${ORIGIN}/player/`, method: "POST", mode: "navigate" })],
    ["the API", req({ url: `${ORIGIN}/api/v1/screens` })],
    ["media (D83's cache owns it)", req({ url: `${ORIGIN}/media/abc123` })],
    ["a media byte-range", req({ url: `${ORIGIN}/player/assets/index-abc123.js`, range: true })],
    ["a cross-origin dashboard", req({ url: "https://grafana.example/d/wall?token=secret", mode: "navigate" })],
    ["an unprecached same-origin file", req({ url: `${ORIGIN}/player/favicon.ico` })],
    ["the console SPA", req({ url: `${ORIGIN}/`, mode: "navigate" })],
  ])("passes %s through untouched (no respondWith)", async (_label, request) => {
    const h = makeHarness();
    await h.install();
    expect(await h.dispatchFetch(request)).toBeNull();
    expect(h.state.fetched).toHaveLength(0); // not even proxied — the browser talks to the network itself
  });
});

describe("shell-sw cache-first shell serving", () => {
  test("a player navigation (with ?screen=… and the bare /player path) answers from cache", async () => {
    const h = makeHarness();
    await h.install();
    expect(await h.dispatchFetch(req({ url: `${ORIGIN}/player/?screen=screen-1`, mode: "navigate" }))).toBe(
      "cached:/player/",
    );
    expect(await h.dispatchFetch(req({ url: `${ORIGIN}/player?screen=screen-1`, mode: "navigate" }))).toBe(
      "cached:/player/",
    );
  });

  test("a navigation served from cache kicks a background update check (revalidation)", async () => {
    const h = makeHarness();
    await h.install();
    await h.dispatchFetch(req({ url: `${ORIGIN}/player/?screen=screen-1`, mode: "navigate" }));
    expect(h.state.updateCalls).toBe(1);
  });

  test("a precached hashed asset answers from cache", async () => {
    const h = makeHarness();
    await h.install();
    expect(await h.dispatchFetch(req({ url: `${ORIGIN}/player/assets/index-abc123.js` }))).toBe(
      "cached:/player/assets/index-abc123.js",
    );
  });

  test("a cache miss (request racing the very first install) falls back to the network", async () => {
    const h = makeHarness(); // no install() — cache is empty
    const result = await h.dispatchFetch(req({ url: `${ORIGIN}/player/?screen=screen-1`, mode: "navigate" }));
    expect(String(result)).toStartWith("network:");
    expect(h.state.fetched).toHaveLength(1);
  });
});

describe("shell-sw page messages", () => {
  test("polyptic/skip-waiting → skipWaiting() (the page owns swap timing)", () => {
    const h = makeHarness();
    h.message({ t: "polyptic/skip-waiting" });
    expect(h.state.skipWaitingCalls).toBe(1);
  });

  test("polyptic/version replies with this build's version on the offered port", () => {
    const h = makeHarness();
    const replies: unknown[] = [];
    h.message({ t: "polyptic/version" }, { postMessage: (m) => replies.push(m) });
    expect(replies).toEqual([{ t: "polyptic/version", version: "1.2.3" }]);
  });

  test("garbage messages are ignored", () => {
    const h = makeHarness();
    h.message(null);
    h.message("skip-waiting");
    expect(h.state.skipWaitingCalls).toBe(0);
  });
});

describe("build-sw cache naming", () => {
  test("deterministic: two identical builds share a name (no spurious update churn)", () => {
    expect(shellCacheName(CONFIG)).toBe(shellCacheName({ ...CONFIG }));
  });

  test("a new version or a changed asset list mints a NEW cache name (a new sw.js → an update)", () => {
    expect(shellCacheName({ ...CONFIG, version: "1.2.4" })).not.toBe(CACHE);
    expect(shellCacheName({ ...CONFIG, precache: [...CONFIG.precache, "/player/assets/x.woff2"] })).not.toBe(CACHE);
  });

  test("fingerprint is stable and short", () => {
    expect(fingerprint("abc")).toBe(fingerprint("abc"));
    expect(fingerprint("abc")).not.toBe(fingerprint("abd"));
  });

  test("the generated worker embeds its config header", () => {
    const source = buildShellSw(CONFIG);
    expect(source).toStartWith("self.__POLYPTIC_SW__ = ");
    expect(source).toContain(`"cacheName":"${CACHE}"`);
    expect(source).toContain('"version":"1.2.3"');
  });
});
