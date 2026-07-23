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
  BootMode,
  ContentKind,
  DisplayBackend,
  EnrollmentStatus,
  Geometry,
  HostIdentity,
  ImageRing,
  MachineBootPath,
  MachineDisk,
  OperatorRole,
  Output,
  PlaylistItem,
  PreRegistration,
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
  /** POL-103 — operator tags ("atrium", "floor:2"). Undefined on legacy rows → no tags. */
  tags?: string[];
  /** POL-105 — the OS image id this box last reported booting, and when. Persisted (not live-only
   *  like the vitals ring) because the box a roll-out stranded is the box that is now offline. */
  imageId?: string;
  imageIdAt?: string;
  /** POL-171 — the boot chain this box last reported (`wired` | `local-fallback` | `local-wifi` |
   *  `disk`, the last from POL-176's installed boxes),
   *  when, and the sentence it composed ("image pinned at …"). Persisted for the same reason
   *  imageId is: the box on the fallback is exactly the box a rebuild is silently missing. */
  bootPath?: MachineBootPath;
  bootPathAt?: string;
  bootPathDetail?: string;
  /** POL-176 — live vs installed, as the agent last reported it from the kernel cmdline. Persisted
   *  like `imageId`: whether a dark box needs a truck roll or just power depends on it. */
  bootMode?: BootMode;
  bootModeAt?: string;
  /** POL-176 — the disk inventory the box last reported (`lsblk`), for the INSTALL dialog. */
  disks?: MachineDisk[];
  /** POL-176 — the image id staged to the box's inactive slot, verbatim, and when it was reported.
   *  `staged !== imageId` is the console's "update ready — reboot to apply" badge. */
  stagedImageId?: string;
  stagedImageIdAt?: string;
  /** POL-104 — the box's physical identity as it last reported it (MACs / DMI serial / arch). Kept on
   *  the ROW, not just in presence, so a pending card is informative while the box is offline. */
  hardware?: HostIdentity;
  /** POL-104 — the id of the enrolment token this machine FIRST enrolled on (which batch/stick it came
   *  in on). Undefined on rows that pre-date POL-104, or in open mode. */
  enrolledTokenId?: string;
  /** POL-104 — the token's name at the moment of enrolment (survives the token's deletion). */
  enrolledTokenName?: string;
  /** POL-104 — this machine matched a pre-registration record. */
  preRegistered?: boolean;
  /** POL-134 — ISO time the server last signed this machine's CSR into an mTLS client cert. */
  mtlsCertIssuedAt?: string;
  /** POL-134 — ISO time this machine FIRST connected over the mTLS listener (proof it presents a
   *  working cert). Undefined on legacy rows and on machines still on the plain channel. */
  mtlsSeenAt?: string;
}

