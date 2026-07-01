/**
 * OTA (POL-28) — the PRODUCTION side-effect seam for {@link OtaSys}: the real network, checksum,
 * reboot and clock. Kept apart from ota.ts (which is pure filesystem + logic, unit-tested against a
 * temp dir) so tests can inject a fake seam.
 *
 * Reboot is the one privileged action in the whole OTA path (the slot swaps are all unprivileged in a
 * kiosk-writable tree). We try a short sequence — `sudo -n systemctl reboot` (the narrow NOPASSWD
 * rule setup installs), then a bare `systemctl reboot` (works when the active local session is allowed
 * to reboot via polkit), then `sudo -n reboot` / `reboot` — and issue the first that the box accepts.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { spawnSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

import type { OtaSys } from "./ota";

/** Derive the server's HTTP origin from the agent WS URL (ws→http, wss→https, drop the /agent path). */
export function httpBaseFromServerUrl(serverUrl: string): string {
  try {
    const u = new URL(serverUrl);
    const scheme = u.protocol === "wss:" ? "https:" : u.protocol === "ws:" ? "http:" : u.protocol;
    return `${scheme}//${u.host}`;
  } catch {
    // Best-effort string fallback for a non-URL value.
    return serverUrl.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://").replace(/\/agent\/?$/, "");
  }
}

/** The depot URL the box downloads its arch's binary from. */
export function agentDownloadUrl(base: string, arch: string): string {
  return `${base.replace(/\/+$/, "")}/dist/agent/${arch}`;
}

type Logger = (msg: string) => void;

/** Build the real OtaSys. `log` surfaces the reboot attempts. */
export function createOtaSys(log: Logger = () => {}): OtaSys {
  return {
    now: () => Date.now(),

    async download(url: string, dest: string): Promise<void> {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
      if (!res.body) throw new Error(`empty body from ${url}`);
      // Stream to disk so a ~100MB binary never has to sit fully in memory.
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
    },

    async sha256(path: string): Promise<string> {
      const hash = createHash("sha256");
      await pipeline(createReadStream(path), hash);
      return hash.digest("hex");
    },

    reboot(): void {
      const attempts: Array<[string, string[]]> = [
        ["sudo", ["-n", "systemctl", "reboot"]],
        ["systemctl", ["reboot"]],
        ["sudo", ["-n", "reboot"]],
        ["reboot", []],
      ];
      for (const [cmd, args] of attempts) {
        try {
          const r = spawnSync(cmd, args, { stdio: "ignore" });
          if (r.status === 0) {
            log(`reboot issued via '${cmd} ${args.join(" ")}'`);
            return;
          }
        } catch {
          // try the next form
        }
      }
      log(
        "ERROR: could not reboot to apply the update (no working reboot path). The new slot is staged; " +
          "the box will apply it on its next reboot, or the rollback guard will revert if it never commits.",
      );
    },
  };
}
