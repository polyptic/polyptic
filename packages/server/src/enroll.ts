/**
 * Enrollment / agent authentication (Phase 2b).
 *
 * The server runs in one of two modes, selected by the `POLYPTIC_BOOTSTRAP_TOKEN` env var:
 *
 *   OPEN MODE   (token UNSET — the dev default): every agent that connects is auto-registered AND
 *               auto-approved exactly like Phase 2a. `authenticate()` always returns `open`.
 *   GATED MODE  (token SET): an agent must present either the bootstrap token (first contact) or a
 *               durable per-machine credential (every reconnect). New machines land `pending` and
 *               await an operator's approval before any screens are admitted.
 *
 * Credentials are random 32-byte hex strings (node:crypto). The server stores ONLY the sha256 of a
 * credential on the machine row; the agent persists the raw value locally and presents it on every
 * reconnect. The bootstrap token and credential hashes are compared in constant time (both sides are
 * folded through a fixed-length sha256 digest so neither length nor content timing leaks).
 *
 * `authenticate(hello, existingMachine?)` is pure: it inspects the hello + the machine we already
 * know about and returns a `decision` the WS handler acts on. All persistence / socket I/O lives in
 * the handler, not here.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { AgentMessage, EnrollmentStatus } from "@polyptic/protocol";

/** The `agent/hello` variant of the agent channel union. */
export type AgentHelloMessage = Extract<AgentMessage, { t: "agent/hello" }>;

/** What the server already knows about a machine (looked up by `hello.machineId`). */
export interface ExistingMachine {
  status: EnrollmentStatus;
  /** sha256(credential) hex, if the machine has ever been issued a credential. */
  credentialHash?: string;
}

/**
 * The handler's marching orders. `kind` selects the post-decision action; `credential`, when present,
 * means "issue this credential via `server/enrolled` (with `status`) BEFORE acting on `kind`".
 *
 *   open           — OPEN MODE: register + approve + create screens + apply (Phase 2a behaviour).
 *   enroll-pending — GATED first contact, NEW machine: create it `pending`, persist outputs + hash,
 *                    reply `server/enrolled` then `server/pending`. No screens, no apply.
 *   admit          — valid credential (or re-enrol token) on an APPROVED machine: ensure screens +
 *                    `server/apply`. If `credential` is set, re-issue it via `server/enrolled` first.
 *   pending        — recognised but still `pending`: reply `server/pending`, keep the socket open.
 *                    If `credential` is set (token re-enrol), re-issue it via `server/enrolled` first.
 *   reject         — bad/absent token AND bad/absent credential, or the machine is `rejected`:
 *                    reply `server/rejected {reason}` and CLOSE the socket.
 */
export type EnrollDecisionKind = "open" | "admit" | "pending" | "enroll-pending" | "reject";

export interface EnrollDecision {
  kind: EnrollDecisionKind;
  /** When set, send `server/enrolled {machineId, credential, status}` before acting on `kind`. */
  credential?: string;
  /** Status carried by `server/enrolled` (and the status the machine should hold). */
  status?: EnrollmentStatus;
  /** Human-readable reason for `kind === "reject"`. */
  reason?: string;
}

/** A fresh, durable per-machine credential: 32 random bytes, hex-encoded (64 chars). */
export function generateCredential(): string {
  return randomBytes(32).toString("hex");
}

/** The value the server persists for a credential: its sha256, hex-encoded. */
export function hashCredential(credential: string): string {
  return createHash("sha256").update(credential, "utf8").digest("hex");
}

/** sha256 digest (raw 32 bytes) — used to give the constant-time compare fixed-length inputs. */
function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Constant-time string equality. Both inputs are folded through a fixed-length sha256 digest first,
 * so `timingSafeEqual` always sees equal-length buffers and neither length nor content timing leaks.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * Enrollment policy. Constructed once at boot from the configured bootstrap token; `open` is true
 * when no token is set (OPEN MODE / dev default).
 */
