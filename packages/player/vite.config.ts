import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import type { Plugin } from "vite";
import vue from "@vitejs/plugin-vue";

import { buildShellSw } from "./sw/build-sw";

// The build version stamped onto the idle splash, the corner badge and every diag line (POL-86).
// `packages/player/package.json` is permanently 0.0.0 — the real version only exists as the git tag,
// which release.yml passes into the image build as POLYPTIC_VERSION (the agent binary reads exactly
// the same value; see agent/src/version.ts). Without this the wall reports `v0.0.0` forever, which is
// worthless precisely when you are staring at a misbehaving screen asking "which build is this?".
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"));
const buildVersion = (process.env.POLYPTIC_VERSION ?? "").trim().replace(/^v/, "") || pkg.version;

/**
 * POL-132 — emit the shell service worker alongside the build. The worker precaches EXACTLY the
 * files Vite emitted (content-hashed names, so the list is only knowable here) and serves them
 * cache-first, which is what lets a wall RELOAD while the control plane is down and still paint.
 * Build-only (`apply: "build"`): the dev server never registers a worker, so `bun run dev` / HMR
 * can never be cache-poisoned. `enforce: "post"` runs after Vite's own html plugin, so the bundle
 * listing is complete when we read it.
 */
function shellServiceWorker(version: string): Plugin {
  let base = "/";
  return {
    name: "polyptic:player-shell-sw",
    apply: "build",
    enforce: "post",
    configResolved(config) {
      base = config.base;
    },
    generateBundle(_options, bundle) {
      // index.html is cached under the navigation URL (`base`) at install; sw.js must never cache
      // itself (the browser's update check must always see the server's copy).
      const files = Object.keys(bundle).filter((f) => f !== "index.html" && f !== "sw.js");
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: buildShellSw({
          version,
          shellUrl: base,
          precache: [base, ...files.map((f) => base + f)],
        }),
      });
    },
  };
}

// The player is the headless page shown fullscreen on each wall screen.
// Dev server is pinned to 5173 (the SERVER advertises PLAYER_BASE_URL=http://localhost:5173).
export default defineConfig(({ command }) => ({
  // The single-image deploy serves the player under /player/ (see server/src/spa.ts), so a PRODUCTION
  // build must emit asset URLs rooted there. With the default "/" base the built index.html asks for
  // /assets/<hash>.js, which collides with the CONSOLE's /assets/ and 404s — a white wall screen.
  // (Found live: a box showed the console's login page, then nothing.) The dev server keeps "/" so
  // `bun run dev` still serves the player at http://localhost:5173/.
  base: command === "build" ? "/player/" : "/",
  plugins: [vue(), shellServiceWorker(buildVersion)],
  define: {
    __APP_VERSION__: JSON.stringify(buildVersion),
  },
  server: {
    // Bind 0.0.0.0 so a remote display/agent (a wall box on the LAN) can reach the dev player.
    // Pair with PLAYER_BASE_URL=http://<this-host>:5173 on the server so the agent advertises a
    // reachable URL, not localhost. (In the single-image deploy the player is served same-origin.)
    host: true,
    port: 5173,
    strictPort: true,
  },
}));
