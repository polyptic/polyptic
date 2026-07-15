/**
 * POL-117 — manual machine naming, driven directly against the ControlPlane.
 *
 * Every netbooted box boots the same live image, so every box's hostname is
 * `localhost.localdomain` — meaningless as an identity. The rules pinned here:
 *
 *   - a meaningless hostname (localhost / localhost.localdomain / *.localdomain / empty) is NEVER
 *     adopted as the label; the label stays = the machine id (the "unnamed" sentinel),
 *   - a MEANINGFUL hostname still is (the pre-POL-117 nicety, kept),
 *   - renameMachine writes through the store (survives a control-plane restart),
 *   - an operator's name always beats the hostname on every later hello,
 *   - a machine labelled `localhost.localdomain` BEFORE this fix relabels on its next hello
 *     (the stale adoption is not mistaken for an operator rename).
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { meaningfulHostname } from "@polyptic/protocol";

import { ControlPlane, type RegisterMachineInput } from "../src/state";
import { MemoryStore } from "../src/store/memory";

function hello(machineId: string, hostname?: string): RegisterMachineInput {
  return {
    machineId,
    agentVersion: "test",
    backend: "wayland-sway",
    outputs: [{ connector: "DP-1", width: 1920, height: 1080 }],
    hostname,
  };
}

let store: MemoryStore;
let cp: ControlPlane;

beforeEach(async () => {
  store = new MemoryStore();
  cp = new ControlPlane(store);
  await cp.init();
});

describe("meaningfulHostname (the shared contract helper)", () => {
  test("live-image hostnames identify nothing", () => {
    expect(meaningfulHostname("localhost.localdomain")).toBeNull();
    expect(meaningfulHostname("LOCALHOST.LOCALDOMAIN")).toBeNull();
    expect(meaningfulHostname("localhost")).toBeNull();
    expect(meaningfulHostname("box-3.localdomain")).toBeNull();
    expect(meaningfulHostname("   ")).toBeNull();
    expect(meaningfulHostname(undefined)).toBeNull();
  });

  test("a real hostname passes through, trimmed", () => {
    expect(meaningfulHostname(" lobby-wall ")).toBe("lobby-wall");
    expect(meaningfulHostname("kiosk-7.example.com")).toBe("kiosk-7.example.com");
  });
});

describe("label adoption on hello (POL-117)", () => {
  test("localhost.localdomain is never adopted — the label stays the id sentinel", async () => {
    await cp.registerMachine(hello("dmi-aaa111", "localhost.localdomain"));
    expect(cp.getMachine("dmi-aaa111")?.label).toBe("dmi-aaa111");
  });

  test("a meaningful hostname is still adopted", async () => {
    await cp.registerMachine(hello("dmi-bbb222", "lobby-wall"));
    expect(cp.getMachine("dmi-bbb222")?.label).toBe("lobby-wall");
  });

  test("a stale pre-fix localhost.localdomain label relabels to the sentinel on the next hello", async () => {
    // Simulate the pre-POL-117 state: the meaningless hostname landed in the label.
    await cp.registerMachine(hello("dmi-ccc333", "old-name"));
    await cp.renameMachine("dmi-ccc333", "localhost.localdomain"); // stand-in for the stale row
    await cp.registerMachine(hello("dmi-ccc333", "localhost.localdomain"));
    expect(cp.getMachine("dmi-ccc333")?.label).toBe("dmi-ccc333");
  });

  test("pending enrolment follows the same rule", async () => {
    await cp.enrollPending(hello("dmi-ddd444", "localhost.localdomain"), "cred-hash");
    expect(cp.getMachine("dmi-ddd444")?.label).toBe("dmi-ddd444");
    expect(cp.getMachine("dmi-ddd444")?.status).toBe("pending");
  });
});

describe("renameMachine (POL-117)", () => {
  test("rename round-trips and beats the hostname on every later hello", async () => {
    await cp.registerMachine(hello("dmi-eee555", "localhost.localdomain"));
    const renamed = await cp.renameMachine("dmi-eee555", "Boardroom Right");
    expect(renamed?.label).toBe("Boardroom Right");

    // The box re-hellos with its meaningless hostname — the operator's name wins.
    await cp.registerMachine(hello("dmi-eee555", "localhost.localdomain"));
    expect(cp.getMachine("dmi-eee555")?.label).toBe("Boardroom Right");

    // ... and with a MEANINGFUL hostname too: a rename is authoritative, not a default.
    await cp.registerMachine(hello("dmi-eee555", "some-new-hostname"));
    expect(cp.getMachine("dmi-eee555")?.label).toBe("Boardroom Right");
  });

  test("rename persists — a fresh ControlPlane over the same store reads it back", async () => {
    await cp.registerMachine(hello("dmi-fff666", "localhost.localdomain"));
    await cp.renameMachine("dmi-fff666", "Reception");

    const rebooted = new ControlPlane(store);
    await rebooted.init();
    expect(rebooted.getMachine("dmi-fff666")?.label).toBe("Reception");
  });

  test("renaming a pending machine works and does not change its status", async () => {
    await cp.enrollPending(hello("dmi-ggg777", "localhost.localdomain"), "cred-hash");
    const renamed = await cp.renameMachine("dmi-ggg777", "Atrium North");
    expect(renamed?.label).toBe("Atrium North");
    expect(cp.getMachine("dmi-ggg777")?.status).toBe("pending");
  });

  test("renaming an unknown machine returns null", async () => {
    expect(await cp.renameMachine("dmi-nope", "Ghost")).toBeNull();
  });
});
