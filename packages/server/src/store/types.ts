/**
 * Store interface + persisted DTOs for the Polyptic control plane.
 *
 * The Store is the durable home of the registry: machines, screens (incl. their friendly name),
 * per-screen content (canvas + surfaces), and the global revision counter. The control plane keeps
 * an in-memory working copy and WRITES THROUGH to the Store on every mutation; on boot it LOADs the
 * persisted state back into memory and resumes the revision.
 *
 * `PostgresStore` is the product storage (default). `MemoryStore` is a test double with identical
 * semantics. Both implement this interface so the rest of the server never knows which is live.
 *
 * The persisted DTOs are structurally aligned with the protocol's `Machine` / `Screen` / `ScreenSlice`
 * so values flow between storage and the wire without translation, but they are declared here
 * explicitly to keep storage decoupled from the message layer.
 */
import type {
  ContentKind,
  DisplayBackend,
  EnrollmentStatus,
  Geometry,
  Output,
  PlaylistItem,
  Scene,
  Surface,
} from "@polyptic/protocol";

/** A machine row: device plumbing + the outputs it last reported. */
export interface PersistedMachine {
  id: string;
  label: string;
  agentVersion?: string;
  backend?: DisplayBackend;
  outputs: Output[];
  /**
   * Enrollment lifecycle (Phase 2b). Undefined on legacy rows persisted before this column existed —
   * the control plane loads those as `approved`.
   */
  status?: EnrollmentStatus;
  /** sha256(credential) hex for the durable per-machine credential, if one has been issued. */
  credentialHash?: string;
  /** ISO-8601 timestamp of the last agent hello. */
  lastSeen?: string;
  /** POL-59 — operator armed this box for a remote shell. Undefined on legacy rows → false. */
  shellEnabled?: boolean;
  /** POL-59 — ISO time the shell was armed / last used, for the auto-disarm TTL sweep. */
  shellArmedAt?: string;
}

/** A screen row: the first-class, named entity, stable per (machineId, connector). */
export interface PersistedScreen {
  id: string;
  friendlyName: string;
  machineId: string;
  connector: string;
}

/** A screen's renderable content: its canvas + the surfaces currently placed on it. */
export interface PersistedContent {
  screenId: string;
  canvas: Geometry;
  surfaces: Surface[];
  /**
   * Phase 3c — the library source this screen currently shows, if any. `null`/undefined means the
   * content is ad-hoc (an ad-hoc URL or cleared content), so a library edit never re-resolves it.
   * Editing the referenced source re-resolves + re-pushes this screen's surface.
   */
  sourceId?: string | null;
}

/**
 * Phase 3c — a content LIBRARY entry. A reusable, named source ({id, name, kind, url}) that a screen
 * or video wall is assigned by id; the control plane resolves it to the surface(s) it renders.
 */
export interface PersistedContentSource {
  id: string;
  name: string;
  kind: ContentKind;
  /** The address non-playlist/non-page kinds resolve to. `null`/undefined on a playlist (POL-34)
   *  or a page (POL-42 — a page has a definition, not an address). */
  url?: string | null;
  /**
   * POL-24 — the credential profile whose token is stamped into this source's URL at send time.
   * `null`/undefined = unauthenticated (also the value on legacy rows persisted before the column).
   */
  credentialProfileId?: string | null;
  /**
   * POL-34 — playlist kind only: the authored carousel steps (jsonb). `null`/undefined on every other
   * kind and on legacy rows persisted before the column.
   */
  items?: PlaylistItem[] | null;
  /** POL-42 — the authored composition (a `PageDefinition` as JSON), present only for `page`
   *  sources. The control plane re-validates it against the contract on load. */
  definition?: unknown | null;
  /** POL-18 — the framing-probe verdict ("ok" | "blocked" | "unknown") for web/dashboard sources.
   *  `null`/undefined = never probed (also legacy rows persisted before the column). */
  framing?: string | null;
  /** POL-18 — the operator's placement override ("auto" | "iframe" | "window"). `null`/undefined =
   *  auto (also legacy rows persisted before the column). */
  placementMode?: string | null;
}

