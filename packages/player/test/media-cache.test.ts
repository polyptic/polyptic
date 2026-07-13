/**
 * Unit tests for the POL-32 media blob cache — the mechanism that makes wall media survive a
 * network outage.
 *
 * Everything the cache touches is injected (store, fetch, timers, clock, object-URL factory), so
 * these tests drive the full behaviour matrix without a browser: cache-first for immutable
 * control-plane uploads, stale-while-revalidate for external URLs, in-flight dedup, retry-on-
 * failure (the self-heal that ends an outage), and startup pruning (age + LRU size cap).
 */
import { describe, expect, test } from "bun:test";

import { MediaCache } from "../src/media-cache";
import type { MediaCacheStore, MediaMeta, WantedMedia } from "../src/media-cache";

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

class MemoryStore implements MediaCacheStore {
  meta = new Map<string, MediaMeta>();
  blobs = new Map<string, Blob>();

  async getMeta(url: string): Promise<MediaMeta | undefined> {
    return this.meta.get(url);
  }
  async getBlob(url: string): Promise<Blob | undefined> {
    return this.blobs.get(url);
  }
  async put(meta: MediaMeta, blob: Blob): Promise<void> {
    this.meta.set(meta.url, meta);
    this.blobs.set(meta.url, blob);
  }
  async putMeta(meta: MediaMeta): Promise<void> {
    this.meta.set(meta.url, meta);
  }
  async delete(url: string): Promise<void> {
    this.meta.delete(url);
    this.blobs.delete(url);
  }
  async allMeta(): Promise<MediaMeta[]> {
    return [...this.meta.values()];
  }
}

interface PendingTimer {
  id: number;
  fn: () => void;
  ms: number;
  cleared: boolean;
}

/** One test's fully-instrumented cache: scripted fetch, manual timers, counted object URLs. */
function makeHarness(opts?: { maxBytes?: number; maxAgeMs?: number }) {
  const store = new MemoryStore();
  const readies: { url: string; objectUrl: string }[] = [];
  const revoked: string[] = [];
  const fetches: { url: string; headers: Record<string, string> }[] = [];
  const timers: PendingTimer[] = [];
  let nowMs = 1_000_000;
  let objectUrlSeq = 0;

  // Per-URL scripted responses, consumed in order; a `null` entry means "network error".
  const responses = new Map<string, (Response | null)[]>();
  const script = (url: string, ...rs: (Response | null)[]) => {
    responses.set(url, [...(responses.get(url) ?? []), ...rs]);
  };

  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) {
      headers[k] = v;
    }
    fetches.push({ url, headers });
    const queue = responses.get(url);
    const next = queue?.shift();
    if (next === undefined || next === null) throw new TypeError("network down");
    return next;
  }) as typeof fetch;

  const cache = new MediaCache(store, {
    onReady: (url, objectUrl) => readies.push({ url, objectUrl }),
    fetchFn,
    now: () => nowMs,
    setTimer: (fn, ms) => {
      const timer: PendingTimer = { id: timers.length, fn, ms, cleared: false };
      timers.push(timer);
      return timer.id;
    },
    clearTimer: (id) => {
      const timer = timers[id as number];
      if (timer) timer.cleared = true;
    },
    createObjectUrl: () => `blob:fake-${++objectUrlSeq}`,
    revokeObjectUrl: (url) => revoked.push(url),
    maxBytes: opts?.maxBytes,
    maxAgeMs: opts?.maxAgeMs,
  });

  /** Let queued microtasks (the async ensure/resolve chains) run to completion. */
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
  };

  return {
    store,
    cache,
    readies,
    revoked,
    fetches,
    timers,
    script,
    settle,
    advance: (ms: number) => {
      nowMs += ms;
    },
    firePending: async () => {
      const pending = timers.filter((t) => !t.cleared);
      timers.length = 0;
      for (const t of pending) t.fn();
      await new Promise((r) => setTimeout(r, 0));
      for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    },
  };
}

function ok(body: string, headers?: Record<string, string>): Response {
  return new Response(new Blob([body]), { status: 200, headers });
}

const IMMUTABLE_URL = "http://192.168.1.50:8080/media/abc123";
const EXTERNAL_URL = "https://cdn.example.com/poster.jpg";

const wantImmutable: WantedMedia[] = [{ url: IMMUTABLE_URL, immutable: true }];
const wantExternal: WantedMedia[] = [{ url: EXTERNAL_URL, immutable: false }];

// ─────────────────────────────────────────────────────────────────────────────
// Download + cache-first
// ─────────────────────────────────────────────────────────────────────────────