/** A screen row: the first-class, named entity, stable per (machineId, connector). */
export interface PersistedScreen {
  id: string;
  friendlyName: string;
  machineId: string;
  connector: string;
  /** POL-119 — operator enabled casting (AirPlay receiver) on this screen. Persistent, no TTL.
   *  Undefined on legacy rows → false. */
  castEnabled?: boolean;
  /** POL-111 — the screen's template variables ("line" → "Line 3"). Undefined on legacy rows → {}.
   *  Note what is NOT here: any substituted content. Variables live on the SCREEN; the content rows
   *  keep their clean `{{placeholder}}` templates and substitution happens at send time. */
  variables?: Record<string, string>;
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
  /** POL-157 — the opt-in reload cadence (a `RefreshPolicy` as JSON), web/dashboard sources only.
   *  `null`/undefined = off (also legacy rows persisted before the column). The control plane
   *  re-validates it against the contract on load. */
  refresh?: unknown | null;
  /** POL-175 — the structured address breakdown (a `SourceComposition` as JSON) the dialog edits;
   *  `url` above stays the canonical composed URL. `null`/undefined on legacy rows (the console
   *  re-parses the url on edit-open). The control plane re-validates it on load. */
  composition?: unknown | null;
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

/**
 * POL-112 — a remembered audio intent for one (target, content) pair, keyed exactly like a zoom
 * preference. Assigning that content to that target again restores the level the operator dialled in;
 * NEW content on that target has no row and so arrives at the muted default.
 */
export interface PersistedAudioPreference {
  targetId: string;
  sourceKey: string;
  muted: boolean;
  volume: number;
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
 * mirroring the protocol `Scene`'s {placements, walls, screens}. WHEN a scene plays is not here:
 * POL-89/D93 dropped D24's illustrative `schedule_at` in favour of real `schedules` rows.
 */
export interface PersistedScene {
  id: string;
  name: string;
  muralId: string;
  snapshot: Pick<Scene, "placements" | "walls" | "screens">;
}

/** POL-89 — a named window of the day ("Opening hours", 08:00–18:00). `end <= start` wraps midnight. */
export interface PersistedDaypart {
  id: string;
  name: string;
  start: string;
  end: string;
}

/** POL-89 — a scene bound to a daypart on a recurrence, at a priority. The scheduler's unit. */
export interface PersistedSchedule {
  id: string;
  sceneId: string;
  daypartId: string;
  /** Weekdays the window is armed on (0=Sun…6=Sat). */
  days: number[];
  priority: number;
  enabled: boolean;
  /** Inclusive date range (`YYYY-MM-DD`), tested against the window's START date. */
  from: string | null;
  until: string | null;
  createdAt: string;
}

/** POL-89 — deployment-wide scheduler settings (one row): master switch, timezone, default scene. */
export interface PersistedSchedulerSettings {
  enabled: boolean;
  /** IANA zone. Explicit and configurable — never implied by the browser or the process env. */
  timezone: string;
  defaultSceneId: string | null;
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
  /**
   * POL-107 — what this account may do (`admin` | `operator` | `viewer`). A row written before
   * POL-107 has no role column value; the Postgres migration back-fills `admin` (that single account
   * WAS the admin) and every read normalizes an unknown/absent value to `admin` for the same reason.
   */
  role: OperatorRole;
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
 * POL-104 — one enrolment token. The pre-POL-104 single `bootstrap` row still exists and is still the
 * seed: on the first boot after the upgrade the server LIFTS its token into this table as a `legacy`
 * record (no expiry, no cap, `bake: true`), because every boot medium already flashed carries exactly
 * that secret. The `bootstrap` row is kept in step with whichever token is currently `bake`, so a
 * downgrade to a pre-POL-104 server still finds a working token where it expects one.
 *
 * The secret is stored RAW, not hashed — deliberately, and unlike the per-machine credentials next
 * door. `GET /boot/grub.cfg` has to be able to BAKE it into a kernel cmdline, and `build-boot-medium.sh`
 * lifts it back out of that menu; a hash cannot be baked into anything. (This is also true of the
 * pre-POL-104 `bootstrap.token` it replaces — POL-104 does not lower the bar, but it does not raise it
 * either, and that is the honest limit of this change.)
 */
export interface PersistedEnrollmentToken {
  id: string;
  name: string;
  secret: string;
  createdAt: string;
  expiresAt?: string | null;
  maxEnrollments?: number | null;
  uses: number;
  revokedAt?: string | null;
  lastUsedAt?: string | null;
  /** The token `/boot/grub.cfg` bakes. Exactly one row carries this. */
  bake: boolean;
  /** Lifted from the pre-POL-104 `bootstrap` row: the secret already in the field. */
  legacy: boolean;
}

/** POL-104 — a box declared before it ever booted (see the protocol's `PreRegistration`). */
export type PersistedPreRegistration = PreRegistration;

/**
 * POL-134 — the persisted agent-mTLS posture: whether the deployment has graduated to REQUIRING the
 * mTLS channel for every live agent session. Written exactly once by the auto-promotion (when every
 * known machine has been seen on the mTLS listener) or by a pinned `AGENT_MTLS_REQUIRE`; read on
 * boot so a promotion survives restarts and never silently regresses.
 */
export interface PersistedAgentMtlsPosture {
  required: boolean;
  /** ISO-8601 time of the promotion (or the first boot that saw the pin). */
  promotedAt?: string;
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
 * POL-70/D89 — the deployment's own SELF-SIGNED server TLS material (`TLS_MODE=self-signed`), for
 * installs with no cert infrastructure at all (the homelab case). One row, REUSED across restarts:
 * operators trust the CA certificate ONCE (Console ▸ Settings ▸ HTTPS ▸ Download) and every later
 * boot serves a leaf chaining to it — re-minting the CA on boot would re-warn every browser, which
 * is why persistence is the whole point. The LEAF may be re-minted from the same CA (new SANs, or
 * nearing expiry) without breaking that trust. Distinct from {@link PersistedMtlsCa}: that CA
 * authenticates AGENTS (client certs); this one authenticates the SERVER to browsers.
 */
export interface PersistedServerTls {
  /** The CA certificate (PEM) — what operators download and add to their trust store. */
  caCertPem: string;
  /** The CA private key (PKCS#8 PEM) — signs the server leaf; never leaves the store. */
  caKeyPem: string;
  /** The current server leaf certificate (PEM), SANs covering every dialable host. */
  certPem: string;
  /** The leaf's private key (PKCS#8 PEM). */
  keyPem: string;
  /** SANs baked into the current leaf — drives the "re-mint on new host" check. */
  sans: string[];
  /** ISO-8601 creation timestamp of the CA. */
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
  /**
   * POL-105 — the staged roll-out RINGS, ordered, first match wins. Each pins one build for the
   * machines a POL-103 selector matches (`tag=canary` → build X); every machine matching no ring
   * follows the arch's ACTIVE build, so an empty list is exactly the pre-POL-105 fleet-wide roll-out.
   * Persisted as a whole (jsonb): small, always read whole, only ever replaced whole.
   */
  rings: ImageRing[];
  /** POL-121 — the FIRST-IMAGE LATCH: when the server auto-triggered the one-shot full build that
   *  fills an empty depot on a fresh install. Written BEFORE the hook is spawned and never cleared,
   *  so a crash-looping or rescheduled pod cannot launch a build storm: the very first server that
   *  sees an empty depot claims it, everyone after reads the claim and stands down. Null on a
   *  deployment that never needed one (an image was already in the depot). */
  firstBuildAt: string | null;
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

/**
 * The fleet's UEFI boot-order policy (POL-115): may a running box put its own UEFI entry back at the
 * head of BootOrder when the firmware displaces it? Absent until an operator first flips it, and the
 * control plane's fallback is `false` — report the drift, write nothing.
 */
export interface PersistedBootOrderPolicy {
  reassert: boolean;
}

/**
 * Panel power (POL-101): the deployment's timezone plus each screen's daily on/off window. ONE row,
 * because that is genuinely all this is — a per-screen window and the zone to read it in. Kept
 * deliberately small: the full recurrence machinery belongs to the scene scheduler, and the two are
 * meant to converge (D100), so this must not grow a private calendar in the meantime.
 *
 * Absent until an operator first sets panel hours; a deployment that never does keeps its walls on
 * 24/7, exactly as before POL-101.
 */
export interface PersistedPanelPower {
  /** IANA zone the windows are read in ("Europe/London"). Explicit — never the server's own TZ. */
  timezone: string;
  /** screenId → its daily window. A screen with no entry is never touched by the scheduler. */
  hours: Record<string, { enabled: boolean; on: string; off: string }>;
}

/** The full snapshot returned by `load()` — everything needed to rebuild the in-memory state. */
export interface PersistedState {
  revision: number;
  /** POL-95 — the scene the wall is currently on (null = none / diverged). Persisted with the
   *  revision in the single-row `meta` table: the active scene is desired state, not a UI hint, so a
   *  server restart must not lose it. */
  activeSceneId: string | null;
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
  /** POL-89 — the scene scheduler: the daypart library and the schedules bound to it. */
  dayparts: PersistedDaypart[];
  schedules: PersistedSchedule[];
  /** POL-24 — credential profiles (content auth). */
  credentialProfiles: PersistedCredentialProfile[];
  /** POL-57 — remembered page zoom per (screen-or-wall, content) pair. */
  zoomPreferences: PersistedZoomPreference[];
  /** POL-112 — remembered audio intent per (screen-or-wall, content) pair. */
  audioPreferences: PersistedAudioPreference[];
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
  /** POL-103 — replace a machine's whole tag set (add + remove are the same call). No-op if absent. */
  setMachineTags(id: string, tags: string[]): Promise<void>;
  /** POL-105 — record the OS image id a box reported BOOTING, and when. No-op if absent. */
  setMachineImage(id: string, imageId: string, at: string): Promise<void>;
  /** POL-176 — record the image id a box's update poll STAGED to its inactive slot. No-op if absent. */
  setMachineStagedImage(id: string, stagedImageId: string, at: string): Promise<void>;
  /** POL-171 — record the boot chain a box reported coming up through. No-op if absent. */
  setMachineBootPath(id: string, path: MachineBootPath, at: string, detail: string): Promise<void>;
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
  /** POL-95 — persist the ACTIVE scene (null = none / the wall has diverged). Single-row, alongside
   *  the revision: which scene the wall is on is desired state, and must survive a restart. */
  setActiveSceneId(sceneId: string | null): Promise<void>;

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

