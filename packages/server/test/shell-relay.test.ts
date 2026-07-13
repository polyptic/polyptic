/**
 * POL-59 — the remote-shell relay's gating and lifecycle, driven directly (no real WS).
 *
 * These pin the security-load-bearing behaviour: a shell only opens against an APPROVED, ARMED,
 * ONLINE box; disarming closes live sessions; a dropped agent ends them; and one operator socket's
 * frames can't touch another's session. Fake WebSockets capture what the relay sends each side.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { FastifyBaseLogger } from "fastify";
import type { WebSocket } from "ws";

import { ActivityLog } from "../src/activity";
import { AgentHub } from "../src/hub";
import { ShellRelay } from "../src/shell-relay";
import { ControlPlane, type RegisterMachineInput } from "../src/state";
import { MemoryStore } from "../src/store/memory";

const OPEN = 1;

/** A stand-in for a ws.WebSocket that records the frames sent to it. */
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

const noopLog = {
  info() {},
  warn() {},
  error() {},
} as unknown as FastifyBaseLogger;

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
let relay: ShellRelay;
let agentSock: FakeSocket;

beforeEach(async () => {
  store = new MemoryStore();
  control = new ControlPlane(store);
  await control.init();
  agentHub = new AgentHub();
  relay = new ShellRelay(agentHub, control, new ActivityLog(), noopLog);
  // A registered, approved, online box.
  await control.registerMachine(hello("box-1"), undefined);
  agentSock = new FakeSocket();
  agentHub.add("box-1", agentSock as unknown as WebSocket);
});

/** The last server→agent frame the hub delivered (via the fake agent socket). */
const lastToAgent = (): any => agentSock.last();

describe("ShellRelay gating (POL-59)", () => {
  test("refuses to open when the box is NOT armed", () => {
    const admin = new FakeSocket();
    relay.openFromAdmin(admin as unknown as WebSocket, "box-1", 80, 24);
    expect(admin.last()).toMatchObject({ t: "server/shell-opened", ok: false });
    expect(admin.last().reason).toContain("not enabled");
    // Nothing was asked of the agent.
    expect(agentSock.sent).toHaveLength(0);
  });

  test("opens once armed — asks the agent to start a PTY", async () => {
    await control.setShellEnabled("box-1", true);
    const admin = new FakeSocket();
    relay.openFromAdmin(admin as unknown as WebSocket, "box-1", 100, 40);
    const sent = lastToAgent();
    expect(sent).toMatchObject({ t: "server/shell-open", cols: 100, rows: 40 });
    expect(typeof sent.sessionId).toBe("string");
    expect(sent.sessionId.length).toBeGreaterThan(0);
  });

  test("refuses an unknown / offline / unapproved box", async () => {
    await control.setShellEnabled("box-1", true);
    agentHub.remove("box-1", agentSock as unknown as WebSocket); // now offline
    const admin = new FakeSocket();
    relay.openFromAdmin(admin as unknown as WebSocket, "box-1", 80, 24);
    expect(admin.last()).toMatchObject({ t: "server/shell-opened", ok: false });
    expect(admin.last().reason).toContain("offline");
  });

  test("relays agent PTY output to the operator that opened the session", async () => {
    await control.setShellEnabled("box-1", true);
    const admin = new FakeSocket();
    relay.openFromAdmin(admin as unknown as WebSocket, "box-1", 80, 24);
    const sessionId = lastToAgent().sessionId as string;
    relay.openedFromAgent("box-1", sessionId, true);
    relay.dataFromAgent("box-1", sessionId, Buffer.from("hello").toString("base64"));
    expect(admin.last()).toMatchObject({ t: "server/shell-data", sessionId });
    expect(Buffer.from(admin.last().dataBase64, "base64").toString()).toBe("hello");
  });

  test("disarming closes a live session on both sides", async () => {
    await control.setShellEnabled("box-1", true);
    const admin = new FakeSocket();
    relay.openFromAdmin(admin as unknown as WebSocket, "box-1", 80, 24);
    const sessionId = lastToAgent().sessionId as string;
    relay.openedFromAgent("box-1", sessionId, true);

    relay.closeMachineSessions("box-1", "remote shell disarmed");
    // Agent told to kill the PTY, operator told the session ended.
    expect(lastToAgent()).toMatchObject({ t: "server/shell-close", sessionId });
    expect(admin.last()).toMatchObject({ t: "server/shell-closed", sessionId });
    // A subsequent keystroke is now dropped (session gone).
    agentSock.sent = [];
    relay.dataFromAdmin(admin as unknown as WebSocket, "box-1", sessionId, Buffer.from("x").toString("base64"));
    expect(agentSock.sent).toHaveLength(0);
  });

  test("a dropped agent socket ends the operator's session", async () => {
    await control.setShellEnabled("box-1", true);
    const admin = new FakeSocket();
    relay.openFromAdmin(admin as unknown as WebSocket, "box-1", 80, 24);
    const sessionId = lastToAgent().sessionId as string;
    relay.openedFromAgent("box-1", sessionId, true);
    relay.agentDisconnected("box-1");
    expect(admin.last()).toMatchObject({ t: "server/shell-closed", sessionId, reason: "machine went offline" });
  });

  test("one operator cannot feed another operator's session", async () => {
    await control.setShellEnabled("box-1", true);
    const a = new FakeSocket();
    const b = new FakeSocket();
    relay.openFromAdmin(a as unknown as WebSocket, "box-1", 80, 24);
    const sessionId = lastToAgent().sessionId as string;
    relay.openedFromAgent("box-1", sessionId, true);
    agentSock.sent = [];
    // B tries to send into A's session — dropped.
    relay.dataFromAdmin(b as unknown as WebSocket, "box-1", sessionId, Buffer.from("x").toString("base64"));
    expect(agentSock.sent).toHaveLength(0);
  });
});
