/**
 * Frame watchdog (POL-86) — a wall must heal a failed content load BY ITSELF.
 *
 * The bug this exists for, from real hardware: on a cold boot the box's interfaces settle at
 * slightly different times (wired DHCP binds, the agent connects, Chrome launches — and *then* the
 * Wi-Fi NIC associates / IPv6 RA lands). Chrome's network-change notifier fires and ABORTS every
 * in-flight request with `ERR_NETWORK_CHANGED`. The content iframe is left showing a broken page,
 * nothing retries, and the wall sits there — dead — until a human opens DevTools and hits reload.
 * That is not an unattended display wall. `docs/ARCHITECTURE.md` has prescribed this watchdog from
 * the beginning ("spinner, load timeout, periodic `iframe.src = iframe.src`, error card + backoff");
 * it was simply never built.
 *
 * THE HARD PART, and why this is signal-driven rather than a simple timeout:
 * a cross-origin iframe's failure is INVISIBLE to us (Same-Origin Policy). Worse, Chrome commits its
 * own error page into the frame and then **fires `load`** — so "did it load?" answers *yes* for a
 * frame showing `ERR_NETWORK_CHANGED`. A load timeout alone therefore cannot see the very failure we
 * are here to fix. So we heal on two classes of evidence:
 *
 *   1. NEVER LOADED — no `load` event within `loadTimeoutMs`. Catches a control plane that is not up
 *      yet, an unreachable dashboard, a black-holed route.
 *   2. THE NETWORK MOVED UNDER US — an external signal that in-flight requests may have been killed:
 *      `window` `online`, the player's own WS reconnecting, or a resource error on our own page.
 *      Any of these means a frame that *did* fire `load` may still be holding an error page, so we
 *      reload it regardless of its apparent state. This is the one that fixes the observed bug.
 *
 * Healing is `el.src = el.src`: it re-fetches WITHOUT changing the URL, so a token the server stamped
 * into the content URL at send time (POL-24) survives untouched, and it does not disturb the keyed
 * DOM element that makes content flips instant (D5). Reloads are rate-limited per frame and backed
 * off, because the failure mode we must never create is a wall hammering a struggling server.
 */

/** No `load` within this and the frame is presumed stuck. Generous: a cold dashboard can be slow. */
const LOAD_TIMEOUT_MS = 20_000;
/** Never reload one frame more often than this, however many signals arrive. */
const MIN_RELOAD_INTERVAL_MS = 10_000;
/** Retry backoff grows to this ceiling, then stays there — a wall keeps trying forever, but calmly. */
const MAX_BACKOFF_MS = 5 * 60_000;
/** Network signals arrive in bursts (online + WS reopen + resource errors); collapse them. */
const HEAL_DEBOUNCE_MS = 1_500;

export interface FrameWatchdogOptions {
  loadTimeoutMs?: number;
  minReloadIntervalMs?: number;
  maxBackoffMs?: number;
  healDebounceMs?: number;
  /** Reload one frame. Injected so tests drive it without a DOM. */
  reload: (id: string) => void;
  log?: (msg: string) => void;
  /** Injected clock, for tests. */
  now?: () => number;
}

