/**
 * Store selection — `createStore()` picks the implementation from the `STORE` env var.
 *
 *   STORE=postgres (default)  → PostgresStore, DATABASE_URL or the dev default.
 *   STORE=memory              → MemoryStore (no database; tests / quick local runs).
 *
 * The caller is responsible for `await store.migrate()` before use (a no-op for the memory store).
 */
import { MemoryStore } from "./memory";
import { PostgresStore } from "./postgres";

import type { Store } from "./types";

export type {
  EnrollmentMode,
  PersistedBootstrap,
  PersistedContent,
  PersistedContentSource,
  PersistedMachine,
  PersistedMural,
  PersistedPlacement,
  PersistedRollout,
  PersistedScene,
  PersistedScreen,
  PersistedSession,
  PersistedState,
  PersistedUser,
  PersistedVideoWall,
  Store,
} from "./types";
export { MemoryStore } from "./memory";
export { PostgresStore } from "./postgres";

const DEFAULT_DATABASE_URL = "postgres://polyptic:polyptic@localhost:5432/polyptic";

export interface CreatedStore {
  store: Store;
  kind: "postgres" | "memory";
}

/** Build the configured Store. Defaults to Postgres (the product storage); `STORE=memory` for tests. */
export function createStore(): CreatedStore {
  const kind = (process.env.STORE ?? "postgres").toLowerCase();
  if (kind === "memory") {
    return { store: new MemoryStore(), kind: "memory" };
  }
  const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  return { store: new PostgresStore(databaseUrl), kind: "postgres" };
}
