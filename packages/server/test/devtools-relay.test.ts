/**
 * POL-67 — the remote-DevTools relay's gating and lifecycle, driven directly (no real WS).
 *
 * These pin the security-load-bearing behaviour, mirroring shell-relay.test.ts (same trust model —
 * the debugging port is code-exec-adjacent): the tunnel only relays for an APPROVED, ONLINE machine
 * whose screen an operator ARMED (the `inspecting` flag, set only by the agent's ack); disarming
 * severs live sessions; a dropped agent ends sessions AND fails pending proxied GETs.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { FastifyBaseLogger } from "fastify";
import type { WebSocket } from "ws";

import { ActivityLog } from "../src/activity";
import { Presence } from "../src/admin";
import { AgentHub } from "../src/hub";
import { DevtoolsRelay } from "../src/devtools-relay";
import { ControlPlane, type RegisterMachineInput } from "../src/state";
import { MemoryStore } from "../src/store/memory";

const OPEN = 1;

/** A stand-in for a ws.WebSocket that records frames/closes and can replay listeners. */
class FakeSocket {
  readyState = OPEN;
  readonly OPEN = OPEN;
  /** Raw frames as sent — CDP text stays text; JSON control frames are parsed via last(). */
  sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  private readonly listeners = new Map<string, ((...args: any[]) => void)[]>();
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
  terminate(): void {
    this.closed = { code: 1006 };
  }
  on(event: string, cb: (...args: any[]) => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(cb);
    this.listeners.set(event, list);
    return this;
  }
  emit(event: string, ...args: any[]): void {
    for (const cb of this.listeners.get(event) ?? []) cb(...args);
  }
  /** The last frame, JSON-parsed (relay control frames are always JSON). */
  last(): any {
    const raw = this.sent[this.sent.length - 1];
    return raw === undefined ? undefined : JSON.parse(raw);
  }
  /** The last frame verbatim — what a CDP client would receive. */
  lastRaw(): string | undefined {
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
    browser: "chrome",
    outputs: [{ connector: "DP-1", width: 1920, height: 1080 }],
    hostname: "box",
  };
}

let store: MemoryStore;
let control: ControlPlane;
let agentHub: AgentHub;
let presence: Presence;
let relay: DevtoolsRelay;
let agentSock: FakeSocket;
let screenId: string;

beforeEach(async () => {
  store = new MemoryStore();
  control = new ControlPlane(store);
  await control.init();
  agentHub = new AgentHub();
  presence = new Presence();
  relay = new DevtoolsRelay(agentHub, control, presence, new ActivityLog(), noopLog);
  // A registered, approved, online box with one screen.
  await control.registerMachine(hello("box-1"), undefined);
  agentSock = new FakeSocket();
  agentHub.add("box-1", agentSock as unknown as WebSocket);
  const screen = control.getScreens().find((s) => s.machineId === "box-1");
  if (!screen) throw new Error("registerMachine created no screen");
  screenId = screen.id;
});

const lastToAgent = (): any => agentSock.last();
const arm = (): void => presence.setScreenInspecting(screenId, true);