/**
 * POL-24 — a credential profile row: a centrally-held OAuth client for Bucket-A content auth
 * (strategy `oauth-client-credentials`). This is the ONLY place the client secret lives; it is never
 * broadcast, never returned by REST, and never logged. Tokens themselves are NOT persisted — they are
 * short-lived and re-fetched on boot.
 */
export interface PersistedCredentialProfile {
  id: string;
  name: string;
  /** The D11 strategy seam; "oauth-client-credentials" today. */
  strategy: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  scope?: string | null;
  audience?: string | null;
  /** Query parameter the token is delivered in at send time (default "auth_token"). */
  tokenParam: string;
}

/**
 * POL-57 — a remembered page zoom for one (target, content) pair. `targetId` is a screen id or a
 * video-wall id; `sourceKey` identifies the page shown there (`source:<id>` for a library source,
 * `url:<url>` for an ad-hoc link). Assigning that content to that target again restores this zoom,
 * so an operator dials a dashboard in once per screen and it sticks.
 */
export interface PersistedZoomPreference {
  targetId: string;
  sourceKey: string;
  zoom: number;
}

/** A mural row (Phase 3): a named, switchable spatial canvas. */
export interface PersistedMural {
  id: string;
  name: string;
}

/**
 * A placement row (Phase 3): a screen positioned on exactly one mural at `{x,y,w,h}` canvas pixels.
 * `screenId` is the primary key — a screen is placed on at most one mural at a time.
 */
