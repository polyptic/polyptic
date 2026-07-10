/**
 * DisplayBackend — the seam between the (generic) agent reconciler and however a given
 * host actually puts a browser/window on a physical output.
 *
 * Phase 1 ships only `dev-open` (opens the player URL in the host's default browser, so the
 * whole system runs on any laptop with no compositor). `wayland-sway` and `x11-i3` are the
 * real placement backends — interface-conformant stubs here, implemented in Phase 4.
 *
 * The agent stays unprivileged and dumb: it never decides *what* to show (the control plane
 * does that and pushes content straight to the player), only *where* a player lives.
 */
import type { DisplayBackend as BackendId } from "@polyptic/protocol";

export interface DisplayBackend {
  /** Which `DisplayBackend` enum value this implementation reports in `agent/hello`. */
  readonly id: BackendId;

  /**
   * Ask the compositor for its REAL output/connector names (the agent sits right next to it), so a
   * machine self-describes its screens and an operator never hand-configures connector names.
   * Returns the live names (e.g. sway `get_outputs`, xrandr connected+active), or `null` when this
   * backend has no compositor to ask (dev-open) or the query is unavailable/errors. An empty array
   * means "asked, none yet" (caller may retry while the compositor warms up).
   */
  discoverOutputs(): Promise<string[] | null>;

  /** Place/point a player at `url` on the given output `connector`. Idempotent per (connector,url). */
  showScreen(connector: string, url: string): Promise<void>;

  /** Tear down whatever `showScreen` placed on `connector`. */
  hideScreen(connector: string): Promise<void>;

  /** Toggle an operator "which panel is this?" overlay across the host's outputs. */
  ident(on: boolean): Promise<void>;

  /**
   * Show/hide the browser's Web Inspector ON the panel driven by `connector` (POL-50) — the only
   * way to see a wall's console/network, since WebKitGTK exposes no browser-openable remote
   * inspector (D63). Relaunches that output's browser, so the page reloads. Throws when the
   * connector has nothing placed on it, or when this backend has no inspector to show.
   */
  inspect(connector: string, on: boolean): Promise<void>;

  /** Grab a thumbnail of `connector`, or `null` if this backend can't capture. */
  capture(connector: string): Promise<Buffer | null>;
}
