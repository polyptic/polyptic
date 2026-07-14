/**
 * POL-97 — the overlay layer's two policies, pulled out of Player.vue so they can be pinned by tests
 * without a DOM.
 *
 * 1. WHAT GETS PROBED. The POL-86 prober proves a URL reachable before the player paints it. It
 *    probes CONTENT surfaces only — and the overlay is not a surface: it rides its own slice field,
 *    so it can never enter the probe set, exactly as a `page` surface never does. That is deliberate,
 *    and it is the same reasoning: a page (and so an overlay) renders LOCALLY — text, clocks, shapes,
 *    a ticker need no network at all — and the embeds inside it arrive with send-time-resolved data
 *    and paint their own calm placeholders. Gating the whole layer on a probe would mean a corner
 *    logo vanished because some feed was slow, which is precisely the failure the overlay exists to
 *    survive. `probeableSurfaces` is the ONE definition of the probe set, and it never sees an overlay.
 *
 * 2. WHERE IT DRAWS. With no span the layer fills the screen. With one (an overlay resolved from a
 *    scope WIDER than the screen, on a video-wall member) it takes the same span treatment a spanning
 *    surface gets — sized to the whole wall, shifted to this panel's window onto it — so a corner logo
 *    lands once, in the WALL's corner. It reuses the content path's span helper: one implementation of
 *    the span math on the client, as there is one on the server.
 */
import type { CSSProperties } from "vue";
import type { SliceOverlay, Surface } from "@polyptic/protocol";

import { contentStyle } from "./surface-style";

/** The surfaces the POL-86 prober must prove before they paint: everything that fetches ONE url.
 *  Playlists (their rotator owns its entries) and pages (local render, send-time data) are excluded —
 *  and an overlay, not being a surface, is structurally incapable of appearing here at all. */
export function probeableSurfaces(surfaces: readonly Surface[]): Surface[] {
  return surfaces.filter((s) => s.type !== "playlist" && s.type !== "page");
}

/** The overlay layer's content box: the screen, or (with a span) this panel's window onto the wall. */
export function overlayStyle(overlay: SliceOverlay): CSSProperties {
  return contentStyle(overlay.span, 1);
}
