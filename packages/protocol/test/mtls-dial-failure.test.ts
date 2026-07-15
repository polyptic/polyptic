/**
 * POL-143 — the wire contract that lets an unreachable mTLS door SURFACE instead of the console
 * promising "moves over on next connection" forever.
 *
 * Two seams:
 *   - `AgentHello.mtlsDialFailure` — the box's own account, on a PLAIN hello, of why it is not on
 *     the secure channel despite holding a cert: the URL it dialled and how many dials failed.
 *   - `AgentSecurityInfo.machines[].mtlsDialError` — what the settings surface renders from it.
 *
 * Both are OPTIONAL: a first-contact hello, an mTLS-channel hello, and a healthy fleet all omit
 * them, and a pre-POL-143 agent that never sends the field must keep parsing.
 */
import { describe, expect, test } from "bun:test";

import { AgentHello, AgentSecurityInfo } from "../src/index";

describe("AgentHello.mtlsDialFailure (POL-143)", () => {
  const base = {
    t: "agent/hello" as const,
    protocol: 1,
    machineId: "box-1",
    agentVersion: "test",
    backend: "wayland-sway",
    outputs: [{ connector: "HDMI-1", width: 1920, height: 1080 }],
  };

  test("a hello WITHOUT the field still parses (a pre-POL-143 agent, or a healthy box)", () => {
    const parsed = AgentHello.parse(base);
    expect(parsed.mtlsDialFailure).toBeUndefined();
  });

  test("carries the dialled URL and the consecutive-failure count", () => {
    const parsed = AgentHello.parse({
      ...base,
      mtlsDialFailure: { url: "wss://polyptic.homelab:8443/agent", attempts: 6 },
    });
    expect(parsed.mtlsDialFailure).toEqual({ url: "wss://polyptic.homelab:8443/agent", attempts: 6 });
  });

  test("attempts must be a positive integer — a zero/negative count is nonsense, never a report", () => {
    for (const attempts of [0, -1, 1.5]) {
      expect(() =>
        AgentHello.parse({ ...base, mtlsDialFailure: { url: "wss://x/agent", attempts } }),
      ).toThrow();
    }
  });
});

describe("AgentSecurityInfo.machines[].mtlsDialError (POL-143)", () => {
  const info = (machine: Record<string, unknown>) =>
    AgentSecurityInfo.parse({ mode: "migrating", pinned: false, machines: [{ id: "m1", label: "wall1", online: true, ...machine }] });

  test("a machine without the field parses (the common case)", () => {
    expect(info({}).machines[0]!.mtlsDialError).toBeUndefined();
  });

  test("carries url + attempts + when it was last reported", () => {
    const at = new Date().toISOString();
    const parsed = info({ mtlsDialError: { url: "wss://polyptic.homelab:8443/agent", attempts: 4, at } });
    expect(parsed.machines[0]!.mtlsDialError).toEqual({ url: "wss://polyptic.homelab:8443/agent", attempts: 4, at });
  });
});
