/**
 * A connector that VANISHES and COMES BACK — the field case, with real evidence behind it.
 *
 * Two production screens went dark and nothing could bring them back. One box advertised only `DP-2`
 * for 69 consecutive hellos while its screen record was bound to `DP-1`; another advertised ZERO
 * outputs for 93 hellos while its screen was bound to `DP-2`. A DisplayPort panel switched off drops
 * its link, and the connector leaves the compositor's output list — so from that moment the screen
 * identity the control plane addresses does not exist on that box, and every command aimed at it was
 * refused in the box's own words ("DP-1 is not a known sway output"). Restarting the box brought the
 * connector back, and the screens worked again.
 *
 * What is pinned here is the pair of edges the control plane has to see on re-advertise:
 *   - a connector GOING: the screen record survives (POL-9 — a panel switched off overnight must not
 *     delete an operator's work) and the machine reports which screens have no output behind them;
 *   - a connector COMING BACK: the screen is named as REBOUND, so the caller re-asserts its desired
 *     state, and its assignment carries its content again without an operator touching anything.
 *
 * The POL-9 guards are deliberately re-tested from this angle: an EMPTY advertise is "no info", never
 * "they're gone", and a used screen is never pruned. See state.prune.test.ts for the other half.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import type { Output } from "@polyptic/protocol";
import { ActivityLog } from "../src/activity";
import { buildAdminState, Presence } from "../src/admin";
import { PlayerHub } from "../src/hub";
import { ControlPlane, type RegisterMachineInput } from "../src/state";
import { MemoryStore } from "../src/store/memory";

function outputs(...connectors: string[]): Output[] {
  return connectors.map((connector) => ({ connector, width: 1920, height: 1080 }));
}

function hello(machineId: string, ...connectors: string[]): RegisterMachineInput {
  return {
    machineId,
    agentVersion: "test",
    backend: "wayland-sway",
    outputs: outputs(...connectors),
    hostname: "test-box",
  };
}

let store: MemoryStore;
let cp: ControlPlane;

/** Put content on a screen so POL-9 treats it as USED — the field screens were placed and playing. */
async function useScreen(screenId: string): Promise<void> {
  await cp.setDemoWeb(screenId, "https://example.com/");
}

beforeEach(async () => {
  store = new MemoryStore();
  cp = new ControlPlane(store);
  await cp.init();
});

