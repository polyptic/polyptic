/// <reference types="vite/client" />

// Single-file-component shim so the type-checker (and editors) understand `*.vue` imports.
declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}
