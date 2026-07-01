/**
 * OTA (POL-28) — setup-side provisioning for over-the-air self-updates.
 *
 * Gives the box an UNPRIVILEGED A/B slot tree in the kiosk user's home, points the agent unit's
 * ExecStart at a stable `current` symlink (the unit file is NEVER rewritten by an update — OTA only
 * flips symlinks), and installs the STANDALONE rollback guard (a systemd user timer + oneshot that is
 * deliberately not bound to the agent unit, so it still fires and reverts a crash-looping new agent).
 * The one privileged action an update needs — a reboot — is confined to a narrow sudoers rule.
 *
 *   ${otaDir}/current -> versions/<version>/polyptic-agent   ← agent unit ExecStart
 *   ${otaDir}/previous -> versions/<oldversion>              ← retained rollback slot
 *
 * The FROZEN `/usr/local/bin/polyptic-agent` (never OTA'd) runs `setup` + `rollback-check`, so the
 * guard works even when the new slot's binary is broken.
 */
import { basename } from "node:path";

import type { Logger } from "./log";
import type { Sys } from "./system";
import { ROLLBACK_SERVICE, ROLLBACK_TIMER, SESSION_TARGET } from "./templates";

const MANAGED = "managed by `polyptic-agent setup` — re-running setup may overwrite this file.";

export { ROLLBACK_SERVICE, ROLLBACK_TIMER } from "./templates";
export const OTA_SUDOERS_PATH = "/etc/sudoers.d/polyptic-ota";
/** Fire the rollback guard this long after the kiosk session starts (must exceed reboot + commit). */
export const ROLLBACK_DELAY_SEC = 300;

/** The kiosk-writable OTA slot root for a user's home. Matches the agent's `otaRoot()` default. */
export function otaDirFor(home: string): string {
  return `${home}/.polyptic/agent`;
}

/** The stable ExecStart path the agent unit runs — the `current` slot's binary. */
export function otaSlotExec(otaDir: string): string {
  return `${otaDir}/current/polyptic-agent`;
}

// ── systemd user units (the standalone rollback guard) ──────────────────────────

export interface RollbackUnitParams {
  /** The FROZEN installed binary that runs `rollback-check` (never OTA'd). */
  frozenBin: string;
  /** The OTA slot dir, pinned so the guard reads exactly the agent's tree. */
  otaDir: string;
}

export function rollbackServiceUnit(p: RollbackUnitParams): string {
  return `# /etc/systemd/user/${ROLLBACK_SERVICE} — ${MANAGED}
[Unit]
Description=Polyptic OTA rollback guard — reverts a self-update that never came back healthy
Documentation=file:///etc/polyptic/agent.toml
# Deliberately NOT PartOf/BindsTo the agent unit: it must still run when the new agent crash-loops.

[Service]
Type=oneshot
# Runs the FROZEN installed binary (never OTA'd) so the guard works even if the new slot is broken.
ExecStart=${p.frozenBin} rollback-check
Environment=POLYPTIC_OTA_DIR=${p.otaDir}
`;
}

export function rollbackTimerUnit(): string {
  return `# /etc/systemd/user/${ROLLBACK_TIMER} — ${MANAGED}
[Unit]
Description=Polyptic OTA rollback guard timer
# Standalone — armed by the session target but NOT tied to the agent unit's lifecycle.

[Timer]
# Fire once, ~${ROLLBACK_DELAY_SEC}s after the timer is activated (≈ kiosk session start). A healthy
# trial boot commits (clears the confirm marker) well before this; a crash-looping one is reverted here.
OnActiveSec=${ROLLBACK_DELAY_SEC}s
AccuracySec=5s
Persistent=false

[Install]
WantedBy=${SESSION_TARGET}
`;
}

/** A narrow NOPASSWD sudoers rule letting the kiosk user + the guard reboot to apply/revert an update. */
export function otaSudoers(user: string): string {
  return `# ${OTA_SUDOERS_PATH} — ${MANAGED}
# OTA (POL-28): the ONLY privileged action in the self-update path is the reboot that applies (or the
# guard reverts) an update — every A/B slot swap is unprivileged in the kiosk-writable slot tree. This
# lets the unprivileged '${user}' agent + rollback guard reboot, and nothing else.
${user} ALL=(root) NOPASSWD: /usr/bin/systemctl reboot, /bin/systemctl reboot, /usr/sbin/reboot, /sbin/reboot
`;
}

// ── slot provisioning ───────────────────────────────────────────────────────────

export interface ProvisionSlotsParams {
  user: string;
  otaDir: string;
  /** The freshly-installed binary to seed the initial slot from (the installer's /usr/local/bin). */
  sourceBinary: string;
  /** The version to name the initial slot (the seed binary's baked version). */
  version: string;
}

/**
 * Seed the A/B slot tree from the installed binary and point `current` at it. Idempotent + safe to
 * re-run: the slot binary is copied only when absent (so it never overwrites a RUNNING slot binary,
 * which would fail ETXTBSY), while `current` is (re)pointed at this version — so an installer re-run
 * that brings a new binary takes effect, recording the old `current` as `previous` for rollback.
 */
export function provisionOtaSlots(sys: Sys, log: Logger, p: ProvisionSlotsParams): void {
  const { user, otaDir, sourceBinary, version } = p;
  log.step(`provision OTA A/B slots (${otaDir})`);

  const versionsDir = `${otaDir}/versions`;
  const slotDir = `${versionsDir}/${version}`;
  const dest = `${slotDir}/polyptic-agent`;
  const currentLink = `${otaDir}/current`;
  const previousLink = `${otaDir}/previous`;

  sys.ensureDir(otaDir);
  sys.ensureDir(slotDir);

  // Copy the binary only when absent — an already-present slot binary may be the RUNNING one (ETXTBSY),
  // and it's identical to the frozen source anyway.
  if (!sys.exists(dest)) {
    sys.exec("install", ["-D", "-m", "0755", sourceBinary, dest], { desc: `seed OTA slot ${version}` });
  } else {
    log.skip(`OTA slot binary for ${version} already present`);
  }

  // Record the old current as previous (rollback target), then point current at this version. Symlink
  // flips are ETXTBSY-safe (they don't touch the running process's binary).
  const curTarget = sys.readlinkSafe(currentLink);
  if (curTarget !== null && basename(curTarget) !== version) {
    sys.symlink(curTarget, previousLink);
  }
  sys.symlink(`versions/${version}`, currentLink);

  // Hand the whole tree to the kiosk user so the agent can flip slots + stage downloads without root.
  sys.chown(otaDir, user, user, true);
}
