/**
 * Surface prober (POL-86, priority B) — a surface's URL is PROVEN reachable before the wall ever
 * points an element at it, and re-proven whenever there is any reason to doubt it.
 *
 * Why this replaces the signal-driven frame watchdog: the watchdog reloaded frames when the browser
 * hinted the network had moved (`online`, a WS reconnect, a resource error on our own page). On the
 * first real hardware boot it mattered, NONE of those hints fired — the box's Wi-Fi settled without
 * an offline period, the player's WS connected once and stayed up, and the player page had no
 * subresources left to fail — so the wall sat broken until a human refreshed it. Hints are optional;
 * a watchdog built on them is optional too. The probe is not a hint:
 *
 *     fetch(url, { mode: "no-cors", cache: "no-store" })
 *
 * REJECTS on network failure (DNS not ready, route black-holed, connection refused, request aborted
 * by a network change) and resolves as soon as response headers arrive — for ANY origin, no CORS
 * cooperation needed. That makes it a direct reachability oracle for the exact URL the element will
 * fetch. It deliberately proves REACHABILITY, not success: an HTTP error page is the content owner's
 * page and renders as one; a network failure renders as Chrome's sad face / a broken-image icon,
 * which an unattended wall must never show.
 *
 * Per surface, the life cycle is:
 *
 *   PROVE   probe until it succeeds (backoff, forever, calmly) — only then paint the element.
 *   VERIFY  re-probe shortly after painting (10s, 30s): a network change in the window between the
 *           successful probe and the element's own fetch kills the load with no event we can see
 *           (SOP hides a cross-origin iframe's failure, and Chrome fires `load` for its own error
 *           page). A failed verify means that window was live — re-prove, then reload IN PLACE.
 *   STEADY  quiet. No periodic polling: a fleet of walls must not trickle-poll its dashboards.
 *
 * Re-doubt comes from three places, all funnelled here:
 *   - `recheck()` — the browser's network hints, demoted from triggers-of-reloads to triggers-of-probes.
 *     If the probe passes, the element is reloaded in place anyway (in-flight loads may have been
 *     aborted); if it fails, we re-prove first. Either way the wall converges on working content.
 *   - `elementError()` — media (`<img>`/`<video>`) tells us outright when its fetch failed; the
 *     element is cleared (a broken-image icon is a failed screen) and the URL re-proven, with its own
 *     backoff so a reachable-but-undecodable asset cannot spin.
 *   - a changed URL from the operator — the OLD content stays up until the NEW URL proves, so a bad
 *     assignment degrades to "wall keeps showing the previous content" rather than a sad face.
 *
 * In-place reloads are rate-limited per surface AND queued when refused — a heal that is warranted
 * but rate-limited happens later, it is never dropped (dropping one is exactly how the watchdog
 * stayed blind). The one residual gap, stated honestly: a cross-origin IFRAME whose load is aborted
 * with no browser hint, after the last verify passes, is undetectable from this side of the SOP wall.
 * Media has no such gap — its error events are wired.
 *
 * Framework-agnostic and fully injected (probe, clock, callbacks) so tests drive it without a DOM.
 */

import { redactUrl } from "./diag";

export interface SurfaceTarget {
  id: string;
  url: string;
}

/** What the prober currently believes about a surface's URL (POL-94). `unknown` = never concluded
 *  anything yet (first probe still in flight) — it is never REPORTED, only an initial value. */
export type SurfaceHealth = "unknown" | "reachable" | "unreachable";

/** One health conclusion, emitted only when a surface's state CHANGES (POL-94). */
export interface SurfaceHealthChange {
  id: string;
  url: string;
  state: "reachable" | "unreachable";
  detail?: string;
}