  // ── Audio preferences (POL-112) ────────────────────────────────────────────
  /** Insert-or-update the remembered audio intent for one (target, content) pair. */
  upsertAudioPreference(pref: PersistedAudioPreference): Promise<void>;
  /** Forget every remembered audio intent for a screen or wall that no longer exists. No-op if none. */
  deleteAudioPreferencesForTarget(targetId: string): Promise<void>;
  /** All persisted audio preferences. */
  listAudioPreferences(): Promise<PersistedAudioPreference[]>;

  // ── Credential profiles (POL-24) ───────────────────────────────────────────
  /** Insert-or-update a credential-profile row (the only home of the client secret). */
  upsertCredentialProfile(profile: PersistedCredentialProfile): Promise<void>;
  /** Delete a credential-profile row. No-op if absent. */
  deleteCredentialProfile(id: string): Promise<void>;
  /** All persisted credential profiles. */
  listCredentialProfiles(): Promise<PersistedCredentialProfile[]>;

  // ── Scenes (Phase 3d) ──────────────────────────────────────────────────────
  /** Insert-or-update a scene row (id + name + mural + snapshot jsonb). */
  upsertScene(scene: PersistedScene): Promise<void>;
  /** Delete a scene row. No-op if absent. */
  deleteScene(id: string): Promise<void>;
  /** All persisted scenes. */
  listScenes(): Promise<PersistedScene[]>;

