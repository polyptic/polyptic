/**
 * POL-32 — cached media: the wall's images and videos must survive a network outage.
 *
 * The player renders media straight off the network (`<img src>` / `<video src>`). An image that has
 * painted survives a dead network (the decoded bitmap is in the DOM), but a VIDEO does not — it
 * streams over HTTP Range and freezes mid-frame the moment the server becomes unreachable, which on
 * a looping wall video means a frozen wall. And a fetch that fails during a blip is never retried.
 *
 * The fix is a local blob cache: every image/video src is downloaded once into IndexedDB and the
 * element is pointed at a `blob:` object URL, so playback is served entirely from the box — a
 * network outage of any length cannot touch it, and the cache survives page reloads. A service
 * worker + Cache API would be the textbook tool, but both require a SECURE CONTEXT and the wall
 * loads the player over plain HTTP (netboot boxes speak plain HTTP to the control plane by design),
 * so IndexedDB — available to insecure origins — is the load-bearing choice, not a preference.
 *
 * Freshness: an uploaded media URL (`/media/<id>`) is IMMUTABLE by construction — replacing content
 * means a new upload, which mints a new id, hence a new URL — so those are cached forever. External
 * URLs (a CDN the operator pointed a source at) may change in place, so a cache hit still shows
 * instantly but revalidates in the background with a conditional GET (ETag/Last-Modified); a 200
 * replaces the entry and the caller is told to swap.
 *
 * Failure is the normal case this module exists for: a fetch that fails (offline, server restart)
 * retries on a backoff for as long as the URL is still wanted, so a wall that boots into an outage
 * heals itself the moment the network returns. Everything is dependency-injected (store, fetch,
 * timers, clock, object-URL factory) so the logic is unit-testable under bun with no browser.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Store seam — IndexedDB in the player, an in-memory Map in tests
// ─────────────────────────────────────────────────────────────────────────────

/** Metadata for one cached URL. Kept in its own store so pruning never loads blobs into memory. */
export interface MediaMeta {
  url: string;
  /** Blob size in bytes — drives the total-size eviction cap. */
  size: number;
  cachedAt: number;
  /** Last time a render actually used this URL — drives age pruning + LRU eviction. */
  lastUsed: number;
  /** HTTP validators for background revalidation of mutable (external) URLs. */
  etag?: string;
  lastModified?: string;
}

export interface MediaCacheStore {
  getMeta(url: string): Promise<MediaMeta | undefined>;
  getBlob(url: string): Promise<Blob | undefined>;
  put(meta: MediaMeta, blob: Blob): Promise<void>;
  /** Update metadata only (lastUsed touch) without rewriting the blob. */
  putMeta(meta: MediaMeta): Promise<void>;
  delete(url: string): Promise<void>;
  allMeta(): Promise<MediaMeta[]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache options + defaults
// ─────────────────────────────────────────────────────────────────────────────

export interface MediaCacheOptions {
  /** A cached (or newly cached) URL is ready to render: point the element at `objectUrl`. Fired
   *  again with a NEW object URL if background revalidation found changed content. */
  onReady: (url: string, objectUrl: string) => void;
  fetchFn?: typeof fetch;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
  /** Evict least-recently-used entries beyond this total size. Default 4 GiB. */
  maxBytes?: number;
  /** Drop entries not used by any render for this long. Default 30 days. */
  maxAgeMs?: number;
}

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Retry backoff for failed fetches: 5s doubling to a 60s cap — an outage heals within a minute. */
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 60_000;
/** Re-check a mutable URL at most this often (render pushes must not spam conditional GETs). */
const REVALIDATE_MIN_INTERVAL_MS = 60_000;
/** Grace before revoking a REPLACED object URL — the caller repoints its elements asynchronously
 *  (Vue patches on nextTick), and revoking under a still-attached element can kill its source. */
const REVOKE_DELAY_MS = 60_000;
/** Persist a lastUsed touch at most this often per URL (avoid IDB write churn on every render). */
const TOUCH_MIN_INTERVAL_MS = 60 * 60 * 1000;

/** One media URL a render currently wants on the glass. */
export interface WantedMedia {
  url: string;
  /** True for control-plane uploads (`/media/<id>`) — content can never change under this URL. */
  immutable: boolean;
}

/** Only http(s) URLs are cacheable — `data:`/`blob:` srcs are already local. */
function isCacheable(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}

// ─────────────────────────────────────────────────────────────────────────────
// The cache
// ─────────────────────────────────────────────────────────────────────────────

interface UrlState {
  immutable: boolean;
  /** A fetch/revalidate for this URL is already running — never two in flight. */
  inFlight: boolean;
  /** Pending retry timer (failed fetch, waiting to try again). */
  retryTimer: unknown | null;
  retryDelayMs: number;
  /** The live object URL handed to onReady (revoked when replaced). */
  objectUrl: string | null;
  lastValidatedAt: number;
  lastTouchedAt: number;
}

export class MediaCache {
  private readonly onReady: (url: string, objectUrl: string) => void;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (id: unknown) => void;
  private readonly createObjectUrl: (blob: Blob) => string;
  private readonly revokeObjectUrl: (url: string) => void;
  private readonly maxBytes: number;
  private readonly maxAgeMs: number;

