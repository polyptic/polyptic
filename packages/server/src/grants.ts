/**
 * MURAL GRANTS (POL-191) — permission scoped to one canvas.
 *
 * POL-107 gave the deployment three GLOBAL roles (`viewer < operator < admin`). That is the right
 * model for one team running one estate, and the wrong one the moment an organisation hosts Polyptic:
 * an `operator` there can drive every wall in the building, and there is no way to say "this team owns
 * those two murals."
 *
 * A grant says: **this subject holds this role ON this mural.** The subject is either a USER (by id) or
 * a GROUP (by the name the IdP asserts). Group grants are what make this work in a brokered
 * deployment — the directory already holds the membership list, and an admin should not have to keep a
 * second copy of it here, nor pre-create an account for someone who has never signed in.
 *
 * ── The rule ────────────────────────────────────────────────────────────────────────────────────
 *
 *     a FLEET role (operator, admin) → that role on every mural, raised by any grant it holds
 *     anything else (viewer)         → exactly the grant it holds there, or NOTHING
 *
 * There is no third mode and no switch. **Access decides sight**: a mural you hold nothing on is a
 * mural you are not shown — not over the admin socket, not over REST, not as a thumbnail, and not as
 * a scene you could apply. Showing somebody a wall they have no access to, and then refusing them
 * when they touch it, is not access control; it is a locked door with the contents on display.
 *
 * So the model has two axes and they compose. The FLEET role says whether you have deployment-wide
 * access at all; GRANTS say which individual murals you have access to, and at what depth. `viewer`
 * is the "no fleet access" rank, which is why it is the right default for a brokered account: an
 * account nobody has given anything to signs in and sees an empty console, which is correct.
 *
 * Fleet roles are NOT scoped, deliberately: `operator` and `admin` are deployment-wide by
 * construction, and hiding a wall from someone who can still reconfigure it would be a worse lie than
 * showing it. Their sight matches their power exactly, like everyone else's.
 *
 * ── Why this is an in-memory index ──────────────────────────────────────────────────────────────
 *
 * The gate consults it on EVERY `/api/v1/**` call. Authorization must not wait on a database
 * round-trip, so the whole (small) grant table is loaded once at boot and mutated in step with every
 * write. The store is still the authority — this is a cache that is written through, never a
 * second source of truth.
 */
import type { MuralGrant, MuralGrantSubjectKind, OperatorRole } from "@polyptic/protocol";

import { roleAllows } from "./roles";
import type { PersistedMuralGrant, Store } from "./store";

/** An identity as the grant resolver needs to see it: who they are, and what the IdP said they are in. */
export interface GrantSubject {
  id: string;
  role: OperatorRole;
  groups: string[];
}

/** Rank, mirroring `roles.ts` — `pickHigher` needs an ordering, not just a predicate. */
function pickHigher(a: OperatorRole, b: OperatorRole): OperatorRole {
  return roleAllows(a, b) ? a : b;
}

/** Group names are matched case-insensitively: directories are inconsistent about case, and a
 *  permission that silently depends on it is a trap nobody debugs twice. */
function normalizeSubjectId(kind: MuralGrantSubjectKind, subjectId: string): string {
  return kind === "group" ? subjectId.trim().toLowerCase() : subjectId.trim();
}

/** The in-memory key for one grant. */
function key(muralId: string, kind: MuralGrantSubjectKind, subjectId: string): string {
  return `${muralId}\u0000${kind}\u0000${subjectId}`;
}

/**
 * POL-191 — is this account a FLEET role? `operator` and `admin` are deployment-wide by construction
 * (POL-107 gave the operator every wall and the admin every machine), so they reach and see every
 * mural. Everyone else reaches exactly what they were granted.
 */
function isFleetRole(role: OperatorRole): boolean {
  return role === "operator" || role === "admin";
}

export class GrantService {
  private readonly store: Store;
  /** key() → grant. The whole table; it is one row per (mural, subject) and stays small. */
  private readonly grants = new Map<string, PersistedMuralGrant>();

  constructor(store: Store) {
    this.store = store;
  }

