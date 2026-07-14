/**
 * cast — the AirPlay receiver's launch mechanics (POL-119).
 *
 * The receiver is UxPlay (GPLv3, GStreamer, Ubuntu universe): one supervised instance per
 * cast-enabled connector, advertised over mDNS under the screen's friendly name. Everything here is
 * a pure argv/derivation helper; supervision reuses `SupervisedProcess` and window placement stays
 * in the sway backend (a receiver window appears at SENDER-CONNECT time — and the PIN prompt is a
 * window too — so casting needs the persistent watch, not launch-time `waitForWindow`).
 *
 * Non-negotiables baked into the argv (the pitch's no-gos):
 *   - PIN mode is ALWAYS on (`-pin`): a new device must type the code shown on the wall itself —
 *     proof of physical presence. There is no PIN-less code path.
 *   - Video only (`-as 0`): walls are silent by design; the box ships no audio server.
 *   - `waylandsink` natively — never an Xwayland sink (POL-67: Xwayland software paths peg the CPU).
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { which } from "./proc";

/**
 * Base of the per-connector port range. 7100 is UxPlay's own legacy default; each instance takes
 * three consecutive TCP+UDP ports from its base, and the stride leaves headroom so instances on the
 * same box can never overlap (assigned in arrival order, like the DevTools ports, POL-67).
 */
export const CAST_PORT_BASE = 7100;
export const CAST_PORT_STRIDE = 8;

/** What one connector's receiver should be. A change to any field forces a relaunch (mDNS renames
 *  ride a fresh apply, so a console rename restarts that receiver under the new name). */
export interface CastTarget {
  /** The screen's friendly name — what the Screen Mirroring menu shows. */
  name: string;
}

export function sameCastTarget(a: CastTarget | null, b: CastTarget | null): boolean {
  if (a === null || b === null) return a === b;
  return a.name === b.name;
}

/** Where this connector's PIN registrations persist, so a returning presenter doesn't re-enter a
 *  PIN every meeting. Under the kiosk user's state dir; on a RAM-booted box this simply resets on
 *  reboot — the accepted fallback (PIN on next connection), never a security hole. */
export function castRegFileFor(connector: string, env: NodeJS.ProcessEnv = process.env): string {
  const state = env.XDG_STATE_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".local", "state");
  const safe = connector.replace(/[^A-Za-z0-9_.-]/g, "_") || "output";
  return join(state, "polyptic", `uxplay-reg-${safe}`);
}

/**
 * A stable, locally-administered MAC for one receiver instance. UxPlay derives its AirPlay device
 * id from the host MAC, so two instances on one box would otherwise collide and senders would see
 * one flickering device instead of two screens. Deterministic (FNV-1a over the seed) rather than
 * random so a respawned receiver keeps its identity — and with it its PIN registrations.
 */
export function castDeviceMac(seed: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const bytes: number[] = [];
  for (let i = 0; i < 5; i++) {
    bytes.push(h & 0xff);
    h = (Math.imul(h, 0x01000193) ^ (h >>> 13)) >>> 0;
  }
  // 0x02 = locally administered, unicast — never collides with real hardware.
  return ["02", ...bytes.map((b) => b.toString(16).padStart(2, "0"))].join(":");
}

/** Build the UxPlay argv for one connector's receiver. Pure — pinned by tests. */
export function buildUxplayArgs(opts: {
  name: string;
  basePort: number;
  regFile: string;
  mac: string;
}): string[] {
  return [
    "-n", opts.name,
    "-nh", // the friendly name IS the advertisement — no "@hostname" suffix
    "-p", String(opts.basePort), // fixed base port: instances on one box must not collide
    "-m", opts.mac, // stable per-connector device id (see castDeviceMac)
    "-pin", // ALWAYS-on on-screen PIN — no PIN-less mode, per the pitch's no-gos
    "-reg", opts.regFile, // remember PIN-verified devices across sessions
    "-as", "0", // video only: walls are silent by design
    "-vs", "waylandsink", // native Wayland — never an Xwayland sink (POL-67)
    "-fs", // fullscreen hint; sway's move-to-output re-asserts it on the right connector
  ];
}

/** Does a compositor window's `app_id` / WM class look like our receiver? UxPlay's GStreamer
 *  window reports "uxplay" (older builds: a bare GStreamer id). Fallback only — pid is primary. */
export function matchesUxplayWindow(appId: string): boolean {
  return /uxplay/i.test(appId);
}

/** Assert the uxplay binary is present, with a remediation hint pointing at the image setup. */
export async function resolveUxplay(): Promise<string> {
  if (!(await which("uxplay"))) {
    throw new Error(
      "uxplay not found — casting needs the uxplay/avahi/gstreamer packages " +
        "(re-run `polyptic-agent setup`, or update the box image)",
    );
  }
  return "uxplay";
}

/** Ensure the registration file's directory exists (the state dir is absent on a fresh RAM boot). */
export function ensureCastStateDir(regFile: string): void {
  mkdirSync(dirname(regFile), { recursive: true });
}
