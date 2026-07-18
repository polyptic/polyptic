/**
 * POL-119 — the cast receiver's launch mechanics: argv pinning (the pitch's no-gos are FLAGS here,
 * so they get pinned), the deterministic per-connector device id, and the registration-file path.
 */
import { describe, expect, test } from "bun:test";

import {
  CAST_PORT_BASE,
  CAST_PORT_STRIDE,
  buildUxplayArgs,
  castDeviceMac,
  castRegFileFor,
  matchesUxplayWindow,
  sameCastTarget,
} from "../src/backends/cast";

const ARGS = buildUxplayArgs({
  name: "Boardroom Left",
  basePort: CAST_PORT_BASE,
  regFile: "/home/kiosk/.local/state/polyptic/uxplay-reg-DP-1",
  mac: "02:aa:bb:cc:dd:ee",
});

function valueOf(flag: string): string | undefined {
  const i = ARGS.indexOf(flag);
  return i >= 0 ? ARGS[i + 1] : undefined;
}

describe("buildUxplayArgs — the pitch's no-gos are argv, so they are pinned (POL-119)", () => {
  test("advertises the friendly name verbatim, without the hostname suffix", () => {
    expect(valueOf("-n")).toBe("Boardroom Left");
    expect(ARGS).toContain("-nh");
  });

  test("PIN mode is ALWAYS on — there is no PIN-less code path", () => {
    expect(ARGS).toContain("-pin");
  });

  test("PIN registrations persist to the connector's reg file", () => {
    expect(valueOf("-reg")).toBe("/home/kiosk/.local/state/polyptic/uxplay-reg-DP-1");
  });

  test("video only: the audio sink is disabled (walls are silent by design)", () => {
    expect(valueOf("-as")).toBe("0");
  });

  test("renders via waylandsink natively — never an Xwayland sink (POL-67)", () => {
    expect(valueOf("-vs")).toBe("waylandsink");
    expect(ARGS).toContain("-fs");
  });

  test("takes a fixed base port so multiple instances on one box never collide", () => {
    expect(valueOf("-p")).toBe(String(CAST_PORT_BASE));
    // UxPlay claims base..base+2; the stride must leave room for that plus headroom.
    expect(CAST_PORT_STRIDE).toBeGreaterThan(2);
  });

  test("pins the per-instance device id", () => {
    expect(valueOf("-m")).toBe("02:aa:bb:cc:dd:ee");
  });
});

describe("castDeviceMac — stable per-connector receiver identity", () => {
  test("deterministic: same seed, same MAC (a respawn keeps its registrations)", () => {
    expect(castDeviceMac("box:DP-1")).toBe(castDeviceMac("box:DP-1"));
  });

  test("distinct per connector: two receivers on one box never collide", () => {
    expect(castDeviceMac("box:DP-1")).not.toBe(castDeviceMac("box:DP-2"));
  });

  test("locally administered unicast (02:…), valid MAC shape", () => {
    const mac = castDeviceMac("anything");
    expect(mac).toMatch(/^02(:[0-9a-f]{2}){5}$/);
  });
});

describe("castRegFileFor — the registration file path", () => {
  test("lives under XDG_STATE_HOME when set, with the connector sanitized", () => {
    const p = castRegFileFor("DP 1/weird", { XDG_STATE_HOME: "/var/state", HOME: "/home/k" });
    expect(p).toBe("/var/state/polyptic/uxplay-reg-DP_1_weird");
  });

  test("falls back to ~/.local/state", () => {
    const p = castRegFileFor("DP-1", { HOME: "/home/kiosk" });
    expect(p).toBe("/home/kiosk/.local/state/polyptic/uxplay-reg-DP-1");
  });
});

describe("window matching + target identity", () => {
  test("matchesUxplayWindow accepts UxPlay app ids and rejects the browsers'", () => {
    expect(matchesUxplayWindow("uxplay")).toBe(true);
    expect(matchesUxplayWindow("UxPlay")).toBe(true);
    expect(matchesUxplayWindow("google-chrome")).toBe(false);
    expect(matchesUxplayWindow("surf")).toBe(false);
    expect(matchesUxplayWindow("")).toBe(false);
  });

  test("sameCastTarget: only a name change forces a relaunch", () => {
    expect(sameCastTarget({ name: "A" }, { name: "A" })).toBe(true);
    expect(sameCastTarget({ name: "A" }, { name: "B" })).toBe(false);
    expect(sameCastTarget(null, { name: "A" })).toBe(false);
    expect(sameCastTarget(null, null)).toBe(true);
  });
});

