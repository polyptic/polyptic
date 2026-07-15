/**
 * Stream engine (POL-108) — keeps ONE live surface alive, or says out loud that it isn't.
 *
 * A live stream fails differently from a file. A file is fetched once: if the fetch succeeds it
 * plays, and if it fails the element fires `error` and the POL-86 prober re-proves the URL. A live
 * stream is a moving window over content that does not exist yet, so it can fail at any moment and
 * in ways the media element never reports:
 *
 *   - the origin (or the restreamer in front of an RTSP camera) restarts → segments 404 for a while;
 *   - the playlist stops advancing → the element is happily "playing" a buffer that runs dry, and
 *     then just sits there — no `error`, no `ended`, no event AT ALL. A black rectangle on the wall
 *     with the browser insisting everything is fine. This is the failure that matters: it is silent.
 *   - the network moves under the box → the segment fetches die mid-flight.
 *
 * So health here is measured, not trusted: PROGRESS (does `currentTime` still advance?) is the only
 * honest signal, and the watchdog polls it. Recovery is layered, cheapest first:
 *
 *   1. the media pipeline's own retries (hls.js retries a failed segment on its own — we do not
 *      interfere, only FATAL errors reach us);
 *   2. this engine: on a fatal error OR a stall, tear the pipeline down and re-attach it, with
 *      exponential backoff. A restreamer bouncing for 20s heals here, without the surface flicking
 *      away from the wall;
 *   3. the POL-86 prober: after `giveUpAfter` consecutive failed re-attaches the engine hands the
 *      surface BACK (`onGiveUp`) — the element is cleared, the URL is re-proven with the prober's own
 *      forever-backoff, and the surface repaints (remounting a fresh engine) the moment the stream's
 *      URL is reachable again. That is the difference between a source that is flapping and a source
 *      that is GONE: a gone source must not be hammered by an MSE pipeline every few seconds, and it
 *      must not sit on a black rectangle either — the prober's calm re-prove is exactly the right
 *      machinery, and it already exists.
 *
 * Every transition is narrated (`onHealth` → the on-glass board + `player.diag`), because a dead feed
 * that says WHY it is dead is the difference between a five-minute fix and a site visit.
 *
 * DOM-free and fully injected (attach/detach/mediaTime/clock) — the tests drive the whole state
 * machine, including the silent-stall case, without a browser.
 */

/** What the wall is currently able to say about this feed. */
export type StreamHealth =
  /** Attached, nothing has played yet — the normal first second of any feed. */
  | "connecting"
  /** Frames are arriving: `currentTime` is advancing. */
  | "live"
  /** It broke and the engine is re-attaching (the last frame stays up under the board). */
  | "recovering"
  /** The engine gave up; the prober now owns the surface until the URL is reachable again. */
  | "down";

export interface StreamEngineOptions {
  /** Attach the media pipeline to the element (hls.js, or the element's native HLS). */
  attach: () => void;
  /** Tear it down: destroy the pipeline and release the element's source. */
  detach: () => void;
  /** The element's current playback position, in seconds. The engine compares readings: a position
   *  that ADVANCES is the one honest liveness signal a live stream has. */
  mediaTime: () => number;
  /** Health transition — drives the on-glass board and the diag trail. */
  onHealth: (health: StreamHealth, detail: string) => void;
  /** The engine's own reconnects are exhausted: hand the surface back to the prober. */
  onGiveUp: (reason: string) => void;
  log?: (msg: string) => void;
  /** No progress for this long, while attached, IS a failure — even with no error event. */
  stallTimeoutMs?: number;
  /** How often progress is sampled. */
  stallPollMs?: number;
  retryMinMs?: number;
  retryMaxMs?: number;
  /** Consecutive failed re-attaches before handing the surface to the prober. */
  giveUpAfter?: number;
  now?: () => number;
}

const STALL_TIMEOUT_MS = 12_000;
const STALL_POLL_MS = 2_000;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 15_000;
const GIVE_UP_AFTER = 4;
/** Playback must move by more than this between polls to count — a hair of jitter is not progress. */
const PROGRESS_EPSILON_S = 0.01;

export class StreamEngine {
  private readonly opts: Required<Omit<StreamEngineOptions, "log">> & { log: (m: string) => void };

