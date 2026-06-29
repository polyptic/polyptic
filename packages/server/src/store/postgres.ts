/**
 * PostgresStore — the product/default registry storage.
 *
 * Backed by the `postgres` npm client (porsager/postgres), which runs natively under Bun. The
 * schema is created idempotently by `migrate()` (CREATE TABLE IF NOT EXISTS), so a fresh database
 * and a restart both Just Work. Every write is an UPSERT (ON CONFLICT … DO UPDATE) so the control
 * plane can write-through without first checking existence.
 *
 * jsonb columns (outputs, canvas, surfaces) are stored via `sql.json(...)` and come back already
 * parsed. timestamptz (last_seen) is stored as a Date and read back as a Date → ISO string. The
 * revision lives in a single-row `meta` table.
 *
 * Rows loaded from the DB are re-validated against the protocol schemas before entering memory;
 * anything that fails validation degrades gracefully (empty outputs / empty surfaces / default
 * canvas) rather than crashing the boot.
 */
import postgres from "postgres";

import { DisplayBackend, Geometry, Output, Surface } from "@polyptych/protocol";

import type {
  PersistedContent,
  PersistedMachine,
  PersistedScreen,
  PersistedState,
  Store,
} from "./types";

const DEFAULT_CANVAS = { x: 0, y: 0, w: 1920, h: 1080 } as const;

interface MachineRow {
  id: string;
  label: string;
  agent_version: string | null;
  backend: string | null;
  outputs: unknown;
  last_seen: Date | null;
}

interface ScreenRow {
  id: string;
  friendly_name: string;
  machine_id: string;
  connector: string;
}

interface ContentRow {
  screen_id: string;
  canvas: unknown;
  surfaces: unknown;
}

interface MetaRow {
  revision: string; // bigint comes back as a string to avoid precision loss
}

export class PostgresStore implements Store {
  private readonly sql: ReturnType<typeof postgres>;

  constructor(databaseUrl: string) {
    this.sql = postgres(databaseUrl, {
      // Keep the dev pool small; the control plane is the only writer.
      max: 10,
      // Surface JS errors instead of throwing strings.
      onnotice: () => {},
    });
  }

  async migrate(): Promise<void> {
    const sql = this.sql;
    await sql`
      CREATE TABLE IF NOT EXISTS machines (
        id            text PRIMARY KEY,
        label         text NOT NULL,
        agent_version text,
        backend       text,
        outputs       jsonb NOT NULL DEFAULT '[]'::jsonb,
        last_seen     timestamptz
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS screens (
        id            text PRIMARY KEY,
        friendly_name text NOT NULL,
        machine_id    text NOT NULL,
        connector     text NOT NULL
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS screen_content (
        screen_id text PRIMARY KEY,
        canvas    jsonb NOT NULL,
        surfaces  jsonb NOT NULL DEFAULT '[]'::jsonb
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS meta (
        id       int PRIMARY KEY DEFAULT 1,
        revision bigint NOT NULL DEFAULT 0
      )
    `;
    await sql`
      INSERT INTO meta (id, revision) VALUES (1, 0)
      ON CONFLICT (id) DO NOTHING
    `;
  }

  async load(): Promise<PersistedState> {
    const sql = this.sql;
    const [machineRows, screenRows, contentRows, metaRows] = await Promise.all([
      sql<MachineRow[]>`SELECT id, label, agent_version, backend, outputs, last_seen FROM machines`,
      sql<ScreenRow[]>`SELECT id, friendly_name, machine_id, connector FROM screens`,
      sql<ContentRow[]>`SELECT screen_id, canvas, surfaces FROM screen_content`,
      sql<MetaRow[]>`SELECT revision FROM meta WHERE id = 1`,
    ]);

    const machines: PersistedMachine[] = machineRows.map((row) => {
      const outputs = Output.array().safeParse(row.outputs);
      const backend = DisplayBackend.safeParse(row.backend);
      return {
        id: row.id,
        label: row.label,
        agentVersion: row.agent_version ?? undefined,
        backend: backend.success ? backend.data : undefined,
        outputs: outputs.success ? outputs.data : [],
        lastSeen: row.last_seen ? row.last_seen.toISOString() : undefined,
      };
    });

    const screens: PersistedScreen[] = screenRows.map((row) => ({
      id: row.id,
      friendlyName: row.friendly_name,
      machineId: row.machine_id,
      connector: row.connector,
    }));

    const content: PersistedContent[] = contentRows.map((row) => {
      const canvas = Geometry.safeParse(row.canvas);
      const surfaces = Surface.array().safeParse(row.surfaces);
      return {
        screenId: row.screen_id,
        canvas: canvas.success ? canvas.data : { ...DEFAULT_CANVAS },
        surfaces: surfaces.success ? surfaces.data : [],
      };
    });

    const revision = metaRows[0] ? Number(metaRows[0].revision) : 0;

    return { revision, machines, screens, content };
  }

  async upsertMachine(machine: PersistedMachine): Promise<void> {
    const sql = this.sql;
    await sql`
      INSERT INTO machines (id, label, agent_version, backend, outputs, last_seen)
      VALUES (
        ${machine.id},
        ${machine.label},
        ${machine.agentVersion ?? null},
        ${machine.backend ?? null},
        ${sql.json(machine.outputs)},
        ${machine.lastSeen ? new Date(machine.lastSeen) : null}
      )
      ON CONFLICT (id) DO UPDATE SET
        label         = EXCLUDED.label,
        agent_version = EXCLUDED.agent_version,
        backend       = EXCLUDED.backend,
        outputs       = EXCLUDED.outputs,
        last_seen     = EXCLUDED.last_seen
    `;
  }

  async upsertScreen(screen: PersistedScreen): Promise<void> {
    const sql = this.sql;
    await sql`
      INSERT INTO screens (id, friendly_name, machine_id, connector)
      VALUES (${screen.id}, ${screen.friendlyName}, ${screen.machineId}, ${screen.connector})
      ON CONFLICT (id) DO UPDATE SET
        friendly_name = EXCLUDED.friendly_name,
        machine_id    = EXCLUDED.machine_id,
        connector     = EXCLUDED.connector
    `;
  }

  async upsertContent(content: PersistedContent): Promise<void> {
    const sql = this.sql;
    await sql`
      INSERT INTO screen_content (screen_id, canvas, surfaces)
      VALUES (${content.screenId}, ${sql.json(content.canvas)}, ${sql.json(content.surfaces)})
      ON CONFLICT (screen_id) DO UPDATE SET
        canvas   = EXCLUDED.canvas,
        surfaces = EXCLUDED.surfaces
    `;
  }

  async setRevision(revision: number): Promise<void> {
    const sql = this.sql;
    await sql`
      INSERT INTO meta (id, revision) VALUES (1, ${revision})
      ON CONFLICT (id) DO UPDATE SET revision = EXCLUDED.revision
    `;
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}