export interface PersistedPlacement {
  muralId: string;
  screenId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A video-wall row (Phase 3b): a "combined surface" — ≥2 adjacent placed screens on one mural that
 * one piece of content spans across. `memberScreenIds` is stored as jsonb (an array of screen ids).
 */
export interface PersistedVideoWall {
  id: string;
  muralId: string;
  memberScreenIds: string[];
  /**
   * Operator-given name for the combined surface (e.g. "Atrium Wall"). Nullable/undefined on legacy
   * rows persisted before naming existed — the control plane loads those with `VideoWall.name`
   * undefined and the console derives a member-name label. Never required at the store layer.
   */
  name?: string | null;
  /**
   * Phase 3c — the library source this wall currently spans, if any. `null`/undefined means the wall
   * shows ad-hoc content (an ad-hoc URL or none). Editing the referenced source re-resolves + re-pushes
   * every member's span slice.
   */
  contentSourceId?: string | null;
}

/**
 * Phase 3d — a SCENE row: a named SNAPSHOT of a mural's whole wall. The layout (placements),
 * grouping (video walls) and content (per screen + per wall) live together in the `snapshot` jsonb,
 * mirroring the protocol `Scene`'s {placements, walls, screens}. `scheduleAt` is the illustrative
 * "HH:MM" time — STORED, NOT FIRED — and is null/undefined when unscheduled.
 */
export interface PersistedScene {
  id: string;
  name: string;
  muralId: string;
  snapshot: Pick<Scene, "placements" | "walls" | "screens">;
  scheduleAt?: string | null;
}

// ── Local operator accounts + sessions + enrollment bootstrap (Phase 3f / D29) ──

/**
 * A local operator account. Passwords are NEVER stored in plaintext — only `passwordHash`, an
 * argon2id digest produced by `Bun.password.hash`. The email is stored normalized (trimmed + lower).
 */
export interface PersistedUser {
  id: string;
  email: string;
  /** argon2id hash (Bun.password). The plaintext password is never stored or logged. */
  passwordHash: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
}

/**
 * A server-side session. `id` is the OPAQUE session identifier the server holds — specifically the
 * sha256 of the random session token carried in the (signed, http-only) cookie, so a database read
 * never reveals a usable token. Sessions are revocable (delete the row) and expire at `expiresAt`.
 */
export interface PersistedSession {
  /** sha256(sessionToken) hex — the cookie carries the raw token, the DB only ever sees its hash. */
  id: string;
  userId: string;
  createdAt: string;
  /** ISO-8601 expiry. A session past this instant is treated as absent and swept. */
  expiresAt: string;
}

/** Enrollment mode for the agent bootstrap token (mirrors the protocol `EnrollmentInfo.mode`). */
export type EnrollmentMode = "open" | "gated";

/**
 * The persisted enrollment bootstrap: which mode the deployment runs in and (when `gated`) the
 * current bootstrap token an agent must present on first contact. `open` mode has a `null` token.
 * Seeded on first boot from `POLYPTIC_BOOTSTRAP_TOKEN`; mutated by the Settings "regenerate" action.
 */
export interface PersistedBootstrap {
  mode: EnrollmentMode;
  token: string | null;
}

/**
 * POL-25 — the deployment's own agent CA for mTLS client certificates. Generated once on the first
 * boot with `AGENT_MTLS_PORT` set, then reused forever: every client cert the fleet holds chains to
 * THIS key, so losing the row would orphan the whole fleet's certs (they'd re-enrol via the app-level
 * credential seam, but only after their mTLS dials start failing). The private key never leaves the
 * server; it is exactly as sensitive as the machine credential hashes stored alongside it.
 */
export interface PersistedMtlsCa {
  /** The CA certificate (PEM) — sent to agents as their pinned trust root. */
  certPem: string;
  /** The CA private key (PKCS#8 PEM). Signs client CSRs and the listener's own server cert. */
  keyPem: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
}

/**
 * Image-updates state (POL-41): the scheduled-rebuild settings, the urgent roll-out switch, and the
 * last rebuild-hook run. One row; absent until first mutated (defaults: schedule on at 01:00,
 * urgent off).
 */
export interface PersistedImageRollout {
  scheduleEnabled: boolean;
  /** Server-local `HH:MM` the daily refresh hook fires at. */
  scheduleTime: string;
  /** Weekly FULL rebuild cycle (POL-43): the daily refresh holds the kernel (D47), so this second
   *  cycle — a rebuild from the base ISO — is what actually rolls kernel CVEs. */
  fullScheduleEnabled: boolean;
  /** Day-of-week the full rebuild fires (0 = Sunday … 6 = Saturday). */
  fullScheduleDay: number;
  /** Server-local `HH:MM` the full rebuild fires at. */
  fullScheduleTime: string;
  urgent: boolean;
  lastBuildStartedAt: string | null;
  lastBuildFinishedAt: string | null;
  lastBuildStatus: "running" | "success" | "failure" | null;
  lastBuildLog: string | null;
  /** Which cycle the last run was: the daily in-place refresh or the weekly full rebuild. */
  lastBuildKind: "refresh" | "full" | null;
}

/**
 * Fleet-wide display settings (POL-6): the operator-toggleable on-screen badge visibility, persisted
 * so a runtime choice survives a restart. Absent until the setting is first changed — the control
 * plane then falls back to its env-derived default (prod off / dev on).
 */
export interface PersistedDisplaySettings {
  showBadges: boolean;
}

/** The full snapshot returned by `load()` — everything needed to rebuild the in-memory state. */
export interface PersistedState {
  revision: number;
  machines: PersistedMachine[];
  screens: PersistedScreen[];
  content: PersistedContent[];
  /** Phase 3 — murals and placements. */
  murals: PersistedMural[];
  placements: PersistedPlacement[];
  /** Phase 3b — combined surfaces (video walls). */
  videoWalls: PersistedVideoWall[];
  /** Phase 3c — the content library. */
  contentSources: PersistedContentSource[];
  /** Phase 3d — saved wall snapshots (scenes). */
  scenes: PersistedScene[];
  /** POL-24 — credential profiles (content auth). */
  credentialProfiles: PersistedCredentialProfile[];
  /** POL-57 — remembered page zoom per (screen-or-wall, content) pair. */
  zoomPreferences: PersistedZoomPreference[];
}

/**
 * The durable registry store. Implementations: `PostgresStore` (default/product) and `MemoryStore`
 * (test double). All writes are upserts so the control plane can blindly write-through.
 */
export interface Store {
  /** Idempotent schema setup. CREATE TABLE IF NOT EXISTS …; no-op for the memory store. */
  migrate(): Promise<void>;
  /** Load the full persisted snapshot on boot. */
  load(): Promise<PersistedState>;
  /** Insert-or-update a machine row (incl. its enrollment status + credential hash). */
  upsertMachine(machine: PersistedMachine): Promise<void>;
  /** Update only a machine's enrollment status (operator approve/reject). No-op if the row is absent. */
  setMachineStatus(id: string, status: EnrollmentStatus): Promise<void>;
  /** Arm/disarm a machine for the remote shell (POL-59), stamping the arm time. No-op if absent. */
  setMachineShellEnabled(id: string, enabled: boolean, armedAt: string | null): Promise<void>;
  /**
   * Permanently forget a machine: delete its row AND cascade its screens, their content, and their
   * placements (defensive — the control plane also removes each in memory + dissolves walls first, so
   * memory + broadcasts stay correct). No-op if the row is absent.
   */
  deleteMachine(id: string): Promise<void>;
  /** Insert-or-update a screen row (incl. its friendly name). */
  upsertScreen(screen: PersistedScreen): Promise<void>;
  /**
   * Delete a screen row ONLY (not its content/placement — callers drop those via deleteContent /
   * deletePlacement). Used both to prune a stale phantom the machine no longer advertises and to
   * permanently remove a screen from the console (POL-14). No-op if absent.
   */
  deleteScreen(id: string): Promise<void>;
  /** Insert-or-update a screen's content row (canvas + surfaces). */
  upsertContent(content: PersistedContent): Promise<void>;
  /** Delete a screen's content row. No-op if absent. */
  deleteContent(screenId: string): Promise<void>;
  /** Persist the global revision counter. */
  setRevision(revision: number): Promise<void>;

