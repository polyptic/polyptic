/**
 * POL-176 — install-to-disk: the control plane's half.
 *
 * Four contracts, each load-bearing on a real fleet:
 *
 *   1. The hello's boot facts (bootMode / disks / stagedImageId) PERSIST like imageId does — a dark
 *      box must still say how it boots — and a hello that carries none never erases what a newer
 *      session already reported.
 *   2. The heartbeat's staged image id is change-detected: one feed line on the "update ready"
 *      edge, silence on the every-few-seconds repeat, and NO line when staged == running.
 *   3. `disk-boot` closes the local-fallback story exactly like `wired-boot` does.
 *   4. The live `installing` presence state is TTL-bounded (a box that dies mid-wipe must not read
 *      "installing…" forever) and the boot-report codes render in install-to-disk words.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import type { MachineDisk } from "@polyptic/protocol";

import { ActivityLog } from "../src/activity";
import { Presence } from "../src/admin";
import { bootReportLine } from "../src/provision";
import { ControlPlane, type RegisterMachineInput } from "../src/state";
import { MemoryStore } from "../src/store/memory";

const RUNNING = "20260720T000000Z-aaaa1111";
const STAGED = "20260723T000000Z-bbbb2222";

const DISKS: MachineDisk[] = [
  { device: "/dev/sda", sizeBytes: 256e9, model: "SAMSUNG MZ7LN256", removable: false, contents: "empty" },
  { device: "/dev/sdb", sizeBytes: 16e9, removable: true, contents: "vfat (POLYPTIC)" },
];

function hello(machineId: string, extra: Partial<RegisterMachineInput> = {}): RegisterMachineInput {
  return {
    machineId,
    agentVersion: "test",
    backend: "wayland-sway",
    outputs: [{ connector: "DP-1", width: 1920, height: 1080 }],
    hostname: "wall1",
    ...extra,
  };
}

let store: MemoryStore;
let cp: ControlPlane;
let activity: ActivityLog;

const feed = (): string[] => activity.recent().map((e) => e.text);

beforeEach(async () => {
  store = new MemoryStore();
  activity = new ActivityLog();
  cp = new ControlPlane(store, activity);
  await cp.init();
});

describe("the hello's boot facts (POL-176)", () => {
  test("bootMode, disks and stagedImageId are recorded with timestamps", async () => {
    await cp.registerMachine(hello("box-1", { bootMode: "live", disks: DISKS, stagedImageId: STAGED }));
    const m = cp.getMachine("box-1");
    expect(m?.bootMode).toBe("live");
    expect(typeof m?.bootModeAt).toBe("string");
    expect(m?.disks).toHaveLength(2);
    expect(m?.stagedImageId).toBe(STAGED);
    expect(typeof m?.stagedImageIdAt).toBe("string");
  });

  test("a hello with NO facts never erases the ones we already knew (an older agent, a failed probe)", async () => {
    await cp.registerMachine(hello("box-1", { bootMode: "live", disks: DISKS, stagedImageId: STAGED }));
    await cp.registerMachine(hello("box-1"));
    const m = cp.getMachine("box-1");
    expect(m?.bootMode).toBe("live");
    expect(m?.disks).toHaveLength(2);
    expect(m?.stagedImageId).toBe(STAGED);
  });

  test("a reboot into the installed OS updates the mode in place", async () => {
    await cp.registerMachine(hello("box-1", { bootMode: "live", disks: DISKS }));
    await cp.registerMachine(hello("box-1", { bootMode: "installed", disks: [DISKS[0] as MachineDisk] }));
    const m = cp.getMachine("box-1");
    expect(m?.bootMode).toBe("installed");
    expect(m?.disks).toHaveLength(1);
  });

  test("the facts survive a restart — a dark box still says how it boots", async () => {
    await cp.registerMachine(hello("box-1", { bootMode: "installed", disks: DISKS, stagedImageId: STAGED }));
    const restarted = new ControlPlane(store);
    await restarted.init();
    const m = restarted.getMachine("box-1");
    expect(m?.bootMode).toBe("installed");
    expect(m?.disks?.[0]?.model).toBe("SAMSUNG MZ7LN256");
    expect(m?.stagedImageId).toBe(STAGED);
  });
});

describe("the staged image id on the heartbeat (POL-176)", () => {
  test("a change persists, and staged != running earns ONE update-ready line", async () => {
    await cp.registerMachine(hello("box-1", { imageId: RUNNING }));

    expect(await cp.noteMachineStagedImage("box-1", STAGED)).toBe(true);
    expect(cp.getMachine("box-1")?.stagedImageId).toBe(STAGED);
    expect(feed().some((l) => l.includes(STAGED) && l.includes("reboot"))).toBe(true);

    // The same id arrives every few seconds — silence, and no store churn.
    const before = feed().length;
    expect(await cp.noteMachineStagedImage("box-1", STAGED)).toBe(false);
    expect(feed().length).toBe(before);
  });

  test("staged == running is the applied steady state — recorded, but never announced", async () => {
    await cp.registerMachine(hello("box-1", { imageId: RUNNING }));
    const before = feed().length;
    expect(await cp.noteMachineStagedImage("box-1", RUNNING)).toBe(true);
    expect(cp.getMachine("box-1")?.stagedImageId).toBe(RUNNING);
    expect(feed().length).toBe(before);
  });

  test("an unknown machine and an empty id are no-ops", async () => {
    expect(await cp.noteMachineStagedImage("ghost", STAGED)).toBe(false);
    await cp.registerMachine(hello("box-1"));
    expect(await cp.noteMachineStagedImage("box-1", "  ")).toBe(false);
  });
});

describe("disk-boot closes the fallback story (POL-176)", () => {
  test("local-fallback → disk emits the recovery line, like local-fallback → wired does", async () => {
    await cp.registerMachine(hello("box-1"));
    await cp.noteBootPath("box-1", "local-fallback", "image pinned at 20260721T…");
    await cp.noteBootPath("box-1", "disk", "");
    expect(cp.getMachine("box-1")?.bootPath).toBe("disk");
    expect(feed().some((l) => l.includes("boots from its internal disk"))).toBe(true);
  });

  test("a routine disk boot (no fallback before it) is silent state", async () => {
    await cp.registerMachine(hello("box-1"));
    const before = feed().length;
    await cp.noteBootPath("box-1", "disk", "");
    expect(cp.getMachine("box-1")?.bootPath).toBe("disk");
    expect(feed().length).toBe(before);
  });
});

describe("Presence.installing (POL-176) — live-only, TTL-bounded", () => {
  test("the latest phase is readable with its receipt time, and clears on demand", () => {
    const p = new Presence();
    p.setMachineInstalling("box-1", { phase: "fetching", percent: 42, detail: "rootfs 210 MiB" }, 1_000);
    const held = p.machineInstalling("box-1", 2_000);
    expect(held?.phase).toBe("fetching");
    expect(held?.percent).toBe(42);
    expect(held?.at).toBe(new Date(1_000).toISOString());
    p.clearMachineInstalling("box-1");
    expect(p.machineInstalling("box-1", 2_000)).toBeUndefined();
  });

  test("a stalled non-terminal phase expires after the installer's own 30-minute budget", () => {
    const p = new Presence();
    p.setMachineInstalling("box-1", { phase: "wiping" }, 0);
    expect(p.machineInstalling("box-1", 29 * 60_000)?.phase).toBe("wiping");
    expect(p.machineInstalling("box-1", 31 * 60_000)).toBeUndefined();
  });

  test("a terminal outcome lingers only for the short grace, so the badge clears itself", () => {
    const p = new Presence();
    p.setMachineInstalling("box-1", { phase: "done", percent: 100 }, 0);
    expect(p.machineInstalling("box-1", 30_000)?.phase).toBe("done");
    expect(p.machineInstalling("box-1", 90_000)).toBeUndefined();
  });

  test("forgetMachine drops the install state with everything else", () => {
    const p = new Presence();
    p.setMachineInstalling("box-1", { phase: "starting" }, 0);
    p.forgetMachine("box-1");
    expect(p.machineInstalling("box-1", 1)).toBeUndefined();
  });
});

describe("boot reports, in install-to-disk words (POL-176)", () => {
  const machineId = "dmi-1a2b3c4d5e6f";

  test("`installed` is GOOD and quotes the box's own sentence naming the disk", () => {
    const line = bootReportLine({
      ok: true,
      code: "installed",
      detail: "installed to /dev/sda (A/B slots, loader on partition 1)",
      machineId,
    });
    expect(line.severity).toBe("good");
    expect(line.text).toContain("installed Polyptic to disk");
    expect(line.text).toContain("/dev/sda");
  });

  test("`disk-boot` renders as an info sentence (the route keeps it out of the feed)", () => {
    const line = bootReportLine({ ok: true, code: "disk-boot", detail: "", machineId });
    expect(line.severity).toBe("info");
    expect(line.text).toContain("booted from its internal disk");
  });

  test("the install-* failures are BAD, in install words — not bootloader ones", () => {
    for (const code of ["install-bad-target", "install-disk-too-small", "install-write-failed"] as const) {
      const line = bootReportLine({ ok: false, code, detail: "", machineId });
      expect(line.severity).toBe("bad");
      expect(line.text).toContain(`could not install Polyptic to disk (${code})`);
      expect(line.text).not.toContain("bootloader");
    }
  });
});
