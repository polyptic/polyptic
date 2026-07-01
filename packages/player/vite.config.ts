import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// Read our own version at config time so the idle splash can stamp the build (see IdleSplash.vue).
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"));

// The player is the headless page shown fullscreen on each wall screen.
// Dev server is pinned to 5173 (the SERVER advertises PLAYER_BASE_URL=http://localhost:5173).
export default defineConfig({
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
});
