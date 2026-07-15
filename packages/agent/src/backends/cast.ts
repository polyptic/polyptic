/**
 * cast — the AirPlay receiver's launch mechanics (POL-119).
 *
 * The receiver is UxPlay (GPLv3, GStreamer, Ubuntu universe): one supervised instance per
 * cast-enabled connector, advertised over mDNS under the screen's friendly name. Everything here is
 * a pure argv/derivation helper; supervision reuses `SupervisedProcess` and window placement stays
 * in the sway backend (a receiver window appears when MIRRORING starts — so casting needs the
 * persistent watch, not launch-time `waitForWindow`). The pairing PIN is NOT a window: UxPlay
 * prints it to stdout only, so the agent parses it there and surfaces it via the player (POL-136,
 * correcting D111's premise — see the PIN section below).
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
    "-pin", // ALWAYS-on pairing PIN (printed to stdout; WE show it on-screen — POL-136)
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

/**
 * Wrap the receiver's spawn so its stdout is LINE-buffered even into a pipe (POL-136 review
 * finding 1). UxPlay's logger is bare `printf` with no `fflush`/`setvbuf` — the only `fflush(NULL)`
 * in its codebase sits in the audio path our `-as 0` disables — so with stdout a pipe, libc
 * block-buffers at ~4 KiB and the PIN lines (a few hundred bytes) can sit unread past the whole
 * pairing window: wall blank AND journal silent, the original bug reproduced one layer down.
 * `stdbuf -oL -eL` (coreutils — Essential on the ubuntu-base image, but VERIFIED at spawn; POL-78
 * taught us to assume nothing) presets line buffering via LD_PRELOAD and then EXECS the receiver,
 * so the spawned pid still IS uxplay: pid-matched window placement and the reg-file cmdline token
 * both keep working. Pure — pinned by tests.
 */
export function wrapLineBuffered(
  bin: string,
  args: string[],
  stdbufAvailable: boolean,
): { cmd: string; argv: string[] } {
  if (!stdbufAvailable) return { cmd: bin, argv: args };
  return { cmd: "stdbuf", argv: ["-oL", "-eL", bin, ...args] };
}

/**
 * Apply one backend PIN event to the agent's connector→PIN ledger (POL-136). Returns true when the
 * ledger CHANGED (the caller sends an immediate status). The subtlety this encodes (review
 * finding 4): a `null` CLEAR must apply even when the connector is no longer castable — teardown
 * orderings can delete the `casting` entry before the receiver's exit event lands, and a swallowed
 * clear would level-report a stale PIN in every heartbeat forever. Only NEW pins are gated on
 * castability.
 */
export function applyCastPinEvent(
  pins: Map<string, string>,
  castable: (connector: string) => boolean,
  connector: string,
  pin: string | null,
): boolean {
  if ((pins.get(connector) ?? null) === pin) return false;
  if (pin === null) {
    pins.delete(connector);
    return true;
  }
  if (!castable(connector)) return false; // receiver retired — never surface a stale pin
  pins.set(connector, pin);
  return true;
}

// ── PIN pairing (POL-136) ─────────────────────────────────────────────────────
//
// D111 assumed "the PIN prompt is a window too". It is not: UxPlay's `display_pin` callback renders
// the PIN as ASCII art on STDOUT (uxplay.cpp, via LOGI) and its raop library logs the value right
// after — no video window exists until MIRRORING starts, which is after pairing. So at PIN time the
// window watch has nothing to place and the phone asks for a number the wall never shows. The agent
// supervises the receiver and owns its stdout, so it learns the PIN from these lines (verbatim
// upstream format strings, pinned by tests):
//
//   client sent PAIR-PIN-START request                          (raop_handlers.h — pairing began)
//   *** CLIENT MUST NOW ENTER PIN = "0417" AS AIRPLAY PASSWORD  (raop_handlers.h — the PIN itself)
//   registered new client: iPhone DeviceID = …                  (uxplay.cpp — pairing succeeded)
//
// and surfaces it on the panel via agent/status → server → player overlay.

