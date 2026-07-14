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

import { z } from "zod";

import {
  ContentKind,
  DisplayBackend,
  EnrollmentStatus,
  Geometry,
  Output,
  PlaylistItem,
  Surface,
} from "@polyptic/protocol";

import type {
  EnrollmentMode,
  PersistedBootstrap,
  PersistedContent,
  PersistedContentSource,
  PersistedCredentialProfile,
  PersistedDisplaySettings,
  PersistedImageRollout,
  PersistedMachine,
  PersistedMtlsCa,
  PersistedNotificationRule,
  PersistedServerTls,
  PersistedMural,
  PersistedPlacement,
  PersistedScene,
  PersistedScreen,
  PersistedSession,
  PersistedState,
  PersistedUser,
  PersistedVideoWall,
  PersistedZoomPreference,
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
  shell_enabled: boolean | null;
  shell_armed_at: Date | null;
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
  source_id: string | null;
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
  name: string | null;
  content_source_id: string | null;
}

interface ContentSourceRow {
  id: string;
  name: string;
  kind: string;
  url: string | null;
  credential_profile_id: string | null;
  items: unknown;
  definition: unknown | null;
}

/** Row → DTO for a content source, re-validating at the edge (shared by load + list). Returns []
 *  for a row with an unrecognised kind rather than crashing the boot; a malformed `items` jsonb
 *  degrades to an empty carousel rather than dropping the playlist. */
function contentSourceFromRow(row: ContentSourceRow): PersistedContentSource[] {
  const kind = ContentKind.safeParse(row.kind);
  if (!kind.success) return [];
  const items = z.array(PlaylistItem).safeParse(row.items);
  return [
    {
      id: row.id,
      name: row.name,
      kind: kind.data,
      url: row.url ?? null,
      credentialProfileId: row.credential_profile_id ?? null,
      definition: row.definition ?? null,
      items: kind.data === "playlist" ? (items.success ? items.data : []) : null,
    },
  ];
}

interface NotificationRuleRow {
  id: string;
  name: string;
  enabled: boolean;
  kinds: string[] | null;
  notifier: string;
  webhook_url: string | null;
  webhook_secret: string | null;
  email_to: string[] | null;
  debounce_seconds: number;
  quiet_start: string | null;
  quiet_end: string | null;
}

interface CredentialProfileRow {
  id: string;
  name: string;
  strategy: string;
  token_endpoint: string;
  client_id: string;
  client_secret: string;
  scope: string | null;
  audience: string | null;
  token_param: string;
}

interface ZoomPreferenceRow {
  target_id: string;
  source_key: string;
  zoom: number;
}

interface SceneRow {
  id: string;
  name: string;
  mural_id: string;
  snapshot: unknown;
  schedule_at: string | null;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  created_at: Date;
}

interface SessionRow {
  id: string;
  user_id: string;
  created_at: Date;
  expires_at: Date;
}

interface BootstrapRow {
  mode: string;
  token: string | null;
}

interface DisplaySettingsRow {
  show_badges: boolean;
}

