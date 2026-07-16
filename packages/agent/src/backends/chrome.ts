/**
 * chrome — Google Chrome as the kiosk browser, running NATIVE Wayland (POL-67, D77).
 *
 * Why it exists: surf (WebKitGTK) is an X11 client, so under the wayland-sway backend it renders
 * through Xwayland, whose GPU path needs DRI3 — and on real wall hardware (amdgpu, fpd-ago) DRI3 is
 * broken, so every surf software-renders and pegs the CPU at 300%+. Chrome with
 * `--ozone-platform=wayland` talks EGL/GBM straight to the GPU exactly like sway does, sidestepping
 * Xwayland and DRI3 entirely. It also brings the real remote-debugging story (`--remote-debugging-port`,
 * loopback-only) that WebKitGTK structurally lacks (D63) — the DevTools tunnel rides on it.
 *
 * One Chrome per output: Chrome DEDUPES into an existing process when two launches share a
 * `--user-data-dir`, so each connector gets its own data dir. That dir doubles as the unique
 * command-line token the stale-orphan reaper keys on, and (since Chrome 136) a non-default data dir
 * is also what makes `--remote-debugging-port` honoured at all.
 *
 * surf stays available as the fallback (`POLYPTIC_BROWSER=surf`, or simply Chrome not installed —
 * e.g. arm64, whose index Google's apt repo does not publish yet; see setup/browser.ts, which probes
 * the repo rather than hardcoding the arch, so those boxes adopt Chrome the moment it ships).
 */
import type { KioskBrowser } from "@polyptic/protocol";
import { which } from "./proc";
import { killStaleByToken, sanitizeConnector } from "./supervise";
import { SURF_CANDIDATES } from "./surf";

/** Candidate Chrome binary names, most-preferred first; `POLYPTIC_CHROME` overrides. Chromium is
 *  accepted for self-provisioned boxes that installed a non-snap chromium themselves. */
export const CHROME_CANDIDATES = ["google-chrome-stable", "google-chrome", "chromium"] as const;

/** First DevTools port; each connector gets base + its launch index (loopback-only). */
export const DEVTOOLS_PORT_BASE = 9222;

/** What one Chrome kiosk launch needs. */
export interface ChromeLaunchSpec {
  /** Player URL (already carrying `?screen=<id>`). Passed via `--app=` (chromeless window). */
  url: string;
  /** Which output this instance drives — keys the per-instance `--user-data-dir`. */
  connector: string;
  /** Loopback DevTools port for this instance (always on; the TUNNEL is what gets armed/gated). */
  devtoolsPort: number;
  /** Any extra flags (escape hatch, e.g. a lab-only option). */
  extra?: string[];
}

/**
 * Resolve the Chrome binary (or throw a clear error). `POLYPTIC_CHROME` overrides; else the first
 * candidate on PATH.
 */
export async function resolveChrome(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const override = env.POLYPTIC_CHROME?.trim();
  const candidates = override ? [override] : [...CHROME_CANDIDATES];
  for (const c of candidates) {
    if (await which(c, env)) return c;
  }
  throw new Error(
    `no Chrome binary found (tried: ${candidates.join(", ")}) — \`polyptic-agent setup\` installs ` +
      `google-chrome-stable, or set POLYPTIC_CHROME to the browser path.`,
  );
}

/** Per-connector Chrome profile dir — the process-isolation key AND the stale-reap token. */
export function chromeDataDir(connector: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_RUNTIME_DIR?.trim() || "/tmp";
  return `${base}/polyptic-chrome-${sanitizeConnector(connector)}`;
}

