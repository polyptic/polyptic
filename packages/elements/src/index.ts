/**
 * @polyptic/elements — the shared page-element renderers (POL-42).
 *
 * One set of Vue components used by BOTH the player (the wall) and the console's Studio canvas, so
 * the editing preview and the wall render can never drift: the canvas IS the renderer.
 */
export { default as PageCanvas } from "./PageCanvas.vue";
export { default as PageElementView } from "./PageElementView.vue";
export { ELEMENT_LIBRARY, defaultElement, libraryEntry } from "./library";
export type { ElementLibraryEntry } from "./library";
export { formatAge, formatClock, formatCountdown, useNow } from "./clock";
export { qrSvgPath, qrModuleCount } from "./qr";
export { embedZoomStyle, feedFontSizes } from "./style";
