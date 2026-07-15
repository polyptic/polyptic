/**
 * Panel power (POL-101) — the backend commands and the CEC capability probe, against a stubbed
 * process/filesystem seam. No compositor, no CEC bus, no display: exactly the point of `PowerExec`.
 *
 * What is pinned here is the behaviour a real wall depends on:
 *   - the exact sway / xset command lines (a typo here darkens nothing, or worse, darkens everything);
 *   - that the x11 sleep sequence pins every DPMS TIMEOUT to zero before enabling the extension — the
 *     structural guarantee that idleness can still never blank a wall (the POL-101 non-negotiable);
 *   - CEC is probed, not assumed: no tool, or no openable /dev/cec*, degrades to DPMS-only;
 *   - a failing CEC command does NOT fail the sleep (the output is dark either way) but IS dropped
 *     from the reported methods, so the console never claims a panel was powered down when it wasn't;
 *   - a failing DPMS command DOES fail the whole thing — never tell an operator a wall is dark when
 *     it may still be lit.
 */
import { describe, expect, test } from "bun:test";

import {
  PanelPower,
  cecCommand,
  detectCecAdapter,
  swayDpmsArgs,
  x11DpmsCommands,
  type CecAdapter,
  type PowerExec,
} from "../src/backends/power";

interface StubOpts {
  tools?: string[];
  devices?: string[];
  /** Commands that should exit non-zero, matched on `${cmd} ${args.join(" ")}`.startsWith(). */
  failing?: string[];
}

function stubExec(opts: StubOpts = {}): PowerExec & { ran: string[]; logs: string[] } {
  const ran: string[] = [];
  const logs: string[] = [];
  return {
    ran,
    logs,
    async run(cmd, args) {
      const line = `${cmd} ${args.join(" ")}`;
      ran.push(line);
      const fails = (opts.failing ?? []).some((f) => line.startsWith(f));
      return fails
        ? { code: 1, stdout: "", stderr: "no response from the bus" }
        : { code: 0, stdout: "", stderr: "" };
    },
    async which(tool) {
      return (opts.tools ?? []).includes(tool);
    },
    async readable(path) {
      return (opts.devices ?? []).includes(path);
    },
    log(msg) {
      logs.push(msg);
    },
  };
}

describe("POL-101 backend commands", () => {
  test("sway sleeps and wakes ONE named output (per-connector DPMS)", () => {
    expect(swayDpmsArgs("DP-3", false)).toEqual(["output", "DP-3", "dpms", "off"]);
    expect(swayDpmsArgs("DP-3", true)).toEqual(["output", "DP-3", "dpms", "on"]);
  });

  test("the x11 SLEEP sequence pins every DPMS timeout to zero BEFORE enabling the extension", () => {
    const cmds = x11DpmsCommands(false).map((c) => `${c.cmd} ${c.args.join(" ")}`);
    // The order is load-bearing: `xset dpms 0 0 0` first means the extension, once enabled, has NO
    // standby/suspend/off timeout — so idleness can never blank the wall. Only an explicit `force`
    // can, which is the entire POL-101 non-negotiable expressed in three commands.
    expect(cmds).toEqual(["xset dpms 0 0 0", "xset +dpms", "xset dpms force off"]);
    expect(cmds.indexOf("xset dpms 0 0 0")).toBeLessThan(cmds.indexOf("xset +dpms"));
  });

  test("the x11 WAKE sequence restores the i3 config's never-blank baseline", () => {
    const cmds = x11DpmsCommands(true).map((c) => `${c.cmd} ${c.args.join(" ")}`);
    expect(cmds).toEqual(["xset dpms force on", "xset s off -dpms s noblank"]);
  });

  test("CEC addresses the TV (logical address 0), by either tool", () => {
    const kernel: CecAdapter = { tool: "cec-ctl", device: "/dev/cec0" };
    expect(cecCommand(kernel, false)).toEqual({
      cmd: "cec-ctl",
      args: ["-d", "/dev/cec0", "--to", "0", "--standby"],
    });
    expect(cecCommand(kernel, true).args).toContain("--image-view-on");

    const libcec: CecAdapter = { tool: "cec-client", device: "" };
    expect(cecCommand(libcec, false).args).toContain("standby 0");
    expect(cecCommand(libcec, true).args).toContain("on 0");
  });
});