/**
 * The flags EVERY Chrome instance this agent launches must carry — the player's kiosk browser AND
 * the POL-18 web-window alike. Extracted so the two launchers CANNOT drift on the flags that make
 * or break a wall: `--ozone-platform=wayland` (POL-67 — native Wayland, EGL/GBM straight to the GPU,
 * no Xwayland, no DRI3, no 300%-CPU software-render → the very trap POL-146 first suspected here),
 * the per-instance `--user-data-dir` (separate processes, no dedupe, the reaper's unique token, and
 * — Chrome ≥136 — the precondition for `--remote-debugging-port` being honoured at all), a loopback
 * DevTools port, the kiosk hygiene flags, and unmuted autoplay. `--kiosk` is DELIBERATELY not here:
 * the player fullscreens, the web-window must stay a positionable surface (see buildChromeWindowArgs).
 */
function chromeBaseArgs(
  url: string,
  dataDir: string,
  devtoolsPort: number,
): string[] {
  return [
    // The whole point (POL-67): native Wayland — EGL/GBM straight to the GPU, no Xwayland, no DRI3.
    "--ozone-platform=wayland",
    `--app=${url}`,
    // One profile per instance: separate processes (no dedupe), and the reaper's unique token.
    `--user-data-dir=${dataDir}`,
    // Loopback-only DevTools endpoint for the POL-67 tunnel. Never exposed on the network; the
    // agent only proxies to it for a connector an operator ARMED (server/inspect on).
    `--remote-debugging-port=${devtoolsPort}`,
    // Kiosk hygiene: no first-run bubbles, no "restore pages?" after a crash-respawn, no dialogs.
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    "--noerrdialogs",
    "--disable-features=Translate",
    // A wall shows video with nobody there to click "play" — and, since POL-112, with the sound ON if
    // an operator asked for it. Without this flag Chrome refuses to autoplay UNMUTED media, and the
    // player would have to fall back to muted playback (which it does, deliberately — see audio.ts).
    "--autoplay-policy=no-user-gesture-required",
  ];
}

/**
 * Build Chrome's argv for one output. All flags, no positional URL — `--app=` carries it (a
 * chromeless window; `--kiosk` fullscreens it, and sway re-asserts fullscreen on placement anyway).
 * `POLYPTIC_BROWSER_ARGS` (space-split, if set) is appended last so it can override anything here.
 */
export function buildChromeArgs(
  spec: ChromeLaunchSpec,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const base = chromeBaseArgs(spec.url, chromeDataDir(spec.connector, env), spec.devtoolsPort);
  // The player fullscreens; splice `--kiosk` in right after the ozone flag (order is cosmetic).
  const args = [base[0]!, "--kiosk", ...base.slice(1)];
  // POL-132 — the player's shell service worker (what lets a wall RELOAD while the control plane is
  // down and still paint) requires a SECURE CONTEXT, and netboot boxes reach the control plane over
  // plain HTTP by design (D47/D52). This flag grants the player's origin the FULL secure-context
  // treatment — not just service workers but everything gated on it (WebCrypto subtle, geolocation,
  // getUserMedia, …). Acceptable on a kiosk whose one origin IS the control plane we already trust
  // with the whole wall; NOT a general browsing flag — which is why it is scoped to exactly this
  // origin, and only for http (an https deploy needs — and gets — no carve-out). Storage stays in
  // the per-connector profile above, so the registration survives an agent browser respawn (a
  // REBOOT wipes XDG_RUNTIME_DIR, which is fine: reboot survival is out of POL-132's scope).
  const playerOrigin = insecurePlayerOrigin(spec.url);
  if (playerOrigin) args.push(`--unsafely-treat-insecure-origin-as-secure=${playerOrigin}`);
  if (spec.extra && spec.extra.length > 0) args.push(...spec.extra);
  const extra = env.POLYPTIC_BROWSER_ARGS?.trim();
  if (extra) args.push(...extra.split(/\s+/).filter(Boolean));
  return args;
}

/** What one Chrome WEB-WINDOW launch needs (POL-18): a second, non-kiosk `--app=` window the sway
 *  backend floats + positions over the player. Sized by the compositor (sway `resize set`), so no
 *  `--window-size` here — Wayland clients don't self-position anyway. */