  private readonly states = new Map<string, UrlState>();
  private wanted = new Set<string>();

  constructor(
    private readonly store: MediaCacheStore,
    opts: MediaCacheOptions,
  ) {
    this.onReady = opts.onReady;
    this.fetchFn = opts.fetchFn ?? fetch.bind(globalThis);
    this.now = opts.now ?? Date.now;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
    this.createObjectUrl = opts.createObjectUrl ?? ((blob) => URL.createObjectURL(blob));
    this.revokeObjectUrl = opts.revokeObjectUrl ?? ((url) => URL.revokeObjectURL(url));
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  }

  /**
   * Declare the set of media URLs the CURRENT render wants (called on every render push). New URLs
   * begin caching; URLs no longer wanted stop retrying. Cached hits fire `onReady` asynchronously.
   */
  sync(entries: WantedMedia[]): void {
    const next = new Set<string>();
    for (const entry of entries) {
      if (!isCacheable(entry.url)) continue;
      next.add(entry.url);
      this.ensure(entry.url, entry.immutable);
    }
    // Cancel pending retries for URLs that left the render — but keep their object URLs alive: the
    // render may come straight back (scene flip-flop) and a revoked URL would kill the element.
    for (const url of this.wanted) {
      if (next.has(url)) continue;
      const state = this.states.get(url);
      if (state?.retryTimer != null) {
        this.clearTimer(state.retryTimer);
        state.retryTimer = null;
      }
    }
    this.wanted = next;
  }

  /**
   * Age-prune + size-evict the store (call once on startup). Entries unused for `maxAgeMs` go
   * first; then least-recently-used entries are evicted until the total is under `maxBytes`.
   * Currently-wanted URLs are never evicted by the size cap.
   */
  async prune(): Promise<void> {
    let all: MediaMeta[];
    try {
      all = await this.store.allMeta();
    } catch {
      return; // a broken store must never take the player down
    }
    const cutoff = this.now() - this.maxAgeMs;
    const kept: MediaMeta[] = [];
    for (const meta of all) {
      if (meta.lastUsed < cutoff && !this.wanted.has(meta.url)) {
        await this.safeDelete(meta.url);
      } else {
        kept.push(meta);
      }
    }
    let total = kept.reduce((sum, m) => sum + m.size, 0);
    if (total <= this.maxBytes) return;
    kept.sort((a, b) => a.lastUsed - b.lastUsed);
    for (const meta of kept) {
      if (total <= this.maxBytes) break;
      if (this.wanted.has(meta.url)) continue;
      await this.safeDelete(meta.url);
      total -= meta.size;
    }
  }

