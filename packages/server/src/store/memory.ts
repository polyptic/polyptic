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
  PersistedBootstrap,
  PersistedContent,
  PersistedContentSource,
  PersistedMachine,
  PersistedMural,
  PersistedPlacement,
  PersistedScene,
  PersistedScreen,
  PersistedSession,
  PersistedState,
  PersistedUser,
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
  /** Keyed by source id — the content library (Phase 3c). */
  private readonly contentSources = new Map<string, PersistedContentSource>();
  /** Keyed by scene id — saved wall snapshots (Phase 3d). */
  private readonly scenes = new Map<string, PersistedScene>();
  /** Keyed by user id — local operator accounts (Phase 3f). */
  private readonly users = new Map<string, PersistedUser>();
  /** Keyed by session id (sha256 of the cookie token) — server-side sessions (Phase 3f). */
  private readonly sessions = new Map<string, PersistedSession>();
  /** The enrollment bootstrap (mode + token), seeded on first boot. */
  private bootstrap: PersistedBootstrap | undefined;
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
      contentSources: [...this.contentSources.values()].map(clone),
      scenes: [...this.scenes.values()].map(clone),
    };
  }

  async upsertMachine(machine: PersistedMachine): Promise<void> {
    this.machines.set(machine.id, clone(machine));
  }

  async setMachineStatus(id: string, status: EnrollmentStatus): Promise<void> {
    const machine = this.machines.get(id);
    if (machine) machine.status = status;
  }

  async deleteMachine(id: string): Promise<void> {
    this.machines.delete(id);
    // Cascade the machine's screens + their content + placements (defensive — the control plane also
    // removes each in memory + dissolves walls first so memory + broadcasts stay correct).
    for (const [screenId, screen] of this.screens) {
      if (screen.machineId !== id) continue;
      this.screens.delete(screenId);
      this.content.delete(screenId);
      this.placements.delete(screenId);
    }
  }

  async upsertScreen(screen: PersistedScreen): Promise<void> {
    this.screens.set(screen.id, clone(screen));
  }

  async deleteScreen(id: string): Promise<void> {
    this.screens.delete(id);
  }

  async upsertContent(content: PersistedContent): Promise<void> {
    this.content.set(content.screenId, clone(content));
  }

  async deleteContent(screenId: string): Promise<void> {
    this.content.delete(screenId);
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

  // ── Content library (Phase 3c) ──────────────────────────────────────────────

  async upsertContentSource(source: PersistedContentSource): Promise<void> {
    this.contentSources.set(source.id, clone(source));
  }

  async deleteContentSource(id: string): Promise<void> {
    this.contentSources.delete(id);
    // Clear the assignment off any content/wall rows that referenced it (the control plane also
    // clears each in-use assignment individually so memory + broadcasts stay correct).
    for (const content of this.content.values()) {
      if (content.sourceId === id) content.sourceId = null;
    }
    for (const wall of this.videoWalls.values()) {
      if (wall.contentSourceId === id) wall.contentSourceId = null;
    }
  }

  async listContentSources(): Promise<PersistedContentSource[]> {
    return [...this.contentSources.values()].map(clone);
  }

  // ── Scenes (Phase 3d) ───────────────────────────────────────────────────────

  async upsertScene(scene: PersistedScene): Promise<void> {
    this.scenes.set(scene.id, clone(scene));
  }

  async deleteScene(id: string): Promise<void> {
    this.scenes.delete(id);
  }

  async listScenes(): Promise<PersistedScene[]> {
    return [...this.scenes.values()].map(clone);
  }

  // ── Local operator accounts + sessions (Phase 3f) ────────────────────────────

  async getUserByEmail(email: string): Promise<PersistedUser | undefined> {
    for (const user of this.users.values()) {
      if (user.email === email) return clone(user);
    }
    return undefined;
  }

  async getUserById(id: string): Promise<PersistedUser | undefined> {
    const user = this.users.get(id);
    return user ? clone(user) : undefined;
  }

  async countUsers(): Promise<number> {
    return this.users.size;
  }

  async createUser(user: PersistedUser): Promise<void> {
    this.users.set(user.id, clone(user));
  }

  async updateUserPassword(id: string, passwordHash: string): Promise<void> {
    const user = this.users.get(id);
    if (user) user.passwordHash = passwordHash;
  }

  async createSession(session: PersistedSession): Promise<void> {
    this.sessions.set(session.id, clone(session));
  }

  async getSession(id: string): Promise<PersistedSession | undefined> {
    const session = this.sessions.get(id);
    return session ? clone(session) : undefined;
  }

  async deleteSession(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  async deleteSessionsForUser(userId: string): Promise<void> {
    for (const [id, session] of this.sessions) {
      if (session.userId === userId) this.sessions.delete(id);
    }
  }

  async deleteExpiredSessions(nowIso: string): Promise<void> {
    const cutoff = Date.parse(nowIso);
    for (const [id, session] of this.sessions) {
      if (Date.parse(session.expiresAt) <= cutoff) this.sessions.delete(id);
    }
  }

  // ── Enrollment bootstrap token (Phase 3f) ────────────────────────────────────

  async getBootstrap(): Promise<PersistedBootstrap | undefined> {
    return this.bootstrap ? clone(this.bootstrap) : undefined;
  }

  async setBootstrap(bootstrap: PersistedBootstrap): Promise<void> {
    this.bootstrap = clone(bootstrap);
  }

  async close(): Promise<void> {
    // No resources to release.
  }
}