export interface SurfaceProberOptions {
  /** Point the element at a proven URL (mount it if this surface was dark). */
  paint: (id: string, url: string) => void;
  /** Unmount the element — show the calm placeholder instead of a broken one. */
  clear: (id: string) => void;
  /** Re-fetch a painted element in place (no remount; D5's keyed DOM survives). */
  reload: (id: string) => void;
  /** Reachability oracle; resolves = reachable. Injected for tests. */
  probe?: (url: string) => Promise<void>;
  /** POL-108 — a probe FAILED (with how many in a row, and why). The prober itself needs no such
   *  hook: it just keeps trying, calmly, forever. A LIVE surface does — a wall whose camera was
   *  already unreachable when the box booted would otherwise sit on "Connecting…" for ever, which is
   *  true but useless. The player turns a repeated failure into "No signal · cannot reach the source"
   *  on the glass. Optional; nothing else listens. */
  onProbeFail?: (id: string, attempts: number, error: string) => void;
  /** POL-94 — the probe's verdict CHANGED for a surface. Fired on transitions only (never per probe,
   *  never per retry), so reporting a fleet's content health to the control plane is a handful of
   *  frames rather than a poll. The player forwards these as `player/surface-health`. */
  onHealth?: (change: SurfaceHealthChange) => void;
  log?: (msg: string) => void;
  probeTimeoutMs?: number;
  probeBackoffMinMs?: number;
  probeBackoffMaxMs?: number;
  /** Post-paint verification schedule, relative to the paint. */
  verifyDelaysMs?: number[];
  minReloadIntervalMs?: number;
  recheckDebounceMs?: number;
  /** First retry delay after an element (media) load error; doubles per consecutive error. */
  errorRetryMinMs?: number;
  now?: () => number;
}

const PROBE_TIMEOUT_MS = 10_000;
const PROBE_BACKOFF_MIN_MS = 500;
const PROBE_BACKOFF_MAX_MS = 15_000;
const VERIFY_DELAYS_MS = [10_000, 30_000];
const MIN_RELOAD_INTERVAL_MS = 10_000;
const RECHECK_DEBOUNCE_MS = 1_500;
const ERROR_RETRY_MIN_MS = 1_000;

type Phase = "proving" | "verifying" | "steady";

interface SurfaceState {
  url: string;
  paintedUrl: string | null;
  phase: Phase;
  /** Consecutive failed probes — drives the probe backoff. */
  attempts: number;
  /** Consecutive element load errors — drives the element-error backoff (probe may keep passing). */
  errorStreak: number;
  /** Bumped to invalidate in-flight probe results when the surface is retargeted or dropped. */
  seq: number;
  /** POL-94 — the last verdict REPORTED for this surface (so we only report changes). */
  health: SurfaceHealth;
  /** Pending probe retry or scheduled verify. */
  timer: ReturnType<typeof setTimeout> | null;
  verifyIdx: number;
  lastReloadAt: number;
  reloadTimer: ReturnType<typeof setTimeout> | null;
}

/** Probe with a timeout, and cancel the body the moment headers prove the URL reachable — the real
 *  element does the actual fetch; the probe must not download a video twice. */
function defaultProbe(timeoutMs: number): (url: string) => Promise<void> {
  return async (url: string): Promise<void> => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new Error(`no response in ${timeoutMs}ms`)), timeoutMs);
    try {
      await fetch(url, { mode: "no-cors", cache: "no-store", redirect: "follow", signal: ctl.signal });
    } finally {
      clearTimeout(timer);
      ctl.abort(); // resolved: headers were enough; stop streaming the body
    }
  };
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

export class SurfaceProber {
  private readonly surfaces = new Map<string, SurfaceState>();
  private recheckTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  private readonly paint: (id: string, url: string) => void;
  private readonly clearEl: (id: string) => void;
  private readonly reloadEl: (id: string) => void;
  private readonly probe: (url: string) => Promise<void>;
  private readonly onProbeFail: (id: string, attempts: number, error: string) => void;
  private readonly onHealth: (change: SurfaceHealthChange) => void;
  private readonly log: (msg: string) => void;
  private readonly backoffMinMs: number;
  private readonly backoffMaxMs: number;
  private readonly verifyDelaysMs: number[];
  private readonly minReloadIntervalMs: number;
  private readonly recheckDebounceMs: number;
  private readonly errorRetryMinMs: number;
  private readonly now: () => number;