// ── PIN pairing (POL-136) ─────────────────────────────────────────────────────
//
// The receiver never draws its PIN: `display_pin` (uxplay.cpp) renders ASCII art on STDOUT and the
// raop library logs the value right after — no window exists until mirroring starts. These fixtures
// are VERBATIM the upstream format strings (raop_handlers.h / uxplay.cpp, checked 2026-07-15); the
// classifier is what turns that stdout into a PIN on the panel, so its match rules are pinned hard.

import {
  CAST_PIN_MISSING_MS,
  CAST_PIN_TTL_MS,
  CastPairingTracker,
  classifyCastLine,
  type PinTimers,
} from "../src/backends/cast";

/** The receiver's pairing transcript, as the upstream format strings produce it. */
const PAIRING_LINES = [
  `connection request from iPhone (iPhone14,5) with deviceID = 08:66:98:AA:BB:CC`,
  `client sent PAIR-PIN-START request`,
  ``, // the ASCII-art PIN block follows (create_pin_display) — blank lines and art, no digits as text
  `      8888888888     d88     8888888888     888888888 `,
  `             d88    d888            d88    d88        `,
  `*** CLIENT MUST NOW ENTER PIN = "0417" AS AIRPLAY PASSWORD`,
  `client requested pair-setup-pin, datalen = 4096`,
  `registered new client: iPhone DeviceID = 08:66:98:AA:BB:CC PK = `,
];

describe("classifyCastLine — the receiver's stdout is the ONLY place the PIN exists (POL-136)", () => {
  test("learns the PIN from the raop announcement line, zero-padding preserved", () => {
    expect(classifyCastLine(`*** CLIENT MUST NOW ENTER PIN = "0417" AS AIRPLAY PASSWORD`)).toEqual({
      kind: "pin",
      pin: "0417",
    });
  });

  test("matches unanchored: a logger prefix ahead of the format string still parses", () => {
    expect(
      classifyCastLine(`2026-07-15 10:00:00 *** CLIENT MUST NOW ENTER PIN = "9004" AS AIRPLAY PASSWORD`),
    ).toEqual({ kind: "pin", pin: "9004" });
  });

  test("recognises the start of a pairing (the phone is now showing its prompt)", () => {
    expect(classifyCastLine("client sent PAIR-PIN-START request")).toEqual({
      kind: "pairing-started",
    });
  });

  test("recognises a completed registration (the PIN has served its purpose)", () => {
    expect(
      classifyCastLine("registered new client: iPhone DeviceID = 08:66:98:AA:BB:CC PK = "),
    ).toEqual({ kind: "paired" });
  });

  test("everything else — including the ASCII-art PIN block itself — is noise", () => {
    expect(classifyCastLine("")).toBeNull();
    expect(classifyCastLine(`      8888888888     d88     8888888888     888888888 `)).toBeNull();
    expect(classifyCastLine("connection request from iPhone (iPhone14,5) with deviceID = x")).toBeNull();
    expect(classifyCastLine("raop_rtp_mirror starting mirroring")).toBeNull();
    expect(classifyCastLine(`CLIENT MUST NOW ENTER PIN = "not-digits" AS AIRPLAY PASSWORD`)).toBeNull();
  });
});

/** Deterministic fake timers: fire manually, in order, by advancing time. */
function fakeTimers(): PinTimers & { advance(ms: number): void } {
  let now = 0;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    set(fn, ms) {
      const id = ++seq;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clear(handle) {
      pending.delete(handle as number);
    },
    advance(ms) {
      now += ms;
      for (const [id, t] of [...pending]) {
        if (t.at <= now) {
          pending.delete(id);
          t.fn();
        }
      }
    },
  };
}

function trackedEvents() {
  const changes: (string | null)[] = [];
  let missing = 0;
  const timers = fakeTimers();
  const tracker = new CastPairingTracker(
    {
      onPinChange: (pin) => changes.push(pin),
      onPinMissing: () => {
        missing += 1;
      },
    },
    timers,
  );
  return { tracker, timers, changes, missing: () => missing };
}

