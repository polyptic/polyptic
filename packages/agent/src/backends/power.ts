/**
 * Panel power (POL-101) — the two rungs by which a box darkens a wall, and the honest report of
 * which ones it actually has.
 *
 * The wall's standing discipline does NOT change: the compositor still asserts `output * dpms on` at
 * startup, there is still no swayidle, and no timeout of any kind can blank a panel (the x11 rung
 * below is careful to keep every DPMS timeout at zero, precisely so enabling the extension cannot
 * reintroduce auto-blanking). A panel goes dark ONLY when the control plane says so — an operator's
 * click, or a panel-hours boundary the operator set. Idleness is never a reason.
 *
 * Rung 1 — DPMS (always, on a real compositor):
 *   sway: `swaymsg output <name> dpms off` stops driving the output. Cheap, instant, and it survives
 *   nothing: the compositor re-asserts `dpms on` on restart, which is exactly right for a box that
 *   reboots (it comes back lit, and the scheduler re-sleeps it if it is still out of hours).
 *
 * Rung 2 — HDMI-CEC (best-effort, capability-detected):
 *   DPMS stops the pixels; it does not necessarily stop the PANEL. Plenty of displays — TVs above
 *   all — respond to a dead HDMI signal by lighting a "no signal" screen, or simply by staying on
 *   with a black backlight, which burns exactly the power and panel life this feature exists to save.
 *   CEC talks to the display itself ("standby" / "image view on"), and it is the only rung that
 *   reliably powers a TV down. It needs an adapter, a `/dev/cec*` node, and a kiosk user who can open
 *   it — none of which we can assume. So we PROBE, report the answer on hello, degrade to DPMS-only
 *   when it is missing, and say so loudly in the log. Nothing on the glass ever depends on it.
 *
 * Two tools, either of which is enough:
 *   - `cec-ctl` (v4l-utils) — the KERNEL CEC API, `/dev/cec0`. Preferred: no daemon, no libcec.
 *   - `cec-client` (libcec) — the userspace stack, driven by a one-shot command on stdin.
 *
 * Everything here takes its process access through `PowerExec`, so the command lines are unit-testable
 * with no compositor, no CEC bus and no display anywhere near the machine running the tests.
 */
import type { PanelPowerMethod, PowerCapabilities } from "@polyptic/protocol";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { run, which } from "./proc";
import type { RunResult } from "./proc";

/** The process/filesystem seam. Real backends pass the `proc` helpers; tests pass stubs. */
export interface PowerExec {
  run(cmd: string, args: string[]): Promise<RunResult>;
  which(tool: string): Promise<boolean>;
  /** Is this path present AND openable by the (unprivileged) agent? Used for `/dev/cec*`. */
  readable(path: string): Promise<boolean>;
  log(msg: string): void;
}

