import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// Read our own version at config time so the idle splash can stamp the build (see IdleSplash.vue).
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"));

// The player is the headless page shown fullscreen on each wall screen.
// Dev server is pinned to 5173 (the SERVER advertises PLAYER_BASE_URL=http://localhost:5173).
export default defineConfig(({ command }) => ({
  // The single-image deploy serves the player under /player/ (see server/src/spa.ts), so a PRODUCTION
  // build must emit asset URLs rooted there. With the default "/" base the built index.html asks for
  // /assets/<hash>.js, which collides with the CONSOLE's /assets/ and 404s — a white wall screen.
  // (Found live: a box showed the console's login page, then nothing.) The dev server keeps "/" so
  // `bun run dev` still serves the player at http://localhost:5173/.
  base: command === "build" ? "/player/" : "/",
  plugins: [vue()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
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