export interface ChromeWindowSpec {
  /** The (credential-stamped) content URL. */
  url: string;
  /** The placement's stable window id — keys the per-window `--user-data-dir`/reap token. */
  windowId: string;
  /** Loopback DevTools port for this instance (Chrome requires a non-default data dir for it). */
  devtoolsPort: number;
}

/** Per-window Chrome profile dir — process-isolation key AND the stale-reap token (POL-18). */
export function chromeWindowDataDir(
  windowId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const base = env.XDG_RUNTIME_DIR?.trim() || "/tmp";
  return `${base}/polyptic-chrome-win-${sanitizeConnector(windowId)}`;
}

/**
 * Build Chrome's argv for one placed web-window (POL-18). Same kiosk hygiene as the player's
 * instance, but NO `--kiosk`: this window must stay a floating, positionable surface — sway sizes
 * and moves it; fullscreening it would cover the whole output.
 */
export function buildChromeWindowArgs(
  spec: ChromeWindowSpec,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  // The SAME GPU/native-Wayland base as the player (POL-146): a placed window that software-rendered
  // while the player ran on the GPU would come up black on real amdgpu — the two must never diverge
  // on the flags that decide GPU vs software render, which is why both build from chromeBaseArgs.
  const args = chromeBaseArgs(spec.url, chromeWindowDataDir(spec.windowId, env), spec.devtoolsPort);
  const extra = env.POLYPTIC_BROWSER_ARGS?.trim();
  if (extra) args.push(...extra.split(/\s+/).filter(Boolean));
  return args;
}

/** Pre-launch hygiene for one placed window: reap an orphan holding its unique data dir (POL-18). */
export async function prelaunchChromeWindow(
  windowId: string,
  log: (m: string) => void,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await killStaleByToken(chromeWindowDataDir(windowId, env), log);
}

/** The player URL's origin when (and only when) it is plain `http:` — the one origin the kiosk may
 *  treat as secure so service workers (POL-132) work on an HTTP control plane. `https:` origins are
 *  already secure; an unparseable URL yields null (no flag — never guess a security exemption). */
export function insecurePlayerOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** Does a compositor window's `app_id` / WM class look like our Chrome? Under native Wayland an
 *  `--app=` window reports app_id like "chrome-<origin>__-Default" (or "google-chrome"). */
export function matchesChromeWindow(appId: string): boolean {
  return /chrom/i.test(appId);
}

/**
 * Pre-launch hygiene for one output: reap any Chrome we don't track that still holds this output's
 * unique `--user-data-dir` (an orphan from an agent crash). Without this the orphan owns the profile
 * lock and a fresh launch dedupes into it — a browser nobody supervises.
 */
export async function prelaunchChrome(
  connector: string,
  log: (m: string) => void,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await killStaleByToken(chromeDataDir(connector, env), log);
}

/**
 * Which kiosk browser this box drives: `POLYPTIC_BROWSER` (chrome | surf) wins; otherwise Chrome
 * when any candidate is on PATH, else surf. Reported on `agent/hello` (drives the console's
 * Inspect-vs-DevTools affordance) and used by the sway backend to pick its launcher — the two MUST
 * agree, which is why this is the one shared decision point.
 */
export async function selectKioskBrowser(
  env: NodeJS.ProcessEnv = process.env,
): Promise<KioskBrowser> {
  const forced = env.POLYPTIC_BROWSER?.trim();
  if (forced === "chrome" || forced === "surf") return forced;
  if (forced) {
    throw new Error(`Unknown POLYPTIC_BROWSER="${forced}" (expected: chrome | surf)`);
  }
  const override = env.POLYPTIC_CHROME?.trim();
  const candidates = override ? [override] : [...CHROME_CANDIDATES];
  for (const c of candidates) {
    if (await which(c, env)) return "chrome";
  }
  return "surf";
}

/** Re-exported so callers picking between the two browsers see both candidate sets in one place. */
export { SURF_CANDIDATES };