/** The live `proc`-backed exec the real backends use. */
export const systemPowerExec: PowerExec = {
  run: (cmd, args) => run(cmd, args),
  which: (tool) => which(tool),
  readable: async (path) => {
    try {
      // R_OK|W_OK: the kernel CEC API is a read/write ioctl device — a node we can only read is a
      // node we cannot send a standby on, and pretending otherwise would make the capability a lie.
      await access(path, fsConstants.R_OK | fsConstants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
  log: (msg) => console.log(`[${new Date().toISOString()}] [power] ${msg}`),
};

/** The kernel CEC device nodes we look for, in order. A box with several adapters uses the first. */
export const CEC_DEVICES = ["/dev/cec0", "/dev/cec1"] as const;

/** A CEC adapter this box can actually drive. */
export interface CecAdapter {
  tool: "cec-ctl" | "cec-client";
  /** The kernel device node (`cec-ctl`), or the empty string when libcec picks its own adapter. */
  device: string;
}

/**
 * The sway IPC command that powers one output. `dpms off` stops driving the connector; `dpms on`
 * drives it again. The browser underneath is untouched — this is why waking is instant.
 */
export function swayDpmsArgs(output: string, on: boolean): string[] {
  return ["output", output, "dpms", on ? "on" : "off"];
}

/**
 * The x11-i3 fallback's DPMS sequence. The i3 config runs `xset s off -dpms s noblank` at startup,
 * i.e. it DISABLES the DPMS extension outright — so `xset dpms force off` alone would silently do
 * nothing. We therefore enable the extension, but pin every timeout to zero first, so it can only
 * ever be driven by an explicit `force` and never by idleness. That is the whole non-negotiable,
 * expressed in three commands:
 *
 *   sleep: xset dpms 0 0 0   (no standby/suspend/off timeout — idleness can never blank us)
 *          xset +dpms        (the extension is now available to be FORCED)
 *          xset dpms force off
 *   wake:  xset dpms force on
 *          xset s off -dpms s noblank   (back to the config's baseline: no screensaver, no DPMS)
 */
export function x11DpmsCommands(on: boolean): Array<{ cmd: string; args: string[] }> {
  if (on) {
    return [
      { cmd: "xset", args: ["dpms", "force", "on"] },
      { cmd: "xset", args: ["s", "off", "-dpms", "s", "noblank"] },
    ];
  }
  return [
    { cmd: "xset", args: ["dpms", "0", "0", "0"] },
    { cmd: "xset", args: ["+dpms"] },
    { cmd: "xset", args: ["dpms", "force", "off"] },
  ];
}

/**
 * The command that tells the DISPLAY itself to stand by (or wake). Addressed to logical address 0 —
 * the TV — which is what a kiosk box on an HDMI input is talking to.
 */
export function cecCommand(adapter: CecAdapter, on: boolean): { cmd: string; args: string[] } {
  if (adapter.tool === "cec-ctl") {
    // `--to 0` = the TV. `--image-view-on` is CEC's "wake up and show my input"; `--standby` is off.
    return {
      cmd: "cec-ctl",
      args: ["-d", adapter.device, "--to", "0", on ? "--image-view-on" : "--standby"],
    };
  }
  // libcec's one-shot form: pipe a command in, exit. `-s` = single command, `-d 1` = quiet.
  return { cmd: "cec-client", args: ["-s", "-d", "1", "-t", "p", on ? "on 0" : "standby 0"] };
}

/**
 * Probe the box for a usable CEC adapter, once, at agent startup. Returns `null` when there is none —
 * which is not an error, and must never be treated as one: the overwhelming majority of boxes have no
 * CEC adapter, and they still sleep their panels perfectly well via DPMS.
 */
export async function detectCecAdapter(exec: PowerExec = systemPowerExec): Promise<CecAdapter | null> {
  // Preferred: the kernel CEC API. Needs both the tool and a device node the kiosk user can OPEN —
  // the node is typically root:video, so an unprivileged agent only gets there because `setup` puts
  // the kiosk user in `video` (see setup/install.ts). No group, no CEC: report it, don't fake it.
  if (await exec.which("cec-ctl")) {
    for (const device of CEC_DEVICES) {
      if (await exec.readable(device)) {
        exec.log(`HDMI-CEC available via cec-ctl on ${device} — sleep will also power the panel down`);
        return { tool: "cec-ctl", device };
      }
    }
    exec.log(
      `cec-ctl is installed but no ${CEC_DEVICES.join(" / ")} is openable by this user — ` +
        `CEC disabled (panels will sleep via DPMS only). If the box HAS a CEC adapter, check the ` +
        `kiosk user is in the 'video' group and that a udev rule grants it the device.`,
    );
  }
  // Fallback: libcec. It enumerates its own adapters, so we only need the binary + a device node.
  if (await exec.which("cec-client")) {
    for (const device of CEC_DEVICES) {
      if (await exec.readable(device)) {
        exec.log(`HDMI-CEC available via cec-client (libcec) — sleep will also power the panel down`);
        return { tool: "cec-client", device: "" };
      }
    }
  }
  exec.log(
    "no HDMI-CEC adapter found — panels will sleep via DPMS only (the output goes dark; a display " +
      "that ignores a dead signal may stay lit). This is a normal, supported configuration.",
  );
  return null;
}

/** How one backend actually drives DPMS for a connector. Throws on failure — DPMS is the rung we
 *  REQUIRE, so a failure here is a failed sleep, not a degraded one. */
export type DpmsDriver = (connector: string, on: boolean) => Promise<void>;

/**
 * The shared panel-power engine: DPMS (required) + CEC (best-effort), one capability probe, one
 * `apply`. Both real backends own one of these; `dev-open` owns none and refuses outright.
 */
export class PanelPower {
  private cec: CecAdapter | null = null;
  private probed = false;

  constructor(
    private readonly dpms: DpmsDriver,
    private readonly exec: PowerExec = systemPowerExec,
  ) {}

  /** Probe once (idempotent). Called at agent startup so hello can report the truth. */
  async capabilities(): Promise<PowerCapabilities> {
    if (!this.probed) {
      this.cec = await detectCecAdapter(this.exec);
      this.probed = true;
    }
    return { dpms: true, cec: this.cec !== null };
  }

  /**
   * Sleep or wake ONE panel. DPMS first (and if that throws, the whole thing failed — the operator
   * must not be told a wall is asleep when it is still lit). CEC after, best-effort: a CEC bus that
   * refuses is logged and dropped from the reported methods, never escalated — a box whose TV ignores
   * CEC has still darkened its output, which is the outcome we promised it could deliver.
   */
  async apply(connector: string, on: boolean): Promise<PanelPowerMethod[]> {
    await this.capabilities(); // ensure the probe has run even if hello never asked
    await this.dpms(connector, on);
    const methods: PanelPowerMethod[] = ["dpms"];

    if (this.cec) {
      const { cmd, args } = cecCommand(this.cec, on);
      const res = await this.exec.run(cmd, args);
      if (res.code === 0) {
        methods.push("cec");
      } else {
        this.exec.log(
          `CEC ${on ? "wake" : "standby"} for ${connector} failed: ` +
            `${res.stderr.trim() || `exit ${res.code}`} — the output is ${on ? "driven" : "dark"} ` +
            `regardless (DPMS applied); the panel itself may not have ${on ? "woken" : "powered down"}.`,
        );
      }
    }
    return methods;
  }
}
