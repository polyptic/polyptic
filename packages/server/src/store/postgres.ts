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

import { DisplayBackend, EnrollmentStatus, Geometry, Output, Surface } from "@polyptic/protocol";

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

const DEFAULT_CANVAS = { x: 0, y: 0, w: 1920, h: 1080 } as const;

interface MachineRow {
  id: string;
  label: string;
  agent_version: string | null;
  backend: string | null;
  outputs: unknown;
  status: string | null;
  credential_hash: string | null;
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

interface MuralRow {
  id: string;
  name: string;
}

interface PlacementRow {
  mural_id: string;
  screen_id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface VideoWallRow {
  id: string;
  mural_id: string;
  member_screen_ids: unknown;
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
        id              text PRIMARY KEY,
        label           text NOT NULL,
        agent_version   text,
        backend         text,
        outputs         jsonb NOT NULL DEFAULT '[]'::jsonb,
        status          text NOT NULL DEFAULT 'approved',
        credential_hash text,
        last_seen       timestamptz
      )
    `;
    // Idempotent migration for databases created before Phase 2b: existing rows default to 'approved'.
    await sql`ALTER TABLE machines ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'approved'`;
    await sql`ALTER TABLE machines ADD COLUMN IF NOT EXISTS credential_hash text`;
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
    // Murals & placement (Phase 3). A screen is placed on at most one mural, so screen_id is the PK.
    await sql`
      CREATE TABLE IF NOT EXISTS murals (
        id   text PRIMARY KEY,
        name text NOT NULL
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS placements (
        mural_id  text NOT NULL,
        screen_id text PRIMARY KEY,
        x         double precision NOT NULL,
        y         double precision NOT NULL,
        w         double precision NOT NULL,
        h         double precision NOT NULL
      )
    `;
    // Combined surfaces / video walls (Phase 3b). Members are stored as a jsonb array of screen ids.
    await sql`
      CREATE TABLE IF NOT EXISTS video_walls (
        id                text PRIMARY KEY,
        mural_id          text NOT NULL,
        member_screen_ids jsonb NOT NULL DEFAULT '[]'::jsonb
      )
    `;
  }

  async load(): Promise<PersistedState> {
    const sql = this.sql;
    const [machineRows, screenRows, contentRows, metaRows, muralRows, placementRows, videoWallRows] =
      await Promise.all([
        sql<MachineRow[]>`SELECT id, label, agent_version, backend, outputs, status, credential_hash, last_seen FROM machines`,
        sql<ScreenRow[]>`SELECT id, friendly_name, machine_id, connector FROM screens`,
        sql<ContentRow[]>`SELECT screen_id, canvas, surfaces FROM screen_content`,
        sql<MetaRow[]>`SELECT revision FROM meta WHERE id = 1`,
        sql<MuralRow[]>`SELECT id, name FROM murals`,
        sql<PlacementRow[]>`SELECT mural_id, screen_id, x, y, w, h FROM placements`,
        sql<VideoWallRow[]>`SELECT id, mural_id, member_screen_ids FROM video_walls`,
      ]);

    const machines: PersistedMachine[] = machineRows.map((row) => {
      const outputs = Output.array().safeParse(row.outputs);
      const backend = DisplayBackend.safeParse(row.backend);
      const status = EnrollmentStatus.safeParse(row.status);
      return {
        id: row.id,
        label: row.label,
        agentVersion: row.agent_version ?? undefined,
        backend: backend.success ? backend.data : undefined,
        outputs: outputs.success ? outputs.data : [],
        // Legacy rows (NULL) and anything unrecognised degrade to `approved`.
        status: status.success ? status.data : "approved",
        credentialHash: row.credential_hash ?? undefined,
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

    const murals: PersistedMural[] = muralRows.map((row) => ({
      id: row.id,
      name: row.name,
    }));

    const placements: PersistedPlacement[] = placementRows.map((row) => ({
      muralId: row.mural_id,
      screenId: row.screen_id,
      x: Number(row.x),
      y: Number(row.y),
      w: Number(row.w),
      h: Number(row.h),
    }));

    const videoWalls: PersistedVideoWall[] = videoWallRows.map((row) => ({
      id: row.id,
      muralId: row.mural_id,
      // jsonb comes back already parsed; keep only string members and degrade gracefully otherwise.
      memberScreenIds: Array.isArray(row.member_screen_ids)
        ? row.member_screen_ids.filter((v): v is string => typeof v === "string")
        : [],
    }));

    const revision = metaRows[0] ? Number(metaRows[0].revision) : 0;

    return { revision, machines, screens, content, murals, placements, videoWalls };
  }

  async upsertMachine(machine: PersistedMachine): Promise<void> {
    const sql = this.sql;
    await sql`
      INSERT INTO machines (id, label, agent_version, backend, outputs, status, credential_hash, last_seen)
      VALUES (
        ${machine.id},
        ${machine.label},
        ${machine.agentVersion ?? null},
        ${machine.backend ?? null},
        ${sql.json(machine.outputs)},
        ${machine.status ?? "approved"},
        ${machine.credentialHash ?? null},
        ${machine.lastSeen ? new Date(machine.lastSeen) : null}
      )
      ON CONFLICT (id) DO UPDATE SET
        label           = EXCLUDED.label,
        agent_version   = EXCLUDED.agent_version,
        backend         = EXCLUDED.backend,
        outputs         = EXCLUDED.outputs,
        status          = EXCLUDED.status,
        credential_hash = EXCLUDED.credential_hash,
        last_seen       = EXCLUDED.last_seen
    `;
  }

  async setMachineStatus(id: string, status: EnrollmentStatus): Promise<void> {
    const sql = this.sql;
    await sql`UPDATE machines SET status = ${status} WHERE id = ${id}`;
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

  // ── Murals & placement (Phase 3) ────────────────────────────────────────────

  async upsertMural(mural: PersistedMural): Promise<void> {
    const sql = this.sql;
    await sql`
      INSERT INTO murals (id, name) VALUES (${mural.id}, ${mural.name})
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
    `;
  }

  async deleteMural(id: string): Promise<void> {
    const sql = this.sql;
    // Drop the mural and any placements/video-walls that referenced it (defensive — the control plane
    // also unplaces each screen and deletes each wall individually so memory + broadcasts stay correct).
    await sql`DELETE FROM placements WHERE mural_id = ${id}`;
    await sql`DELETE FROM video_walls WHERE mural_id = ${id}`;
    await sql`DELETE FROM murals WHERE id = ${id}`;
  }

  async listMurals(): Promise<PersistedMural[]> {
    const sql = this.sql;
    const rows = await sql<MuralRow[]>`SELECT id, name FROM murals`;
    return rows.map((row) => ({ id: row.id, name: row.name }));
  }

  async upsertPlacement(placement: PersistedPlacement): Promise<void> {
    const sql = this.sql;
    await sql`
      INSERT INTO placements (mural_id, screen_id, x, y, w, h)
      VALUES (
        ${placement.muralId},
        ${placement.screenId},
        ${placement.x},
        ${placement.y},
        ${placement.w},
        ${placement.h}
      )
      ON CONFLICT (screen_id) DO UPDATE SET
        mural_id = EXCLUDED.mural_id,
        x        = EXCLUDED.x,
        y        = EXCLUDED.y,
        w        = EXCLUDED.w,
        h        = EXCLUDED.h
    `;
  }

  async deletePlacement(screenId: string): Promise<void> {
    const sql = this.sql;
    await sql`DELETE FROM placements WHERE screen_id = ${screenId}`;
  }

  async listPlacements(): Promise<PersistedPlacement[]> {
    const sql = this.sql;
    const rows = await sql<PlacementRow[]>`SELECT mural_id, screen_id, x, y, w, h FROM placements`;
    return rows.map((row) => ({
      muralId: row.mural_id,
      screenId: row.screen_id,
      x: Number(row.x),
      y: Number(row.y),
      w: Number(row.w),
      h: Number(row.h),
    }));
  }

  // ── Combined surfaces / video walls (Phase 3b) ──────────────────────────────

  async upsertVideoWall(wall: PersistedVideoWall): Promise<void> {
    const sql = this.sql;
    await sql`
      INSERT INTO video_walls (id, mural_id, member_screen_ids)
      VALUES (${wall.id}, ${wall.muralId}, ${sql.json(wall.memberScreenIds)})
      ON CONFLICT (id) DO UPDATE SET
        mural_id          = EXCLUDED.mural_id,
        member_screen_ids = EXCLUDED.member_screen_ids
    `;
  }

  async deleteVideoWall(id: string): Promise<void> {
    const sql = this.sql;
    await sql`DELETE FROM video_walls WHERE id = ${id}`;
  }

  async listVideoWalls(): Promise<PersistedVideoWall[]> {
    const sql = this.sql;
    const rows = await sql<VideoWallRow[]>`SELECT id, mural_id, member_screen_ids FROM video_walls`;
    return rows.map((row) => ({
      id: row.id,
      muralId: row.mural_id,
      memberScreenIds: Array.isArray(row.member_screen_ids)
        ? row.member_screen_ids.filter((v): v is string => typeof v === "string")
        : [],
    }));
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}
