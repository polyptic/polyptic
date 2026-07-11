// Single-file-component shim so plain tsc (and editors without Volar) understand `*.vue` imports.
declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}