describe("DevtoolsRelay gating (POL-67)", () => {
  test("refuses a proxied GET when the screen is NOT armed", async () => {
    await expect(relay.request(screenId, "/json/list")).rejects.toThrow(/not armed/);
    expect(agentSock.sent).toHaveLength(0);
  });

  test("refuses when the machine is offline, even if armed", async () => {
    arm();
    agentHub.remove("box-1", agentSock as unknown as WebSocket);
    await expect(relay.request(screenId, "/json/list")).rejects.toThrow(/offline/);
  });

  test("proxies a GET once armed and resolves with the agent's answer", async () => {
    arm();
    const promise = relay.request(screenId, "/json/list");
    const sent = lastToAgent();
    expect(sent).toMatchObject({ t: "server/devtools-request", connector: "DP-1", path: "/json/list" });
    relay.responseFromAgent(
      "box-1",
      sent.reqId,
      true,
      200,
      "application/json",
      Buffer.from("[]").toString("base64"),
    );
    const res = await promise;
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe("[]");
  });

  test("an agent refusal rejects the proxied GET with its reason", async () => {
    arm();
    const promise = relay.request(screenId, "/json/list");
    relay.responseFromAgent("box-1", lastToAgent().reqId, false, undefined, undefined, undefined, "not armed on the box");
    await expect(promise).rejects.toThrow("not armed on the box");
  });

  test("refuses a CDP session when not armed — closes the client with policy code 1008", () => {
    const client = new FakeSocket();
    relay.openFromClient(client as unknown as WebSocket, screenId, "/devtools/page/abc");
    expect(client.closed?.code).toBe(1008);
    expect(agentSock.sent).toHaveLength(0);
  });

  test("bridges a CDP session once armed: open, both-way data, close from the box", () => {
    arm();
    const client = new FakeSocket();
    relay.openFromClient(client as unknown as WebSocket, screenId, "/devtools/page/abc");
    const open = lastToAgent();
    expect(open).toMatchObject({ t: "server/devtools-open", connector: "DP-1", path: "/devtools/page/abc" });
    const sessionId = open.sessionId as string;

    relay.openedFromAgent("box-1", sessionId, true);
    // operator → box
    client.emit("message", Buffer.from('{"id":1}'));
    expect(lastToAgent()).toMatchObject({ t: "server/devtools-data", sessionId });
    expect(Buffer.from(lastToAgent().dataBase64, "base64").toString()).toBe('{"id":1}');
    // box → operator (text frame out, verbatim)
    relay.dataFromAgent("box-1", sessionId, Buffer.from('{"id":1,"result":{}}').toString("base64"));
    expect(client.lastRaw()).toBe('{"id":1,"result":{}}');
    // box closes
    relay.closedFromAgent("box-1", sessionId, "page navigated away");
    expect(client.closed?.code).toBe(1000);
  });

  test("frames sent before the agent confirms the open are buffered, then flushed", () => {
    arm();
    const client = new FakeSocket();
    relay.openFromClient(client as unknown as WebSocket, screenId, "/devtools/page/abc");
    const sessionId = lastToAgent().sessionId as string;
    client.emit("message", Buffer.from('{"id":1}'));
    // Not yet forwarded — still the open frame.
    expect(lastToAgent().t).toBe("server/devtools-open");
    relay.openedFromAgent("box-1", sessionId, true);
    expect(lastToAgent()).toMatchObject({ t: "server/devtools-data", sessionId });
  });

  test("disarming severs a live session on both sides", () => {
    arm();
    const client = new FakeSocket();
    relay.openFromClient(client as unknown as WebSocket, screenId, "/devtools/page/abc");
    const sessionId = lastToAgent().sessionId as string;
    relay.openedFromAgent("box-1", sessionId, true);

    presence.setScreenInspecting(screenId, false);
    relay.closeScreenSessions(screenId, "DevTools disarmed");
    expect(lastToAgent()).toMatchObject({ t: "server/devtools-close", sessionId });
    expect(client.closed?.reason).toContain("disarmed");
  });

  test("a disarm mid-session makes the next operator frame close the session, not relay", () => {
    arm();
    const client = new FakeSocket();
    relay.openFromClient(client as unknown as WebSocket, screenId, "/devtools/page/abc");
    const sessionId = lastToAgent().sessionId as string;
    relay.openedFromAgent("box-1", sessionId, true);

    presence.setScreenInspecting(screenId, false); // disarm without the REST hook
    client.emit("message", Buffer.from('{"id":2}'));
    expect(lastToAgent()).toMatchObject({ t: "server/devtools-close", sessionId });
    expect(client.closed).not.toBeNull();
  });

  test("agent disconnect ends live sessions and fails pending GETs", async () => {
    arm();
    const client = new FakeSocket();
    relay.openFromClient(client as unknown as WebSocket, screenId, "/devtools/page/abc");
    relay.openedFromAgent("box-1", lastToAgent().sessionId as string, true);
    const pending = relay.request(screenId, "/json/version");

    relay.agentDisconnected("box-1");
    expect(client.closed?.code).toBe(1001);
    await expect(pending).rejects.toThrow(/offline/);
  });

  test("another machine's frames cannot touch the session", () => {
    arm();
    const client = new FakeSocket();
    relay.openFromClient(client as unknown as WebSocket, screenId, "/devtools/page/abc");
    const sessionId = lastToAgent().sessionId as string;
    relay.openedFromAgent("box-1", sessionId, true);

    relay.dataFromAgent("box-2", sessionId, Buffer.from("evil").toString("base64"));
    expect(client.sent).toHaveLength(0);
    relay.closedFromAgent("box-2", sessionId);
    expect(client.closed).toBeNull();
  });
});
