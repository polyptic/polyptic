/**
 * POL-81 — operator SSH access contracts. The public-key validator is a friendly-error edge gate
 * (the box re-validates before authorized_keys); the arm body enforces "a key is required to arm".
 */
import { describe, expect, test } from "bun:test";

import {
  AgentSshStatus,
  ServerToAgentSshArm,
  SshArmBody,
  SshPublicKey,
  SSH_DEBUG_USER,
  SSH_DEFAULT_PORT,
} from "../src/index";

describe("SshPublicKey", () => {
  test("accepts common key types", () => {
    for (const k of [
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI comment",
      "ssh-rsa AAAAB3NzaC1yc2E",
      "ecdsa-sha2-nistp256 AAAAE2Vj",
      "sk-ssh-ed25519@openssh.com AAAAG",
    ]) {
      expect(SshPublicKey.safeParse(k).success).toBe(true);
    }
  });

  test("rejects multi-line, empty, and non-key strings", () => {
    expect(SshPublicKey.safeParse("ssh-ed25519 AAAA\nrm -rf /").success).toBe(false);
    expect(SshPublicKey.safeParse("").success).toBe(false);
    expect(SshPublicKey.safeParse("not a key").success).toBe(false);
    expect(SshPublicKey.safeParse("ssh-ed25519").success).toBe(false); // no key body
  });
});

describe("SshArmBody", () => {
  test("arming requires a public key", () => {
    expect(SshArmBody.safeParse({ enabled: true }).success).toBe(false);
    expect(SshArmBody.safeParse({ enabled: true, publicKey: "ssh-ed25519 AAAA" }).success).toBe(true);
  });

  test("disarming needs no key", () => {
    expect(SshArmBody.safeParse({ enabled: false }).success).toBe(true);
  });
});

describe("ServerToAgentSshArm", () => {
  test("defaults debugUser/port/ttl", () => {
    const msg = ServerToAgentSshArm.parse({ t: "server/ssh-arm", enabled: false });
    expect(msg.debugUser).toBe(SSH_DEBUG_USER);
    expect(msg.port).toBe(SSH_DEFAULT_PORT);
    expect(msg.ttlMs).toBe(60 * 60 * 1000);
  });
});

describe("AgentSshStatus", () => {
  test("carries the connection details and defaults listening=false", () => {
    const msg = AgentSshStatus.parse({ t: "agent/ssh-status", machineId: "box-1", armed: true, host: "10.0.0.5", port: 22, user: SSH_DEBUG_USER });
    expect(msg.armed).toBe(true);
    expect(msg.listening).toBe(false);
    expect(msg.host).toBe("10.0.0.5");
  });
});
