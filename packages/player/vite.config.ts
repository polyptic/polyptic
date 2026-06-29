import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// The player is the headless page shown fullscreen on each wall screen.
// Dev server is pinned to 5173 (the SERVER advertises PLAYER_BASE_URL=http://localhost:5173).
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    strictPort: true,
  },
});
