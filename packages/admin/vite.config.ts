import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// The admin UI is the operator-facing console (registry view, rename, ident).
// Dev server is pinned to 5174 so it never collides with the player (5173) or server (8080).
export default defineConfig({
  plugins: [solid()],
  server: {
    port: 5174,
    strictPort: true,
  },
});
