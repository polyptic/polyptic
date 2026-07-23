/**
 * Operator SSH access — the agent's half (POL-81).
 *
 * The complement to the POL-59 remote shell: an ARMED, key-authed, root-capable SSH session on the
 * box. The agent runs UNPRIVILEGED (the kiosk user), so — exactly like the POL-55 reboot — it cannot
 * touch sshd or `authorized_keys` itself. It writes a request file into the kiosk-writable request dir
 * and a root-owned systemd `.path`/`.service` helper (installed by `polyptic-agent setup`) acts on it:
 *
 *   arm    → the helper installs `key` for `user`, starts sshd, schedules a box-side TTL disarm.
 *   disarm → the helper stops sshd and removes the key.
 *
 * The escalation surface is the SAME as the reboot helper's (a file in a directory the kiosk user may
 * write). It does NOT widen to remote or to untrusted WEB content — the browser sandbox cannot reach
 * the request dir — and it grants the kiosk user NO standing privilege: the debug user is separate,
 * the root account stays locked, and root capability is reached only via the debug user's key-authed,
 * TTL'd, passwordless sudo. The helper re-validates the key before it ever reaches `authorized_keys`.
 *
 * REFUSALS are first-class and loud, like reboot: `dev-open` (a developer's laptop) and any non-Linux
 * host decline and say why, and the reason rides back to the console in `agent/ssh-status`.
 */
import { execFile } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";

import type { DisplayBackend as BackendId } from "@polyptic/protocol";

import { REBOOT_REQUEST_DIR } from "./host";

/** The request file the root-owned `polyptic-sshd.path` helper watches (POL-81). Sits in the same
 *  kiosk-writable dir as the reboot request. Content is a tiny `key=value` block (see below). */
export const SSH_REQUEST_PATH = join(REBOOT_REQUEST_DIR, "ssh");

/** How long to wait for sshd to reach the desired state after handing the request to the helper. */
const SETTLE_TIMEOUT_MS = 5_000;
const SETTLE_POLL_MS = 300;
/** systemctl probe timeout. */
const SYSTEMCTL_TIMEOUT_MS = 4_000;

/** The core of `agent/ssh-status` (without the message envelope). */
export interface SshStatusReport {
  armed: boolean;
  listening: boolean;
  host?: string;
  port?: number;
  user?: string;
  expiresAt?: string;
  reason?: string;
}

/** What the agent was asked to do (the server/ssh-arm payload it needs to act on). */
export interface SshArmRequest {
  enabled: boolean;
  publicKey?: string;
  debugUser: string;
  port: number;
  ttlMs: number;
}

/**
 * Why this host may not run operator SSH, or null when it may. Pure + testable, like
 * {@link import("./host").rebootRefusal}: a dev laptop must never sprout an sshd from a console click.
 */
export function sshRefusal(backendId: BackendId, platform: string = process.platform): string | null {
  if (backendId === "dev-open") {
    return "the dev-open backend runs on a developer's own machine — refusing to start sshd on it";
  }
  if (platform !== "linux") {
    return `operator SSH is only implemented for Linux hosts (this one is ${platform})`;
  }
  return null;
}

/** True when `setup`'s privileged request dir exists (the SSH helper is installed alongside reboot). */
function helperInstalled(): boolean {
  return existsSync(REBOOT_REQUEST_DIR);
}

/** The box's primary reachable IPv4 for an operator to `ssh` to — the first non-internal address.
 *  Best-effort: undefined when only loopback exists (the console then omits the host from the hint). */
export function primaryIpv4(ifaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string | undefined {
  for (const addrs of Object.values(ifaces)) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && !addr.internal) return addr.address;
    }
  }
  return undefined;
}

/** Render the request file the helper parses. Deliberately a flat `key=value` block, key LAST so a
 *  half-written file never yields a truncated key that still parses. */
export function renderSshRequest(req: SshArmRequest): string {
  const lines = [
    `op=${req.enabled ? "arm" : "disarm"}`,
    `user=${req.debugUser}`,
    `port=${req.port}`,
    `ttl=${Math.round(req.ttlMs / 1000)}`,
  ];
  if (req.enabled && req.publicKey) lines.push(`key=${req.publicKey}`);
  return lines.join("\n") + "\n";
}

/** Is one systemd unit active? Never throws — an error reads as "not active". */
function unitActive(unit: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("systemctl", ["is-active", unit], { timeout: SYSTEMCTL_TIMEOUT_MS }, (_err, stdout) => {
      resolve(stdout.trim() === "active");
    });
  });
}

/** Is sshd accepting connections? On Ubuntu/Debian the unit is `ssh` and the DEFAULT is socket
 *  activation (`ssh.socket` active, `ssh.service` idle until a connection), so check BOTH — an active
 *  socket means the box is reachable even though the service reads inactive. */
async function sshdActive(): Promise<boolean> {
  if (await unitActive("ssh.socket")) return true;
  return unitActive("ssh");
}

/** Poll sshd's active state until it matches `want`, or the settle timeout elapses. */
async function waitForSshd(want: boolean): Promise<boolean> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  // First check is immediate; then poll.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const active = await sshdActive();
    if (active === want) return active;
    if (Date.now() >= deadline) return active;
    await new Promise((r) => setTimeout(r, SETTLE_POLL_MS));
  }
}

/**
 * Act on a `server/ssh-arm` and report what actually happened. Never throws — a failed arm must not
 * take the reconciler down; the box that keeps rendering is strictly better than a dead one, and the
 * failure is reported so the operator sees it. `probe` is injectable for tests.
 */
export async function applySshArm(
  backendId: BackendId,
  req: SshArmRequest,
  probe: (want: boolean) => Promise<boolean> = waitForSshd,
): Promise<SshStatusReport> {
  const refusal = sshRefusal(backendId);
  if (refusal) return { armed: false, listening: false, reason: refusal };

  if (!helperInstalled()) {
    return {
      armed: false,
      listening: false,
      reason:
        `no privileged SSH helper (${REBOOT_REQUEST_DIR} absent) — re-run \`polyptic-agent setup\` ` +
        `to install it.`,
    };
  }

  try {
    writeFileSync(SSH_REQUEST_PATH, renderSshRequest(req));
  } catch (err) {
    return {
      armed: false,
      listening: false,
      reason: `cannot write ${SSH_REQUEST_PATH}: ${(err as Error).message}`,
    };
  }

  const listening = await probe(req.enabled);
  if (!req.enabled) {
    return { armed: false, listening };
  }
  return {
    armed: true,
    listening,
    host: primaryIpv4(),
    port: req.port,
    user: req.debugUser,
    expiresAt: req.ttlMs > 0 ? new Date(Date.now() + req.ttlMs).toISOString() : undefined,
    reason: listening ? undefined : "sshd did not come up — check the box's journal",
  };
}