  /** Load the table once at boot. Called before the gate is registered. */
  async load(): Promise<void> {
    this.grants.clear();
    for (const grant of await this.store.listMuralGrants()) {
      this.grants.set(key(grant.muralId, grant.subjectKind, grant.subjectId), grant);
    }
  }

  /** How many grants exist — the boot log reports it, so a deployment says out loud whether anyone
   *  holds anything beyond their global role. */
  get size(): number {
    return this.grants.size;
  }

  /**
   * The role `subject` holds ON `muralId`, or **null** for no role there at all.
   *
   * A FLEET role holds its own role on every mural, raised by any grant it also happens to hold
   * there. Anything else holds exactly what it was granted — and `null` is the ordinary answer, not
   * an error case: it is what an account with no access to this wall has, and `roleAllows` refuses it
   * for everything including `viewer`.
   */
  effectiveRole(subject: GrantSubject, muralId: string): OperatorRole | null {
    const granted = this.bestGrantOn(subject, muralId);
    // A FLEET role reaches every mural, and a grant can still raise it there (a `viewer`-turned-
    // mural-admin case does not arise for these, but an operator granted admin on one wall is real).
    if (isFleetRole(subject.role)) {
      return granted ? pickHigher(subject.role, granted) : subject.role;
    }
    // Everyone else holds exactly what they were given here, or nothing at all.
    return granted;
  }

  /** The best grant matching this subject on one mural, ignoring their global role. Null if none. */
  private bestGrantOn(subject: GrantSubject, muralId: string): OperatorRole | null {
    let best: OperatorRole | null = null;
    const direct = this.grants.get(key(muralId, "user", subject.id));
    if (direct) best = direct.role;
    for (const group of subject.groups) {
      const grant = this.grants.get(key(muralId, "group", normalizeSubjectId("group", group)));
      if (grant) best = best ? pickHigher(best, grant.role) : grant.role;
    }
    return best;
  }

  /**
   * The role to measure a mural-scoped route by when its mural CANNOT be resolved — an unplaced
   * screen, an unknown wall, a body that named no mural.
   *
   * A thing on no mural is FLEET PLUMBING: it belongs to nobody's canvas, so it belongs to the fleet
   * roles. Everyone else gets nothing, because they hold exactly what they were handed and the tray
   * is never handed to anyone.
   */
  unscopedFallbackRole(subject: GrantSubject): OperatorRole | null {
    return isFleetRole(subject.role) ? subject.role : null;
  }

  /**
   * WHICH MURALS this account is shown — `"all"`, or the exact set.
   *
   * `"all"` is not a convenience: it is what keeps every fleet role on the single shared,
   * serialized-once state broadcast, so a deployment run entirely by operators and admins — the
   * ordinary single-team case — pays nothing for any of this.
   *
   * Everything else in the console follows from this set rather than being filtered on its own terms:
   * a screen is visible because it is PLACED on a visible mural, a wall because it sits on one, a
   * scene because it snapshots one. There is exactly one question, asked once.
   */
  visibleMuralIds(subject: GrantSubject): Set<string> | "all" {
    if (isFleetRole(subject.role)) return "all";
    const groups = new Set(subject.groups.map((g) => normalizeSubjectId("group", g)));
    const visible = new Set<string>();
    for (const grant of this.grants.values()) {
      if (grant.subjectKind === "user" && grant.subjectId === subject.id) visible.add(grant.muralId);
      else if (grant.subjectKind === "group" && groups.has(grant.subjectId)) visible.add(grant.muralId);
    }
    return visible;
  }