interface FrameState {
  loaded: boolean;
  /** When we last reloaded it — enforces `minReloadIntervalMs`. `-Infinity` = never reloaded, so the
   *  rate limit can never refuse a frame's FIRST heal (a plain `0` would, under any clock whose
   *  epoch is smaller than the interval). */
  lastReloadAt: number;
  /** Consecutive heal attempts without a confirmed load; drives the backoff. */
  attempts: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export class FrameWatchdog {
  private readonly frames = new Map<string, FrameState>();
  private healTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  private readonly loadTimeoutMs: number;
  private readonly minReloadIntervalMs: number;
  private readonly maxBackoffMs: number;
  private readonly healDebounceMs: number;
  private readonly reload: (id: string) => void;
  private readonly log: (msg: string) => void;
  private readonly now: () => number;

  constructor(opts: FrameWatchdogOptions) {
    this.loadTimeoutMs = opts.loadTimeoutMs ?? LOAD_TIMEOUT_MS;
    this.minReloadIntervalMs = opts.minReloadIntervalMs ?? MIN_RELOAD_INTERVAL_MS;
    this.maxBackoffMs = opts.maxBackoffMs ?? MAX_BACKOFF_MS;
    this.healDebounceMs = opts.healDebounceMs ?? HEAL_DEBOUNCE_MS;
    this.reload = opts.reload;
    this.log = opts.log ?? ((): void => {});
    this.now = opts.now ?? ((): number => Date.now());
  }

  /** The set of framed surfaces currently on screen. Ids that vanished are forgotten. */
  sync(ids: string[]): void {
    if (this.stopped) return;
    const wanted = new Set(ids);
    for (const id of [...this.frames.keys()]) {
      if (!wanted.has(id)) this.forget(id);
    }
    for (const id of ids) {
      if (!this.frames.has(id)) this.watch(id);
    }
  }

  /**
   * This frame is (re)navigating to a URL — the operator assigned new content, or we just reloaded
   * it. Reset its load state and start the never-loaded timer.
   */
  watch(id: string): void {
    if (this.stopped) return;
    const existing = this.frames.get(id);
    const state: FrameState = {
      loaded: false,
      lastReloadAt: existing?.lastReloadAt ?? Number.NEGATIVE_INFINITY,
      attempts: existing?.attempts ?? 0,
      timer: null,
    };
    if (existing?.timer) clearTimeout(existing.timer);
    this.frames.set(id, state);
    this.armTimeout(id, state);
  }

  /** The frame fired `load`. NOTE: this is NOT proof it is healthy — see the header. */
  onLoad(id: string): void {
    const state = this.frames.get(id);
    if (!state) return;
    state.loaded = true;
    state.attempts = 0; // a load resets the backoff; a subsequent failure starts fresh
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  }

  /**
   * Something happened that may have killed in-flight requests — `online`, a WS reconnect, a
   * resource error on our own page. Reload EVERY frame, including ones that reported `load`, because
   * a frame holding Chrome's error page reports `load` too. Debounced: these signals arrive in bursts.
   */
  heal(reason: string): void {
    if (this.stopped || this.frames.size === 0) return;
    if (this.healTimer) return; // a heal is already pending; the burst collapses into it
    this.healTimer = setTimeout(() => {
      this.healTimer = null;
      if (this.stopped) return;
      this.log(`network signal (${reason}) — reloading ${this.frames.size} frame(s)`);
      for (const id of this.frames.keys()) this.tryReload(id, reason);
    }, this.healDebounceMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.healTimer) clearTimeout(this.healTimer);
    this.healTimer = null;
    for (const id of [...this.frames.keys()]) this.forget(id);
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private forget(id: string): void {
    const state = this.frames.get(id);
    if (state?.timer) clearTimeout(state.timer);
    this.frames.delete(id);
  }

  /** Arm the "it never loaded" timer, backed off by how many times we have already tried. */
  private armTimeout(id: string, state: FrameState): void {
    const backoff = Math.min(this.maxBackoffMs, this.loadTimeoutMs * 2 ** state.attempts);
    state.timer = setTimeout(() => {
      state.timer = null;
      if (this.stopped) return;
      const current = this.frames.get(id);
      if (!current || current.loaded) return; // it loaded in the meantime
      this.tryReload(id, "never loaded");
    }, backoff);
  }

  /** Reload one frame, honouring the rate limit. Re-arms the timer so we keep watching it. */
  private tryReload(id: string, reason: string): void {
    const state = this.frames.get(id);
    if (!state) return;
    const now = this.now();
    if (now - state.lastReloadAt < this.minReloadIntervalMs) {
      // A burst of signals, or a frame we just reloaded. Never hammer a struggling server.
      return;
    }
    state.lastReloadAt = now;
    state.attempts += 1;
    state.loaded = false;
    if (state.timer) clearTimeout(state.timer);
    this.log(`reloading frame ${id} (${reason}, attempt ${state.attempts})`);
    this.reload(id);
    this.armTimeout(id, state);
  }
}
