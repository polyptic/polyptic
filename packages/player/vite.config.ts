import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// The player is the headless page shown fullscreen on each wall screen.
// Dev server is pinned to 5173 (the SERVER advertises PLAYER_BASE_URL=http://localhost:5173).
export default defineConfig({
  plugins: [vue()],
  server: {
    // Bind 0.0.0.0 so a remote display/agent (a wall box on the LAN) can reach the dev player.
    // Pair with PLAYER_BASE_URL=http://<this-host>:5173 on the server so the agent advertises a
    // reachable URL, not localhost. (In the single-image deploy the player is served same-origin.)
    host: true,
    port: 5173,
    strictPort: true,
  },
});