describe("a connector that vanishes and returns", () => {
  test("a first hello rebinds nothing — every connector is new, none came back", async () => {
    const result = await cp.registerMachine(hello("m1", "DP-1", "DP-2"));
    expect(result.reboundScreenIds).toEqual([]);
    expect(result.unadvertisedScreenIds).toEqual([]);
  });

  test("an unchanged reconnect rebinds nothing", async () => {
    await cp.registerMachine(hello("m1", "DP-1"));
    const again = await cp.registerMachine(hello("m1", "DP-1"));
    expect(again.reboundScreenIds).toEqual([]);
    expect(again.unadvertisedScreenIds).toEqual([]);
  });

  test("the wall right box: DP-1 goes, the screen survives and is named as unreachable", async () => {
    await cp.registerMachine(hello("m1", "DP-1", "DP-2"));
    const screen = cp.getScreens().find((s) => s.connector === "DP-1")!;
    await useScreen(screen.id);

    const gone = await cp.registerMachine(hello("m1", "DP-2"));
    expect(gone.unadvertisedScreenIds).toEqual([screen.id]);
    // The record is INTACT: a panel switched off overnight is not a reason to delete a screen.
    expect(cp.getScreen(screen.id)).toBeDefined();
    expect(cp.isConnectorAdvertised("m1", "DP-1")).toBe(false);
  });

  test("…and when DP-1 comes back, the SAME screen is rebound, with its content", async () => {
    await cp.registerMachine(hello("m1", "DP-1", "DP-2"));
    const screen = cp.getScreens().find((s) => s.connector === "DP-1")!;
    await useScreen(screen.id);
    await cp.registerMachine(hello("m1", "DP-2"));

    const back = await cp.registerMachine(hello("m1", "DP-1", "DP-2"));
    expect(back.reboundScreenIds).toEqual([screen.id]);
    expect(back.unadvertisedScreenIds).toEqual([]);
    // Same identity, and the apply that goes out carries its player URL — the screen is addressable
    // again without an operator re-placing anything.
    const assignment = back.assignments.find((a) => a.connector === "DP-1");
    expect(assignment?.screenId).toBe(screen.id);
    expect(assignment?.playerUrl).toContain(screen.id);
    expect(cp.isConnectorAdvertised("m1", "DP-1")).toBe(true);
  });

  test("the kiosk box: ZERO outputs, then DP-2 returns — the screen is rebound", async () => {
    await cp.registerMachine(hello("m1", "DP-2"));
    const screen = cp.getScreens()[0]!;
    await useScreen(screen.id);

    // 93 hellos advertising nothing at all. POL-9: no info ≠ "it's gone", so nothing is pruned…
    const empty = await cp.registerMachine(hello("m1"));
    expect(cp.getScreens().map((s) => s.id)).toEqual([screen.id]);
    // …but the screen IS unreachable, and the control plane says so rather than staying quiet.
    expect(empty.unadvertisedScreenIds).toEqual([screen.id]);

    const back = await cp.registerMachine(hello("m1", "DP-2"));
    expect(back.reboundScreenIds).toEqual([screen.id]);
  });

  test("a connector seen for the FIRST time is a new screen, not a rebind", async () => {
    await cp.registerMachine(hello("m1", "DP-1"));
    const grew = await cp.registerMachine(hello("m1", "DP-1", "HDMI-A-1"));
    expect(grew.reboundScreenIds).toEqual([]); // a panel plugged in for the first time was never away
    expect(cp.getScreens()).toHaveLength(2);
  });

  test("an UNUSED screen whose connector goes is still pruned (POL-9), so it cannot rebind", async () => {
    await cp.registerMachine(hello("m1", "HDMI-1")); // the old guessed phantom
    await cp.registerMachine(hello("m1", "DP-1"));
    expect(cp.getScreens().map((s) => s.connector)).toEqual(["DP-1"]);

    const back = await cp.registerMachine(hello("m1", "HDMI-1", "DP-1"));
    expect(back.reboundScreenIds).toEqual([]); // nothing survived to rebind; a fresh screen is created
    expect(cp.getScreens().map((s) => s.connector).sort()).toEqual(["DP-1", "HDMI-1"]);
  });

  /**
   * What the console is given to paint with. `connectorMissing` is the whole point of the field
   * ticket: an operator looking at these two screens saw the vocabulary of a healthy sleeping panel.
   */
  test("admin/state marks the screen whose connector the ONLINE box is not reporting", async () => {
    await cp.registerMachine(hello("m1", "DP-1", "DP-2"));
    const screen = cp.getScreens().find((s) => s.connector === "DP-1")!;
    await useScreen(screen.id);
    const presence = new Presence();
    presence.agentConnected("m1");
    const activity = new ActivityLog();
    const playerHub = new PlayerHub();
    const viewOf = (id: string) =>
      buildAdminState(cp, playerHub, presence, activity)
        .machines.find((m) => m.id === "m1")
        ?.screens.find((s) => s.id === id);

    expect(viewOf(screen.id)?.connectorMissing).toBeUndefined(); // reported: nothing to say

    await cp.registerMachine(hello("m1", "DP-2"));
    expect(viewOf(screen.id)?.connectorMissing).toBe(true);
    // Its neighbour is untouched — this is a per-screen fact, not a machine-wide alarm.
    const neighbour = cp.getScreens().find((s) => s.connector === "DP-2")!;
    expect(viewOf(neighbour.id)?.connectorMissing).toBeUndefined();

    // A box that has gone dark makes no claim about its outputs: the flag is live-only.
    presence.agentDisconnected("m1");
    expect(viewOf(screen.id)?.connectorMissing).toBeUndefined();

    presence.agentConnected("m1");
    await cp.registerMachine(hello("m1", "DP-1", "DP-2"));
    expect(viewOf(screen.id)?.connectorMissing).toBeUndefined(); // back, and reading as healthy again
  });

  test("only the re-advertising machine is affected", async () => {
    await cp.registerMachine(hello("m1", "DP-1"));
    await cp.registerMachine(hello("m2", "DP-1"));
    await useScreen(cp.getScreens().find((s) => s.machineId === "m1")!.id);
    await useScreen(cp.getScreens().find((s) => s.machineId === "m2")!.id);

    const gone = await cp.registerMachine(hello("m1"));
    expect(gone.unadvertisedScreenIds).toHaveLength(1);
    expect(cp.isConnectorAdvertised("m2", "DP-1")).toBe(true);
  });
});
