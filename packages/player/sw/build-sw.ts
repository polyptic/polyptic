/**
 * POL-132 — generate the player's shell service worker at build time.
 *
 * The worker must know EXACTLY which files make up this build (Vite emits content-hashed asset
 * names), so vite.config.ts calls `buildShellSw` from its `generateBundle` hook with the emitted
 * file list and stamps the result out as `dist/sw.js`. The worker source itself lives in
 * `shell-sw.js` (static, reviewable); this module only prepends the build's config object.
 *
 * The cache name embeds the version AND a fingerprint of the precache list, so:
 *   - any change to the build (new asset hashes, new version tag) yields a byte-different sw.js →
 *     the browser installs it as an update → the page swaps at its next safe moment (D107 version
 *     discipline: a wall is never pinned to an old shell past the next successful server contact);
 *   - two identical builds yield an identical sw.js → no spurious update churn.
 */
import { readFileSync } from "node:fs";

export interface ShellSwConfig {
  /** Build version (POLYPTIC_VERSION at image build; package.json's 0.0.0 as the dev fallback). */
  version: string;
  /** The player page URL the navigation cache key uses — Vite's `base`, e.g. "/player/". */
  shellUrl: string;
  /** Every path this build may serve from cache: the shell plus its hashed assets. */
  precache: string[];
}

/** djb2 (xor variant) — a stable, dependency-free fingerprint for the cache name. */
export function fingerprint(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash * 33) ^ input.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

/** The cache name for one build: prefix (activate() sweeps on it) + version + content fingerprint. */
export function shellCacheName(config: ShellSwConfig): string {
  return `polyptic-player-shell-${config.version}-${fingerprint(JSON.stringify([config.shellUrl, ...config.precache]))}`;
}

/** Render the complete sw.js for one build: the config header + the static worker template. */
export function buildShellSw(config: ShellSwConfig): string {
  const template = readFileSync(new URL("./shell-sw.js", import.meta.url), "utf-8");
  const header = `self.__POLYPTIC_SW__ = ${JSON.stringify({ ...config, cacheName: shellCacheName(config) })};\n`;
  return header + template;
}
