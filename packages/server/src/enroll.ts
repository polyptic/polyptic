/**
 * Enrollment / agent authentication (Phase 2b, rebuilt by POL-104).
 *
 * The server runs in one of two modes:
 *
 *   OPEN MODE   (no enrolment token at all — the dev default): every agent that connects is
 *               auto-registered AND auto-approved exactly like Phase 2a. `authenticate()` returns `open`.
 *   GATED MODE  (one or more enrolment tokens): an agent must present a VALID token (first contact) or
 *               a durable per-machine credential (every reconnect). New machines land `pending` and
 *               await an operator's approval — unless a pre-registration says otherwise (see
 *               `preregistration.ts`; pre-registration is consulted only AFTER this gate says yes).
 *
 * POL-104 — WHY THIS IS A SET OF TOKENS AND NOT ONE.
 * Before POL-104 a gated deployment had exactly one bootstrap token and it was baked into every boot
 * medium ever flashed. One stick out of the building = enrolment compromised for the whole estate, and
 * rotating meant a helm upgrade plus re-flashing every medium. A token is now a first-class record:
 * named (the batch/site it was cut for), optionally EXPIRING, optionally CAPPED at N new machines, and
 * individually REVOCABLE. Exactly one token is the BAKE token — the one `/boot/grub.cfg` writes into a
 * kernel cmdline, and therefore the one `build-boot-medium.sh` lifts back out of that menu.
 *
 * THE THREE RULES THAT KEEP A WORKING WALL WORKING:
 *   1. Backward compatibility. The pre-POL-104 single token is LIFTED into the token set on first boot
 *      as a `legacy` record — no expiry, no cap, still the bake token. Every stick already in the field
 *      keeps enrolling, unchanged, until an operator deliberately decides otherwise.
 *   2. Revocation blocks ENROLMENT, never a running box. A machine that enrolled on a token holds a
 *      durable per-machine credential; revoking the token it came in on does not touch that credential,
 *      so the wall stays up. Killing a machine is a SEPARATE, explicit act (reject it).
 *   3. Rotation has a grace window. Rotating cuts a successor and puts the old secret on a timer rather
 *      than killing it, so boots in flight — and media not yet re-flashed — still land.
 *
 * Credentials are random 32-byte hex strings (node:crypto). The server stores ONLY the sha256 of a
 * credential on the machine row; the agent persists the raw value locally and presents it on every
 * reconnect. Tokens and credential hashes are compared in constant time (both sides are folded through
 * a fixed-length sha256 digest so neither length nor content timing leaks).
 *
 * `authenticate(hello, existingMachine?)` is pure: it inspects the hello + the machine we already know
 * about and returns a `decision` the WS handler acts on. All persistence / socket I/O lives in the
 * handler, not here — with ONE seam: a token's use-count lives in this class (so the cap can be
 * enforced synchronously, inside the decision) and is written through by an injected `persist` hook.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type { AgentMessage, EnrollmentStatus, EnrollmentTokenView } from "@polyptic/protocol";

/** The `agent/hello` variant of the agent channel union. */
export type AgentHelloMessage = Extract<AgentMessage, { t: "agent/hello" }>;

/** What the server already knows about a machine (looked up by `hello.machineId`). */
export interface ExistingMachine {
  status: EnrollmentStatus;
  /** sha256(credential) hex, if the machine has ever been issued a credential. */
  credentialHash?: string;
}

/**
 * One enrolment token, in memory. Mirrors `PersistedEnrollmentToken` (the store DTO) and
 * `EnrollmentTokenView` (the wire DTO) — this class owns the live copy so the cap can be enforced
 * inside `authenticate` without a round-trip to the database.
 */
export interface EnrollmentToken {
  id: string;
  name: string;
  secret: string;
  createdAt: string;
  /** ISO. Past this instant the token enrols nothing. Null = never expires. */
  expiresAt: string | null;
  /** Cap on NEW machines. Null = uncapped. */
  maxEnrollments: number | null;
  /** Machines that have FIRST enrolled on this token. */
  uses: number;
  revokedAt: string | null;
  lastUsedAt: string | null;
  /** The token `/boot/grub.cfg` bakes. Exactly one. */
  bake: boolean;
  /** The pre-POL-104 flat token, lifted in on upgrade. */
  legacy: boolean;
}

