/**
 * OTA (POL-28) setup-renderer unit tests — the systemd units + sudoers + slot-path helpers `polyptic-agent
 * setup` writes. Pure string/path generators (the agent carries them as source and writes them at
 * provision time), so they're testable without a booting VM. The live behaviour (a self-update reboots +
 * commits, a bad build auto-reverts) is flagged for VM/hardware verification by setup itself.
 */
import { describe, expect, test } from "bun:test";

import {
  OTA_SUDOERS_PATH,
  ROLLBACK_DELAY_SEC,
  otaDirFor,
  otaSlotExec,
  otaSudoers,
  rollbackServiceUnit,
  rollbackTimerUnit,
} from "../agent/src/setup/ota";
import { ROLLBACK_TIMER, agentServiceUnit, sessionTargetUnit } from "../agent/src/setup/templates";

describe("slot paths", () => {
  test("otaDirFor + otaSlotExec derive the kiosk-writable tree + the stable ExecStart", () => {
    const dir = otaDirFor("/home/kiosk");
    expect(dir).toBe("/home/kiosk/.polyptic/agent");
    expect(otaSlotExec(dir)).toBe("/home/kiosk/.polyptic/agent/current/polyptic-agent");
  });
});

describe("rollback guard units (standalone — must survive a crash-looping agent)", () => {
  const svc = rollbackServiceUnit({ frozenBin: "/usr/local/bin/polyptic-agent", otaDir: "/home/kiosk/.polyptic/agent" });
  const timer = rollbackTimerUnit();

  test("the oneshot runs the FROZEN binary's rollback-check, pinned to the slot dir", () => {
    expect(svc).toContain("ExecStart=/usr/local/bin/polyptic-agent rollback-check");
    expect(svc).toContain("Environment=POLYPTIC_OTA_DIR=/home/kiosk/.polyptic/agent");
    expect(svc).toContain("Type=oneshot");
  });

  test("the oneshot is NOT bound to the agent unit (no PartOf/BindsTo)", () => {
    expect(svc).not.toContain("PartOf=");
    expect(svc).not.toContain("BindsTo=");
  });

  test("the timer fires ~ROLLBACK_DELAY_SEC after activation and is wanted by the session target", () => {
    expect(timer).toContain(`OnActiveSec=${ROLLBACK_DELAY_SEC}s`);
    expect(timer).toContain("WantedBy=polyptic-session.target");
  });
});

describe("reboot sudoers (the one privileged OTA action)", () => {
  const rule = otaSudoers("kiosk");
  test("grants the kiosk user NOPASSWD reboot and nothing else", () => {
    expect(OTA_SUDOERS_PATH).toBe("/etc/sudoers.d/polyptic-ota");
    expect(rule).toContain("kiosk ALL=(root) NOPASSWD:");
    expect(rule).toContain("systemctl reboot");
    expect(rule).toContain("/sbin/reboot");
  });
});

describe("agent + session units gain OTA wiring", () => {
  test("session target Wants the rollback timer only when OTA is on", () => {
    expect(sessionTargetUnit({ withRollbackTimer: true })).toContain(`Wants=polyptic-agent.service\nWants=${ROLLBACK_TIMER}`);
    expect(sessionTargetUnit({ withRollbackTimer: false })).not.toContain(ROLLBACK_TIMER);
    expect(sessionTargetUnit()).not.toContain(ROLLBACK_TIMER);
  });

  test("agent unit ExecStart points at the slot symlink + pins POLYPTIC_OTA_DIR when OTA is on", () => {
    const withOta = agentServiceUnit({
      agentBin: "/home/kiosk/.polyptic/agent/current/polyptic-agent",
      configPath: "/etc/polyptic/agent.toml",
      otaDir: "/home/kiosk/.polyptic/agent",
    });
    expect(withOta).toContain("ExecStart=/home/kiosk/.polyptic/agent/current/polyptic-agent");
    expect(withOta).toContain("Environment=POLYPTIC_OTA_DIR=/home/kiosk/.polyptic/agent");

    // Without OTA (--no-ota) the unit runs the binary directly and carries no OTA env.
    const noOta = agentServiceUnit({ agentBin: "/usr/local/bin/polyptic-agent", configPath: "/etc/polyptic/agent.toml" });
    expect(noOta).toContain("ExecStart=/usr/local/bin/polyptic-agent");
    expect(noOta).not.toContain("POLYPTIC_OTA_DIR");
  });
});
