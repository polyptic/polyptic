/**
 * browser — a tiny indirection so the wayland-sway / x11-i3 backends can drive EITHER a kiosk
 * Chromium (the default) or cog (WPE/WebKit) without caring which.
 *
 * Chromium stays the default everywhere; cog is purely opt-in via `POLYPTIC_BROWSER=cog` (set from
 * agent.toml `browser = "cog"` / `polyptic-agent setup --browser cog`). On Ubuntu/arm64 there is no
 * real `.deb` Chromium (only the confined snap), so cog is the kiosk browser there (D27).
 *
 * Both backends keep their pid-based placement + `SupervisedChromium` supervision unchanged; only
 * the four things that actually differ — which binary, which argv, which window `app_id`, what
 * prelaunch hygiene — live behind this interface.
 */
import type { ChromiumLaunchSpec } from "./chromium";
import {
  buildChromiumArgs,
  ensureDir,
  killStaleByToken,
  killStaleForProfile,
  resetCrashFlags,
  resolveChromium,
} from "./chromium";
import { buildCogArgs, resolveCog } from "./cog";
import { buildSurfArgs, resolveSurf } from "./surf";

export interface Browser {
  /** Stable identity of the backend browser (for logs + selection). */
  readonly name: "chromium" | "cog" | "surf";
  /** Resolve the launch binary (or throw a clear error). */
  resolveBin(env?: NodeJS.ProcessEnv): Promise<string>;
  /** Build the per-output argv from the shared launch spec. */
  buildArgs(spec: ChromiumLaunchSpec): string[];
  /** Pre-launch hygiene for one output: ensure the profile dir + reap stale instances. */
  prelaunch(profileDir: string, url: string, log: (m: string) => void): Promise<void>;
  /** Does a compositor window's `app_id` / WM class look like this browser? */
  matchesWindow(appId: string): boolean;
}

/** The default kiosk Chromium, wrapping the existing chromium.ts helpers. */
export const chromiumBrowser: Browser = {
  name: "chromium",
  resolveBin: (env) => resolveChromium(env),
  buildArgs: (spec) => buildChromiumArgs(spec),
  async prelaunch(profileDir, _url, log) {
    await ensureDir(profileDir);
    await killStaleForProfile(profileDir, log);
    await resetCrashFlags(profileDir, log);
  },
  matchesWindow: (appId) => /chrom|polyptic/i.test(appId),
};

/** cog (WPE/WebKit) — the Ubuntu/arm64 kiosk browser where Chromium is snap-only (D27). */
export const cogBrowser: Browser = {
  name: "cog",
  resolveBin: (env) => resolveCog(env),
  buildArgs: (spec) => buildCogArgs(spec),
  async prelaunch(profileDir, url, log) {
    await ensureDir(profileDir);
    // cog has no `--user-data-dir` token, so key the stale-reap on the unique player URL instead.
    await killStaleByToken(url, log);
    // No crash-flag reset: cog has no Chromium "Restore pages?" Preferences bubble to clear.
  },
  matchesWindow: (appId) => /cog|wpe|webkit/i.test(appId),
};

/** surf (suckless WebKitGTK) — the Ubuntu kiosk browser where Chromium is snap-only + cog isn't packaged (D27). */
export const surfBrowser: Browser = {
  name: "surf",
  resolveBin: (env) => resolveSurf(env),
  buildArgs: (spec) => buildSurfArgs(spec),
  async prelaunch(profileDir, url, log) {
    await ensureDir(profileDir);
    // surf has no `--user-data-dir` token, so key the stale-reap on the unique player URL instead.
    await killStaleByToken(url, log);
    // No crash-flag reset: surf has no Chromium "Restore pages?" Preferences bubble to clear.
  },
  matchesWindow: (appId) => /surf|webkit/i.test(appId),
};

/**
 * Pick the backend browser from the environment. `POLYPTIC_BROWSER=cog` selects cog,
 * `POLYPTIC_BROWSER=surf` selects surf; anything else (including unset) keeps Chromium, so existing
 * setups are unaffected.
 */
export function selectBrowser(env: NodeJS.ProcessEnv = process.env): Browser {
  const choice = env.POLYPTIC_BROWSER?.trim().toLowerCase();
  if (choice === "cog") return cogBrowser;
  if (choice === "surf") return surfBrowser;
  return chromiumBrowser;
}