/** What one receiver stdout/stderr line means for PIN pairing, or null for everything else. */
export type CastPairingLine =
  | { kind: "pairing-started" }
  | { kind: "pin"; pin: string }
  | { kind: "paired" };

/** Classify one line of UxPlay output. Substring/regex matching (never anchored): the exact logger
 *  prefix varies by level and build, but the format strings themselves are stable upstream. */
export function classifyCastLine(line: string): CastPairingLine | null {
  const pin = /CLIENT MUST NOW ENTER PIN = "(\d+)" AS AIRPLAY PASSWORD/.exec(line);
  if (pin?.[1]) return { kind: "pin", pin: pin[1] };
  if (line.includes("client sent PAIR-PIN-START request")) return { kind: "pairing-started" };
  if (/registered new client:/.test(line)) return { kind: "paired" };
  return null;
}

/** How long after PAIR-PIN-START we wait for the PIN line before declaring, loudly, that the wall
 *  cannot show what the phone is asking for. The two lines are logged back-to-back by the same
 *  handler, so seconds of silence means the output format changed under us. */
export const CAST_PIN_MISSING_MS = 3_000;
/** Backstop: a PIN left on the glass this long with no outcome (paired / window / process exit)
 *  is cleared — a sender that walked away must not strand a four-digit code on the wall. */
export const CAST_PIN_TTL_MS = 120_000;

/** Injectable timer seam so the tracker's timing rules are unit-testable. */
export interface PinTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: PinTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * The PIN lifecycle for ONE connector's receiver: feed it every output line plus the two box-side
 * signals (a receiver window appearing = mirroring started; the process exiting), and it calls
 * `onPinChange` with the PIN the panel must show right now, or null to clear it — only on change.
 * `onPinMissing` fires when a pairing started but no PIN could be learned: the exact silent failure
 * this exists to make LOUD.
 */
export class CastPairingTracker {
  private pin: string | null = null;
  private missingTimer: unknown = null;
  private ttlTimer: unknown = null;

  constructor(
    private readonly cb: {
      onPinChange: (pin: string | null) => void;
      onPinMissing: () => void;
    },
    private readonly timers: PinTimers = realTimers,
  ) {}

  onLine(line: string): void {
    const ev = classifyCastLine(line);
    if (!ev) return;
    if (ev.kind === "pairing-started") {
      // Expect the PIN line momentarily; a fresh pairing attempt re-arms the check.
      this.clearMissingTimer();
      this.missingTimer = this.timers.set(() => {
        this.missingTimer = null;
        if (this.pin === null) this.cb.onPinMissing();
      }, CAST_PIN_MISSING_MS);
    } else if (ev.kind === "pin") {
      this.clearMissingTimer();
      this.setPin(ev.pin);
    } else {
      // paired — the phone took the PIN; the mirror window follows on its own.
      this.setPin(null);
    }
  }

  /** A receiver window appeared: mirroring is starting, the pairing phase is over. */
  windowAppeared(): void {
    this.setPin(null);
  }

  /** The receiver process ended (exit or teardown): whatever it was pairing died with it. */
  processEnded(): void {
    this.clearMissingTimer();
    this.setPin(null);
  }

  private setPin(pin: string | null): void {
    if (this.ttlTimer !== null) {
      this.timers.clear(this.ttlTimer);
      this.ttlTimer = null;
    }
    if (pin !== null) {
      this.ttlTimer = this.timers.set(() => {
        this.ttlTimer = null;
        this.setPin(null);
      }, CAST_PIN_TTL_MS);
    }
    if (this.pin === pin) return;
    this.pin = pin;
    this.cb.onPinChange(pin);
  }

  private clearMissingTimer(): void {
    if (this.missingTimer !== null) {
      this.timers.clear(this.missingTimer);
      this.missingTimer = null;
    }
  }
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