describe("MediaCache — download and cache-first", () => {
  test("a cache miss downloads, persists, and surfaces an object URL", async () => {
    const h = makeHarness();
    h.script(IMMUTABLE_URL, ok("image-bytes", { etag: '"v1"' }));
    h.cache.sync(wantImmutable);
    await h.settle();

    expect(h.readies).toEqual([{ url: IMMUTABLE_URL, objectUrl: "blob:fake-1" }]);
    expect(h.fetches.length).toBe(1);
    expect(h.store.meta.get(IMMUTABLE_URL)?.etag).toBe('"v1"');
    expect(await h.store.blobs.get(IMMUTABLE_URL)?.text()).toBe("image-bytes");
  });

  test("a cached immutable URL is served with NO network traffic at all", async () => {
    const h = makeHarness();
    await h.store.put(
      { url: IMMUTABLE_URL, size: 11, cachedAt: 1, lastUsed: 1 },
      new Blob(["image-bytes"]),
    );
    h.cache.sync(wantImmutable);
    await h.settle();

    expect(h.readies.length).toBe(1);
    expect(h.readies[0]?.objectUrl).toBe("blob:fake-1");
    expect(h.fetches.length).toBe(0); // ← the offline guarantee: a hit never needs the network
  });

  test("repeated syncs of an already-surfaced immutable URL do nothing (dedup)", async () => {
    const h = makeHarness();
    h.script(IMMUTABLE_URL, ok("image-bytes"));
    h.cache.sync(wantImmutable);
    h.cache.sync(wantImmutable);
    await h.settle();
    h.cache.sync(wantImmutable);
    await h.settle();

    expect(h.fetches.length).toBe(1);
    expect(h.readies.length).toBe(1);
  });

  test("non-http(s) srcs (data:, blob:) are ignored — already local", async () => {
    const h = makeHarness();
    h.cache.sync([{ url: "data:image/png;base64,AAAA", immutable: false }]);
    await h.settle();
    expect(h.fetches.length).toBe(0);
    expect(h.readies.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stale-while-revalidate for mutable (external) URLs
// ─────────────────────────────────────────────────────────────────────────────

describe("MediaCache — mutable URLs revalidate in the background", () => {
  test("a cache hit surfaces instantly, then a 304 keeps it (conditional headers sent)", async () => {
    const h = makeHarness();
    await h.store.put(
      { url: EXTERNAL_URL, size: 5, cachedAt: 1, lastUsed: 1, etag: '"v1"' },
      new Blob(["old!!"]),
    );
    h.script(EXTERNAL_URL, new Response(null, { status: 304 }));
    h.cache.sync(wantExternal);
    await h.settle();

    expect(h.readies.length).toBe(1); // served from cache…
    expect(h.fetches.length).toBe(1); // …and revalidated once
    expect(h.fetches[0]?.headers["If-None-Match"]).toBe('"v1"');
    expect(h.revoked.length).toBe(0);
  });

  test("changed content (200) replaces the entry and re-surfaces a NEW object URL", async () => {
    const h = makeHarness();
    await h.store.put(
      { url: EXTERNAL_URL, size: 5, cachedAt: 1, lastUsed: 1, etag: '"v1"' },
      new Blob(["old!!"]),
    );
    h.script(EXTERNAL_URL, ok("new-bytes", { etag: '"v2"' }));
    h.cache.sync(wantExternal);
    await h.settle();

    expect(h.readies.length).toBe(2);
    expect(h.readies[1]?.objectUrl).toBe("blob:fake-2");
    expect(h.store.meta.get(EXTERNAL_URL)?.etag).toBe('"v2"');
    expect(await h.store.blobs.get(EXTERNAL_URL)?.text()).toBe("new-bytes");
    // The replaced object URL is revoked only after the grace timer (elements repoint async).
    expect(h.revoked.length).toBe(0);
    await h.firePending();
    expect(h.revoked).toEqual(["blob:fake-1"]);
  });

  test("revalidation is throttled — an immediate re-sync does not re-fetch", async () => {
    const h = makeHarness();
    await h.store.put(
      { url: EXTERNAL_URL, size: 5, cachedAt: 1, lastUsed: 1, etag: '"v1"' },
      new Blob(["old!!"]),
    );
    h.script(EXTERNAL_URL, new Response(null, { status: 304 }));
    h.cache.sync(wantExternal);
    await h.settle();
    h.cache.sync(wantExternal); // seconds later (clock unmoved) — inside the throttle window
    await h.settle();

    expect(h.fetches.length).toBe(1);
  });

  test("a failed revalidation keeps showing the cached copy (the outage case)", async () => {
    const h = makeHarness();
    await h.store.put(
      { url: EXTERNAL_URL, size: 5, cachedAt: 1, lastUsed: 1, etag: '"v1"' },
      new Blob(["old!!"]),
    );
    h.script(EXTERNAL_URL, null); // network down
    h.cache.sync(wantExternal);
    await h.settle();

    expect(h.readies.length).toBe(1); // cache still surfaced
    expect(h.store.blobs.has(EXTERNAL_URL)).toBe(true); // nothing was thrown away
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Retry — the self-heal that ends an outage
// ─────────────────────────────────────────────────────────────────────────────

describe("MediaCache — failed downloads retry while still wanted", () => {
  test("a failed fetch schedules a backoff retry that succeeds when the network returns", async () => {
    const h = makeHarness();
    h.script(IMMUTABLE_URL, null, ok("image-bytes")); // fail once, then succeed
    h.cache.sync(wantImmutable);
    await h.settle();

    expect(h.readies.length).toBe(0);
    const retry = h.timers.find((t) => !t.cleared);
    expect(retry?.ms).toBe(5_000);

    await h.firePending(); // the network is back
    expect(h.readies).toEqual([{ url: IMMUTABLE_URL, objectUrl: "blob:fake-1" }]);
  });

  test("the retry delay doubles up to the cap", async () => {
    const h = makeHarness();
    h.script(IMMUTABLE_URL, null, null, null);
    h.cache.sync(wantImmutable);
    await h.settle();
    expect(h.timers.filter((t) => !t.cleared).at(-1)?.ms).toBe(5_000);
    await h.firePending();
    expect(h.timers.filter((t) => !t.cleared).at(-1)?.ms).toBe(10_000);
    await h.firePending();
    expect(h.timers.filter((t) => !t.cleared).at(-1)?.ms).toBe(20_000);
  });

  test("a URL dropped from the render cancels its pending retry", async () => {
    const h = makeHarness();
    h.script(IMMUTABLE_URL, null);
    h.cache.sync(wantImmutable);
    await h.settle();
    expect(h.timers.filter((t) => !t.cleared).length).toBe(1);

    h.cache.sync([]); // the surface left the wall
    expect(h.timers.filter((t) => !t.cleared).length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pruning — age + LRU size cap
// ─────────────────────────────────────────────────────────────────────────────

describe("MediaCache — prune", () => {
  test("entries unused past maxAge are deleted; fresh ones survive", async () => {
    const h = makeHarness({ maxAgeMs: 1_000 });
    await h.store.put({ url: "http://a/stale", size: 1, cachedAt: 0, lastUsed: 0 }, new Blob(["a"]));
    await h.store.put(
      { url: "http://b/fresh", size: 1, cachedAt: 999_999, lastUsed: 999_999 },
      new Blob(["b"]),
    );
    await h.cache.prune();

    expect(h.store.meta.has("http://a/stale")).toBe(false);
    expect(h.store.meta.has("http://b/fresh")).toBe(true);
  });

  test("over the size cap, least-recently-used entries are evicted first", async () => {
    const h = makeHarness({ maxBytes: 250 });
    await h.store.put(
      { url: "http://a/oldest", size: 100, cachedAt: 999_000, lastUsed: 999_000 },
      new Blob(["a"]),
    );
    await h.store.put(
      { url: "http://b/mid", size: 100, cachedAt: 999_500, lastUsed: 999_500 },
      new Blob(["b"]),
    );
    await h.store.put(
      { url: "http://c/newest", size: 100, cachedAt: 999_900, lastUsed: 999_900 },
      new Blob(["c"]),
    );
    await h.cache.prune();

    expect(h.store.meta.has("http://a/oldest")).toBe(false);
    expect(h.store.meta.has("http://b/mid")).toBe(true);
    expect(h.store.meta.has("http://c/newest")).toBe(true);
  });

  test("currently-wanted URLs are never size-evicted", async () => {
    const h = makeHarness({ maxBytes: 150 });
    await h.store.put(
      { url: IMMUTABLE_URL, size: 100, cachedAt: 999_000, lastUsed: 999_000 },
      new Blob(["wanted"]),
    );
    await h.store.put(
      { url: "http://b/idle", size: 100, cachedAt: 999_900, lastUsed: 999_900 },
      new Blob(["idle"]),
    );
    h.cache.sync(wantImmutable); // IMMUTABLE_URL is on the glass right now
    await h.settle();
    await h.cache.prune();

    expect(h.store.meta.has(IMMUTABLE_URL)).toBe(true); // older but wanted → kept
    expect(h.store.meta.has("http://b/idle")).toBe(false); // newer but idle → evicted
  });
});

describe("MediaCache — discard (a corrupt cached blob must not re-serve)", () => {
  test("discard revokes the object URL, deletes the entry, and the next sync re-downloads", async () => {
    const h = makeHarness();
    h.script(IMMUTABLE_URL, ok("original"));
    h.cache.sync(wantImmutable);
    await h.settle();
    expect(h.readies).toHaveLength(1);
    const served = h.readies[0]!.objectUrl;
    expect(h.store.meta.has(IMMUTABLE_URL)).toBe(true);

    // The element failed to decode the blob (torn write / corrupt download) → the player discards.
    await h.cache.discard(IMMUTABLE_URL);
    expect(h.revoked).toContain(served);
    expect(h.store.meta.has(IMMUTABLE_URL)).toBe(false);
    expect(h.store.blobs.has(IMMUTABLE_URL)).toBe(false);

    // The next render sync re-downloads fresh bytes and publishes a NEW object URL.
    h.script(IMMUTABLE_URL, ok("fresh"));
    h.cache.sync(wantImmutable);
    await h.settle();
    expect(h.readies).toHaveLength(2);
    expect(h.readies[1]!.objectUrl).not.toBe(served);
  });
});
