/**
 * POL-81 — the SshAccessManager: arm/disarm push to the box, reconcile on reconnect, agent-status
 * ingest, and the TTL sweep (shared tick with the shell). Fakes stand in for the WS + presence.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { FastifyBaseLogger } from "fastify";
import type { WebSocket } from "ws";

import { ActivityLog } from "../src/activity";
import { AgentHub } from "../src/hub";
import { Presence } from "../src/admin";
import { SshAccessManager } from "../src/ssh-access";
import { ControlPlane, type RegisterMachineInput } from "../src/state";
import { MemoryStore } from "../src/store/memory";

const OPEN = 1;
class FakeSocket {
  readyState = OPEN;
  readonly OPEN = OPEN;
  sent: any[] = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  last(): any {
    return this.sent[this.sent.length - 1];
  }
}

const noopLog = { info() {}, warn() {}, error() {} } as unknown as FastifyBaseLogger;
const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 operator@laptop";
const TTL = 60 * 60 * 1000;

function hello(machineId: string): RegisterMachineInput {
  return {
    machineId,
    agentVersion: "test",
    backend: "wayland-sway",
    outputs: [{ connector: "DP-1", width: 1920, height: 1080 }],
    hostname: "box",
  };
}

let store: MemoryStore;
let control: ControlPlane;
let agentHub: AgentHub;
let presence: Presence;
let broadcasts: number;
let manager: SshAccessManager;
let agentSock: FakeSocket;

beforeEach(async () => {
  store = new MemoryStore();
  control = new ControlPlane(store);
  await control.init();
  agentHub = new AgentHub();
  presence = new Presence();
  broadcasts = 0;
  const broadcaster = { broadcast() { broadcasts++; } } as any;
  manager = new SshAccessManager(agentHub, control, new ActivityLog(), presence, broadcaster, noopLog, {
    debugUser: "polyptic-debug",
    port: 22,
    ttlMs: TTL,
  });
  await control.registerMachine(hello("box-1"), undefined);
  agentSock = new FakeSocket();
  agentHub.add("box-1", agentSock as unknown as WebSocket);
});

describe("SshAccessManager", () => {
  test("arm pushes server/ssh-arm with the key + config", () => {
    const delivered = manager.arm("box-1", KEY);
    expect(delivered).toBe(1);
    expect(agentSock.last()).toMatchObject({ t: "server/ssh-arm", enabled: true, publicKey: KEY, debugUser: "polyptic-debug", port: 22 });
  });

  test("disarm pushes an enabled:false frame", () => {
    manager.disarm("box-1");
    expect(agentSock.last()).toMatchObject({ t: "server/ssh-arm", enabled: false });
  });

  test("reconcile re-pushes the arm for an armed box, and is a no-op when disarmed", async () => {
    await control.setSshEnabled("box-1", true, KEY);
    manager.reconcile("box-1");
    expect(agentSock.last()).toMatchObject({ t: "server/ssh-arm", enabled: true, publicKey: KEY });

    // Disarm, then reconcile → nothing new pushed.
    await control.setSshEnabled("box-1", false);
    const before = agentSock.sent.length;
    manager.reconcile("box-1");
    expect(agentSock.sent.length).toBe(before);
  });

  test("agent status is stored in Presence and broadcast", () => {
    manager.onStatusFromAgent("box-1", { armed: true, listening: true, host: "10.0.0.5", port: 22, user: "polyptic-debug" });
    expect(presence.sshStatus("box-1")).toMatchObject({ armed: true, listening: true, host: "10.0.0.5" });
    expect(broadcasts).toBeGreaterThan(0);
  });

  test("sweep disarms an expired box and pushes a disarm to it", async () => {
    await control.setSshEnabled("box-1", true, KEY);
    const armedAt = Date.parse(control.getMachine("box-1")!.sshArmedAt!);
    const disarmed = await manager.sweepExpired(armedAt + TTL + 1);
    expect(disarmed).toEqual(["box-1"]);
    expect(control.isSshEnabled("box-1")).toBe(false);
    expect(agentSock.last()).toMatchObject({ t: "server/ssh-arm", enabled: false });
  });

  test("sweep leaves a box within the TTL armed", async () => {
    await control.setSshEnabled("box-1", true, KEY);
    const armedAt = Date.parse(control.getMachine("box-1")!.sshArmedAt!);
    expect(await manager.sweepExpired(armedAt + TTL - 1)).toEqual([]);
    expect(control.isSshEnabled("box-1")).toBe(true);
  });
});