  // ── Murals & placement (Phase 3) ──────────────────────────────────────────
  /** Insert-or-update a mural row (id + name). */
  upsertMural(mural: PersistedMural): Promise<void>;
  /** Delete a mural row (and any placements on it). No-op if absent. */
  deleteMural(id: string): Promise<void>;
  /** All persisted murals. */
  listMurals(): Promise<PersistedMural[]>;
  /** Insert-or-update a placement, keyed by screenId (placing elsewhere moves the screen). */
  upsertPlacement(placement: PersistedPlacement): Promise<void>;
  /** Remove a screen's placement (unplace it). No-op if absent. */
  deletePlacement(screenId: string): Promise<void>;
  /** All persisted placements. */
  listPlacements(): Promise<PersistedPlacement[]>;

  // ── Combined surfaces / video walls (Phase 3b) ─────────────────────────────
  /** Insert-or-update a video-wall row (id + mural + member screen ids). */
  upsertVideoWall(wall: PersistedVideoWall): Promise<void>;
  /** Delete a video-wall row (split it). No-op if absent. */
  deleteVideoWall(id: string): Promise<void>;
  /** All persisted video walls. */
  listVideoWalls(): Promise<PersistedVideoWall[]>;

  // ── Content library (Phase 3c) ─────────────────────────────────────────────
  /** Insert-or-update a content-source row (id + name + kind + url). */
  upsertContentSource(source: PersistedContentSource): Promise<void>;
  /** Delete a content-source row. No-op if absent. */
  deleteContentSource(id: string): Promise<void>;
  /** All persisted content sources. */
  listContentSources(): Promise<PersistedContentSource[]>;

  // ── Page zoom preferences (POL-57) ─────────────────────────────────────────
  /** Insert-or-update the remembered zoom for one (target, content) pair. */
  upsertZoomPreference(pref: PersistedZoomPreference): Promise<void>;
  /** Forget every remembered zoom for a screen or wall that no longer exists. No-op if none. */
  deleteZoomPreferencesForTarget(targetId: string): Promise<void>;
  /** All persisted zoom preferences. */
  listZoomPreferences(): Promise<PersistedZoomPreference[]>;

  // ── Credential profiles (POL-24) ───────────────────────────────────────────
  /** Insert-or-update a credential-profile row (the only home of the client secret). */
  upsertCredentialProfile(profile: PersistedCredentialProfile): Promise<void>;
  /** Delete a credential-profile row. No-op if absent. */
  deleteCredentialProfile(id: string): Promise<void>;
  /** All persisted credential profiles. */
  listCredentialProfiles(): Promise<PersistedCredentialProfile[]>;

