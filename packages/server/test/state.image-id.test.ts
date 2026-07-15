/**
 * POL-105 — the control plane records which OS image each box actually BOOTED.
 *
 * The point of persisting it (rather than living in the online-only vitals ring, POL-92) is the box
 * that has gone dark: "which machines are still on 20260711T…?" is a question about a machine that is
 * NOT currently talking to us, and that is precisely the machine a bad roll-out has stranded. So:
 *
 *   - `agent/hello` carries the id, and a hello with NO id never erases the one we knew;
 *   - a heartbeat's vitals refresh it, and a CHANGE announces itself (that line is the evidence a
 *     roll-out actually reached the box);
 *   - it survives a restart, i.e. it is store state;
 *   - it survives a re-hello, exactly like the operator's tags do.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { ActivityLog } from "../src/activity";
import { ControlPlane, type RegisterMachineInput } from "../src/state";
import { MemoryStore } from "../src/store/memory";

const OLD = "20260711T191928Z-deadbeef";
const NEW = "20260714T020000Z-cafebabe";

function hello(machineId: string, imageId?: string): RegisterMachineInput {
  return {
    machineId,
    agentVersion: "test",
    backend: "wayland-sway",
    outputs: [{ connector: "DP-1", width: 1920, height: 1080 }],
    hostname: "wall1",
    imageId,
  };
}

let store: MemoryStore;
let cp: ControlPlane;
let activity: ActivityLog;

/** The feed lines emitted so far, newest first. */
const feed = (): string[] => activity.recent().map((e) => e.text);

beforeEach(async () => {
  store = new MemoryStore();
  activity = new ActivityLog();
  cp = new ControlPlane(store, activity);
  await cp.init();
});

describe("the booted image id (POL-105)", () => {
  test("a hello carrying an image id records it, with a timestamp", async () => {
    await cp.registerMachine(hello("box-1", OLD));
    const m = cp.getMachine("box-1");
    expect(m?.imageId).toBe(OLD);
    expect(typeof m?.imageIdAt).toBe("string");
  });

  test("a hello with NO image id never erases the one we already knew", async () => {
    await cp.registerMachine(hello("box-1", OLD));
    await cp.registerMachine(hello("box-1")); // an older agent, or a dev box with no live image
    expect(cp.getMachine("box-1")?.imageId).toBe(OLD);
  });

  test("a heartbeat's report of a NEW id updates it and announces the change", async () => {
    await cp.registerMachine(hello("box-1", OLD));

    expect(await cp.noteMachineImage("box-1", NEW)).toBe(true);
    expect(cp.getMachine("box-1")?.imageId).toBe(NEW);
    expect(feed().some((l) => l.includes(NEW) && l.includes(OLD))).toBe(true);

    // The same id arrives every few seconds — it must be silent, and must not churn the store.
    const before = feed().length;
    expect(await cp.noteMachineImage("box-1", NEW)).toBe(false);
    expect(feed().length).toBe(before);
  });

  test("an unknown machine, and an empty id, are no-ops", async () => {
    expect(await cp.noteMachineImage("ghost", NEW)).toBe(false);
    await cp.registerMachine(hello("box-1", OLD));
    expect(await cp.noteMachineImage("box-1", "  ")).toBe(false);
    expect(cp.getMachine("box-1")?.imageId).toBe(OLD);
  });

  test("it is STORE state: it survives a restart, and an offline box still reports its build", async () => {
    await cp.registerMachine(hello("box-1", OLD));
    await cp.noteMachineImage("box-1", NEW);

    const restarted = new ControlPlane(store); // same store, fresh process
    await restarted.init();
    const m = restarted.getMachine("box-1");
    expect(m?.imageId).toBe(NEW); // nobody is connected — the answer is still there
  });

  test("tags and the image id are independent: a re-hello keeps both", async () => {
    await cp.registerMachine(hello("box-1", OLD));
    await cp.setMachineTags("box-1", ["canary"]);
    await cp.registerMachine(hello("box-1", NEW)); // the box reboots into the canary build

    const m = cp.getMachine("box-1");
    expect(m?.tags).toEqual(["canary"]); // the operator's tag survives the box's own report
    expect(m?.imageId).toBe(NEW);
    expect(cp.machineTags("box-1")).toEqual(["canary"]); // what the depot's manifest route reads
    expect(cp.machineTags("ghost")).toEqual([]); // an unknown box matches no ring
  });
});
