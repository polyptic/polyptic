/**
 * MemoryStore — the in-memory test double for the Store interface.
 *
 * Same semantics as PostgresStore (upsert-everything, load returns a full snapshot) but holds
 * everything in plain Maps. Used by tests and by `STORE=memory` for a database-free run. State is
 * deep-cloned on the way in and out so callers can never mutate the store's copy by reference —
 * mirroring the isolation a real database gives you.
 */
import type {
  PersistedContent,
  PersistedMachine,
  PersistedScreen,
  PersistedState,
  Store,
} from "./types";

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class MemoryStore implements Store {
  private readonly machines = new Map<string, PersistedMachine>();
  private readonly screens = new Map<string, PersistedScreen>();
  private readonly content = new Map<string, PersistedContent>();
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
    };
  }

  async upsertMachine(machine: PersistedMachine): Promise<void> {
    this.machines.set(machine.id, clone(machine));
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

  async close(): Promise<void> {
    // No resources to release.
  }
}