  /**
   * The best role this subject holds on ANY mural.
   *
   * This exists for the fleet-wide routes that a mural owner genuinely cannot do without — putting a
   * URL in the content library, uploading a media file, saving a scene. Those are not addressed to a
   * mural in their path, so there is no id to scope them by, and gating them on the GLOBAL role would
   * make "manage the content on your mural" impossible: you could point a screen at a source but never
   * create one. The library is a shared, fleet-wide space and this deliberately treats it as such —
   * a mural owner can add to it, and the alternative (per-mural libraries) is a much larger change to
   * a model that is shared everywhere else.
   */
  bestRoleAnywhere(subject: GrantSubject): OperatorRole {
    // The fleet role IS the floor here, deliberately: this answers "may you touch the shared
    // library", not "may you touch a particular wall". A `viewer` floor grants nothing anyway (every
    // any-mural route asks for operator), so there is no hole to close.
    let best = subject.role;
    const groups = new Set(subject.groups.map((g) => normalizeSubjectId("group", g)));
    for (const grant of this.grants.values()) {
      if (grant.subjectKind === "user" && grant.subjectId === subject.id) {
        best = pickHigher(best, grant.role);
      } else if (grant.subjectKind === "group" && groups.has(grant.subjectId)) {
        best = pickHigher(best, grant.role);
      }
    }
    return best;
  }

  /** Every grant on a mural, for the console's People panel. Oldest first. */
  listForMural(muralId: string): PersistedMuralGrant[] {
    return [...this.grants.values()]
      .filter((g) => g.muralId === muralId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.subjectId.localeCompare(b.subjectId));
  }

  /** Create or re-level one grant (idempotent on the subject). Write-through: store, then index. */
  async put(
    muralId: string,
    subjectKind: MuralGrantSubjectKind,
    subjectIdRaw: string,
    role: OperatorRole,
  ): Promise<PersistedMuralGrant> {
    const subjectId = normalizeSubjectId(subjectKind, subjectIdRaw);
    const k = key(muralId, subjectKind, subjectId);
    const grant: PersistedMuralGrant = {
      muralId,
      subjectKind,
      subjectId,
      role,
      // Re-levelling keeps the ORIGINAL createdAt: it is the same grant at a different level, and the
      // People panel's ordering should not jump around when someone is promoted.
      createdAt: this.grants.get(k)?.createdAt ?? new Date().toISOString(),
    };
    await this.store.upsertMuralGrant(grant);
    this.grants.set(k, grant);
    return grant;
  }

  /** Revoke one grant. Returns false if there was nothing to revoke. */
  async remove(
    muralId: string,
    subjectKind: MuralGrantSubjectKind,
    subjectIdRaw: string,
  ): Promise<boolean> {
    const subjectId = normalizeSubjectId(subjectKind, subjectIdRaw);
    const k = key(muralId, subjectKind, subjectId);
    if (!this.grants.has(k)) return false;
    await this.store.deleteMuralGrant(muralId, subjectKind, subjectId);
    this.grants.delete(k);
    return true;
  }

  /** Drop every grant on a mural — called when the mural is deleted. */
  async removeForMural(muralId: string): Promise<void> {
    await this.store.deleteMuralGrantsForMural(muralId);
    for (const [k, grant] of this.grants) {
      if (grant.muralId === muralId) this.grants.delete(k);
    }
  }

  /** Drop every grant a user holds — called when the account is deleted. */
  async removeForUser(userId: string): Promise<void> {
    await this.store.deleteMuralGrantsForUser(userId);
    for (const [k, grant] of this.grants) {
      if (grant.subjectKind === "user" && grant.subjectId === userId) this.grants.delete(k);
    }
  }

  /**
   * Give whoever created a mural `admin` ON it. A team that stands up its own wall can then staff it —
   * add their colleagues, hand out levels — without going back to a fleet admin for every change.
   *
   * A global admin gets one too. It changes nothing about what they may do (their global role already
   * allows everything), and it means the People panel shows an owner rather than an empty list.
   */
  async grantOwner(muralId: string, userId: string): Promise<void> {
    await this.put(muralId, "user", userId, "admin");
  }
}

/** Decorate a persisted grant for the API: same row, plus a human label for a `user` subject. */
export function toMuralGrantView(
  grant: PersistedMuralGrant,
  emailForUser: (userId: string) => string | undefined,
): MuralGrant {
  return {
    muralId: grant.muralId,
    subjectKind: grant.subjectKind,
    subjectId: grant.subjectId,
    role: grant.role,
    createdAt: grant.createdAt,
    subjectLabel: grant.subjectKind === "user" ? (emailForUser(grant.subjectId) ?? null) : null,
  };
}
