/**
 * POL-81 — the agent's operator-SSH seam. The pure, filesystem-free parts: the refusal decision (a
 * dev laptop must never sprout an sshd), the request-file rendering (what the root helper parses), and
 * the primary-IP pick. `applySshArm` on a refusing backend must NOT touch the filesystem at all.
 */
import { describe, expect, test } from "bun:test";

import { applySshArm, primaryIpv4, renderSshRequest, sshRefusal } from "../src/ssh";

describe("sshRefusal (POL-81)", () => {
  test("refuses on the dev-open backend", () => {
    expect(sshRefusal("dev-open")).toContain("developer's own machine");
  });
  test("refuses on a non-Linux host", () => {
    expect(sshRefusal("wayland-sway", "darwin")).toContain("only implemented for Linux");
  });
  test("allows a real Linux kiosk backend", () => {
    expect(sshRefusal("wayland-sway", "linux")).toBeNull();
    expect(sshRefusal("x11-i3", "linux")).toBeNull();
  });
});

describe("renderSshRequest (POL-81)", () => {
  test("arm carries op/user/port/ttl + key, key LAST", () => {
    const out = renderSshRequest({
      enabled: true,
      publicKey: "ssh-ed25519 AAAA operator@laptop",
      debugUser: "polyptic-debug",
      port: 22,
      ttlMs: 3_600_000,
    });
    expect(out).toBe("op=arm\nuser=polyptic-debug\nport=22\nttl=3600\nkey=ssh-ed25519 AAAA operator@laptop\n");
  });

  test("disarm carries op=disarm and NO key", () => {
    const out = renderSshRequest({ enabled: false, debugUser: "polyptic-debug", port: 22, ttlMs: 3_600_000 });
    expect(out).toContain("op=disarm");
    expect(out).not.toContain("key=");
  });
});

describe("primaryIpv4 (POL-81)", () => {
  test("returns the first non-internal IPv4", () => {
    const ip = primaryIpv4({
      lo: [{ family: "IPv4", address: "127.0.0.1", internal: true } as any],
      eth0: [{ family: "IPv4", address: "10.0.0.5", internal: false } as any],
    });
    expect(ip).toBe("10.0.0.5");
  });
  test("undefined when only loopback exists", () => {
    expect(primaryIpv4({ lo: [{ family: "IPv4", address: "127.0.0.1", internal: true } as any] })).toBeUndefined();
  });
});

describe("applySshArm refusal (POL-81)", () => {
  test("a dev-open backend refuses without arming or touching the filesystem", async () => {
    const status = await applySshArm(
      "dev-open",
      { enabled: true, publicKey: "ssh-ed25519 AAAA", debugUser: "polyptic-debug", port: 22, ttlMs: 3_600_000 },
      async () => true,
    );
    expect(status.armed).toBe(false);
    expect(status.listening).toBe(false);
    expect(status.reason).toContain("developer's own machine");
  });
});