describe("CastPairingTracker — the PIN lifecycle, from stdout to panel and back off it (POL-136)", () => {
  test("a full pairing: PIN surfaces on the announcement line, clears on registration", () => {
    const { tracker, changes, missing } = trackedEvents();
    for (const line of PAIRING_LINES) tracker.onLine(line);
    expect(changes).toEqual(["0417", null]);
    expect(missing()).toBe(0);
  });

  test("the mirror window appearing clears the PIN (pairing is over, content is coming)", () => {
    const { tracker, changes } = trackedEvents();
    tracker.onLine(`*** CLIENT MUST NOW ENTER PIN = "1234" AS AIRPLAY PASSWORD`);
    tracker.windowAppeared();
    expect(changes).toEqual(["1234", null]);
  });

  test("the receiver dying clears the PIN — nothing strands a code for a dead pairing", () => {
    const { tracker, changes } = trackedEvents();
    tracker.onLine(`*** CLIENT MUST NOW ENTER PIN = "1234" AS AIRPLAY PASSWORD`);
    tracker.processEnded();
    expect(changes).toEqual(["1234", null]);
  });

  test("a retry mid-pairing swaps the PIN without an intermediate clear", () => {
    const { tracker, changes } = trackedEvents();
    tracker.onLine(`*** CLIENT MUST NOW ENTER PIN = "1111" AS AIRPLAY PASSWORD`);
    tracker.onLine("client sent PAIR-PIN-START request");
    tracker.onLine(`*** CLIENT MUST NOW ENTER PIN = "2222" AS AIRPLAY PASSWORD`);
    expect(changes).toEqual(["1111", "2222"]);
  });

  test("LOUD when a pairing starts but no PIN line follows — the exact silent failure of POL-136", () => {
    const { tracker, timers, changes, missing } = trackedEvents();
    tracker.onLine("client sent PAIR-PIN-START request");
    timers.advance(CAST_PIN_MISSING_MS);
    expect(missing()).toBe(1);
    expect(changes).toEqual([]);
  });

  test("no false alarm when the PIN line arrives in time", () => {
    const { tracker, timers, missing } = trackedEvents();
    tracker.onLine("client sent PAIR-PIN-START request");
    tracker.onLine(`*** CLIENT MUST NOW ENTER PIN = "0417" AS AIRPLAY PASSWORD`);
    timers.advance(CAST_PIN_MISSING_MS);
    expect(missing()).toBe(0);
  });

  test("TTL backstop: an abandoned pairing cannot strand a code on the glass", () => {
    const { tracker, timers, changes } = trackedEvents();
    tracker.onLine(`*** CLIENT MUST NOW ENTER PIN = "7777" AS AIRPLAY PASSWORD`);
    timers.advance(CAST_PIN_TTL_MS);
    expect(changes).toEqual(["7777", null]);
  });

  test("a fresh PIN re-arms the TTL rather than inheriting the old deadline", () => {
    const { tracker, timers, changes } = trackedEvents();
    tracker.onLine(`*** CLIENT MUST NOW ENTER PIN = "1111" AS AIRPLAY PASSWORD`);
    timers.advance(CAST_PIN_TTL_MS - 1_000);
    tracker.onLine(`*** CLIENT MUST NOW ENTER PIN = "2222" AS AIRPLAY PASSWORD`);
    timers.advance(2_000); // past the FIRST pin's deadline, well inside the second's
    expect(changes).toEqual(["1111", "2222"]);
  });
});

// ── Review findings (PR #118) ────────────────────────────────────────────────

import {
  GST_VA_DECODER_RANKS,
  applyCastPinEvent,
  uxplayChildEnv,
  wrapLineBuffered,
} from "../src/backends/cast";