  // ── Scene scheduler (POL-89) ───────────────────────────────────────────────
  /** Insert-or-update a daypart row. */
  upsertDaypart(daypart: PersistedDaypart): Promise<void>;
  /** Delete a daypart row (the control plane deletes the schedules bound to it first). No-op if absent. */
  deleteDaypart(id: string): Promise<void>;
  /** All persisted dayparts. */
  listDayparts(): Promise<PersistedDaypart[]>;
  /** Insert-or-update a schedule row. */
  upsertSchedule(schedule: PersistedSchedule): Promise<void>;
  /** Delete a schedule row. No-op if absent. */
  deleteSchedule(id: string): Promise<void>;
  /** All persisted schedules. */
  listSchedules(): Promise<PersistedSchedule[]>;
  /** The persisted scheduler settings (single row). Undefined until first set — the control plane
   *  then falls back to its default (scheduler on, the server's own zone, no default scene). */
  getSchedulerSettings(): Promise<PersistedSchedulerSettings | undefined>;
  /** Replace the scheduler settings (single row). */
  setSchedulerSettings(settings: PersistedSchedulerSettings): Promise<void>;

  // ── Local operator accounts + sessions (Phase 3f / D29) ────────────────────
  /** Look up a user by (normalized) email. Used by login + change-password. */
  getUserByEmail(email: string): Promise<PersistedUser | undefined>;
  /** Look up a user by id. Used when resolving a session back to its operator. */
  getUserById(id: string): Promise<PersistedUser | undefined>;
  /** How many users exist — drives "seed an admin on first boot if none exist". */
  countUsers(): Promise<number>;
  /** Insert a new user row (id + email + argon2id hash + created_at + role). */
  createUser(user: PersistedUser): Promise<void>;
  /** Replace a user's password hash (after verifying the current password). No-op if absent. */
  updateUserPassword(id: string, passwordHash: string): Promise<void>;
  /** Every operator account, oldest first (POL-107 — Settings ▸ Operators). Hashes stay in the row. */
  listUsers(): Promise<PersistedUser[]>;
  /** Change an account's role (POL-107). No-op if absent. */
  updateUserRole(id: string, role: OperatorRole): Promise<void>;
  /** Delete an account and every session it holds (POL-107). No-op if absent. */
  deleteUser(id: string): Promise<void>;
  /** How many accounts hold `admin` — the last-admin guard reads this before a demote/delete. */
  countAdmins(): Promise<number>;

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