  // ── Scenes (Phase 3d) ──────────────────────────────────────────────────────
  /** Insert-or-update a scene row (id + name + mural + snapshot jsonb + schedule_at). */
  upsertScene(scene: PersistedScene): Promise<void>;
  /** Delete a scene row. No-op if absent. */
  deleteScene(id: string): Promise<void>;
  /** All persisted scenes. */
  listScenes(): Promise<PersistedScene[]>;

  // ── Local operator accounts + sessions (Phase 3f / D29) ────────────────────
  /** Look up a user by (normalized) email. Used by login + change-password. */
  getUserByEmail(email: string): Promise<PersistedUser | undefined>;
  /** Look up a user by id. Used when resolving a session back to its operator. */
  getUserById(id: string): Promise<PersistedUser | undefined>;
  /** How many users exist — drives "seed an admin on first boot if none exist". */
  countUsers(): Promise<number>;
  /** Insert a new user row (id + email + argon2id hash + created_at). */
  createUser(user: PersistedUser): Promise<void>;
  /** Replace a user's password hash (after verifying the current password). No-op if absent. */
  updateUserPassword(id: string, passwordHash: string): Promise<void>;

  /** Insert a session row (its id is sha256(token); the raw token only ever lives in the cookie). */
  createSession(session: PersistedSession): Promise<void>;
  /** Look up a session by its id (sha256 of the cookie token). Undefined if revoked/absent. */
  getSession(id: string): Promise<PersistedSession | undefined>;
  /** Revoke a single session (logout). No-op if absent. */
  deleteSession(id: string): Promise<void>;
  /** Revoke every session for a user (e.g. after a password change). */
  deleteSessionsForUser(userId: string): Promise<void>;
  /** Sweep sessions whose expires_at is at or before `nowIso`. */
  deleteExpiredSessions(nowIso: string): Promise<void>;

  // ── Enrollment bootstrap token (Phase 3f) ──────────────────────────────────
  /** The persisted enrollment bootstrap (mode + token). Undefined before first seed. */
  getBootstrap(): Promise<PersistedBootstrap | undefined>;
  /** Persist the enrollment bootstrap (single row). */
  setBootstrap(bootstrap: PersistedBootstrap): Promise<void>;

  // ── mTLS agent CA (POL-25) ─────────────────────────────────────────────────
  /** The persisted agent CA (cert + key). Undefined until first generated. */
  getMtlsCa(): Promise<PersistedMtlsCa | undefined>;
  /** Persist the agent CA (single row, written once on first mTLS boot). */
  setMtlsCa(ca: PersistedMtlsCa): Promise<void>;

  // ── Player-token secret (POL-54) ───────────────────────────────────────────
  /** The persisted HMAC secret behind the per-screen player tokens (hex). Undefined until the first
   *  boot generates it. Persisted so tokens survive a server restart — a reconnecting wall must
   *  never be rejected just because the control plane bounced. */
  getPlayerTokenSecret(): Promise<string | undefined>;
  /** Persist the player-token secret (single row, written once on first boot). */
  setPlayerTokenSecret(secret: string): Promise<void>;

  // ── Display settings (POL-6) ───────────────────────────────────────────────
  /** The persisted fleet-wide display settings (badge toggle). Undefined until first changed. */
  // ── Image updates (POL-41) ─────────────────────────────────────────────────
  /** The persisted image-updates state (schedule + urgency + last build). Undefined until first set. */
  getImageRollout(): Promise<PersistedImageRollout | undefined>;
  /** Replace the image-updates state. */
  setImageRollout(rollout: PersistedImageRollout): Promise<void>;

  getDisplaySettings(): Promise<PersistedDisplaySettings | undefined>;
  /** Persist the fleet-wide display settings (single row). */
  setDisplaySettings(settings: PersistedDisplaySettings): Promise<void>;

  /** Release any underlying resources (DB pool). */
  close(): Promise<void>;
}