  private health: StreamHealth = "connecting";
  /** Last playback position seen. `null` = "no reading yet", which is NOT the same as "position 0":
   *  a freshly-attached pipeline sits at 0, so treating 0 as a baseline reads the first poll of a
   *  STONE-DEAD feed as progress and lights the wall up green over a black rectangle. Caught in live
   *  verification against a real origin whose segments were 404ing: the surface flapped live→stalled
   *  →live forever, healthy by its own account, showing nothing. The first poll after each attach
   *  establishes the baseline and claims nothing. */
  private lastTime: number | null = null;
  /** Consecutive failures since the last time frames were flowing. */
  private attempts = 0;
  private lastProgressAt = 0;
  private attached = false;
  private stopped = false;
  /** Once we hand back to the prober we go inert: a late error event must not re-enter the loop. */
  private gaveUp = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: StreamEngineOptions) {
    this.opts = {
      attach: options.attach,
      detach: options.detach,
      mediaTime: options.mediaTime,
      onHealth: options.onHealth,
      onGiveUp: options.onGiveUp,
      log: options.log ?? ((): void => {}),
      stallTimeoutMs: options.stallTimeoutMs ?? STALL_TIMEOUT_MS,
      stallPollMs: options.stallPollMs ?? STALL_POLL_MS,
      retryMinMs: options.retryMinMs ?? RETRY_MIN_MS,
      retryMaxMs: options.retryMaxMs ?? RETRY_MAX_MS,
      giveUpAfter: options.giveUpAfter ?? GIVE_UP_AFTER,
      now: options.now ?? ((): number => Date.now()),
    };
  }

  /** Attach the pipeline and start watching for progress. */
  start(): void {
    if (this.stopped) return;
    this.gaveUp = false;
    this.attempts = 0;
    this.setHealth("connecting", "connecting to the live stream");
    this.attachNow();
  }

  /** Re-attach from the outside (the prober healing this surface in place after a network move). */
  restart(reason: string): void {
    if (this.stopped) return;
    this.opts.log(`re-attaching (${reason})`);
    this.detachNow();
    this.gaveUp = false;
    this.attempts = 0;
    this.setHealth("connecting", "reconnecting to the live stream");
    this.attachNow();
  }

  /** The pipeline reported a FATAL error (its own retries are exhausted), or the element errored. */
  fail(reason: string): void {
    if (this.stopped || this.gaveUp || this.retryTimer) return; // recovering, or the prober's now
    this.detachNow();
    this.attempts += 1;

    if (this.attempts > this.opts.giveUpAfter) {
      this.gaveUp = true;
      this.setHealth("down", reason);
      this.opts.log(
        `gave up after ${this.opts.giveUpAfter} reconnects (${reason}) — handing back to the prober`,
      );
      this.opts.onGiveUp(reason);
      return;
    }

    const delay = Math.min(
      this.opts.retryMaxMs,
      this.opts.retryMinMs * 2 ** (this.attempts - 1),
    );
    this.setHealth(
      "recovering",
      `${reason} — reconnecting (attempt ${this.attempts} of ${this.opts.giveUpAfter})`,
    );
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.stopped) return;
      this.attachNow();
    }, delay);
  }

  /** Tear everything down (component unmount). Idempotent. */
  stop(): void {
    this.stopped = true;
    this.detachNow();
  }

  currentHealth(): StreamHealth {
    return this.health;
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private attachNow(): void {
    this.lastTime = null;
    this.opts.attach();
    this.attached = true;
    this.lastProgressAt = this.opts.now();
    if (this.pollTimer === null) {
      this.pollTimer = setInterval(() => this.poll(), this.opts.stallPollMs);
    }
  }

  private detachNow(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (!this.attached) return;
    this.attached = false;
    this.opts.detach();
  }

  /**
   * The watchdog. Progress means health — and it is the ONLY thing that does: an HLS pipeline whose
   * playlist has stopped advancing keeps the element in `playing` state with no error event, which is
   * precisely how an unattended wall ends up showing a frozen frame nobody notices.
   */
  private poll(): void {
    if (this.stopped || !this.attached) return;
    const time = this.opts.mediaTime();
    const advanced = this.lastTime !== null && time > this.lastTime + PROGRESS_EPSILON_S;
    this.lastTime = time;
    if (advanced) {
      this.lastProgressAt = this.opts.now();
      if (this.health !== "live") {
        this.attempts = 0;
        this.setHealth("live", "frames are arriving");
      }
      return;
    }
    const idleMs = this.opts.now() - this.lastProgressAt;
    if (idleMs >= this.opts.stallTimeoutMs) {
      this.fail(`no video for ${Math.round(idleMs / 1000)}s (the source stopped sending)`);
    }
  }

  private setHealth(health: StreamHealth, detail: string): void {
    this.health = health;
    this.opts.log(`${health}: ${detail}`);
    this.opts.onHealth(health, detail);
  }
}