  // ── Enrolment tokens + pre-registration (POL-104) ──────────────────────────
  /** Every enrolment token, newest last. Empty on a deployment that has never been gated. */
  listEnrollmentTokens(): Promise<PersistedEnrollmentToken[]>;
  /** Insert-or-update one token row (create, revoke, bake-flag flip, use-count bump). */
  upsertEnrollmentToken(token: PersistedEnrollmentToken): Promise<void>;
  /** Forget a token entirely. Machines that enrolled on it are untouched (they hold credentials). */
  deleteEnrollmentToken(id: string): Promise<void>;

  /** Every pre-registration record, newest last. */
  listPreRegistrations(): Promise<PersistedPreRegistration[]>;
  /** Insert-or-update one pre-registration record. */
  upsertPreRegistration(record: PersistedPreRegistration): Promise<void>;
  /** Forget a pre-registration record. */
  deletePreRegistration(id: string): Promise<void>;

  // ── mTLS agent CA (POL-25) ─────────────────────────────────────────────────
  /** The persisted agent CA (cert + key). Undefined until first generated. */
  getMtlsCa(): Promise<PersistedMtlsCa | undefined>;
  /** Persist the agent CA (single row, written once on first mTLS boot). */
  setMtlsCa(ca: PersistedMtlsCa): Promise<void>;

  // ── Agent-mTLS posture (POL-134) ───────────────────────────────────────────
  /** The persisted require-mTLS posture. Undefined until first promoted/pinned. */
  getAgentMtlsPosture(): Promise<PersistedAgentMtlsPosture | undefined>;
  /** Persist the require-mTLS posture (single row). */
  setAgentMtlsPosture(posture: PersistedAgentMtlsPosture): Promise<void>;

  // ── Player-token secret (POL-54) ───────────────────────────────────────────
  /** The persisted HMAC secret behind the per-screen player tokens (hex). Undefined until the first
   *  boot generates it. Persisted so tokens survive a server restart — a reconnecting wall must
   *  never be rejected just because the control plane bounced. */
  getPlayerTokenSecret(): Promise<string | undefined>;
  /** Persist the player-token secret (single row, written once on first boot). */
  setPlayerTokenSecret(secret: string): Promise<void>;
  // ── Self-signed server TLS (POL-70/D89) ────────────────────────────────────
  /** The persisted self-signed server TLS material (CA + current leaf). Undefined until first boot in self-signed mode. */
  getServerTls(): Promise<PersistedServerTls | undefined>;
  /** Persist the self-signed server TLS material (single row; leaf re-mints overwrite in place). */
  setServerTls(tls: PersistedServerTls): Promise<void>;

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

  // ── UEFI boot-order policy (POL-115) ───────────────────────────────────────
  /** The persisted boot-order policy. Undefined until an operator first flips it (default: report-only). */
  getBootOrderPolicy(): Promise<PersistedBootOrderPolicy | undefined>;
  /** Persist the fleet-wide boot-order policy (single row). */
  setBootOrderPolicy(policy: PersistedBootOrderPolicy): Promise<void>;

  // ── Panel power (POL-101) ──────────────────────────────────────────────────
  /** The persisted panel-power config (timezone + per-screen hours). Undefined until first set. */
  getPanelPower(): Promise<PersistedPanelPower | undefined>;
  /** Replace the panel-power config (single row). */
  setPanelPower(power: PersistedPanelPower): Promise<void>;

  /** Release any underlying resources (DB pool). */
  close(): Promise<void>;
}