  constructor(opts: SurfaceProberOptions) {
    this.paint = opts.paint;
    this.clearEl = opts.clear;
    this.reloadEl = opts.reload;
    this.probe = opts.probe ?? defaultProbe(opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS);
    this.onProbeFail = opts.onProbeFail ?? ((): void => {});
    this.onHealth = opts.onHealth ?? ((): void => {});
    this.log = opts.log ?? ((): void => {});
    this.backoffMinMs = opts.probeBackoffMinMs ?? PROBE_BACKOFF_MIN_MS;
    this.backoffMaxMs = opts.probeBackoffMaxMs ?? PROBE_BACKOFF_MAX_MS;
    this.verifyDelaysMs = opts.verifyDelaysMs ?? VERIFY_DELAYS_MS;
    this.minReloadIntervalMs = opts.minReloadIntervalMs ?? MIN_RELOAD_INTERVAL_MS;
    this.recheckDebounceMs = opts.recheckDebounceMs ?? RECHECK_DEBOUNCE_MS;
    this.errorRetryMinMs = opts.errorRetryMinMs ?? ERROR_RETRY_MIN_MS;
    this.now = opts.now ?? ((): number => Date.now());
  }

  /** The surfaces currently on screen. Same id+url is untouched (probe loops keep their state);
   *  a changed url re-proves while the OLD painted content stays up; gone ids are forgotten. */
  sync(targets: SurfaceTarget[]): void {
    if (this.stopped) return;
    const wanted = new Set(targets.map((t) => t.id));
    for (const id of [...this.surfaces.keys()]) {
      if (!wanted.has(id)) this.drop(id);
    }
    for (const { id, url } of targets) {
      const state = this.surfaces.get(id);
      if (!state) {
        this.surfaces.set(id, {
          url,
          paintedUrl: null,
          phase: "proving",
          attempts: 0,
          errorStreak: 0,
          seq: 0,
          health: "unknown",
          timer: null,
          verifyIdx: 0,
          lastReloadAt: Number.NEGATIVE_INFINITY,
          reloadTimer: null,
        });
        this.log(`${id}: proving ${redactUrl(url)}`);
        void this.prove(id, "first paint");
      } else if (state.url !== url) {
        this.invalidate(state);
        state.url = url;
        state.phase = "proving";
        state.attempts = 0;
        state.errorStreak = 0;
        // A new URL is a new question: whatever we knew about the old one says nothing about this
        // one, and the console must not keep showing the old verdict against the new address.
        state.health = "unknown";
        this.log(`${id}: url changed — proving ${redactUrl(url)} (previous content stays up meanwhile)`);
        void this.prove(id, "url change");
      }
    }
  }

