/**
 * dev-open — the development DisplayBackend.
 *
 * No compositor required. By default it just LOGS the player URL for each screen (content still
 * arrives live over the player WS channel — nothing here drives it). It can also open the URL in the
 * host browser (`open` on macOS, `xdg-open` on Linux) for the zero-config Phase-1 demo, but that is
 * OPT-IN via `POLYPTIC_DEV_OPEN=1`: auto-opening on every (re)placement steals window focus and is
 * pure noise when you're running the dev stack to work on the server/console.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DisplayBackend } from "./types";

const run = promisify(execFile);

/** Auto-open the player in the host browser? Off unless POLYPTIC_DEV_OPEN is explicitly truthy. */
function autoOpenEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.POLYPTIC_DEV_OPEN?.trim() ?? "");
}

export class DevOpenBackend implements DisplayBackend {
  readonly id = "dev-open" as const;

  // Last URL surfaced per connector. A reconcile that doesn't change a screen's URL must never
  // re-open it (content flips travel over the player WS, not by changing this URL), so we dedupe.
  private readonly shown = new Map<string, string>();

  async discoverOutputs(): Promise<string[] | null> {
    // No compositor to interrogate in dev; the agent advertises the configured/default connector.
    return null;
  }

  async showScreen(connector: string, url: string): Promise<void> {
    if (this.shown.get(connector) === url) return; // unchanged — never re-open / re-log
    this.shown.set(connector, url);

    if (!autoOpenEnabled()) {
      console.log(
        `[dev-open] player for ${connector} → ${url} (auto-open off; set POLYPTIC_DEV_OPEN=1 to open it)`,
      );
      return;
    }

    const opener =
      process.platform === "darwin"
        ? "open"
        : process.platform === "linux"
          ? "xdg-open"
          : null;
    if (!opener) {
      throw new Error(`dev-open backend has no URL opener for platform "${process.platform}"`);
    }
    await run(opener, [url]);
    console.log(`[dev-open] opened player for ${connector} → ${url}`);
  }

  async hideScreen(connector: string): Promise<void> {
    // The host's default browser is not ours to drive; nothing to tear down in dev.
    this.shown.delete(connector);
    console.log(`[dev-open] hideScreen(${connector}) — no-op in dev`);
  }

  async ident(on: boolean): Promise<void> {
    // No compositor overlay available in dev; the player-side ident pulse covers the demo.
    console.log(`[dev-open] ident ${on ? "on" : "off"} — no-op in dev`);
  }

  /**
   * The host's default browser is not ours to drive, so there is no inspector to pop. Throw rather
   * than log-and-succeed: the console shows this as a refusal, which is the truth — and on a dev
   * box the operator already has their own dev tools one keystroke away.
   */
  async inspect(connector: string, on: boolean): Promise<void> {
    throw new Error(
      `the dev-open backend cannot show an inspector on ${connector} ` +
        `(it does not own the browser) — open your own dev tools on the player tab instead`,
    );
  }

  /** dev-open does not own its browser — never a DevTools port to tunnel to. */
  devtoolsEndpoint(): { port: number } | null {
    return null;
  }

  async capture(): Promise<Buffer | null> {
    // No screenshot facility without a compositor (grim/grim-equivalent lands in Phase 5).
    return null;
  }

  /** POL-119 — no compositor, no receiver window to place: refuse to enable (the console shows the
   *  reason); disabling (`null`) is always a safe no-op. */
  async setCast(connector: string, spec: { name: string } | null): Promise<void> {
    if (spec === null) return;
    throw new Error(`the dev-open backend cannot run a cast receiver on ${connector}`);
  }

  onCastSession(): void {
    // Never fires: no receiver can run here.
  }

  onCastPin(): void {
    // Never fires: no receiver can run here (POL-136).
  }
}
