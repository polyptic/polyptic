/**
 * MemoryStore — the in-memory test double for the Store interface.
 *
 * Same semantics as PostgresStore (upsert-everything, load returns a full snapshot) but holds
 * everything in plain Maps. Used by tests and by `STORE=memory` for a database-free run. State is
 * deep-cloned on the way in and out so callers can never mutate the store's copy by reference —
 * mirroring the isolation a real database gives you.
 */
import type { EnrollmentStatus } from "@polyptic/protocol";
import type {
  PersistedContent,
  PersistedMachine,
  PersistedMural,
  PersistedPlacement,
  PersistedScreen,
  PersistedState,
  PersistedVideoWall,
  Store,
} from "./types";

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class MemoryStore implements Store {
  private readonly machines = new Map<string, PersistedMachine>();
  private readonly screens = new Map<string, PersistedScreen>();
  private readonly content = new Map<string, PersistedContent>();
  private readonly murals = new Map<string, PersistedMural>();
  /** Keyed by screenId — a screen is placed on at most one mural at a time. */
  private readonly placements = new Map<string, PersistedPlacement>();
  /** Keyed by wall id — combined surfaces (Phase 3b). */
  private readonly videoWalls = new Map<string, PersistedVideoWall>();
  private revision = 0;

  async migrate(): Promise<void> {
    // Nothing to set up for the in-memory store.
  }

  async load(): Promise<PersistedState> {
    return {
      revision: this.revision,
      machines: [...this.machines.values()].map(clone),
      screens: [...this.screens.values()].map(clone),
      content: [...this.content.values()].map(clone),
      murals: [...this.murals.values()].map(clone),
      placements: [...this.placements.values()].map(clone),
      videoWalls: [...this.videoWalls.values()].map(clone),
    };
  }

  async upsertMachine(machine: PersistedMachine): Promise<void> {
    this.machines.set(machine.id, clone(machine));
  }

  async setMachineStatus(id: string, status: EnrollmentStatus): Promise<void> {
    const machine = this.machines.get(id);
    if (machine) machine.status = status;
  }

  async upsertScreen(screen: PersistedScreen): Promise<void> {
    this.screens.set(screen.id, clone(screen));
  }

  async upsertContent(content: PersistedContent): Promise<void> {
    this.content.set(content.screenId, clone(content));
  }

  async setRevision(revision: number): Promise<void> {
    this.revision = revision;
  }

  // ── Murals & placement (Phase 3) ────────────────────────────────────────────

  async upsertMural(mural: PersistedMural): Promise<void> {
    this.murals.set(mural.id, clone(mural));
  }

  async deleteMural(id: string): Promise<void> {
    this.murals.delete(id);
    // Drop any placements that referenced the mural (the control plane also unplaces individually).
    for (const [screenId, placement] of this.placements) {
      if (placement.muralId === id) this.placements.delete(screenId);
    }
    // Drop any video walls on the mural (the control plane also deletes them individually).
    for (const [wallId, wall] of this.videoWalls) {
      if (wall.muralId === id) this.videoWalls.delete(wallId);
    }
  }

  async listMurals(): Promise<PersistedMural[]> {
    return [...this.murals.values()].map(clone);
  }

  async upsertPlacement(placement: PersistedPlacement): Promise<void> {
    this.placements.set(placement.screenId, clone(placement));
  }

  async deletePlacement(screenId: string): Promise<void> {
    this.placements.delete(screenId);
  }

  async listPlacements(): Promise<PersistedPlacement[]> {
    return [...this.placements.values()].map(clone);
  }

  // ── Combined surfaces / video walls (Phase 3b) ──────────────────────────────

  async upsertVideoWall(wall: PersistedVideoWall): Promise<void> {
    this.videoWalls.set(wall.id, clone(wall));
  }

  async deleteVideoWall(id: string): Promise<void> {
    this.videoWalls.delete(id);
  }

  async listVideoWalls(): Promise<PersistedVideoWall[]> {
    return [...this.videoWalls.values()].map(clone);
  }

  async close(): Promise<void> {
    // No resources to release.
  }
}
