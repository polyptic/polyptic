/**
 * surf — the kiosk browser, and the only one Polyptic ships (D63).
 *
 * The suckless WebKitGTK browser: a real `.deb` in Ubuntu's main archive, chromeless and fullscreen
 * by nature. `surf <url>` shows one page per process, one process per output — which is all the
 * per-output isolation we need (isolation comes from separate processes/pids). It takes the URL as a
 * POSITIONAL argument, and it is an X11 (WebKitGTK/Xlib) client, so under the wayland-sway backend it
 * renders through XWayland.
 */
import { which } from "./proc";
import { killStaleByToken } from "./supervise";

/** Candidate surf binary names, most-preferred first; `POLYPTIC_SURF` overrides. */
export const SURF_CANDIDATES = ["surf"] as const;

/** What one surf launch needs. Position/size/scale are absent by design: surf has no such flags —
 *  the compositor (sway) or the window manager (i3/EWMH) places and fullscreens it. */
export interface SurfLaunchSpec {
  /** Player URL (already carrying `?screen=<id>`). Passed as surf's positional argument. */
  url: string;
  /** Enable surf's Web Inspector (`-N`), so the agent can pop it on the wall (POL-50). */
  inspector?: boolean;
  /** Any extra flags (escape hatch, e.g. a lab-only surf option). */
  extra?: string[];
}

/**
 * Resolve the surf binary (or throw a clear error). `POLYPTIC_SURF` overrides; else the first
 * candidate on PATH.
 */
export async function resolveSurf(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const override = env.POLYPTIC_SURF?.trim();
  const candidates = override ? [override] : [...SURF_CANDIDATES];
  for (const c of candidates) {
    if (await which(c)) return c;
  }
  throw new Error(
    `no surf binary found (tried: ${candidates.join(", ")}) — \`apt install surf\`, or set ` +
      `POLYPTIC_SURF to the browser path.`,
  );
}

/**
 * Build surf's argv for one output.
 *
 * Order matters: flags first, then `POLYPTIC_BROWSER_ARGS` (space-split, if set), then the URL
 * **last** — surf takes the URL as a positional argument, not `--app=`.
 *
 * `-N` enables the Web Inspector. It is OFF unless the control plane asks for it: a wall is a sealed
 * kiosk, and developer extras must not be one stray keypress away by default. Turning it on means
 * relaunching this output's surf (see SupervisedBrowser.setInspector), because surf can only be
 * given the inspector at launch.
 */
export function buildSurfArgs(
  spec: SurfLaunchSpec,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const args: string[] = [];
  if (spec.inspector) args.push("-N");
  if (spec.extra && spec.extra.length > 0) args.push(...spec.extra);
  const extra = env.POLYPTIC_BROWSER_ARGS?.trim();
  if (extra) args.push(...extra.split(/\s+/).filter(Boolean));
  args.push(spec.url); // URL is the positional arg, and must come last
  return args;
}

/** Does a compositor window's `app_id` / WM class look like surf? */
export function matchesSurfWindow(appId: string): boolean {
  return /surf|webkit/i.test(appId);
}

/**
 * Pre-launch hygiene for one output: reap any surf we don't track that is already showing this
 * player URL (an orphan from an agent crash). surf has no `--user-data-dir` token, so the unique
 * player URL is what we key the reap on.
 */
export async function prelaunchSurf(url: string, log: (m: string) => void): Promise<void> {
  await killStaleByToken(url, log);
}