/** Why a token that we RECOGNISED still cannot be used. Surfaced to the agent (and the server log) so
 *  a box that cannot enrol says WHY — "invalid token" on an expired stick sends an operator hunting
 *  for a typo that isn't there. */
export type TokenRefusal = "revoked" | "expired" | "exhausted";

const REFUSAL_REASON: Record<TokenRefusal, string> = {
  revoked: "enrolment token has been revoked",
  expired: "enrolment token has expired",
  exhausted: "enrolment token has reached its maximum number of enrolments",
};

/**
 * The handler's marching orders. `kind` selects the post-decision action; `credential`, when present,
 * means "issue this credential via `server/enrolled` (with `status`) BEFORE acting on `kind`".
 *
 *   open           — OPEN MODE: register + approve + create screens + apply (Phase 2a behaviour).
 *   enroll-pending — GATED first contact, NEW machine: create it `pending`, persist outputs + hash,
 *                    reply `server/enrolled` then `server/pending`. No screens, no apply. (A matching
 *                    pre-registration may then approve it immediately — that is the handler's job.)
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
  /** POL-104 — the token that authenticated this hello, when a token did. The handler stamps it onto
   *  a NEW machine (provenance: which stick/batch this box came in on) and counts the use. */
  tokenId?: string;
  tokenName?: string;
}

/** A fresh, durable per-machine credential: 32 random bytes, hex-encoded (64 chars). */
export function generateCredential(): string {
  return randomBytes(32).toString("hex");
}

