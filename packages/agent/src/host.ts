/**
 * Host OS lifecycle — the one privileged action the agent can ask for (POL-55).
 *
 * The agent runs UNPRIVILEGED, as the kiosk user, so it cannot reboot the box itself: the live image
 * ships neither `sudo` nor polkit, and logind refuses an unprivileged `systemctl reboot` without one.
 * The privilege therefore lives in a root-owned systemd pair written by `polyptic-agent setup`:
 *
 *   polyptic-reboot.path     PathExists=/run/polyptic/requests/reboot
 *   polyptic-reboot.service  ExecStart=systemctl --no-block reboot
 *
 * so the whole escalation is "create an empty file in a directory the kiosk user may write". There is
 * no command to inject and no argument to smuggle — the only thing the helper can be asked to do IS
 * a reboot. `/run` is tmpfs, so the request cannot outlive the reboot it triggers.
 *
 * Boxes provisioned some other way (a dev Linux host, a hand-rolled image) have no helper; there we
 * fall back to `systemctl reboot`, which works when the caller is root or polkit is present.
 *
 * REFUSALS are first-class, and deliberately loud: `dev-open` is the laptop backend, so a stray
 * reboot there would power-cycle a developer's desktop. Same for any non-Linux host. Both decline and
 * say why, and the console shows the reason.
 */
import { execFile } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { DisplayBackend as BackendId } from "@polyptic/protocol";

/** Root-owned, group-writable by the kiosk user (see the tmpfiles.d drop-in `setup` writes). */
export const REBOOT_REQUEST_DIR = "/run/polyptic/requests";
/** The file whose creation the `polyptic-reboot.path` unit watches for. Content is advisory. */
export const REBOOT_REQUEST_PATH = join(REBOOT_REQUEST_DIR, "reboot");

/** How long `systemctl reboot` gets to be accepted before we call the fallback dead. */
const SYSTEMCTL_TIMEOUT_MS = 10_000;

export interface RebootOutcome {
  /** True once the reboot is under way (or handed to the helper); false means the box stays up. */
  accepted: boolean;
  /** Why we declined, or how the reboot was triggered. Surfaced to the operator. */
  reason: string;
}

/**
 * Why this host may not reboot, or null when it may. Split out from {@link rebootHost} so the refusal
 * is a pure, testable decision that never touches the filesystem.
 */
export function rebootRefusal(backendId: BackendId, platform: string = process.platform): string | null {
  if (backendId === "dev-open") {
    return "the dev-open backend runs on a developer's own machine — refusing to reboot it";
  }
  if (platform !== "linux") {
    return `reboot is only implemented for Linux hosts (this one is ${platform})`;
  }
  return null;
}

/** True when `setup`'s privileged reboot helper is installed on this box. */
function helperInstalled(): boolean {
  return existsSync(REBOOT_REQUEST_DIR);
}

/** Ask systemd directly. Only reachable on a box with no helper (root, or a polkit-enabled distro). */
function systemctlReboot(): Promise<RebootOutcome> {
  return new Promise((resolve) => {
    execFile(
      "systemctl",
      ["--no-block", "reboot"],
      { timeout: SYSTEMCTL_TIMEOUT_MS },
      (err, _stdout, stderr) => {
        if (!err) {
          resolve({ accepted: true, reason: "systemctl reboot accepted" });
          return;
        }
        const detail = String(stderr || err.message).trim().split("\n")[0] ?? "unknown error";
        resolve({
          accepted: false,
          reason:
            `no privileged reboot helper (${REBOOT_REQUEST_DIR} absent) and \`systemctl reboot\` ` +
            `failed: ${detail}. Re-run \`polyptic-agent setup\` to install the helper.`,
        });
      },
    );
  });
}

/**
 * Reboot this box, or explain why not. Never throws — a failed reboot must not take the reconciler
 * down with it, because a box that stays up and keeps rendering is strictly better than a dead one.
 */
export async function rebootHost(backendId: BackendId): Promise<RebootOutcome> {
  const refusal = rebootRefusal(backendId);
  if (refusal) return { accepted: false, reason: refusal };

  if (!helperInstalled()) return systemctlReboot();

  try {
    writeFileSync(REBOOT_REQUEST_PATH, `${new Date().toISOString()} reboot requested by the control plane\n`);
    return { accepted: true, reason: `requested via ${REBOOT_REQUEST_PATH}` };
  } catch (err) {
    return {
      accepted: false,
      reason: `cannot write ${REBOOT_REQUEST_PATH}: ${(err as Error).message}`,
    };
  }
}
