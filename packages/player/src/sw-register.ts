/**
 * POL-132 — shell service worker registration + update discipline (the page side).
 *
 * The worker (sw/shell-sw.js, generated at build) makes the player shell reload-proof during a
 * control-plane outage: cache-first, so a reload mid-outage paints the app (which then restores its
 * last-good slice per POL-32/D83) instead of the browser's "no available server" page.
 *
 * This module owns the two disciplines the worker itself refuses to decide:
 *
 *   REGISTRATION — production builds only (`import.meta.env.PROD`): the dev server / Vite HMR must
 *   never be cache-poisoned. `?sw=off` on the URL is the kill switch for debugging a wall: it
 *   unregisters every worker in scope and leaves the page uncontrolled. On a plain-HTTP origin
 *   (netboot boxes, D47/D52) `navigator.serviceWorker` only exists because the agent launches
 *   Chrome with `--unsafely-treat-insecure-origin-as-secure=<server origin>` (agent chrome.ts);
 *   where it's absent we log exactly what protection is missing and change nothing else.
 *
 *   VERSION (D107) — a newer build's worker installs in the background (the worker's navigation
 *   handler and every server contact trigger update checks) but is only told to take over at a SAFE
 *   MOMENT: the player WS is open, i.e. the control plane is reachable, so the reload that follows
 *   repaints instantly from the last-good slice and reconnects immediately. The swap is written to
 *   the player.diag trail ("shell from cache (vX) → updating to vY") — the trail is how walls get
 *   debugged (D78), so a silent build swap is not allowed to exist.
 *
 * `ShellUpdater` carries the update state machine behind injectable seams so the discipline is
 * unit-testable without a real ServiceWorker plumbing (see test/sw-register.test.ts).
 */

/** The slice of a (waiting/installing) ServiceWorker the updater needs. */
export interface WorkerLike {
  state?: string;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener?(type: string, listener: () => void): void;
}

/** The slice of a ServiceWorkerRegistration the updater needs. */
export interface RegistrationLike {
  readonly waiting: WorkerLike | null;
  readonly installing: WorkerLike | null;
  addEventListener(type: "updatefound", listener: () => void): void;
  update(): Promise<unknown>;
}

export interface ShellUpdaterDeps {
  /** player.diag — every swap decision must land in the trail. */
  log(msg: string): void;
  /** The build THIS page is running (stamped by Vite, D107). */
  version: string;
  /** Is now a safe moment to reload into a new build? (player WS open = server reachable). */
  safeToSwap(): boolean;
  /** Is this page controlled by a worker? (first-install claims never warrant a reload swap). */
  hasController(): boolean;
  /** Ask a worker which build it carries (null on timeout — the swap proceeds regardless). */
  versionOf(worker: WorkerLike): Promise<string | null>;
  /** location.reload() — the one reload the player is allowed: into a newer build, post-contact. */
  reload(): void;
}

export class ShellUpdater {
  private registration: RegistrationLike | null = null;
  private swapRequested = false;
  private reloaded = false;
  private announcedWaiting = false;

  constructor(private readonly deps: ShellUpdaterDeps) {}

  /** Wire a live registration: watch for background installs and pick up an already-waiting build. */
  attach(registration: RegistrationLike): void {
    this.registration = registration;
    registration.addEventListener("updatefound", () => this.watchInstalling());
    this.watchInstalling();
    this.trySwap();
  }

  /** The server answered (player WS open): revalidate the shell and swap if a newer build waits.
   *  Being called IS the safe moment — the swap must not additionally consult `safeToSwap()`,
   *  which polls reactive state that may not have caught up with the very event that triggered
   *  this call (the WS open handler once updated its state AFTER calling us: every contact then
   *  read a stale "connecting" and deferred the swap forever — caught in review; the ordering
   *  test below pins it). `safeToSwap()` remains the gate for swaps triggered by anything that
   *  is NOT itself a server contact (e.g. an install completing mid-connection). */
  serverContact(): void {
    void this.registration?.update().catch(() => {
      /* offline / server gone again — the next contact revalidates */
    });
    this.trySwap(true);
  }

  /**
   * The controlling worker changed. After a swap WE requested this means the new build owns the
   * page — reload into it (once; the guard makes a reload loop structurally impossible). A claim
   * by a first-ever install also fires this event, and must NOT reload a freshly-loaded wall.
   */
  controllerChanged(): void {
    if (!this.swapRequested || this.reloaded) return;
    this.reloaded = true;
    this.deps.reload();
  }

  /** The most recent installing worker we wired (guards against double-watching: `attach` and the
   *  `updatefound` event can both see the same worker object). */
  private watched: WorkerLike | null = null;

  private watchInstalling(): void {
    const installing = this.registration?.installing;
    if (!installing?.addEventListener || installing === this.watched) return;
    this.watched = installing;
    let installed = false;
    installing.addEventListener("statechange", () => {
      if (installing.state === "installed") {
        installed = true;
        this.trySwap();
      } else if (installing.state === "redundant" && !installed) {
        // An install that died BEFORE reaching `installed` (a precache fetch failed mid-addAll,
        // the server vanished, quota). register() resolved long ago, so without this line the
        // failure is silent — and the wall's next reload-mid-outage is unprotected with no trace.
        this.deps.log(
          "shell service worker install FAILED (precache aborted?) — a reload during an outage is not shielded yet; retries on the next update check",
        );
      }
    });
  }

