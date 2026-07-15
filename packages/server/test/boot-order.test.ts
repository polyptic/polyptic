/**
 * POL-115 — the control-plane half of the UEFI boot-order watch.
 *
 * Two contracts, both load-bearing on a fleet of real boxes:
 *
 *   1. The POLICY defaults to report-only, and only an explicit operator opt-in changes that. A box
 *      writes a firmware boot variable only because a human said it may — never because a server
 *      restarted, a migration ran, or a setting was never set.
 *   2. A box's boot-order verdict becomes ONE plain-English Live Activity line that tells an operator
 *      what will happen to that box next time it is powered on. `boot-order-drift` in particular must
 *      NOT read as a bootloader install failure — nothing failed, and nothing was written.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { bootReportLine } from "../src/provision";
import { ControlPlane } from "../src/state";
import { MemoryStore } from "../src/store/memory";

let store: MemoryStore;
let cp: ControlPlane;

beforeEach(async () => {
  store = new MemoryStore();
  cp = new ControlPlane(store);
  await cp.init();
});

describe("ControlPlane boot-order policy (POL-115)", () => {
  test("the default is REPORT-ONLY — an untouched fleet never writes firmware NVRAM", () => {
    expect(cp.getBootOrderPolicy()).toEqual({ reassert: false });
  });

  test("an operator opt-in persists and is reloaded on restart", async () => {
    expect(await cp.setBootOrderPolicy({ reassert: true })).toEqual({ reassert: true });
    expect(await store.getBootOrderPolicy()).toEqual({ reassert: true });

    const restarted = new ControlPlane(store);
    await restarted.init();
    expect(restarted.getBootOrderPolicy()).toEqual({ reassert: true });
  });

  test("opting back out is just as durable — the fleet stops writing", async () => {
    await cp.setBootOrderPolicy({ reassert: true });
    await cp.setBootOrderPolicy({ reassert: false });

    const restarted = new ControlPlane(store);
    await restarted.init();
    expect(restarted.getBootOrderPolicy()).toEqual({ reassert: false });
  });

  test("getBootOrderPolicy returns a defensive copy", async () => {
    const snapshot = cp.getBootOrderPolicy();
    snapshot.reassert = true;
    expect(cp.getBootOrderPolicy()).toEqual({ reassert: false });
  });
});

describe("boot-order drift, as the operator reads it (POL-115)", () => {
  const machineId = "dmi-1a2b3c4d5e6f";

  test("drift is a WARNING that names the consequence, and says nothing was written", () => {
    const line = bootReportLine({
      ok: false,
      code: "boot-order-drift",
      detail: "the firmware now boots ubuntu first; 'Polyptic Netboot' is entry 000a",
      machineId,
    });
    expect(line.severity).toBe("warn");
    expect(line.text).toContain("would boot something else next time");
    expect(line.text).toContain("Nothing was written");
    // It is NOT an install failure: the bootloader is fine, the firmware moved it.
    expect(line.text).not.toContain("could not install");
  });

  test("a corrected boot order is GOOD news, and quotes the box's own sentence", () => {
    const line = bootReportLine({
      ok: true,
      code: "boot-order-reasserted",
      detail: "boot order 000a,0000,0002 (was 0000,000a,0002)",
      machineId,
    });
    expect(line.severity).toBe("good");
    expect(line.text).toContain("back at the head of its UEFI boot order");
    expect(line.text).toContain("boot order 000a,0000,0002 (was 0000,000a,0002)");
  });

  test("a firmware that keeps winning is BAD, and the operator is told the order is unchanged", () => {
    const line = bootReportLine({
      ok: false,
      code: "boot-order-reassert-failed",
      detail: "it still reads 0000,000a,0002",
      machineId,
    });
    expect(line.severity).toBe("bad");
    expect(line.text).toContain("firmware keeps winning");
    expect(line.text).toContain("boot order is unchanged");
  });

  test("the machine is named the same way as every other boot report", () => {
    const line = bootReportLine({ ok: false, code: "boot-order-drift", detail: "", machineId });
    expect(line.text.startsWith(`Machine ${machineId}`)).toBe(true);
  });

  test("a bootloader install failure still reads as one — the new codes did not swallow it", () => {
    const line = bootReportLine({ ok: false, code: "no-esp", detail: "", machineId });
    expect(line.severity).toBe("bad");
    expect(line.text).toContain("could not install the Polyptic bootloader (no-esp)");
  });
});
