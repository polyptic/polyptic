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
  url: string;
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
   * Phase 3c — the library source this wall currently spans, if any. `null`/undefined means the wall
   * shows ad-hoc content (an ad-hoc URL or none). Editing the referenced source re-resolves + re-pushes
   * every member's span slice.
   */
  contentSourceId?: string | null;
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
  /** Insert-or-update a screen row (incl. its friendly name). */
  upsertScreen(screen: PersistedScreen): Promise<void>;
  /** Insert-or-update a screen's content row (canvas + surfaces). */
  upsertContent(content: PersistedContent): Promise<void>;
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

  /** Release any underlying resources (DB pool). */
  close(): Promise<void>;
}