describe("POL-101 CEC capability probe", () => {
  test("prefers the kernel API (cec-ctl on /dev/cec0) when both tools are present", async () => {
    const exec = stubExec({ tools: ["cec-ctl", "cec-client"], devices: ["/dev/cec0"] });
    expect(await detectCecAdapter(exec)).toEqual({ tool: "cec-ctl", device: "/dev/cec0" });
  });

  test("falls back to libcec when only cec-client is installed", async () => {
    const exec = stubExec({ tools: ["cec-client"], devices: ["/dev/cec0"] });
    expect(await detectCecAdapter(exec)).toEqual({ tool: "cec-client", device: "" });
  });

  test("no CEC tools → no adapter, and it says so rather than failing", async () => {
    const exec = stubExec({ tools: [], devices: [] });
    expect(await detectCecAdapter(exec)).toBeNull();
    expect(exec.logs.join(" ")).toContain("no HDMI-CEC adapter found");
  });

  test("the tool is installed but the device is not OPENABLE → no CEC, with the group hint", async () => {
    // The real-world shape of this: /dev/cec0 exists but is root-owned, and the unprivileged kiosk
    // user is not in `video` — so the capability must report FALSE rather than fail at 19:00.
    const exec = stubExec({ tools: ["cec-ctl"], devices: [] });
    expect(await detectCecAdapter(exec)).toBeNull();
    expect(exec.logs.join(" ")).toContain("'video' group");
  });
});

describe("POL-101 PanelPower.apply", () => {
  test("a box with no CEC sleeps the output via DPMS alone and reports exactly that", async () => {
    const exec = stubExec({ tools: [] });
    const slept: Array<{ connector: string; on: boolean }> = [];
    const power = new PanelPower(async (connector, on) => {
      slept.push({ connector, on });
    }, exec);

    expect(await power.capabilities()).toEqual({ dpms: true, cec: false });
    expect(await power.apply("DP-1", false)).toEqual(["dpms"]);
    expect(slept).toEqual([{ connector: "DP-1", on: false }]);
    // Nothing was sent to a bus this box does not have.
    expect(exec.ran).toEqual([]);
  });

  test("a box WITH CEC also powers the display down, and reports both rungs", async () => {
    const exec = stubExec({ tools: ["cec-ctl"], devices: ["/dev/cec0"] });
    const power = new PanelPower(async () => {}, exec);

    expect(await power.capabilities()).toEqual({ dpms: true, cec: true });
    expect(await power.apply("HDMI-A-1", false)).toEqual(["dpms", "cec"]);
    expect(exec.ran).toEqual(["cec-ctl -d /dev/cec0 --to 0 --standby"]);
  });

  test("a CEC failure degrades to DPMS-only — the wall is still dark, and we do not pretend", async () => {
    const exec = stubExec({
      tools: ["cec-ctl"],
      devices: ["/dev/cec0"],
      failing: ["cec-ctl"],
    });
    const power = new PanelPower(async () => {}, exec);

    // The output IS dark (DPMS applied), so this is a success — but `cec` must not appear in the
    // methods, or the console would tell an operator the panel was powered down when it wasn't.
    expect(await power.apply("HDMI-A-1", false)).toEqual(["dpms"]);
    expect(exec.logs.join(" ")).toContain("CEC standby for HDMI-A-1 failed");
  });

  test("a DPMS failure fails the whole request — never claim a wall is dark when it may be lit", async () => {
    const exec = stubExec({ tools: ["cec-ctl"], devices: ["/dev/cec0"] });
    const power = new PanelPower(async () => {
      throw new Error("swaymsg output DP-1 dpms off failed: no such output");
    }, exec);

    await expect(power.apply("DP-1", false)).rejects.toThrow("no such output");
    // And CEC was never reached: we do not power a TV down for a panel we could not blank.
    expect(exec.ran).toEqual([]);
  });

  test("waking runs the same two rungs in the other direction", async () => {
    const exec = stubExec({ tools: ["cec-ctl"], devices: ["/dev/cec0"] });
    const woken: boolean[] = [];
    const power = new PanelPower(async (_c, on) => {
      woken.push(on);
    }, exec);

    expect(await power.apply("HDMI-A-1", true)).toEqual(["dpms", "cec"]);
    expect(woken).toEqual([true]);
    expect(exec.ran).toEqual(["cec-ctl -d /dev/cec0 --to 0 --image-view-on"]);
  });
});