export class Enrollment {
  private token: string | undefined;

  constructor(token: string | undefined) {
    this.token = Enrollment.normalize(token);
  }

  /** True when no bootstrap token is configured — every agent is auto-registered + auto-approved. */
  get open(): boolean {
    return this.token === undefined;
  }

  /**
   * The live bootstrap token the agent WS currently accepts, or `undefined` in OPEN mode. Read by the
   * netboot boot-depot (POL-33): `GET /boot.ipxe` bakes this into the kernel cmdline so a diskless box
   * carries it (and re-presents it on every cold boot). Because it's read from THIS instance, the same
   * one `setToken` mutates on regenerate and `authenticate` compares against, the baked token can never
   * drift from what the agent channel will honour. Already normalized (empty/whitespace → undefined).
   */
  get currentToken(): string | undefined {
    return this.token;
  }

  private static normalize(token: string | undefined): string | undefined {
    const trimmed = token?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : undefined;
  }

  /**
   * Replace the live bootstrap token (Phase 3f — the Settings "regenerate" action). Passing a token
   * switches the deployment to GATED; passing `undefined` switches it back to OPEN. The agent WS path
   * reads `open`/`authenticate` dynamically, so the change takes effect on the next `agent/hello`.
   */
  setToken(token: string | undefined): void {
    this.token = Enrollment.normalize(token);
  }

  /** Build from the environment (`POLYPTIC_BOOTSTRAP_TOKEN`). */
  static fromEnv(env: Record<string, string | undefined> = process.env): Enrollment {
    return new Enrollment(env.POLYPTIC_BOOTSTRAP_TOKEN);
  }

  private tokenValid(provided: string | undefined): boolean {
    if (this.token === undefined || provided === undefined) return false;
    return constantTimeEqual(provided, this.token);
  }

  private credentialValid(provided: string | undefined, existing: ExistingMachine | undefined): boolean {
    if (provided === undefined || existing?.credentialHash === undefined) return false;
    return constantTimeEqual(hashCredential(provided), existing.credentialHash);
  }

  /**
   * Decide what to do with an `agent/hello`. Pure — no side effects. See `EnrollDecision` for the
   * meaning of each `kind`; the case numbering below mirrors the Phase 2b spec.
   */
  authenticate(hello: AgentHelloMessage, existing?: ExistingMachine): EnrollDecision {
    // OPEN MODE: ignore any token/credential and reproduce Phase 2a exactly.
    if (this.open) return { kind: "open" };

    // A rejected machine is terminal: never admit it, regardless of token/credential (spec case 5).
    if (existing?.status === "rejected") {
      return { kind: "reject", reason: "machine has been rejected" };
    }

    const credentialValid = this.credentialValid(hello.credential, existing);
    const tokenValid = this.tokenValid(hello.bootstrapToken);

    // A valid credential is the normal reconnect path — no new credential is issued.
    if (credentialValid && existing) {
      // case 2 — valid credential + approved → admit (ensure screens, apply).
      if (existing.status === "approved") return { kind: "admit" };
      // case 3 — valid credential + pending → keep the connection open, no apply.
      return { kind: "pending" };
    }

    // A valid bootstrap token issues (or re-issues) a durable credential.
    if (tokenValid) {
      const credential = generateCredential();
      // case 1 — first contact, NEW machine → create it pending and issue a credential.
      if (!existing) {
        return { kind: "enroll-pending", credential, status: "pending" };
      }
      // case 4 — token on an EXISTING machine (agent lost its credential): re-issue, carrying the
      // machine's CURRENT status; admit only if it is already approved.
      if (existing.status === "approved") {
        return { kind: "admit", credential, status: "approved" };
      }
      return { kind: "pending", credential, status: "pending" };
    }

    // case 5 — neither a valid token nor a valid credential.
    return { kind: "reject", reason: "invalid or missing enrollment credential" };
  }
}