interface CountRow {
  count: string; // count(*) comes back as a bigint string
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
    await sql`ALTER TABLE machines ADD COLUMN IF NOT EXISTS shell_enabled boolean NOT NULL DEFAULT false`;
    await sql`ALTER TABLE machines ADD COLUMN IF NOT EXISTS shell_armed_at timestamptz`;
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
        surfaces  jsonb NOT NULL DEFAULT '[]'::jsonb,
        source_id text
      )
    `;
    // Idempotent migration for databases created before Phase 3c: the column tracks which library
    // source (if any) a screen currently shows, so source edits can re-resolve + re-push it.
    await sql`ALTER TABLE screen_content ADD COLUMN IF NOT EXISTS source_id text`;
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
        member_screen_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
        content_source_id text
      )
    `;
    // Idempotent migration for databases created before Phase 3c: tracks which library source (if any)
    // a wall currently spans, so source edits re-resolve + re-push every member's span slice.
    await sql`ALTER TABLE video_walls ADD COLUMN IF NOT EXISTS content_source_id text`;
    // Idempotent migration for the "nameable combined surfaces" feature: existing rows keep NULL name
    // (load → VideoWall.name undefined → the console derives a member-name label). Nullable on purpose.
    await sql`ALTER TABLE video_walls ADD COLUMN IF NOT EXISTS name text`;
    // Content library (Phase 3c). A reusable, named source resolved to surface(s) on assignment.
    await sql`
      CREATE TABLE IF NOT EXISTS content_sources (
        id   text PRIMARY KEY,
        name text NOT NULL,
        kind text NOT NULL,
        url  text NOT NULL
      )
    `;
    // Idempotent migration for databases created before POL-24: which credential profile (if any)
    // authenticates this source. NULL = unauthenticated.
    await sql`ALTER TABLE content_sources ADD COLUMN IF NOT EXISTS credential_profile_id text`;
    // Playlists (POL-34): a playlist source keeps its carousel steps here and has NO url, so the url
    // column loses its NOT NULL. Pages (POL-42) store an authored composition (`definition` jsonb)
    // instead of an address. All idempotent for databases created before either kind existed.
    await sql`ALTER TABLE content_sources ADD COLUMN IF NOT EXISTS items jsonb`;
    await sql`ALTER TABLE content_sources ALTER COLUMN url DROP NOT NULL`;
    await sql`ALTER TABLE content_sources ADD COLUMN IF NOT EXISTS definition jsonb`;
    // Page zoom preferences (POL-57). One row per (screen-or-wall, content) pair, so re-assigning a
    // page to a screen restores the zoom that screen last used FOR THAT PAGE.
    await sql`
      CREATE TABLE IF NOT EXISTS zoom_preferences (
        target_id  text NOT NULL,
        source_key text NOT NULL,
        zoom       double precision NOT NULL,
        PRIMARY KEY (target_id, source_key)
      )
    `;
    // Credential profiles (POL-24): centrally-held OAuth clients for Bucket-A content auth. The
    // client secret's ONLY durable home — never broadcast, never returned by REST, never logged.
    await sql`
      CREATE TABLE IF NOT EXISTS credential_profiles (
        id             text PRIMARY KEY,
        name           text NOT NULL,
        strategy       text NOT NULL DEFAULT 'oauth-client-credentials',
        token_endpoint text NOT NULL,
        client_id      text NOT NULL,
        client_secret  text NOT NULL,
        scope          text,
        audience       text,
        token_param    text NOT NULL DEFAULT 'auth_token'
      )
    `;
    // Notification rules (POL-91): which alert kinds go out through which notifier, with the per-rule
    // debounce + quiet hours. `webhook_secret` is the HMAC signing key — the same posture as a
    // credential profile's client secret: this row is its only home, and it never leaves the server.
    await sql`
      CREATE TABLE IF NOT EXISTS notification_rules (
        id               text PRIMARY KEY,
        name             text NOT NULL,
        enabled          boolean NOT NULL DEFAULT true,
        kinds            jsonb NOT NULL DEFAULT '[]'::jsonb,
        notifier         text NOT NULL,
        webhook_url      text,
        webhook_secret   text,
        email_to         jsonb,
        debounce_seconds integer NOT NULL DEFAULT 180,
        quiet_start      text,
        quiet_end        text
      )
    `;
    // Scenes (Phase 3d). A named SNAPSHOT of a mural's whole wall — layout + grouping + content live
    // in the `snapshot` jsonb. `schedule_at` is the illustrative "HH:MM" time (stored, NOT fired).
    await sql`
      CREATE TABLE IF NOT EXISTS scenes (
        id          text PRIMARY KEY,
        name        text NOT NULL,
        mural_id    text NOT NULL,
        snapshot    jsonb NOT NULL DEFAULT '{}'::jsonb,
        schedule_at text
      )
    `;
    // Local operator accounts (Phase 3f / D29). Passwords are stored ONLY as argon2id hashes; the
    // plaintext is never persisted. Email is unique (stored normalized: trimmed + lower-cased).
    await sql`
      CREATE TABLE IF NOT EXISTS users (
        id            text PRIMARY KEY,
        email         text UNIQUE NOT NULL,
        password_hash text NOT NULL,
        created_at    timestamptz NOT NULL DEFAULT now()
      )
    `;
    // Server-side sessions (Phase 3f). `id` is sha256(cookieToken) so a DB read never yields a usable
    // token. Sessions are revocable (delete the row) and expire at expires_at.
    await sql`
      CREATE TABLE IF NOT EXISTS sessions (
        id         text PRIMARY KEY,
        user_id    text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id)`;
    await sql`CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at)`;
    // Enrollment bootstrap (Phase 3f): a single row holding the agent enrollment mode + token,
    // seeded on first boot from POLYPTIC_BOOTSTRAP_TOKEN and mutated by the Settings "regenerate".
    await sql`
      CREATE TABLE IF NOT EXISTS bootstrap (
        id    int PRIMARY KEY DEFAULT 1,
        mode  text NOT NULL DEFAULT 'open',
        token text
      )
    `;
    // mTLS agent CA (POL-25): a single row holding the deployment's own agent-CA cert + private key,
    // generated once on the first boot with AGENT_MTLS_PORT set and reused forever (every client cert
    // in the fleet chains to this key).
    await sql`
      CREATE TABLE IF NOT EXISTS mtls_ca (
        id         int PRIMARY KEY DEFAULT 1,
        cert_pem   text NOT NULL,
        key_pem    text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `;
    // Player-token secret (POL-54): a single row holding the deployment's HMAC secret behind the
    // per-screen player tokens, generated once on first boot and reused forever — so the token a
    // wall box carries in its player URL stays valid across server restarts.
    await sql`
      CREATE TABLE IF NOT EXISTS player_token_secret (
        id     int PRIMARY KEY DEFAULT 1,
        secret text NOT NULL
      )
    `;

    // Self-signed server TLS (POL-70/D89): a single row holding the deployment's own server CA +
    // the current server leaf, minted on the first TLS_MODE=self-signed boot and REUSED across
    // restarts (operators trust the CA once; a re-mint would re-warn every browser).
    await sql`
      CREATE TABLE IF NOT EXISTS server_tls (
        id           int PRIMARY KEY DEFAULT 1,
        ca_cert_pem  text NOT NULL,
        ca_key_pem   text NOT NULL,
        cert_pem     text NOT NULL,
        key_pem      text NOT NULL,
        sans         jsonb NOT NULL DEFAULT '[]'::jsonb,
        created_at   timestamptz NOT NULL DEFAULT now()
      )
    `;
    // Image updates (POL-41): a single row with the scheduled-rebuild settings, the urgent
    // roll-out switch, and the last rebuild-hook run's outcome.
    await sql`
      CREATE TABLE IF NOT EXISTS image_rollout (
        id                     int PRIMARY KEY DEFAULT 1,
        schedule_enabled       boolean NOT NULL DEFAULT true,
        schedule_time          text NOT NULL DEFAULT '01:00',
        urgent                 boolean NOT NULL DEFAULT false,
        last_build_started_at  timestamptz,
        last_build_finished_at timestamptz,
        last_build_status      text,
        last_build_log         text
      )
    `;
    // POL-43: the weekly FULL-rebuild cycle (kernel CVEs) + which cycle the last run was.
    await sql`ALTER TABLE image_rollout ADD COLUMN IF NOT EXISTS full_schedule_enabled boolean NOT NULL DEFAULT true`;
    await sql`ALTER TABLE image_rollout ADD COLUMN IF NOT EXISTS full_schedule_day int NOT NULL DEFAULT 0`;
    await sql`ALTER TABLE image_rollout ADD COLUMN IF NOT EXISTS full_schedule_time text NOT NULL DEFAULT '02:00'`;
    await sql`ALTER TABLE image_rollout ADD COLUMN IF NOT EXISTS last_build_kind text`;
    // Display settings (POL-6): a single row holding the fleet-wide on-screen badge toggle. Absent
    // until an operator first changes it — the control plane falls back to its env default (prod off,
    // dev on) until then, so the row is written on the first mutation, not on migrate.
    await sql`
      CREATE TABLE IF NOT EXISTS display_settings (
        id          int PRIMARY KEY DEFAULT 1,
        show_badges boolean NOT NULL
      )
    `;
  }

  async load(): Promise<PersistedState> {
    const sql = this.sql;
    const [
      machineRows,
      screenRows,
      contentRows,
      metaRows,
      muralRows,
      placementRows,
      videoWallRows,
      contentSourceRows,
      sceneRows,
      credentialProfileRows,
      zoomPreferenceRows,
    ] = await Promise.all([
      sql<MachineRow[]>`SELECT id, label, agent_version, backend, outputs, status, credential_hash, last_seen, shell_enabled, shell_armed_at FROM machines`,
      sql<ScreenRow[]>`SELECT id, friendly_name, machine_id, connector FROM screens`,
      sql<ContentRow[]>`SELECT screen_id, canvas, surfaces, source_id FROM screen_content`,
      sql<MetaRow[]>`SELECT revision FROM meta WHERE id = 1`,
      sql<MuralRow[]>`SELECT id, name FROM murals`,
      sql<PlacementRow[]>`SELECT mural_id, screen_id, x, y, w, h FROM placements`,
      sql<VideoWallRow[]>`SELECT id, mural_id, member_screen_ids, name, content_source_id FROM video_walls`,
      sql<ContentSourceRow[]>`SELECT id, name, kind, url, credential_profile_id, items, definition FROM content_sources`,
      sql<SceneRow[]>`SELECT id, name, mural_id, snapshot, schedule_at FROM scenes`,
      sql<CredentialProfileRow[]>`SELECT id, name, strategy, token_endpoint, client_id, client_secret, scope, audience, token_param FROM credential_profiles`,
      sql<ZoomPreferenceRow[]>`SELECT target_id, source_key, zoom FROM zoom_preferences`,
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
        shellEnabled: row.shell_enabled ?? false,
        shellArmedAt: row.shell_armed_at ? row.shell_armed_at.toISOString() : undefined,
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
        sourceId: row.source_id ?? null,
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
      // NULL on legacy/pre-naming rows → undefined (the console derives a member-name label).
      name: row.name ?? null,
      contentSourceId: row.content_source_id ?? null,
    }));

    const contentSources: PersistedContentSource[] =
      contentSourceRows.flatMap(contentSourceFromRow);

    const credentialProfiles: PersistedCredentialProfile[] = credentialProfileRows.map((row) => ({
      id: row.id,
      name: row.name,
      strategy: row.strategy,
      tokenEndpoint: row.token_endpoint,
      clientId: row.client_id,
      clientSecret: row.client_secret,
      scope: row.scope ?? null,
      audience: row.audience ?? null,
      tokenParam: row.token_param,
    }));

    const zoomPreferences: PersistedZoomPreference[] = zoomPreferenceRows.map((row) => ({
      targetId: row.target_id,
      sourceKey: row.source_key,
      zoom: Number(row.zoom),
    }));

    const scenes: PersistedScene[] = sceneRows.map((row) => {
      // jsonb comes back already parsed; shape it defensively (ControlPlane re-validates each scene).
      const raw =
        row.snapshot && typeof row.snapshot === "object" ? (row.snapshot as Record<string, unknown>) : {};
      return {
        id: row.id,
        name: row.name,
        muralId: row.mural_id,
        snapshot: {
          placements: Array.isArray(raw.placements) ? (raw.placements as PersistedScene["snapshot"]["placements"]) : [],
          walls: Array.isArray(raw.walls) ? (raw.walls as PersistedScene["snapshot"]["walls"]) : [],
          screens: Array.isArray(raw.screens) ? (raw.screens as PersistedScene["snapshot"]["screens"]) : [],
        },
        scheduleAt: row.schedule_at ?? null,
      };
    });

    const revision = metaRows[0] ? Number(metaRows[0].revision) : 0;

    return {
      revision,
      machines,
      screens,
      content,
      murals,
      placements,
      videoWalls,
      contentSources,
      scenes,
      credentialProfiles,
      zoomPreferences,
    };
  }

  async upsertMachine(machine: PersistedMachine): Promise<void> {
    const sql = this.sql;
    await sql`
      INSERT INTO machines (id, label, agent_version, backend, outputs, status, credential_hash, last_seen, shell_enabled, shell_armed_at)
      VALUES (
        ${machine.id},
        ${machine.label},
        ${machine.agentVersion ?? null},
        ${machine.backend ?? null},
        ${sql.json(machine.outputs)},
        ${machine.status ?? "approved"},
        ${machine.credentialHash ?? null},
        ${machine.lastSeen ? new Date(machine.lastSeen) : null},
        ${machine.shellEnabled ?? false},
        ${machine.shellArmedAt ? new Date(machine.shellArmedAt) : null}
      )
      ON CONFLICT (id) DO UPDATE SET
        label           = EXCLUDED.label,
        agent_version   = EXCLUDED.agent_version,
        backend         = EXCLUDED.backend,
        outputs         = EXCLUDED.outputs,
        status          = EXCLUDED.status,
        credential_hash = EXCLUDED.credential_hash,
        last_seen       = EXCLUDED.last_seen,
        shell_enabled   = EXCLUDED.shell_enabled,
        shell_armed_at  = EXCLUDED.shell_armed_at
    `;
  }

  async setMachineStatus(id: string, status: EnrollmentStatus): Promise<void> {
    const sql = this.sql;
    await sql`UPDATE machines SET status = ${status} WHERE id = ${id}`;
  }

  async setMachineShellEnabled(id: string, enabled: boolean, armedAt: string | null): Promise<void> {
    const sql = this.sql;
    await sql`UPDATE machines SET shell_enabled = ${enabled}, shell_armed_at = ${armedAt ? new Date(armedAt) : null} WHERE id = ${id}`;
  }

  async deleteMachine(id: string): Promise<void> {
    const sql = this.sql;
    // Cascade the machine's screens + their content + placements (defensive — the control plane also
    // removes each in memory + dissolves walls first so memory + broadcasts stay correct).
    await sql`DELETE FROM screen_content WHERE screen_id IN (SELECT id FROM screens WHERE machine_id = ${id})`;
    await sql`DELETE FROM placements WHERE screen_id IN (SELECT id FROM screens WHERE machine_id = ${id})`;
    await sql`DELETE FROM zoom_preferences WHERE target_id IN (SELECT id FROM screens WHERE machine_id = ${id})`;
    await sql`DELETE FROM screens WHERE machine_id = ${id}`;
    await sql`DELETE FROM machines WHERE id = ${id}`;
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

  async deleteScreen(id: string): Promise<void> {
    const sql = this.sql;
    await sql`DELETE FROM screens WHERE id = ${id}`;
  }

  async upsertContent(content: PersistedContent): Promise<void> {
    const sql = this.sql;
    await sql`
      INSERT INTO screen_content (screen_id, canvas, surfaces, source_id)
      VALUES (
        ${content.screenId},
        ${sql.json(content.canvas)},
        ${sql.json(content.surfaces)},
        ${content.sourceId ?? null}
      )
      ON CONFLICT (screen_id) DO UPDATE SET
        canvas    = EXCLUDED.canvas,
        surfaces  = EXCLUDED.surfaces,
        source_id = EXCLUDED.source_id
    `;
  }

  async deleteContent(screenId: string): Promise<void> {
    const sql = this.sql;
    await sql`DELETE FROM screen_content WHERE screen_id = ${screenId}`;
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
      INSERT INTO video_walls (id, mural_id, member_screen_ids, name, content_source_id)
      VALUES (
        ${wall.id},
        ${wall.muralId},
        ${sql.json(wall.memberScreenIds)},
        ${wall.name ?? null},
        ${wall.contentSourceId ?? null}
      )
      ON CONFLICT (id) DO UPDATE SET
        mural_id          = EXCLUDED.mural_id,
        member_screen_ids = EXCLUDED.member_screen_ids,
        name              = EXCLUDED.name,
        content_source_id = EXCLUDED.content_source_id
    `;
  }

  async deleteVideoWall(id: string): Promise<void> {
    const sql = this.sql;
    await sql`DELETE FROM video_walls WHERE id = ${id}`;
  }

  async listVideoWalls(): Promise<PersistedVideoWall[]> {
    const sql = this.sql;
    const rows = await sql<VideoWallRow[]>`SELECT id, mural_id, member_screen_ids, name, content_source_id FROM video_walls`;
    return rows.map((row) => ({
      id: row.id,
      muralId: row.mural_id,
      memberScreenIds: Array.isArray(row.member_screen_ids)
        ? row.member_screen_ids.filter((v): v is string => typeof v === "string")
        : [],
      name: row.name ?? null,
      contentSourceId: row.content_source_id ?? null,
    }));
  }

  // ── Content library (Phase 3c) ──────────────────────────────────────────────

  async upsertContentSource(source: PersistedContentSource): Promise<void> {
    const sql = this.sql;
    await sql`
      INSERT INTO content_sources (id, name, kind, url, credential_profile_id, items, definition)
      VALUES (${source.id}, ${source.name}, ${source.kind}, ${source.url ?? null}, ${source.credentialProfileId ?? null}, ${source.items ? sql.json(source.items) : null},
        ${source.definition != null ? sql.json(source.definition as Parameters<typeof sql.json>[0]) : null})
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        kind = EXCLUDED.kind,
        url  = EXCLUDED.url,
        credential_profile_id = EXCLUDED.credential_profile_id,
        items = EXCLUDED.items,
        definition = EXCLUDED.definition
    `;
  }

  async deleteContentSource(id: string): Promise<void> {
    const sql = this.sql;
    // Clear the assignment off any rows that referenced this source (defensive — the control plane
    // also clears each in-use assignment individually so memory + broadcasts stay correct).
    await sql`UPDATE screen_content SET source_id = NULL WHERE source_id = ${id}`;
    await sql`UPDATE video_walls SET content_source_id = NULL WHERE content_source_id = ${id}`;
    await sql`DELETE FROM content_sources WHERE id = ${id}`;
  }

  async listContentSources(): Promise<PersistedContentSource[]> {
    const sql = this.sql;
    const rows = await sql<ContentSourceRow[]>`SELECT id, name, kind, url, credential_profile_id, items, definition FROM content_sources`;
    return rows.flatMap(contentSourceFromRow);
  }

  // ── Page zoom preferences (POL-57) ───────────────────────────────────────────

  async upsertZoomPreference(pref: PersistedZoomPreference): Promise<void> {
    const sql = this.sql;
    await sql`
      INSERT INTO zoom_preferences (target_id, source_key, zoom)
      VALUES (${pref.targetId}, ${pref.sourceKey}, ${pref.zoom})
      ON CONFLICT (target_id, source_key) DO UPDATE SET zoom = EXCLUDED.zoom
    `;
  }

  async deleteZoomPreferencesForTarget(targetId: string): Promise<void> {
    const sql = this.sql;
    await sql`DELETE FROM zoom_preferences WHERE target_id = ${targetId}`;
  }

  async listZoomPreferences(): Promise<PersistedZoomPreference[]> {
    const sql = this.sql;
    const rows = await sql<ZoomPreferenceRow[]>`SELECT target_id, source_key, zoom FROM zoom_preferences`;
    return rows.map((row) => ({
      targetId: row.target_id,
      sourceKey: row.source_key,
      zoom: Number(row.zoom),
    }));
  }

  // ── Credential profiles (POL-24) ─────────────────────────────────────────────

  async upsertCredentialProfile(profile: PersistedCredentialProfile): Promise<void> {
    const sql = this.sql;
    await sql`
      INSERT INTO credential_profiles (id, name, strategy, token_endpoint, client_id, client_secret, scope, audience, token_param)
      VALUES (
        ${profile.id},
        ${profile.name},
        ${profile.strategy},
        ${profile.tokenEndpoint},
        ${profile.clientId},
        ${profile.clientSecret},
        ${profile.scope ?? null},
        ${profile.audience ?? null},
        ${profile.tokenParam}
      )
      ON CONFLICT (id) DO UPDATE SET
        name           = EXCLUDED.name,
        strategy       = EXCLUDED.strategy,
        token_endpoint = EXCLUDED.token_endpoint,
        client_id      = EXCLUDED.client_id,
        client_secret  = EXCLUDED.client_secret,
        scope          = EXCLUDED.scope,
        audience       = EXCLUDED.audience,
        token_param    = EXCLUDED.token_param
    `;
  }

  // ── Notification rules (POL-91) ──────────────────────────────────────────────

  async upsertNotificationRule(rule: PersistedNotificationRule): Promise<void> {
    const sql = this.sql;
    await sql`
      INSERT INTO notification_rules (id, name, enabled, kinds, notifier, webhook_url, webhook_secret, email_to, debounce_seconds, quiet_start, quiet_end)
      VALUES (
        ${rule.id},
        ${rule.name},
        ${rule.enabled},
        ${sql.json(rule.kinds)},
        ${rule.notifier},
        ${rule.webhookUrl ?? null},
        ${rule.webhookSecret ?? null},
        ${rule.emailTo ? sql.json(rule.emailTo) : null},
        ${rule.debounceSeconds},
        ${rule.quietStart ?? null},
        ${rule.quietEnd ?? null}
      )
      ON CONFLICT (id) DO UPDATE SET
        name             = EXCLUDED.name,
        enabled          = EXCLUDED.enabled,
        kinds            = EXCLUDED.kinds,
        notifier         = EXCLUDED.notifier,
        webhook_url      = EXCLUDED.webhook_url,
        webhook_secret   = EXCLUDED.webhook_secret,
        email_to         = EXCLUDED.email_to,
        debounce_seconds = EXCLUDED.debounce_seconds,
        quiet_start      = EXCLUDED.quiet_start,
        quiet_end        = EXCLUDED.quiet_end
    `;
  }

  async deleteNotificationRule(id: string): Promise<void> {
    const sql = this.sql;
    await sql`DELETE FROM notification_rules WHERE id = ${id}`;
  }

  async listNotificationRules(): Promise<PersistedNotificationRule[]> {
    const sql = this.sql;
    const rows = await sql<NotificationRuleRow[]>`
      SELECT id, name, enabled, kinds, notifier, webhook_url, webhook_secret, email_to, debounce_seconds, quiet_start, quiet_end
      FROM notification_rules
    `;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      enabled: row.enabled,
      kinds: Array.isArray(row.kinds) ? row.kinds : [],
      notifier: row.notifier,
      webhookUrl: row.webhook_url ?? null,
      webhookSecret: row.webhook_secret ?? null,
      emailTo: Array.isArray(row.email_to) ? row.email_to : null,
      debounceSeconds: Number(row.debounce_seconds),
      quietStart: row.quiet_start ?? null,
      quietEnd: row.quiet_end ?? null,
    }));
  }

  async deleteCredentialProfile(id: string): Promise<void> {
    const sql = this.sql;
    // Detach from any sources that referenced it (defensive — the control plane refuses to delete an
    // in-use profile, so this only matters for rows mutated outside the API).
    await sql`UPDATE content_sources SET credential_profile_id = NULL WHERE credential_profile_id = ${id}`;
    await sql`DELETE FROM credential_profiles WHERE id = ${id}`;
  }

  async listCredentialProfiles(): Promise<PersistedCredentialProfile[]> {
    const sql = this.sql;
    const rows = await sql<CredentialProfileRow[]>`SELECT id, name, strategy, token_endpoint, client_id, client_secret, scope, audience, token_param FROM credential_profiles`;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      strategy: row.strategy,
      tokenEndpoint: row.token_endpoint,
      clientId: row.client_id,
      clientSecret: row.client_secret,
      scope: row.scope ?? null,
      audience: row.audience ?? null,
      tokenParam: row.token_param,
    }));
  }

  // ── Scenes (Phase 3d) ───────────────────────────────────────────────────────

  async upsertScene(scene: PersistedScene): Promise<void> {
    const sql = this.sql;
    await sql`
      INSERT INTO scenes (id, name, mural_id, snapshot, schedule_at)
      VALUES (
        ${scene.id},
        ${scene.name},
        ${scene.muralId},
        ${sql.json(scene.snapshot)},
        ${scene.scheduleAt ?? null}
      )
      ON CONFLICT (id) DO UPDATE SET
        name        = EXCLUDED.name,
        mural_id    = EXCLUDED.mural_id,
        snapshot    = EXCLUDED.snapshot,
        schedule_at = EXCLUDED.schedule_at
    `;
  }

  async deleteScene(id: string): Promise<void> {
    const sql = this.sql;
    await sql`DELETE FROM scenes WHERE id = ${id}`;
  }

  async listScenes(): Promise<PersistedScene[]> {
    const sql = this.sql;
    const rows = await sql<SceneRow[]>`SELECT id, name, mural_id, snapshot, schedule_at FROM scenes`;
    return rows.map((row) => {
      const raw =
        row.snapshot && typeof row.snapshot === "object" ? (row.snapshot as Record<string, unknown>) : {};
      return {
        id: row.id,
        name: row.name,
        muralId: row.mural_id,
        snapshot: {
          placements: Array.isArray(raw.placements) ? (raw.placements as PersistedScene["snapshot"]["placements"]) : [],
          walls: Array.isArray(raw.walls) ? (raw.walls as PersistedScene["snapshot"]["walls"]) : [],
          screens: Array.isArray(raw.screens) ? (raw.screens as PersistedScene["snapshot"]["screens"]) : [],
        },
        scheduleAt: row.schedule_at ?? null,
      };
    });
  }

  // ── Local operator accounts + sessions (Phase 3f) ────────────────────────────

  async getUserByEmail(email: string): Promise<PersistedUser | undefined> {
    const sql = this.sql;
    const rows = await sql<UserRow[]>`
      SELECT id, email, password_hash, created_at FROM users WHERE email = ${email} LIMIT 1
    `;
    const row = rows[0];
    return row ? this.toUser(row) : undefined;
  }

  async getUserById(id: string): Promise<PersistedUser | undefined> {
    const sql = this.sql;
    const rows = await sql<UserRow[]>`
      SELECT id, email, password_hash, created_at FROM users WHERE id = ${id} LIMIT 1
    `;
    const row = rows[0];
    return row ? this.toUser(row) : undefined;
  }

  async countUsers(): Promise<number> {
    const sql = this.sql;
    const rows = await sql<CountRow[]>`SELECT count(*)::text AS count FROM users`;
    return rows[0] ? Number(rows[0].count) : 0;
  }

  async createUser(user: PersistedUser): Promise<void> {
    const sql = this.sql;
    await sql`
      INSERT INTO users (id, email, password_hash, created_at)
      VALUES (${user.id}, ${user.email}, ${user.passwordHash}, ${new Date(user.createdAt)})
    `;
  }

  async updateUserPassword(id: string, passwordHash: string): Promise<void> {
    const sql = this.sql;
    await sql`UPDATE users SET password_hash = ${passwordHash} WHERE id = ${id}`;
  }

  async createSession(session: PersistedSession): Promise<void> {
    const sql = this.sql;
    await sql`
      INSERT INTO sessions (id, user_id, created_at, expires_at)
      VALUES (
        ${session.id},
        ${session.userId},
        ${new Date(session.createdAt)},
        ${new Date(session.expiresAt)}
      )
      ON CONFLICT (id) DO NOTHING
    `;
  }

  async getSession(id: string): Promise<PersistedSession | undefined> {
    const sql = this.sql;
    const rows = await sql<SessionRow[]>`
      SELECT id, user_id, created_at, expires_at FROM sessions WHERE id = ${id} LIMIT 1
    `;
    const row = rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      userId: row.user_id,
      createdAt: row.created_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
    };
  }

  async deleteSession(id: string): Promise<void> {
    const sql = this.sql;
    await sql`DELETE FROM sessions WHERE id = ${id}`;
  }

  async deleteSessionsForUser(userId: string): Promise<void> {
    const sql = this.sql;
    await sql`DELETE FROM sessions WHERE user_id = ${userId}`;
  }

  async deleteExpiredSessions(nowIso: string): Promise<void> {
    const sql = this.sql;
    await sql`DELETE FROM sessions WHERE expires_at <= ${new Date(nowIso)}`;
  }

  private toUser(row: UserRow): PersistedUser {
    return {
      id: row.id,
      email: row.email,
      passwordHash: row.password_hash,
      createdAt: row.created_at.toISOString(),
    };
  }

  // ── Enrollment bootstrap token (Phase 3f) ────────────────────────────────────

  async getBootstrap(): Promise<PersistedBootstrap | undefined> {
    const sql = this.sql;
    const rows = await sql<BootstrapRow[]>`SELECT mode, token FROM bootstrap WHERE id = 1 LIMIT 1`;
    const row = rows[0];
    if (!row) return undefined;
    const mode: EnrollmentMode = row.mode === "gated" ? "gated" : "open";
    return { mode, token: row.token ?? null };
  }

  async setBootstrap(bootstrap: PersistedBootstrap): Promise<void> {
    const sql = this.sql;
    await sql`
      INSERT INTO bootstrap (id, mode, token) VALUES (1, ${bootstrap.mode}, ${bootstrap.token})
      ON CONFLICT (id) DO UPDATE SET mode = EXCLUDED.mode, token = EXCLUDED.token
    `;
  }

  // ── mTLS agent CA (POL-25) ───────────────────────────────────────────────────

  async getMtlsCa(): Promise<PersistedMtlsCa | undefined> {
    const sql = this.sql;
    const rows = await sql<{ cert_pem: string; key_pem: string; created_at: Date }[]>`
      SELECT cert_pem, key_pem, created_at FROM mtls_ca WHERE id = 1 LIMIT 1
    `;
    const row = rows[0];
    if (!row) return undefined;
    return { certPem: row.cert_pem, keyPem: row.key_pem, createdAt: row.created_at.toISOString() };
  }

  async setMtlsCa(ca: PersistedMtlsCa): Promise<void> {
    const sql = this.sql;
    await sql`
      INSERT INTO mtls_ca (id, cert_pem, key_pem, created_at)
      VALUES (1, ${ca.certPem}, ${ca.keyPem}, ${ca.createdAt})
      ON CONFLICT (id) DO UPDATE SET cert_pem = EXCLUDED.cert_pem, key_pem = EXCLUDED.key_pem
    `;
  }

  // ── Player-token secret (POL-54) ─────────────────────────────────────────────

  async getPlayerTokenSecret(): Promise<string | undefined> {
    const sql = this.sql;
    const rows = await sql<{ secret: string }[]>`
      SELECT secret FROM player_token_secret WHERE id = 1 LIMIT 1
    `;
    return rows[0]?.secret;
  }

  async setPlayerTokenSecret(secret: string): Promise<void> {
    const sql = this.sql;
    await sql`
      INSERT INTO player_token_secret (id, secret) VALUES (1, ${secret})
      ON CONFLICT (id) DO UPDATE SET secret = EXCLUDED.secret
    `;
  }

  // ── Self-signed server TLS (POL-70/D89) ──────────────────────────────────────

  async getServerTls(): Promise<PersistedServerTls | undefined> {
    const sql = this.sql;
    const rows = await sql<
      { ca_cert_pem: string; ca_key_pem: string; cert_pem: string; key_pem: string; sans: unknown; created_at: Date }[]
    >`
      SELECT ca_cert_pem, ca_key_pem, cert_pem, key_pem, sans, created_at FROM server_tls WHERE id = 1 LIMIT 1
    `;
    const row = rows[0];
    if (!row) return undefined;
    return {
      caCertPem: row.ca_cert_pem,
      caKeyPem: row.ca_key_pem,
      certPem: row.cert_pem,
      keyPem: row.key_pem,
      sans: Array.isArray(row.sans) ? row.sans.map(String) : [],
      createdAt: row.created_at.toISOString(),
    };
  }

  async setServerTls(tls: PersistedServerTls): Promise<void> {
    const sql = this.sql;
    await sql`
      INSERT INTO server_tls (id, ca_cert_pem, ca_key_pem, cert_pem, key_pem, sans, created_at)
      VALUES (1, ${tls.caCertPem}, ${tls.caKeyPem}, ${tls.certPem}, ${tls.keyPem}, ${JSON.stringify(tls.sans)}::jsonb, ${tls.createdAt})
      ON CONFLICT (id) DO UPDATE SET
        ca_cert_pem = EXCLUDED.ca_cert_pem,
        ca_key_pem  = EXCLUDED.ca_key_pem,
        cert_pem    = EXCLUDED.cert_pem,
        key_pem     = EXCLUDED.key_pem,
        sans        = EXCLUDED.sans
    `;
  }

  // ── Display settings (POL-6) ─────────────────────────────────────────────────

  // ── Image updates (POL-41) ─────────────────────────────────────────────────

  async getImageRollout(): Promise<PersistedImageRollout | undefined> {
    const sql = this.sql;
    const rows = await sql<
      {
        schedule_enabled: boolean;
        schedule_time: string;
        full_schedule_enabled: boolean;
        full_schedule_day: number;
        full_schedule_time: string;
        urgent: boolean;
        last_build_started_at: Date | null;
        last_build_finished_at: Date | null;
        last_build_status: string | null;
        last_build_log: string | null;
        last_build_kind: string | null;
      }[]
    >`SELECT schedule_enabled, schedule_time, full_schedule_enabled, full_schedule_day, full_schedule_time, urgent, last_build_started_at, last_build_finished_at, last_build_status, last_build_log, last_build_kind FROM image_rollout WHERE id = 1 LIMIT 1`;
    const row = rows[0];
    if (!row) return undefined;
    const status = row.last_build_status;
    const kind = row.last_build_kind;
    return {
      scheduleEnabled: row.schedule_enabled,
      scheduleTime: row.schedule_time,
      fullScheduleEnabled: row.full_schedule_enabled,
      fullScheduleDay: row.full_schedule_day,
      fullScheduleTime: row.full_schedule_time,
      urgent: row.urgent,
      lastBuildStartedAt: row.last_build_started_at?.toISOString() ?? null,
      lastBuildFinishedAt: row.last_build_finished_at?.toISOString() ?? null,
      lastBuildStatus: status === "running" || status === "success" || status === "failure" ? status : null,
      lastBuildLog: row.last_build_log,
      lastBuildKind: kind === "refresh" || kind === "full" ? kind : null,
    };
  }

  async setImageRollout(rollout: PersistedImageRollout): Promise<void> {
    const sql = this.sql;
    await sql`
      INSERT INTO image_rollout (id, schedule_enabled, schedule_time, full_schedule_enabled, full_schedule_day, full_schedule_time, urgent, last_build_started_at, last_build_finished_at, last_build_status, last_build_log, last_build_kind)
      VALUES (1, ${rollout.scheduleEnabled}, ${rollout.scheduleTime}, ${rollout.fullScheduleEnabled}, ${rollout.fullScheduleDay}, ${rollout.fullScheduleTime}, ${rollout.urgent}, ${rollout.lastBuildStartedAt}, ${rollout.lastBuildFinishedAt}, ${rollout.lastBuildStatus}, ${rollout.lastBuildLog}, ${rollout.lastBuildKind})
      ON CONFLICT (id) DO UPDATE SET
        schedule_enabled = EXCLUDED.schedule_enabled,
        schedule_time = EXCLUDED.schedule_time,
        full_schedule_enabled = EXCLUDED.full_schedule_enabled,
        full_schedule_day = EXCLUDED.full_schedule_day,
        full_schedule_time = EXCLUDED.full_schedule_time,
        urgent = EXCLUDED.urgent,
        last_build_started_at = EXCLUDED.last_build_started_at,
        last_build_finished_at = EXCLUDED.last_build_finished_at,
        last_build_status = EXCLUDED.last_build_status,
        last_build_log = EXCLUDED.last_build_log,
        last_build_kind = EXCLUDED.last_build_kind
    `;
  }

  async getDisplaySettings(): Promise<PersistedDisplaySettings | undefined> {
    const sql = this.sql;
    const rows = await sql<DisplaySettingsRow[]>`
      SELECT show_badges FROM display_settings WHERE id = 1 LIMIT 1
    `;
    const row = rows[0];
    if (!row) return undefined;
    return { showBadges: row.show_badges };
  }

  async setDisplaySettings(settings: PersistedDisplaySettings): Promise<void> {
    const sql = this.sql;
    await sql`
      INSERT INTO display_settings (id, show_badges) VALUES (1, ${settings.showBadges})
      ON CONFLICT (id) DO UPDATE SET show_badges = EXCLUDED.show_badges
    `;
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}
