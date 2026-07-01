/// <reference types="vite/client" />

// Injected by Vite `define` (vite.config.ts) — the player's package.json version, shown on the idle splash.
declare const __APP_VERSION__: string;

// Single-file-component shim so the type-checker (and editors) understand `*.vue` imports.
declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}