describe("uxplayChildEnv — decodebin must prefer the hardware VA decoders (POL-163)", () => {
  test("sets GST_PLUGIN_FEATURE_RANK promoting vah264dec/vah265dec/vavp9dec above software", () => {
    const env = uxplayChildEnv({ PATH: "/usr/bin" });
    expect(env.GST_PLUGIN_FEATURE_RANK).toBe(GST_VA_DECODER_RANKS);
    // Each VA decoder is promoted to PRIMARY+1, i.e. just above the software avdec_h264 element.
    expect(env.GST_PLUGIN_FEATURE_RANK).toContain("vah264dec:PRIMARY+1");
    expect(env.GST_PLUGIN_FEATURE_RANK).toContain("vah265dec:PRIMARY+1");
    expect(env.GST_PLUGIN_FEATURE_RANK).toContain("vavp9dec:PRIMARY+1");
  });

  test("merges OVER the agent's env (passes GST_DEBUG through), without mutating the base", () => {
    const base = { PATH: "/usr/bin", GST_DEBUG: "2" };
    const env = uxplayChildEnv(base);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.GST_DEBUG).toBe("2"); // an operator's GST_DEBUG reaches the child for journal relay
    expect(base).toEqual({ PATH: "/usr/bin", GST_DEBUG: "2" }); // base is untouched
    expect("GST_PLUGIN_FEATURE_RANK" in base).toBe(false);
  });

  test("the rank override always wins even if the base already set one", () => {
    const env = uxplayChildEnv({ GST_PLUGIN_FEATURE_RANK: "somethingelse:NONE" });
    expect(env.GST_PLUGIN_FEATURE_RANK).toBe(GST_VA_DECODER_RANKS);
  });
});

describe("buildUxplayArgs — the argv is unchanged by the decode-rank fix (POL-163)", () => {
  test("the receiver's launch argv still carries only the pinned flags, no decoder argv", () => {
    // The fix is env-only: waylandsink, the MAC, the ports, and -reg all stay exactly as they were.
    expect(valueOf("-vs")).toBe("waylandsink");
    expect(valueOf("-m")).toBe("02:aa:bb:cc:dd:ee");
    expect(valueOf("-p")).toBe(String(CAST_PORT_BASE));
    expect(valueOf("-reg")).toBe("/home/kiosk/.local/state/polyptic/uxplay-reg-DP-1");
    expect(ARGS).not.toContain("-vd"); // no explicit decoder override was bolted onto the argv
    expect(ARGS).not.toContain("--gst");
  });
});

describe("wrapLineBuffered — the PIN cannot sit in a libc block buffer (finding 1)", () => {
  const ARGS_IN = ["-n", "Boardroom Left", "-pin"];

  test("spawns through stdbuf -oL -eL so the receiver's printf output is line-buffered into our pipe", () => {
    const { cmd, argv } = wrapLineBuffered("uxplay", ARGS_IN, true);
    expect(cmd).toBe("stdbuf");
    // Order is load-bearing: buffering flags first, then the real command and its untouched argv.
    expect(argv).toEqual(["-oL", "-eL", "uxplay", "-n", "Boardroom Left", "-pin"]);
  });

  test("a box without stdbuf still casts — the receiver runs unwrapped (with the loud log upstream)", () => {
    const { cmd, argv } = wrapLineBuffered("uxplay", ARGS_IN, false);
    expect(cmd).toBe("uxplay");
    expect(argv).toEqual(ARGS_IN);
  });
});

describe("applyCastPinEvent — the agent's connector→PIN ledger rules (finding 4)", () => {
  test("a new PIN on a castable connector applies and reports a change", () => {
    const pins = new Map<string, string>();
    expect(applyCastPinEvent(pins, () => true, "HDMI-1", "0417")).toBe(true);
    expect(pins.get("HDMI-1")).toBe("0417");
  });

  test("repeating the same PIN is not a change (no duplicate status frames)", () => {
    const pins = new Map([["HDMI-1", "0417"]]);
    expect(applyCastPinEvent(pins, () => true, "HDMI-1", "0417")).toBe(false);
  });

  test("a new PIN for a retired connector is refused — never surface a stale pin", () => {
    const pins = new Map<string, string>();
    expect(applyCastPinEvent(pins, () => false, "HDMI-1", "0417")).toBe(false);
    expect(pins.size).toBe(0);
  });

  test("THE ordering bug: a null clear applies even after the casting entry is gone", () => {
    // Receiver death ordering: reconcile deletes the casting entry FIRST, the receiver's exit
    // event lands after. The clear must still take, or the stale PIN level-reports forever.
    const pins = new Map([["HDMI-1", "0417"]]);
    const castable = () => false; // the connector was already retired
    expect(applyCastPinEvent(pins, castable, "HDMI-1", null)).toBe(true);
    expect(pins.size).toBe(0);
  });

  test("a null clear with nothing held is a no-op", () => {
    const pins = new Map<string, string>();
    expect(applyCastPinEvent(pins, () => true, "HDMI-1", null)).toBe(false);
  });
});
