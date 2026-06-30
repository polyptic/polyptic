/**
 * surf — suckless WebKitGTK kiosk-browser launcher (D27 Ubuntu default).
 *
 * On Ubuntu/arm64 there is no real `.deb` Chromium (only the confined snap, which a kiosk must
 * avoid) and `cog` is NOT packaged — but `surf` (the suckless WebKitGTK browser) IS a real `.deb`.
 * surf is chromeless + fullscreen by nature: `surf <url>` shows one page per process, one process
 * per output — which is all the per-output isolation we need (surf has no Chromium-style
 * `--user-data-dir`; isolation comes from separate processes/pids).
 *
 * The shape deliberately mirrors cog.ts so the two are interchangeable behind the `Browser`
 * abstraction (backends/browser.ts), but it stays minimal + robust: surf takes the URL as a
 * POSITIONAL arg (NOT `--app=`) and none of Chromium's flags apply. This file can't be exercised on
 * the dev host, so it does as little as possible.
 */
import type { ChromiumLaunchSpec } from "./chromium";
import { which } from "./proc";

/** Candidate surf binary names, most-preferred first; `POLYPTIC_SURF` overrides. */
export const SURF_CANDIDATES = ["surf"] as const;

/**
 * Resolve the surf binary (or throw a clear error). `POLYPTIC_SURF` (or the generic
 * `POLYPTIC_BROWSER_BIN`) overrides; else the first candidate on PATH.
 */
export async function resolveSurf(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const override = env.POLYPTIC_SURF?.trim() || env.POLYPTIC_BROWSER_BIN?.trim();
  const candidates = override ? [override] : [...SURF_CANDIDATES];
  for (const c of candidates) {
    if (await which(c)) return c;
  }
  throw new Error(
    "surf (suckless WebKitGTK kiosk browser) not found — `apt install surf`, or set POLYPTIC_SURF; " +
      "it's the .deb kiosk browser on Ubuntu where Chromium is snap-only and cog isn't packaged.",
  );
}

/**
 * Build surf's argv for a given output. surf is chromeless + fullscreen by nature, so this is
 * minimal: any `spec.extra`, then `POLYPTIC_BROWSER_ARGS` (space-split, if set), then the URL
 * **last** (surf takes the URL as a positional arg, NOT `--app=`). No Chromium-only flags, and no
 * `--user-data-dir` (surf has none).
 *
 * No flags: surf is chromeless; sway fullscreens + places it via swaymsg.
 */
export function buildSurfArgs(
  spec: ChromiumLaunchSpec,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const args: string[] = [];
  if (spec.extra && spec.extra.length > 0) args.push(...spec.extra);
  const extra = env.POLYPTIC_BROWSER_ARGS?.trim();
  if (extra) args.push(...extra.split(/\s+/).filter(Boolean));
  args.push(spec.url); // URL is the positional arg, and must come last
  return args;
}
