/**
 * Store interface + persisted DTOs for the Polyptych control plane.
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
import type { DisplayBackend, Geometry, Output, Surface } from "@polyptych/protocol";

/** A machine row: device plumbing + the outputs it last reported. */
export interface PersistedMachine {
  id: string;
  label: string;
  agentVersion?: string;
  backend?: DisplayBackend;
  outputs: Output[];
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
}

/** The full snapshot returned by `load()` — everything needed to rebuild the in-memory state. */
export interface PersistedState {
  revision: number;
  machines: PersistedMachine[];
  screens: PersistedScreen[];
  content: PersistedContent[];
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
  /** Insert-or-update a machine row. */
  upsertMachine(machine: PersistedMachine): Promise<void>;
  /** Insert-or-update a screen row (incl. its friendly name). */
  upsertScreen(screen: PersistedScreen): Promise<void>;
  /** Insert-or-update a screen's content row (canvas + surfaces). */
  upsertContent(content: PersistedContent): Promise<void>;
  /** Persist the global revision counter. */
  setRevision(revision: number): Promise<void>;
  /** Release any underlying resources (DB pool). */
  close(): Promise<void>;
}