  private trySwap(contactNow = false): void {
    if (this.swapRequested) return;
    const waiting = this.registration?.waiting ?? null;
    if (!waiting) return;
    // No controller → nothing is being replaced (cannot happen with a *waiting* worker in a normal
    // life, but guard it: reloading an uncontrolled page buys nothing).
    if (!this.deps.hasController()) return;
    if (!contactNow && !this.deps.safeToSwap()) {
      if (!this.announcedWaiting) {
        this.announcedWaiting = true;
        this.deps.log("shell update installed — waiting for server contact to swap builds");
      }
      return;
    }
    this.swapRequested = true;
    void this.deps.versionOf(waiting).then((next) => {
      this.deps.log(
        `shell from cache (v${this.deps.version}) → updating to ${next ? `v${next}` : "a newer build"} — reloading`,
      );
      waiting.postMessage({ t: "polyptic/skip-waiting" });
    });
  }
}

// ── Browser glue ─────────────────────────────────────────────────────────────

/** Captured before anything can claim the page: was THIS document served through a worker —
 *  i.e. (cache-first) from the shell cache? This is what makes the diag trail's
 *  "shell from cache" line honest. */
const CONTROLLED_AT_BOOT =
  typeof navigator !== "undefined" && !!navigator.serviceWorker?.controller;

export function shellFromCache(): boolean {
  return CONTROLLED_AT_BOOT;
}

/** Ask a worker which build it carries; null after a short timeout (never block a swap on it). */
function askVersion(worker: WorkerLike): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const channel = new MessageChannel();
      const timer = setTimeout(() => resolve(null), 1_500);
      channel.port1.onmessage = (ev: MessageEvent) => {
        clearTimeout(timer);
        const version = (ev.data as { version?: unknown } | null)?.version;
        resolve(typeof version === "string" ? version : null);
      };
      worker.postMessage({ t: "polyptic/version" }, [channel.port2]);
    } catch {
      resolve(null);
    }
  });
}

let updater: ShellUpdater | null = null;

export interface InitShellWorkerOptions {
  log(msg: string): void;
  version: string;
  safeToSwap(): boolean;
}

/**
 * Register the shell worker (production builds only) and wire the update discipline. Call once at
 * player boot, after diag is up. Never throws; a wall without worker support simply keeps today's
 * behaviour (a reload mid-outage shows the browser error page) — and says so in the trail.
 */
export function initShellWorker(opts: InitShellWorkerOptions): void {
  if (!import.meta.env.PROD) return; // dev server / HMR: never register, never cache-poison

  const params = new URLSearchParams(window.location.search);
  if (params.get("sw") === "off") {
    // Kill switch for debugging: drop every registration in scope and run uncontrolled.
    opts.log("shell service worker disabled by ?sw=off — unregistering");
    void navigator.serviceWorker
      ?.getRegistrations()
      .then((regs) => Promise.all(regs.map((r) => r.unregister())))
      .catch(() => {});
    return;
  }

  if (!("serviceWorker" in navigator)) {
    // Plain-HTTP origin without the agent's Chrome flag (e.g. the surf fallback, or a hand-opened
    // browser): the wall works exactly as before, minus reload-during-outage protection.
    opts.log(
      "shell service worker unavailable (insecure context or unsupported browser) — a reload during an outage will not be shielded",
    );
    return;
  }

  if (shellFromCache()) {
    opts.log(`shell from cache (v${opts.version})`);
  }

  updater = new ShellUpdater({
    log: opts.log,
    version: opts.version,
    safeToSwap: opts.safeToSwap,
    hasController: () => navigator.serviceWorker.controller !== null,
    versionOf: askVersion,
    reload: () => window.location.reload(),
  });
  navigator.serviceWorker.addEventListener("controllerchange", () => updater?.controllerChanged());

  const swUrl = `${import.meta.env.BASE_URL}sw.js`;
  void (async () => {
    let registration: ServiceWorkerRegistration;
    try {
      try {
        // Prefer the no-trailing-slash scope ("/player") so a bare `/player?screen=…` navigation
        // is controlled too. Wider than the worker's directory, so it needs the
        // `Service-Worker-Allowed: /player` header spa.ts stamps on sw.js …
        registration = await navigator.serviceWorker.register(swUrl, { scope: scopeFor(import.meta.env.BASE_URL) });
      } catch {
        // … and any other host serving the dist without that header still gets the default scope
        // ("/player/"), which covers every URL the control plane actually launches.
        registration = await navigator.serviceWorker.register(swUrl);
      }
    } catch (err) {
      opts.log(`shell service worker registration failed: ${String(err)}`);
      return;
    }
    if (!shellFromCache()) {
      opts.log(`shell service worker registered (v${opts.version}) — reloads now survive an outage`);
    }
    updater?.attach(registration);
  })();
}

/** Vite base → registration scope: "/player/" → "/player"; "/" stays "/". Exported for tests. */
export function scopeFor(base: string): string {
  return base.length > 1 && base.endsWith("/") ? base.slice(0, -1) : base;
}

/** Call on every player-WS open: the control plane answered, so revalidate the shell and (if a
 *  newer build finished installing) swap into it now — the safe moment. */
export function shellServerContact(): void {
  updater?.serverContact();
}