  /**
   * Drop a cached entry outright — the media element failed to DECODE the cached blob (a torn
   * write or a corrupt download), which no amount of re-serving fixes. The object URL is revoked,
   * pending retries cancelled, and the store entry deleted, so the next `sync()` re-downloads from
   * the network instead of re-serving the corpse (POL-86's re-prove would otherwise loop on it: a
   * local blob fetch always "succeeds").
   */
  async discard(url: string): Promise<void> {
    const s = this.states.get(url);
    if (s) {
      if (s.retryTimer != null) {
        this.clearTimer(s.retryTimer);
        s.retryTimer = null;
      }
      if (s.objectUrl) {
        this.revokeObjectUrl(s.objectUrl);
        s.objectUrl = null;
      }
      this.states.delete(url);
    }
    await this.safeDelete(url);
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private state(url: string, immutable: boolean): UrlState {
    let s = this.states.get(url);
    if (!s) {
      s = {
        immutable,
        inFlight: false,
        retryTimer: null,
        retryDelayMs: RETRY_MIN_MS,
        objectUrl: null,
        lastValidatedAt: 0,
        lastTouchedAt: 0,
      };
      this.states.set(url, s);
    }
    s.immutable = immutable;
    return s;
  }

  private ensure(url: string, immutable: boolean): void {
    const s = this.state(url, immutable);
    if (s.inFlight) return;
    s.inFlight = true;
    void this.resolve(url, s).finally(() => {
      s.inFlight = false;
    });
  }

  private async resolve(url: string, s: UrlState): Promise<void> {
    // Already surfaced this session → at most a background revalidation (mutable URLs only).
    if (s.objectUrl !== null) {
      if (!s.immutable && this.now() - s.lastValidatedAt >= REVALIDATE_MIN_INTERVAL_MS) {
        await this.revalidate(url, s);
      }
      return;
    }

    let meta: MediaMeta | undefined;
    let blob: Blob | undefined;
    try {
      meta = await this.store.getMeta(url);
      blob = meta ? await this.store.getBlob(url) : undefined;
    } catch {
      // Store unavailable (private mode, quota) — behave as a miss; the fetch path still works.
    }

    if (meta && blob) {
      s.objectUrl = this.createObjectUrl(blob);
      this.onReady(url, s.objectUrl);
      await this.touch(meta, s);
      if (!s.immutable) await this.revalidate(url, s, meta);
      return;
    }

    await this.download(url, s);
  }

  /** Full download → store → onReady. On failure, schedule a retry while the URL is wanted. */
  private async download(url: string, s: UrlState): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchFn(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch {
      this.scheduleRetry(url, s);
      return;
    }
    let blob: Blob;
    try {
      blob = await response.blob();
    } catch {
      this.scheduleRetry(url, s);
      return;
    }
    s.retryDelayMs = RETRY_MIN_MS;
    s.lastValidatedAt = this.now();
    const meta: MediaMeta = {
      url,
      size: blob.size,
      cachedAt: this.now(),
      lastUsed: this.now(),
      etag: response.headers.get("etag") ?? undefined,
      lastModified: response.headers.get("last-modified") ?? undefined,
    };
    try {
      await this.store.put(meta, blob);
    } catch {
      // Couldn't persist (quota) — still serve this session from the in-memory blob.
    }
    const previous = s.objectUrl;
    s.objectUrl = this.createObjectUrl(blob);
    s.lastTouchedAt = this.now();
    this.onReady(url, s.objectUrl);
    this.revokeLater(previous);
  }

  /** Conditional GET for a mutable URL we already show: 304 → nothing; 200 → replace + re-onReady. */
  private async revalidate(url: string, s: UrlState, knownMeta?: MediaMeta): Promise<void> {
    s.lastValidatedAt = this.now();
    let meta = knownMeta;
    if (!meta) {
      try {
        meta = await this.store.getMeta(url);
      } catch {
        return;
      }
    }
    const headers: Record<string, string> = {};
    if (meta?.etag) headers["If-None-Match"] = meta.etag;
    if (meta?.lastModified) headers["If-Modified-Since"] = meta.lastModified;
    let response: Response;
    try {
      response = await this.fetchFn(url, { headers });
    } catch {
      return; // offline — exactly the moment the cached copy is earning its keep
    }
    if (response.status === 304 || !response.ok) return;
    let blob: Blob;
    try {
      blob = await response.blob();
    } catch {
      return;
    }
    const next: MediaMeta = {
      url,
      size: blob.size,
      cachedAt: this.now(),
      lastUsed: this.now(),
      etag: response.headers.get("etag") ?? undefined,
      lastModified: response.headers.get("last-modified") ?? undefined,
    };
    try {
      await this.store.put(next, blob);
    } catch {
      // Persisting failed; still swap the live element to the fresh bytes.
    }
    const previous = s.objectUrl;
    s.objectUrl = this.createObjectUrl(blob);
    this.onReady(url, s.objectUrl);
    this.revokeLater(previous);
  }

  /** Revoke a replaced object URL after a grace period (the caller's elements repoint async). */
  private revokeLater(objectUrl: string | null): void {
    if (objectUrl === null) return;
    this.setTimer(() => this.revokeObjectUrl(objectUrl), REVOKE_DELAY_MS);
  }

  private scheduleRetry(url: string, s: UrlState): void {
    if (s.retryTimer !== null || !this.wantedOrNew(url)) return;
    const delay = s.retryDelayMs;
    s.retryDelayMs = Math.min(s.retryDelayMs * 2, RETRY_MAX_MS);
    s.retryTimer = this.setTimer(() => {
      s.retryTimer = null;
      if (!this.wanted.has(url)) return;
      this.ensure(url, s.immutable);
    }, delay);
  }

  /** During the very first sync the wanted set is being built while ensure() runs — treat a URL not
   *  yet recorded as wanted (sync() adds it immediately after kicking ensure). */
  private wantedOrNew(url: string): boolean {
    return this.wanted.has(url) || this.states.has(url);
  }

  private async touch(meta: MediaMeta, s: UrlState): Promise<void> {
    const now = this.now();
    if (now - s.lastTouchedAt < TOUCH_MIN_INTERVAL_MS) return;
    s.lastTouchedAt = now;
    try {
      await this.store.putMeta({ ...meta, lastUsed: now });
    } catch {
      // Best-effort — a failed touch only means earlier pruning.
    }
  }

  private async safeDelete(url: string): Promise<void> {
    try {
      await this.store.delete(url);
    } catch {
      // Best-effort.
    }
  }
}
