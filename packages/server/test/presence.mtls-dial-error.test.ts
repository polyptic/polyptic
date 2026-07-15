/**
 * POL-143 — Presence holds a box's own report that it CANNOT reach the mTLS listener (the URL it
 * dialled, the consecutive-failure count, when it last said so). This is what lets the console stop
 * promising "moves over on next connection" forever and say WHY a migration stalled.
 *
 * The contract pinned here:
 *   - edge detection: the caller narrates ONE feed line per real change (first report, or the
 *     dialled URL changed), never one per fallback cycle — the agent re-reports on every retry;
 *   - clear on proof: an mTLS-channel hello disproves the error, so it is cleared;
 *   - clear on drop: a fully-offline box's report describes a session that no longer exists.
 */
import { describe, expect, test } from "bun:test";

import { Presence } from "../src/admin";

const report = (url: string, attempts: number) => ({ url, attempts, at: new Date().toISOString() });

describe("Presence.setMachineMtlsDialError — edges out, one feed line per real change (POL-143)", () => {
  test("reports a change on the first report and when the dialled URL changes, not on repeats", () => {
    const p = new Presence();
    expect(p.setMachineMtlsDialError("m1", report("wss://polyptic.homelab:8443/agent", 1))).toBe(true); // first
    expect(p.setMachineMtlsDialError("m1", report("wss://polyptic.homelab:8443/agent", 2))).toBe(false); // same door, more fails
    expect(p.setMachineMtlsDialError("m1", report("wss://polyptic.homelab:8443/agent", 7))).toBe(false); // still the same door
    expect(p.setMachineMtlsDialError("m1", report("wss://polyptic.homelab:30843/agent", 1))).toBe(true); // NEW door → narrate again
  });

  test("holds the latest report for the settings card to render", () => {
    const p = new Presence();
    expect(p.machineMtlsDialError("m1")).toBeUndefined();
    p.setMachineMtlsDialError("m1", report("wss://polyptic.homelab:8443/agent", 3));
    expect(p.machineMtlsDialError("m1")).toMatchObject({ url: "wss://polyptic.homelab:8443/agent", attempts: 3 });
  });

  test("an mTLS-channel hello disproves the error — clear it", () => {
    const p = new Presence();
    p.setMachineMtlsDialError("m1", report("wss://polyptic.homelab:8443/agent", 4));
    p.clearMachineMtlsDialError("m1");
    expect(p.machineMtlsDialError("m1")).toBeUndefined();
  });

  test("a fully-offline box clears its dial error with the rest of its live state", () => {
    const p = new Presence();
    p.agentConnected("m1", "plain");
    p.setMachineMtlsDialError("m1", report("wss://polyptic.homelab:8443/agent", 5));
    p.setMachineMtlsDialError("m2", report("wss://polyptic.homelab:8443/agent", 5));
    p.agentDisconnected("m1");
    expect(p.machineMtlsDialError("m1")).toBeUndefined();
    expect(p.machineMtlsDialError("m2")).toBeDefined(); // another box's report is untouched
  });

  test("overlapping sessions keep the report until the LAST one drops", () => {
    const p = new Presence();
    p.agentConnected("m1", "plain");
    p.agentConnected("m1", "plain"); // a reconnect races the old socket
    p.setMachineMtlsDialError("m1", report("wss://polyptic.homelab:8443/agent", 2));
    p.agentDisconnected("m1"); // one socket closes; the box is still online
    expect(p.machineMtlsDialError("m1")).toBeDefined();
    p.agentDisconnected("m1"); // now fully offline
    expect(p.machineMtlsDialError("m1")).toBeUndefined();
  });
});