  /** The element itself reported a failed load (media `error`). The probe may well still pass —
   *  a 404 or an undecodable asset is reachable — so this path carries its own backoff. */
  elementError(id: string): void {
    if (this.stopped) return;
    const state = this.surfaces.get(id);
    if (!state) return;
    state.errorStreak += 1;
    this.invalidate(state);
    if (state.paintedUrl !== null) {
      state.paintedUrl = null;
      this.clearEl(id); // a broken-image icon IS a failed screen; show the placeholder instead
    }
    state.phase = "proving";
    state.attempts = 0;
    const delay = Math.min(this.backoffMaxMs, this.errorRetryMinMs * 2 ** (state.errorStreak - 1));
    this.log(`${id}: element failed to load (streak ${state.errorStreak}) — re-proving in ${delay}ms`);
    this.setHealth(id, state, "unreachable", "element failed to load");
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.prove(id, "element error");
    }, delay);
  }

  /** The element finished a real load — media only calls this on genuine success. */
  elementLoaded(id: string): void {
    const state = this.surfaces.get(id);
    if (!state) return;
    state.errorStreak = 0;
    // The element that was failing has now loaded for real — the surface is healthy again, and this
    // is the ONLY signal that can say so (the probe never disproved the URL; the element did).
    if (state.paintedUrl !== null) this.setHealth(id, state, "reachable");
  }

  /**
   * A browser hint that the network moved (online, WS reconnect, resource error). Debounced. Every
   * surface is re-probed: pass → reload in place (in-flight loads may have been aborted even though
   * the URL is reachable NOW); fail → back to proving until it passes.
   */
  recheck(reason: string): void {
    if (this.stopped || this.surfaces.size === 0) return;
    if (this.recheckTimer) return; // the burst collapses into the pending recheck
    this.recheckTimer = setTimeout(() => {
      this.recheckTimer = null;
      if (this.stopped) return;
      this.log(`network signal (${reason}) — re-probing ${this.surfaces.size} surface(s)`);
      for (const [id, state] of this.surfaces) {
        if (state.phase === "proving") {
          // Already hunting. If it is waiting out a backoff, the network just changed — try NOW.
          if (state.timer) {
            clearTimeout(state.timer);
            state.timer = null;
            state.attempts = 0;
            void this.prove(id, `network signal (${reason})`);
          }
          // No timer → a probe is in flight; its result will land on its own.
        } else {
          this.invalidate(state);
          state.phase = "proving";
          state.attempts = 0;
          void this.prove(id, `network signal (${reason})`);
        }
      }
    }, this.recheckDebounceMs);
  }

  /**
   * POL-157 — an operator-scheduled reload for ONE surface (its source's refresh cadence came due).
   * This is a DELIBERATE reload, so it rides the SAME prove-then-swap path a heal does: re-prove the
   * URL and only reload the element IN PLACE once it PROVES — the old content stays on the glass until
   * the new load is known reachable, so a scheduled reload can never black-flash the wall (and a
   * reload while the source is unreachable degrades to "keep showing the last good content", not a sad
   * face). A surface already mid-prove is left alone: it will paint the moment it proves, which is the
   * fresh load the cadence wanted anyway. The reload re-fetches the CURRENT url, so a credentialed
   * source (POL-24) re-stamps a live token at prove/paint time — exactly when a real reload should.
   */
  refreshDue(id: string, reason: string): void {
    if (this.stopped) return;
    const state = this.surfaces.get(id);
    if (!state || state.phase === "proving") return;
    this.invalidate(state);
    state.phase = "proving";
    state.attempts = 0;
    this.log(`${id}: refresh due (${reason}) — re-proving before reload`);
    void this.prove(id, `refresh (${reason})`);
  }

  /**
   * POL-94 — every surface's CURRENT verdict (skipping those with none yet). The player re-sends
   * this whenever its socket (re)opens: the server forgets a screen's health the moment it drops, so
   * without a replay a reconnected wall showing a dead dashboard would read "unknown" in the console
   * until the URL happened to change state again — which, for a URL that is simply dead, is never.
   */
  snapshot(): SurfaceHealthChange[] {
    const out: SurfaceHealthChange[] = [];
    for (const [id, state] of this.surfaces) {
      if (state.health === "unknown") continue;
      out.push({ id, url: state.url, state: state.health });
    }
    return out;
  }

  stop(): void {
    this.stopped = true;
    if (this.recheckTimer) clearTimeout(this.recheckTimer);
    this.recheckTimer = null;
    for (const id of [...this.surfaces.keys()]) this.drop(id);
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /** Report a verdict — but only when it CHANGES. A URL that has been dead for a week costs one
   *  frame, not one per retry; a healthy wall costs none at all. */
  private setHealth(
    id: string,
    state: SurfaceState,
    next: "reachable" | "unreachable",
    detail?: string,
  ): void {
    if (state.health === next) return;
    state.health = next;
    this.onHealth({ id, url: state.url, state: next, ...(detail ? { detail } : {}) });
  }

  private drop(id: string): void {
    const state = this.surfaces.get(id);
    if (state) this.invalidate(state);
    this.surfaces.delete(id);
  }

  /** Kill anything scheduled or in flight for this surface. */
  private invalidate(state: SurfaceState): void {
    state.seq += 1;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    if (state.reloadTimer) clearTimeout(state.reloadTimer);
    state.reloadTimer = null;
  }

  /** One probe of the surface's current URL: success paints (or reloads, if this URL is already
   *  painted); failure retries with backoff, forever — a wall keeps trying, calmly. */
  private async prove(id: string, why: string): Promise<void> {
    const state = this.surfaces.get(id);
    if (!state || this.stopped) return;
    const seq = state.seq;
    const url = state.url;
    let failed = false;
    let error: unknown;
    try {
      await this.probe(url);
    } catch (err) {
      failed = true;
      error = err;
    }
    if (this.stopped) return;
    const current = this.surfaces.get(id);
    if (!current || current.seq !== seq) return; // retargeted or dropped while we were in flight

    if (failed) {
      current.attempts += 1;
      const delay = Math.min(this.backoffMaxMs, this.backoffMinMs * 2 ** (current.attempts - 1));
      this.log(
        `${id}: probe of ${redactUrl(url)} failed (${describeError(error)}) — retry ${current.attempts} in ${delay}ms [${why}]`,
      );
      this.onProbeFail(id, current.attempts, describeError(error));
      this.setHealth(id, current, "unreachable", describeError(error).slice(0, 200));
      current.timer = setTimeout(() => {
        current.timer = null;
        void this.prove(id, why);
      }, delay);
      return;
    }

    const attempts = current.attempts;
    current.attempts = 0;
    // "The URL is fetchable" is only good news if the ELEMENT isn't currently failing on it: a 404
    // image or an undecodable video probes perfectly and still shows a broken icon on the wall. While
    // an error streak is open, the element's own verdict outranks the probe's — `elementLoaded`
    // (a real, successful load) is what clears it.
    if (current.errorStreak === 0) this.setHealth(id, current, "reachable");
    if (current.paintedUrl === url) {
      // The element already shows this URL; reachable again ≠ the element survived the outage.
      current.phase = "verifying";
      this.requestReload(id, why);
    } else {
      this.log(`${id}: reachable${attempts > 0 ? ` after ${attempts + 1} probes` : ""} — painting [${why}]`);
      current.paintedUrl = url;
      current.phase = "verifying";
      current.verifyIdx = 0;
      this.paint(id, url);
      this.scheduleVerify(id, current);
    }
  }

  private scheduleVerify(id: string, state: SurfaceState): void {
    if (state.verifyIdx >= this.verifyDelaysMs.length) {
      state.phase = "steady";
      return;
    }
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.verify(id);
    }, this.verifyDelaysMs[state.verifyIdx]);
  }

  /** Post-paint spot check: the network moving in the window between the successful probe and the
   *  element's own fetch kills the load invisibly (SOP) — a failed verify is how we see that window. */
  private async verify(id: string): Promise<void> {
    const state = this.surfaces.get(id);
    if (!state || this.stopped) return;
    const seq = state.seq;
    let failed = false;
    let error: unknown;
    try {
      await this.probe(state.url);
    } catch (err) {
      failed = true;
      error = err;
    }
    if (this.stopped) return;
    const current = this.surfaces.get(id);
    if (!current || current.seq !== seq) return;

    if (failed) {
      this.log(
        `${id}: verify probe failed (${describeError(error)}) — the network moved after paint; re-proving`,
      );
      this.setHealth(id, current, "unreachable", describeError(error).slice(0, 200));
      current.phase = "proving";
      current.attempts = 0;
      void this.prove(id, "verify failed");
      return;
    }
    this.setHealth(id, current, "reachable");
    current.verifyIdx += 1;
    this.scheduleVerify(id, current);
  }

  /** Reload in place, rate-limited per surface. A refused heal is QUEUED, never dropped — dropping
   *  a warranted heal is exactly how a wall stays broken with no human watching. */
  private requestReload(id: string, reason: string): void {
    const state = this.surfaces.get(id);
    if (!state) return;
    const since = this.now() - state.lastReloadAt;
    if (since >= this.minReloadIntervalMs) {
      this.performReload(id, reason);
      return;
    }
    if (state.reloadTimer) return; // one queued heal is enough; it re-verifies afterwards
    const wait = this.minReloadIntervalMs - since;
    this.log(`${id}: reload wanted (${reason}) but rate-limited — queued for ${wait}ms`);
    state.reloadTimer = setTimeout(() => {
      state.reloadTimer = null;
      this.performReload(id, reason);
    }, wait);
  }

  private performReload(id: string, reason: string): void {
    const state = this.surfaces.get(id);
    if (!state || this.stopped) return;
    state.lastReloadAt = this.now();
    this.log(`${id}: reloading in place (${reason})`);
    this.reloadEl(id);
    // The reload re-navigates, so the just-painted window reopens — verify it again.
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    state.phase = "verifying";
    state.verifyIdx = 0;
    this.scheduleVerify(id, state);
  }
}