/** A fresh enrolment token secret. Same shape as the pre-POL-104 bootstrap token (24 bytes hex). */
export function generateTokenSecret(): string {
  return randomBytes(24).toString("hex");
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

/** Project a live token onto the wire DTO the console renders. */
export function toTokenView(token: EnrollmentToken): EnrollmentTokenView {
  return {
    id: token.id,
    name: token.name,
    secret: token.secret,
    createdAt: token.createdAt,
    expiresAt: token.expiresAt,
    maxEnrollments: token.maxEnrollments,
    uses: token.uses,
    revokedAt: token.revokedAt,
    lastUsedAt: token.lastUsedAt,
    bake: token.bake,
    legacy: token.legacy,
  };
}

/** The id + name we give the pre-POL-104 token when we lift it into the token set. */
export const LEGACY_TOKEN_ID = "legacy";
export const LEGACY_TOKEN_NAME = "Original bootstrap token";

export interface EnrollmentOptions {
  /** Write-through hook: called whenever a token record changes (created, revoked, used, re-baked).
   *  Absent in unit tests — the class is fully usable, just not durable. */
  persist?: (token: EnrollmentToken) => Promise<void>;
  /** Called when a token is deleted. */
  forget?: (tokenId: string) => Promise<void>;
  /** Injected clock, so expiry can be tested without sleeping. */
  now?: () => number;
}

/**
 * Enrollment policy. Holds the live token set; `open` is true when the set is EMPTY (OPEN MODE / dev
 * default). Constructed with the pre-POL-104 scalar token for backward compatibility (`new
 * Enrollment(token)` lifts it into a legacy record), or loaded from the store with `load()`.
 */
export class Enrollment {
  /** Insertion-ordered: id → token. */
  private tokens = new Map<string, EnrollmentToken>();
  private readonly persist: ((token: EnrollmentToken) => Promise<void>) | undefined;
  private readonly forget: ((tokenId: string) => Promise<void>) | undefined;
  private readonly now: () => number;

  constructor(token?: string | undefined, options: EnrollmentOptions = {}) {
    this.persist = options.persist;
    this.forget = options.forget;
    this.now = options.now ?? Date.now;
    this.setToken(token);
  }

  /** Replace the whole live token set (the boot path: seeded from the store). */
  load(tokens: EnrollmentToken[]): void {
    this.tokens = new Map(tokens.map((t) => [t.id, { ...t }]));
    this.ensureExactlyOneBakeToken();
  }

  /** True when no enrolment token exists at all — every agent is auto-registered + auto-approved. */
  get open(): boolean {
    return this.tokens.size === 0;
  }

  /**
   * The token a boot medium bakes. Read by the netboot boot-depot (POL-33): `GET /boot/grub.cfg` bakes
   * this into the kernel cmdline so a diskless box carries it (and re-presents it on every cold boot),
   * and `deploy/build-boot-medium.sh` lifts it straight back out of that menu when it bakes a stick.
   * Because it is read from THIS instance — the same one the token routes mutate and `authenticate`
   * compares against — the baked token can never drift from what the agent channel will honour.
   *
   * POL-104: this is now "the token flagged `bake`", not "the only token". A rotation therefore
   * changes what NEW media carry without touching what OLD media present.
   */
  get currentToken(): string | undefined {
    return this.bakeToken()?.secret;
  }

  /** The token record `/boot/grub.cfg` bakes, or undefined in OPEN mode. */
  bakeToken(): EnrollmentToken | undefined {
    for (const token of this.tokens.values()) if (token.bake) return token;
    // Defensive: a set with no bake flag (a hand-edited row) still has to bake something.
    return this.tokens.values().next().value;
  }

  /** Every token, in creation order. */
  list(): EnrollmentToken[] {
    return [...this.tokens.values()].map((t) => ({ ...t }));
  }

  get(id: string): EnrollmentToken | undefined {
    const token = this.tokens.get(id);
    return token ? { ...token } : undefined;
  }

  /**
   * Is this secret one we RECOGNISE at all, whatever its state (expired, revoked, exhausted)? The boot
   * depot's `POST /boot/report` gate uses this: a box that netbooted on a stick whose token we have
   * since revoked is EXACTLY the box whose boot report we most want to read. The report carries no
   * authority — it is a rate-limited telemetry line — so recognising a dead token here admits nothing.
   */
  knowsSecret(provided: string | undefined): boolean {
    return this.findBySecret(provided) !== undefined;
  }

  private static normalize(token: string | undefined): string | undefined {
    const trimmed = token?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : undefined;
  }

  /**
   * Replace the live token set with a single legacy-shaped token (or clear it → OPEN). This is how the
   * pre-POL-104 flat token is LIFTED on upgrade, and it is what the pre-POL-104 callers/tests still
   * use; the token routes use `createToken`/`rotateToken`/`revokeToken`.
   */
  setToken(token: string | undefined): void {
    const normalized = Enrollment.normalize(token);
    this.tokens.clear();
    if (normalized === undefined) return;
    this.tokens.set(LEGACY_TOKEN_ID, {
      id: LEGACY_TOKEN_ID,
      name: LEGACY_TOKEN_NAME,
      secret: normalized,
      createdAt: new Date(this.now()).toISOString(),
      expiresAt: null,
      maxEnrollments: null,
      uses: 0,
      revokedAt: null,
      lastUsedAt: null,
      bake: true,
      legacy: true,
    });
  }

  /** Build from the environment (`POLYPTIC_BOOTSTRAP_TOKEN`). */
  static fromEnv(env: Record<string, string | undefined> = process.env): Enrollment {
    return new Enrollment(env.POLYPTIC_BOOTSTRAP_TOKEN);
  }

  // ── Token lifecycle (POL-104) ──────────────────────────────────────────────

  /** Cut a new token. The first token on an OPEN deployment switches it to GATED — and, being the only
   *  one, becomes the bake token whatever the caller asked for. */
  async createToken(input: {
    name: string;
    expiresInDays?: number;
    maxEnrollments?: number;
    bake?: boolean;
    secret?: string;
  }): Promise<EnrollmentToken> {
    const nowMs = this.now();
    const token: EnrollmentToken = {
      id: randomUUID(),
      name: input.name.trim(),
      secret: input.secret ?? generateTokenSecret(),
      createdAt: new Date(nowMs).toISOString(),
      expiresAt:
        input.expiresInDays === undefined
          ? null
          : new Date(nowMs + input.expiresInDays * 86_400_000).toISOString(),
      maxEnrollments: input.maxEnrollments ?? null,
      uses: 0,
      revokedAt: null,
      lastUsedAt: null,
      bake: false,
      legacy: false,
    };
    this.tokens.set(token.id, token);
    await this.persist?.({ ...token });
    if (input.bake || this.tokens.size === 1) await this.setBakeToken(token.id);
    return { ...this.tokens.get(token.id)! };
  }

  /**
   * Rotate a token: cut a successor carrying the same name/limits, hand the bake flag over if the old
   * one had it, and put the OLD secret on a GRACE window instead of killing it. Media already flashed
   * (and boots in flight) keep landing for `graceHours`; `graceHours: 0` revokes immediately, which is
   * the "a stick is gone, cut it now" case and is deliberately a distinct, louder choice.
   */
  async rotateToken(
    id: string,
    graceHours: number,
  ): Promise<{ old: EnrollmentToken; next: EnrollmentToken } | undefined> {
    const old = this.tokens.get(id);
    if (!old) return undefined;

    const next = await this.createToken({
      name: old.name,
      maxEnrollments: old.maxEnrollments ?? undefined,
      bake: old.bake,
    });

    const nowMs = this.now();
    if (graceHours <= 0) {
      old.revokedAt = new Date(nowMs).toISOString();
    } else {
      const graceEnd = new Date(nowMs + graceHours * 3_600_000).toISOString();
      // Never EXTEND a token's life: a rotation with a long grace on an already-short-lived token must
      // not resurrect it past its own expiry.
      old.expiresAt = old.expiresAt && old.expiresAt < graceEnd ? old.expiresAt : graceEnd;
    }
    old.bake = false;
    await this.persist?.({ ...old });
    return { old: { ...old }, next };
  }

  /** Revoke a token: NEW enrolments (and token re-enrols) on it stop. Machines already enrolled on it
   *  hold their own credential and keep running — this never darkens a wall. */
  async revokeToken(id: string): Promise<EnrollmentToken | undefined> {
    const token = this.tokens.get(id);
    if (!token) return undefined;
    token.revokedAt = token.revokedAt ?? new Date(this.now()).toISOString();
    await this.persist?.({ ...token });
    // A revoked token must not stay the one we bake into new media.
    if (token.bake) {
      const successor = [...this.tokens.values()].find(
        (t) => t.id !== id && this.usable(t) === undefined,
      );
      if (successor) await this.setBakeToken(successor.id);
    }
    return { ...token };
  }

  /** Forget a token entirely. Machines that enrolled on it are untouched. */
  async deleteToken(id: string): Promise<boolean> {
    const token = this.tokens.get(id);
    if (!token) return false;
    this.tokens.delete(id);
    await this.forget?.(id);
    if (token.bake) await this.ensureExactlyOneBakeTokenPersisted();
    return true;
  }

  /** Make `id` the token that `/boot/grub.cfg` (and therefore the next boot medium) bakes. */
  async setBakeToken(id: string): Promise<EnrollmentToken | undefined> {
    const target = this.tokens.get(id);
    if (!target) return undefined;
    for (const token of this.tokens.values()) {
      const bake = token.id === id;
      if (token.bake !== bake) {
        token.bake = bake;
        await this.persist?.({ ...token });
      }
    }
    return { ...target };
  }

  /** In-memory only: pick a bake token when the set has none (or several). */
  private ensureExactlyOneBakeToken(): void {
    const all = [...this.tokens.values()];
    const baked = all.filter((t) => t.bake);
    if (baked.length === 1) return;
    for (const token of all) token.bake = false;
    const pick = baked[0] ?? all.find((t) => this.usable(t) === undefined) ?? all[0];
    if (pick) pick.bake = true;
  }

  private async ensureExactlyOneBakeTokenPersisted(): Promise<void> {
    this.ensureExactlyOneBakeToken();
    const baked = [...this.tokens.values()].find((t) => t.bake);
    if (baked) await this.persist?.({ ...baked });
  }

  // ── Validity ───────────────────────────────────────────────────────────────

  /** Why this token cannot be used right now, or `undefined` when it can. `forNewMachine` decides
   *  whether the enrolment CAP applies: the cap counts how many boxes a stick may ONBOARD, not how
   *  many times a box that already counted may re-key after losing its credential. */
  private usable(token: EnrollmentToken, forNewMachine = true): TokenRefusal | undefined {
    if (token.revokedAt) return "revoked";
    if (token.expiresAt && Date.parse(token.expiresAt) <= this.now()) return "expired";
    if (forNewMachine && token.maxEnrollments !== null && token.uses >= token.maxEnrollments) {
      return "exhausted";
    }
    return undefined;
  }

  /** Constant-time lookup by secret. Every token is compared (no early exit) so a hit does not leak
   *  its position in the set through timing. */
  private findBySecret(provided: string | undefined): EnrollmentToken | undefined {
    if (provided === undefined) return undefined;
    let match: EnrollmentToken | undefined;
    for (const token of this.tokens.values()) {
      if (constantTimeEqual(provided, token.secret)) match = token;
    }
    return match;
  }

  private credentialValid(provided: string | undefined, existing: ExistingMachine | undefined): boolean {
    if (provided === undefined || existing?.credentialHash === undefined) return false;
    return constantTimeEqual(hashCredential(provided), existing.credentialHash);
  }

  /**
   * Count a NEW machine against a token's cap and stamp `lastUsedAt`. Called by the WS handler on the
   * `enroll-pending` path only — a re-enrol of a machine that already counted consumes no slot.
   */
  async recordUse(tokenId: string): Promise<void> {
    const token = this.tokens.get(tokenId);
    if (!token) return;
    token.uses += 1;
    token.lastUsedAt = new Date(this.now()).toISOString();
    await this.persist?.({ ...token });
  }

  /**
   * Decide what to do with an `agent/hello`. Pure (no I/O; the use-count write happens in the handler
   * via `recordUse`). See `EnrollDecision` for the meaning of each `kind`; the case numbering below
   * mirrors the Phase 2b spec.
   */
  authenticate(hello: AgentHelloMessage, existing?: ExistingMachine): EnrollDecision {
    // OPEN MODE: ignore any token/credential and reproduce Phase 2a exactly.
    if (this.open) return { kind: "open" };

    // A rejected machine is terminal: never admit it, regardless of token/credential (spec case 5).
    if (existing?.status === "rejected") {
      return { kind: "reject", reason: "machine has been rejected" };
    }

    const credentialValid = this.credentialValid(hello.credential, existing);

    // A valid credential is the normal reconnect path — no new credential is issued, and NO token is
    // consulted. This is rule 2: a box that is already enrolled keeps working even if the token it came
    // in on has since been revoked, expired or been used up. Revocation gates the DOOR, not the room.
    if (credentialValid && existing) {
      // case 2 — valid credential + approved → admit (ensure screens, apply).
      if (existing.status === "approved") return { kind: "admit" };
      // case 3 — valid credential + pending → keep the connection open, no apply.
      return { kind: "pending" };
    }

    const token = this.findBySecret(hello.bootstrapToken);
    if (token) {
      const refusal = this.usable(token, existing === undefined);
      if (refusal) {
        // A token we RECOGNISE but will not honour. Say which, so a box that cannot enrol tells the
        // truth about why (the operator's next move is different for each).
        return {
          kind: "reject",
          reason: REFUSAL_REASON[refusal],
          tokenId: token.id,
          tokenName: token.name,
        };
      }
      const credential = generateCredential();
      const stamp = { tokenId: token.id, tokenName: token.name };
      // case 1 — first contact, NEW machine → create it pending and issue a credential.
      if (!existing) {
        return { kind: "enroll-pending", credential, status: "pending", ...stamp };
      }
      // case 4 — token on an EXISTING machine (agent lost its credential): re-issue, carrying the
      // machine's CURRENT status; admit only if it is already approved.
      if (existing.status === "approved") {
        return { kind: "admit", credential, status: "approved", ...stamp };
      }
      return { kind: "pending", credential, status: "pending", ...stamp };
    }

    // case 5 — neither a valid token nor a valid credential.
    return { kind: "reject", reason: "invalid or missing enrollment credential" };
  }
}
