/**
 * dev-open — the development DisplayBackend.
 *
 * No compositor required: it just opens the player URL in the host's default browser
 * (`open` on macOS, `xdg-open` on Linux), so the Phase 1 vertical slice runs on any dev
 * machine. Content still arrives instantly over the player WS channel; this backend only
 * gets the player page on screen once.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DisplayBackend } from "./types";

const run = promisify(execFile);

export class DevOpenBackend implements DisplayBackend {
  readonly id = "dev-open" as const;

  async discoverOutputs(): Promise<string[] | null> {
    // No compositor to interrogate in dev; the agent advertises the configured/default connector.
    return null;
  }

  async showScreen(connector: string, url: string): Promise<void> {
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
    console.log(`[dev-open] hideScreen(${connector}) — no-op in dev`);
  }

  async ident(on: boolean): Promise<void> {
    // No compositor overlay available in dev; the player-side ident pulse covers the demo.
    console.log(`[dev-open] ident ${on ? "on" : "off"} — no-op in dev`);
  }

  async capture(): Promise<Buffer | null> {
    // No screenshot facility without a compositor (grim/grim-equivalent lands in Phase 5).
    return null;
  }
}
