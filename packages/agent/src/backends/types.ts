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
import type {
  DisplayBackend as BackendId,
  PanelPowerMethod,
  PowerCapabilities,
} from "@polyptic/protocol";

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
   * Enable/disable inspection of the page on the panel driven by `connector`. Browser-dependent
   * (POL-50 / POL-67): with Chrome this ARMS the remote DevTools tunnel for that output (nothing on
   * the glass changes); with surf it pops the Web Inspector ON the panel, which relaunches that
   * output's browser and reloads the page (WebKitGTK exposes no tunnel-able remote inspector, D63).
   * Throws when the connector has nothing placed on it, or when this backend has no inspector.
   */
  inspect(connector: string, on: boolean): Promise<void>;

  /**
   * The loopback DevTools endpoint for `connector`, or `null` unless ALL of: this backend drives
   * Chrome, that output's browser is running, and an operator has ARMED it via `inspect(…, true)`
   * (POL-67). The agent refuses to proxy `server/devtools-*` frames whenever this is null — defense
   * in depth under the server's own gate.
   */
  devtoolsEndpoint(connector: string): { port: number } | null;

  /**
   * POL-101 — what this box can do about panel power, probed once at startup and reported on hello:
   * DPMS on any real compositor, CEC only where an adapter is present. `dev-open` reports neither.
   */
  powerCapabilities(): Promise<PowerCapabilities>;

  /**
   * POL-101 — sleep (`on: false`) or wake (`on: true`) the panel driven by `connector`, returning the
   * rungs that were actually applied (`["dpms"]`, or `["dpms","cec"]` on a box with a CEC adapter).
   *
   * ONLY ever called for an explicit operator action or a panel-hours boundary the operator set —
   * never on idleness. The player underneath is left running, so waking puts the existing content back
   * on the glass with no reload. Throws when the panel could not be powered (a dev backend, no
   * compositor, a connector nothing is placed on), and the reason reaches the operator on the ack.
   */
  setPower(connector: string, on: boolean): Promise<PanelPowerMethod[]>;

  /** Grab a thumbnail of `connector`, or `null` if this backend can't capture. */
  capture(connector: string): Promise<Buffer | null>;
}
