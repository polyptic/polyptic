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
  HostIdentity,
  ImageRings,
  MachineTags,
  OperatorRole,
  Output,
  PlaylistItem,
  ScreenVariables,
  Surface,
} from "@polyptic/protocol";

import type {
  EnrollmentMode,
  PersistedBootstrap,
  PersistedContent,
  PersistedContentSource,
  PersistedCredentialProfile,
  PersistedBootOrderPolicy,
  PersistedDaypart,
  PersistedDisplaySettings,
  PersistedEnrollmentToken,
  PersistedPanelPower,
  PersistedImageRollout,
  PersistedMachine,
  PersistedSchedule,
  PersistedSchedulerSettings,
  PersistedAgentMtlsPosture,
  PersistedMtlsCa,
  PersistedPreRegistration,
  PersistedServerTls,
  PersistedMural,
  PersistedPlacement,
  PersistedScene,
  PersistedScreen,
  PersistedSession,
  PersistedState,
  PersistedUser,
  PersistedVideoWall,
  PersistedAudioPreference,
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
  tags: unknown;
  image_id: string | null;
  image_id_at: Date | null;
  hardware: unknown;
  enrolled_token_id: string | null;
  enrolled_token_name: string | null;
  pre_registered: boolean | null;
  mtls_cert_issued_at: Date | null;
  mtls_seen_at: Date | null;
}

/** POL-104 — one enrolment token row. */
interface EnrollmentTokenRow {
  id: string;
  name: string;
  secret: string;
  created_at: Date;
  expires_at: Date | null;
  max_enrollments: number | null;
  uses: number;
  revoked_at: Date | null;
  last_used_at: Date | null;
  bake: boolean;
  legacy: boolean;
}

/** POL-104 — one pre-registration row. */
interface PreRegistrationRow {
  id: string;
  label: string | null;
  tags: unknown;
  auto_approve: boolean;
  machine_id: string | null;
  dmi_serial: string | null;
  mac: string | null;
  note: string | null;
  created_at: Date;
  matched_machine_id: string | null;
  matched_at: Date | null;
  matched_on: string | null;
}

interface ScreenRow {
  id: string;
  friendly_name: string;
  machine_id: string;
  connector: string;
  cast_enabled: boolean | null;
  variables: unknown;
}

interface ContentRow {
  screen_id: string;
  canvas: unknown;
  surfaces: unknown;
  source_id: string | null;
}

interface MetaRow {
  revision: string; // bigint comes back as a string to avoid precision loss
  active_scene_id: string | null; // POL-95 — the scene the wall is on (null = none / diverged)
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
  framing: string | null;
  placement_mode: string | null;
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
      framing: row.framing ?? null,
      placementMode: row.placement_mode ?? null,
    },
  ];
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

interface AudioPreferenceRow {
  target_id: string;
  source_key: string;
  muted: boolean;
  volume: number;
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
}

interface DaypartRow {
  id: string;
  name: string;
  start_time: string;
  end_time: string;
}

interface ScheduleRow {
  id: string;
  scene_id: string;
  daypart_id: string;
  days: unknown;
  priority: number;
  enabled: boolean;
  from_date: string | null;
  until_date: string | null;
  created_at: Date;
}

interface SchedulerSettingsRow {
  enabled: boolean;
  timezone: string;
  default_scene_id: string | null;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  created_at: Date;
  /** POL-107. Nullable in the type on purpose: a pre-POL-107 row read by a mid-migration replica. */
  role: string | null;
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

interface BootOrderPolicyRow {
  reassert: boolean;
}

/** POL-101 — panel power: the deployment timezone + a jsonb map of screenId → daily window. */
interface PanelPowerRow {
  timezone: string;
  hours: Record<string, { enabled: boolean; on: string; off: string }>;
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
    // POL-103 — operator tags. jsonb, not a join table: a tag set is small, always read whole, and
    // only ever replaced whole; a `machine_tags` table would buy nothing but a second write path.
    await sql`ALTER TABLE machines ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]'::jsonb`;
    // POL-105 — the OS image the box last reported BOOTING. Persisted, not live-only: "which boxes
    // are still on 20260711T…?" must be answerable about a box that is currently offline — which is
    // precisely the box a roll-out has stranded.
    await sql`ALTER TABLE machines ADD COLUMN IF NOT EXISTS image_id text`;
    await sql`ALTER TABLE machines ADD COLUMN IF NOT EXISTS image_id_at timestamptz`;
    // POL-104: what the box IS (MACs / DMI serial / arch), which token it enrolled on, and whether it
    // matched a pre-registration. All NULL on rows that pre-date POL-104 — a machine enrolled before
    // this change simply says less on its card; it is never re-gated or re-approved because of it.
    await sql`ALTER TABLE machines ADD COLUMN IF NOT EXISTS hardware jsonb`;
    await sql`ALTER TABLE machines ADD COLUMN IF NOT EXISTS enrolled_token_id text`;
    await sql`ALTER TABLE machines ADD COLUMN IF NOT EXISTS enrolled_token_name text`;
    await sql`ALTER TABLE machines ADD COLUMN IF NOT EXISTS pre_registered boolean NOT NULL DEFAULT false`;
    // POL-134: per-machine mTLS cert state (issued / actually seen on the mTLS listener).
    await sql`ALTER TABLE machines ADD COLUMN IF NOT EXISTS mtls_cert_issued_at timestamptz`;
    await sql`ALTER TABLE machines ADD COLUMN IF NOT EXISTS mtls_seen_at timestamptz`;
    await sql`
      CREATE TABLE IF NOT EXISTS screens (
        id            text PRIMARY KEY,
        friendly_name text NOT NULL,
        machine_id    text NOT NULL,
        connector     text NOT NULL,
        cast_enabled  boolean NOT NULL DEFAULT false,
        variables     jsonb NOT NULL DEFAULT '{}'::jsonb
      )
    `;
    // Idempotent migration for databases created before POL-119: existing screens are not castable.
    await sql`ALTER TABLE screens ADD COLUMN IF NOT EXISTS cast_enabled boolean NOT NULL DEFAULT false`;
    // POL-111 — per-screen template variables. Clean-at-rest holds: this is the ONLY place a
    // substitution input is persisted; no substituted OUTPUT is ever written anywhere.
    await sql`ALTER TABLE screens ADD COLUMN IF NOT EXISTS variables jsonb NOT NULL DEFAULT '{}'::jsonb`;
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
    // POL-95 — the ACTIVE scene rides in the same single row as the revision: it is desired state
    // (which scene the wall is on), not a console hint, so it must survive a restart. Idempotent
    // migration for databases created before POL-95; NULL = none / the wall has diverged.
    await sql`ALTER TABLE meta ADD COLUMN IF NOT EXISTS active_scene_id text`;
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
    // Web-window placement (POL-18): the framing-probe verdict + the operator's placement override.
    // Both nullable on purpose — legacy rows read as "never probed" / "auto".
    await sql`ALTER TABLE content_sources ADD COLUMN IF NOT EXISTS framing text`;
    await sql`ALTER TABLE content_sources ADD COLUMN IF NOT EXISTS placement_mode text`;
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
    // Audio preferences (POL-112). Same shape and lifetime as a zoom preference: one row per
    // (screen-or-wall, content) pair, so an operator dials the sound in once and the same clip on the
    // same screen comes back that way. No row = the muted default, which is what NEW content gets.
    await sql`
      CREATE TABLE IF NOT EXISTS audio_preferences (
        target_id  text NOT NULL,
        source_key text NOT NULL,
        muted      boolean NOT NULL,
        volume     double precision NOT NULL,
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
    // Scenes (Phase 3d). A named SNAPSHOT of a mural's whole wall — layout + grouping + content live
    // in the `snapshot` jsonb.
    await sql`
      CREATE TABLE IF NOT EXISTS scenes (
        id          text PRIMARY KEY,
        name        text NOT NULL,
        mural_id    text NOT NULL,
        snapshot    jsonb NOT NULL DEFAULT '{}'::jsonb
      )
    `;
    // POL-89/D93: D24's `schedule_at` was an illustrative "HH:MM" that was STORED and NEVER FIRED.
    // Real scheduling is the `schedules` table below, so the decoy column is DROPPED rather than
    // migrated: an existing value is not a schedule (no recurrence, no window, no priority), and
    // inventing one from it would make a live wall start flipping scenes nobody asked it to.
    await sql`ALTER TABLE scenes DROP COLUMN IF EXISTS schedule_at`;
    // The scene scheduler (POL-89). A DAYPART is a named window of the day; `end_time <= start_time`
    // wraps past midnight; `start_time = end_time` is the all-day window.
    await sql`
      CREATE TABLE IF NOT EXISTS dayparts (
        id         text PRIMARY KEY,
        name       text NOT NULL,
        start_time text NOT NULL,
        end_time   text NOT NULL
      )
    `;
    // A SCHEDULE binds a scene to a daypart on a recurrence (weekdays + optional inclusive date
    // range), at an integer priority. `days` is a jsonb array of 0=Sun…6=Sat.
    await sql`
      CREATE TABLE IF NOT EXISTS schedules (
        id          text PRIMARY KEY,
        scene_id    text NOT NULL,
        daypart_id  text NOT NULL,
        days        jsonb NOT NULL DEFAULT '[]'::jsonb,
        priority    int NOT NULL DEFAULT 0,
        enabled     boolean NOT NULL DEFAULT true,
        from_date   text,
        until_date  text,
        created_at  timestamptz NOT NULL DEFAULT now()
      )
    `;
    // Deployment-wide scheduler settings (one row): master switch, the ONE timezone every window is
    // evaluated in, and the default scene (the always-on floor). Absent until first changed — the
    // control plane defaults to the server's own zone.
    await sql`
      CREATE TABLE IF NOT EXISTS scheduler_settings (
        id               int PRIMARY KEY DEFAULT 1,
        enabled          boolean NOT NULL,
        timezone         text NOT NULL,
        default_scene_id text
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
    // POL-107 — roles. THE UPGRADE PATH: an existing single-admin deployment has exactly one row in
    // `users`, and that account IS the deployment's admin. The DEFAULT back-fills every pre-POL-107
    // row with 'admin', so the configured admin keeps every capability it had — an upgrade is never a
    // lockout, and it needs no operator action. New rows are written with an explicit role.
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'admin'`;
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
    // POL-104: the enrolment tokens. The `bootstrap` row above survives as the seed (its token is
    // LIFTED into this table on the first boot after the upgrade — every already-flashed medium
    // carries it) and is kept mirroring whichever token is currently `bake`.
    await sql`
      CREATE TABLE IF NOT EXISTS enrollment_tokens (
        id              text PRIMARY KEY,
        name            text NOT NULL,
        secret          text NOT NULL,
        created_at      timestamptz NOT NULL DEFAULT now(),
        expires_at      timestamptz,
        max_enrollments int,
        uses            int NOT NULL DEFAULT 0,
        revoked_at      timestamptz,
        last_used_at    timestamptz,
        bake            boolean NOT NULL DEFAULT false,
        legacy          boolean NOT NULL DEFAULT false
      )
    `;
    // POL-104: boxes declared before they ever booted. Consulted AFTER a hello authenticates — this
    // table is not a credential and never admits anything on its own.
    await sql`
      CREATE TABLE IF NOT EXISTS pre_registrations (
        id                 text PRIMARY KEY,
        label              text,
        tags               jsonb NOT NULL DEFAULT '[]'::jsonb,
        auto_approve       boolean NOT NULL DEFAULT true,
        machine_id         text,
        dmi_serial         text,
        mac                text,
        note               text,
        created_at         timestamptz NOT NULL DEFAULT now(),
        matched_machine_id text,
        matched_at         timestamptz,
        matched_on         text
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
    // Agent-mTLS posture (POL-134): a single row recording whether this deployment has graduated to
    // REQUIRING the mTLS agent channel. Written by the auto-promotion (every known machine seen on
    // mTLS) or a pinned AGENT_MTLS_REQUIRE; read on boot so the posture never silently regresses.
    await sql`
      CREATE TABLE IF NOT EXISTS agent_mtls_posture (
        id          int PRIMARY KEY DEFAULT 1,
        required    boolean NOT NULL DEFAULT false,
        promoted_at timestamptz
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
    // POL-121: the first-image latch. The server that finds an EMPTY depot on a fresh install stamps
    // this before it spawns the one-shot full build, so pod churn cannot re-trigger it.
    await sql`ALTER TABLE image_rollout ADD COLUMN IF NOT EXISTS first_build_at timestamptz`;
    // POL-105: the staged roll-out rings (selector → build). jsonb for the same reason as machine
    // tags: a small ordered list, always read whole, only ever replaced whole.
    await sql`ALTER TABLE image_rollout ADD COLUMN IF NOT EXISTS rings jsonb NOT NULL DEFAULT '[]'::jsonb`;
    // Display settings (POL-6): a single row holding the fleet-wide on-screen badge toggle. Absent
    // until an operator first changes it — the control plane falls back to its env default (prod off,
    // dev on) until then, so the row is written on the first mutation, not on migrate.
    await sql`
      CREATE TABLE IF NOT EXISTS display_settings (
        id          int PRIMARY KEY DEFAULT 1,
        show_badges boolean NOT NULL
      )
    `;
    // UEFI boot-order policy (POL-115): a single row holding the one boolean that decides whether a
    // box may re-assert its own UEFI boot entry. No row = report-only, which is also what the control
    // plane falls back to, so an un-migrated / un-flipped fleet never writes firmware NVRAM.
    await sql`
      CREATE TABLE IF NOT EXISTS boot_order_policy (
        id       int PRIMARY KEY DEFAULT 1,
        reassert boolean NOT NULL
      )
    `;
    // Panel power (POL-101): a single row — the deployment's timezone plus every screen's daily
    // on/off window as jsonb. One row rather than a table per screen because that is all the shape
    // this has, and because the whole thing is read on every scheduler tick. Absent until an operator
    // first sets panel hours, at which point walls that have no window keep running 24/7.
    await sql`
      CREATE TABLE IF NOT EXISTS panel_power (
        id       int PRIMARY KEY DEFAULT 1,
        timezone text NOT NULL,
        hours    jsonb NOT NULL DEFAULT '{}'::jsonb
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
      daypartRows,
      scheduleRows,
      credentialProfileRows,
      zoomPreferenceRows,
      audioPreferenceRows,
    ] = await Promise.all([
      sql<MachineRow[]>`SELECT id, label, agent_version, backend, outputs, status, credential_hash, last_seen, shell_enabled, shell_armed_at, tags, image_id, image_id_at, hardware, enrolled_token_id, enrolled_token_name, pre_registered, mtls_cert_issued_at, mtls_seen_at FROM machines`,
      sql<ScreenRow[]>`SELECT id, friendly_name, machine_id, connector, cast_enabled, variables FROM screens`,
      sql<ContentRow[]>`SELECT screen_id, canvas, surfaces, source_id FROM screen_content`,
      sql<MetaRow[]>`SELECT revision, active_scene_id FROM meta WHERE id = 1`,
      sql<MuralRow[]>`SELECT id, name FROM murals`,
      sql<PlacementRow[]>`SELECT mural_id, screen_id, x, y, w, h FROM placements`,
      sql<VideoWallRow[]>`SELECT id, mural_id, member_screen_ids, name, content_source_id FROM video_walls`,
      sql<ContentSourceRow[]>`SELECT id, name, kind, url, credential_profile_id, items, definition, framing, placement_mode FROM content_sources`,
      sql<SceneRow[]>`SELECT id, name, mural_id, snapshot FROM scenes`,
      sql<DaypartRow[]>`SELECT id, name, start_time, end_time FROM dayparts`,
      sql<ScheduleRow[]>`SELECT id, scene_id, daypart_id, days, priority, enabled, from_date, until_date, created_at FROM schedules`,
      sql<CredentialProfileRow[]>`SELECT id, name, strategy, token_endpoint, client_id, client_secret, scope, audience, token_param FROM credential_profiles`,
      sql<ZoomPreferenceRow[]>`SELECT target_id, source_key, zoom FROM zoom_preferences`,
      sql<AudioPreferenceRow[]>`SELECT target_id, source_key, muted, volume FROM audio_preferences`,
    ]);

    const machines: PersistedMachine[] = machineRows.map((row) => {
      const outputs = Output.array().safeParse(row.outputs);
      const backend = DisplayBackend.safeParse(row.backend);
      const status = EnrollmentStatus.safeParse(row.status);
      // POL-104: a hardware blob that no longer parses (an older/newer agent, a hand-edited row) is
      // DROPPED, never fatal — it is descriptive metadata on a card, not a credential.
      const hardware = row.hardware ? HostIdentity.safeParse(row.hardware) : undefined;
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
        // POL-103 — legacy rows (NULL) and anything unrecognised load as untagged.
        tags: MachineTags.safeParse(row.tags).data ?? [],
        // POL-105 — the last image id the box reported booting (NULL until it reports one).
        imageId: row.image_id ?? undefined,
        imageIdAt: row.image_id_at ? row.image_id_at.toISOString() : undefined,
        hardware: hardware?.success ? hardware.data : undefined,
        enrolledTokenId: row.enrolled_token_id ?? undefined,
        enrolledTokenName: row.enrolled_token_name ?? undefined,
        preRegistered: row.pre_registered ?? false,
        mtlsCertIssuedAt: row.mtls_cert_issued_at ? row.mtls_cert_issued_at.toISOString() : undefined,
        mtlsSeenAt: row.mtls_seen_at ? row.mtls_seen_at.toISOString() : undefined,
      };
    });

    const screens: PersistedScreen[] = screenRows.map((row) => {
      // POL-111 — a row written by a future/rogue writer is not allowed to smuggle an unvalidated
      // variable into the substituter: parse at the edge, drop the map wholesale if it doesn't hold.
      const variables = ScreenVariables.safeParse(row.variables ?? {});
      return {
        id: row.id,
        friendlyName: row.friendly_name,
        machineId: row.machine_id,
        connector: row.connector,
        castEnabled: row.cast_enabled ?? false,
        variables: variables.success ? variables.data : {},
      };
    });

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

    const audioPreferences: PersistedAudioPreference[] = audioPreferenceRows.map((row) => ({
      targetId: row.target_id,
      sourceKey: row.source_key,
      muted: row.muted === true,
      volume: Number(row.volume),
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
      };
    });

    const dayparts: PersistedDaypart[] = daypartRows.map((row) => ({
      id: row.id,
      name: row.name,
      start: row.start_time,
      end: row.end_time,
    }));

    const schedules: PersistedSchedule[] = scheduleRows.map((row) => ({
      id: row.id,
      sceneId: row.scene_id,
      daypartId: row.daypart_id,
      // jsonb comes back parsed; keep only the weekday numbers (the control plane re-validates).
      days: Array.isArray(row.days) ? (row.days as unknown[]).map(Number).filter(Number.isInteger) : [],
      priority: Number(row.priority),
      enabled: row.enabled,
      from: row.from_date ?? null,
      until: row.until_date ?? null,
      createdAt: new Date(row.created_at).toISOString(),
    }));

    const revision = metaRows[0] ? Number(metaRows[0].revision) : 0;
    const activeSceneId = metaRows[0]?.active_scene_id ?? null;

    return {
      revision,
      activeSceneId,
      machines,
      screens,
      content,
      murals,
      placements,
      videoWalls,
      contentSources,
      scenes,
      dayparts,
      schedules,
      credentialProfiles,
      zoomPreferences,
      audioPreferences,
    };
  }

  async upsertMachine(machine: PersistedMachine): Promise<void> {
    const sql = this.sql;
    await sql`
      INSERT INTO machines (id, label, agent_version, backend, outputs, status, credential_hash, last_seen, shell_enabled, shell_armed_at, tags, image_id, image_id_at, hardware, enrolled_token_id, enrolled_token_name, pre_registered, mtls_cert_issued_at, mtls_seen_at)
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
        ${machine.shellArmedAt ? new Date(machine.shellArmedAt) : null},
        ${sql.json(machine.tags ?? [])},
        ${machine.imageId ?? null},
        ${machine.imageIdAt ? new Date(machine.imageIdAt) : null},
        ${machine.hardware ? sql.json(machine.hardware) : null},
        ${machine.enrolledTokenId ?? null},
        ${machine.enrolledTokenName ?? null},
        ${machine.preRegistered ?? false},
        ${machine.mtlsCertIssuedAt ? new Date(machine.mtlsCertIssuedAt) : null},
        ${machine.mtlsSeenAt ? new Date(machine.mtlsSeenAt) : null}
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
        shell_armed_at  = EXCLUDED.shell_armed_at,
        tags            = EXCLUDED.tags,
        -- POL-105 — never let a re-hello that carries no image id ERASE the one we already know: an
        -- older agent (or a dev box with no live image) must not blank a real box's reported build.
        image_id        = COALESCE(EXCLUDED.image_id, machines.image_id),
        image_id_at     = COALESCE(EXCLUDED.image_id_at, machines.image_id_at),
        -- POL-104: never blank out what we already know. A pre-POL-104 agent (or an agent that could
        -- not read its own DMI) sends no hardware; a row that HAS hardware must not lose it because
        -- one hello arrived without any, and the token a machine enrolled on is written ONCE, at
        -- enrolment — a later hello must never rewrite its provenance.
        hardware            = COALESCE(EXCLUDED.hardware, machines.hardware),
        enrolled_token_id   = COALESCE(EXCLUDED.enrolled_token_id, machines.enrolled_token_id),
        enrolled_token_name = COALESCE(EXCLUDED.enrolled_token_name, machines.enrolled_token_name),
        pre_registered      = machines.pre_registered OR EXCLUDED.pre_registered,
        mtls_cert_issued_at = EXCLUDED.mtls_cert_issued_at,
        mtls_seen_at    = EXCLUDED.mtls_seen_at
    `;
  }

  async setMachineImage(id: string, imageId: string, at: string): Promise<void> {
    const sql = this.sql;
    await sql`UPDATE machines SET image_id = ${imageId}, image_id_at = ${new Date(at)} WHERE id = ${id}`;
  }

  async setMachineTags(id: string, tags: string[]): Promise<void> {
    const sql = this.sql;
    await sql`UPDATE machines SET tags = ${sql.json(tags)} WHERE id = ${id}`;
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
    await sql`DELETE FROM audio_preferences WHERE target_id IN (SELECT id FROM screens WHERE machine_id = ${id})`;
    await sql`DELETE FROM screens WHERE machine_id = ${id}`;
    await sql`DELETE FROM machines WHERE id = ${id}`;
  }

  async upsertScreen(screen: PersistedScreen): Promise<void> {
    const sql = this.sql;
    await sql`
      INSERT INTO screens (id, friendly_name, machine_id, connector, cast_enabled, variables)
      VALUES (
        ${screen.id},
        ${screen.friendlyName},
        ${screen.machineId},
        ${screen.connector},
        ${screen.castEnabled ?? false},
        ${sql.json(screen.variables ?? {})}
      )
      ON CONFLICT (id) DO UPDATE SET
        friendly_name = EXCLUDED.friendly_name,
        machine_id    = EXCLUDED.machine_id,
        connector     = EXCLUDED.connector,
        cast_enabled  = EXCLUDED.cast_enabled,
        variables     = EXCLUDED.variables
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

  async setActiveSceneId(sceneId: string | null): Promise<void> {
    const sql = this.sql;
    await sql`
      INSERT INTO meta (id, revision, active_scene_id) VALUES (1, 0, ${sceneId})
      ON CONFLICT (id) DO UPDATE SET active_scene_id = EXCLUDED.active_scene_id
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
      INSERT INTO content_sources (id, name, kind, url, credential_profile_id, items, definition, framing, placement_mode)
      VALUES (${source.id}, ${source.name}, ${source.kind}, ${source.url ?? null}, ${source.credentialProfileId ?? null}, ${source.items ? sql.json(source.items) : null},
        ${source.definition != null ? sql.json(source.definition as Parameters<typeof sql.json>[0]) : null},
        ${source.framing ?? null}, ${source.placementMode ?? null})
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        kind = EXCLUDED.kind,
        url  = EXCLUDED.url,
        credential_profile_id = EXCLUDED.credential_profile_id,
        items = EXCLUDED.items,
        definition = EXCLUDED.definition,
        framing = EXCLUDED.framing,
        placement_mode = EXCLUDED.placement_mode
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
    const rows = await sql<ContentSourceRow[]>`SELECT id, name, kind, url, credential_profile_id, items, definition, framing, placement_mode FROM content_sources`;
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

  // ── Audio preferences (POL-112) ──────────────────────────────────────────────

  async upsertAudioPreference(pref: PersistedAudioPreference): Promise<void> {
    const sql = this.sql;
    await sql`
      INSERT INTO audio_preferences (target_id, source_key, muted, volume)
      VALUES (${pref.targetId}, ${pref.sourceKey}, ${pref.muted}, ${pref.volume})
      ON CONFLICT (target_id, source_key)
      DO UPDATE SET muted = EXCLUDED.muted, volume = EXCLUDED.volume
    `;
  }

  async deleteAudioPreferencesForTarget(targetId: string): Promise<void> {
    const sql = this.sql;
    await sql`DELETE FROM audio_preferences WHERE target_id = ${targetId}`;
  }

  async listAudioPreferences(): Promise<PersistedAudioPreference[]> {
    const sql = this.sql;
    const rows = await sql<AudioPreferenceRow[]>`SELECT target_id, source_key, muted, volume FROM audio_preferences`;
    return rows.map((row) => ({
      targetId: row.target_id,
      sourceKey: row.source_key,
      muted: row.muted === true,
      volume: Number(row.volume),
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
      INSERT INTO scenes (id, name, mural_id, snapshot)
      VALUES (
        ${scene.id},
        ${scene.name},
        ${scene.muralId},
        ${sql.json(scene.snapshot)}
      )
      ON CONFLICT (id) DO UPDATE SET
        name        = EXCLUDED.name,
        mural_id    = EXCLUDED.mural_id,
        snapshot    = EXCLUDED.snapshot
    `;
  }

  async deleteScene(id: string): Promise<void> {
    const sql = this.sql;
    await sql`DELETE FROM scenes WHERE id = ${id}`;
  }

  async listScenes(): Promise<PersistedScene[]> {
    const sql = this.sql;
    const rows = await sql<SceneRow[]>`SELECT id, name, mural_id, snapshot FROM scenes`;
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
      };
    });
  }

  // ── Scene scheduler (POL-89) ────────────────────────────────────────────────

  async upsertDaypart(daypart: PersistedDaypart): Promise<void> {
    const sql = this.sql;
    await sql`
      INSERT INTO dayparts (id, name, start_time, end_time)
      VALUES (${daypart.id}, ${daypart.name}, ${daypart.start}, ${daypart.end})
      ON CONFLICT (id) DO UPDATE SET
        name       = EXCLUDED.name,
        start_time = EXCLUDED.start_time,
        end_time   = EXCLUDED.end_time
    `;
  }

  async deleteDaypart(id: string): Promise<void> {
    const sql = this.sql;
    await sql`DELETE FROM dayparts WHERE id = ${id}`;
  }

  async listDayparts(): Promise<PersistedDaypart[]> {
    const sql = this.sql;
    const rows = await sql<DaypartRow[]>`SELECT id, name, start_time, end_time FROM dayparts`;
    return rows.map((row) => ({ id: row.id, name: row.name, start: row.start_time, end: row.end_time }));
  }

  async upsertSchedule(schedule: PersistedSchedule): Promise<void> {
    const sql = this.sql;
    await sql`
      INSERT INTO schedules (id, scene_id, daypart_id, days, priority, enabled, from_date, until_date, created_at)
      VALUES (
        ${schedule.id},
        ${schedule.sceneId},
        ${schedule.daypartId},
        ${sql.json(schedule.days)},
        ${schedule.priority},
        ${schedule.enabled},
        ${schedule.from},
        ${schedule.until},
        ${schedule.createdAt}
      )
      ON CONFLICT (id) DO UPDATE SET
        scene_id   = EXCLUDED.scene_id,
        daypart_id = EXCLUDED.daypart_id,
        days       = EXCLUDED.days,
        priority   = EXCLUDED.priority,
        enabled    = EXCLUDED.enabled,
        from_date  = EXCLUDED.from_date,
        until_date = EXCLUDED.until_date
    `;
  }

  async deleteSchedule(id: string): Promise<void> {
    const sql = this.sql;
    await sql`DELETE FROM schedules WHERE id = ${id}`;
  }

  async listSchedules(): Promise<PersistedSchedule[]> {
    const sql = this.sql;
    const rows = await sql<ScheduleRow[]>`
      SELECT id, scene_id, daypart_id, days, priority, enabled, from_date, until_date, created_at FROM schedules
    `;
    return rows.map((row) => ({
      id: row.id,
      sceneId: row.scene_id,
      daypartId: row.daypart_id,
      days: Array.isArray(row.days) ? (row.days as unknown[]).map(Number).filter(Number.isInteger) : [],
      priority: Number(row.priority),
      enabled: row.enabled,
      from: row.from_date ?? null,
      until: row.until_date ?? null,
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }

  async getSchedulerSettings(): Promise<PersistedSchedulerSettings | undefined> {
    const sql = this.sql;
    const rows = await sql<SchedulerSettingsRow[]>`
      SELECT enabled, timezone, default_scene_id FROM scheduler_settings WHERE id = 1 LIMIT 1
    `;
    const row = rows[0];
    if (!row) return undefined;
    return { enabled: row.enabled, timezone: row.timezone, defaultSceneId: row.default_scene_id ?? null };
  }

  async setSchedulerSettings(settings: PersistedSchedulerSettings): Promise<void> {
    const sql = this.sql;
    await sql`
      INSERT INTO scheduler_settings (id, enabled, timezone, default_scene_id)
      VALUES (1, ${settings.enabled}, ${settings.timezone}, ${settings.defaultSceneId})
      ON CONFLICT (id) DO UPDATE SET
        enabled          = EXCLUDED.enabled,
        timezone         = EXCLUDED.timezone,
        default_scene_id = EXCLUDED.default_scene_id
    `;
  }

  // ── Local operator accounts + sessions (Phase 3f) ────────────────────────────

  async getUserByEmail(email: string): Promise<PersistedUser | undefined> {
    const sql = this.sql;
    const rows = await sql<UserRow[]>`
      SELECT id, email, password_hash, created_at, role FROM users WHERE email = ${email} LIMIT 1
    `;
    const row = rows[0];
    return row ? this.toUser(row) : undefined;
  }

  async getUserById(id: string): Promise<PersistedUser | undefined> {
    const sql = this.sql;
    const rows = await sql<UserRow[]>`
      SELECT id, email, password_hash, created_at, role FROM users WHERE id = ${id} LIMIT 1
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
      INSERT INTO users (id, email, password_hash, created_at, role)
      VALUES (${user.id}, ${user.email}, ${user.passwordHash}, ${new Date(user.createdAt)}, ${user.role})
    `;
  }

  async updateUserPassword(id: string, passwordHash: string): Promise<void> {
    const sql = this.sql;
    await sql`UPDATE users SET password_hash = ${passwordHash} WHERE id = ${id}`;
  }

  async listUsers(): Promise<PersistedUser[]> {
    const sql = this.sql;
    const rows = await sql<UserRow[]>`
      SELECT id, email, password_hash, created_at, role FROM users ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => this.toUser(row));
  }

  async updateUserRole(id: string, role: OperatorRole): Promise<void> {
    const sql = this.sql;
    await sql`UPDATE users SET role = ${role} WHERE id = ${id}`;
  }

  async deleteUser(id: string): Promise<void> {
    const sql = this.sql;
    // Sessions first: a deleted account must not keep a live cookie for the length of its TTL.
    await sql`DELETE FROM sessions WHERE user_id = ${id}`;
    await sql`DELETE FROM users WHERE id = ${id}`;
  }

  async countAdmins(): Promise<number> {
    const sql = this.sql;
    const rows = await sql<CountRow[]>`
      SELECT count(*)::text AS count FROM users WHERE role = 'admin'
    `;
    return rows[0] ? Number(rows[0].count) : 0;
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
    // An absent/unknown role reads as `admin` — see the migration note: a row that predates POL-107
    // belonged to the deployment's ONLY account, which was an admin in all but name.
    const parsed = OperatorRole.safeParse(row.role);
    return {
      id: row.id,
      email: row.email,
      passwordHash: row.password_hash,
      createdAt: row.created_at.toISOString(),
      role: parsed.success ? parsed.data : "admin",
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

  // ── Enrolment tokens + pre-registration (POL-104) ────────────────────────────

  async listEnrollmentTokens(): Promise<PersistedEnrollmentToken[]> {
    const sql = this.sql;
    const rows = await sql<EnrollmentTokenRow[]>`
      SELECT id, name, secret, created_at, expires_at, max_enrollments, uses, revoked_at, last_used_at, bake, legacy
      FROM enrollment_tokens ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      secret: row.secret,
      createdAt: row.created_at.toISOString(),
      expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
      maxEnrollments: row.max_enrollments ?? null,
      uses: row.uses,
      revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
      lastUsedAt: row.last_used_at ? row.last_used_at.toISOString() : null,
      bake: row.bake,
      legacy: row.legacy,
    }));
  }

  async upsertEnrollmentToken(token: PersistedEnrollmentToken): Promise<void> {
    const sql = this.sql;
    await sql`
      INSERT INTO enrollment_tokens (id, name, secret, created_at, expires_at, max_enrollments, uses, revoked_at, last_used_at, bake, legacy)
      VALUES (
        ${token.id},
        ${token.name},
        ${token.secret},
        ${new Date(token.createdAt)},
        ${token.expiresAt ? new Date(token.expiresAt) : null},
        ${token.maxEnrollments ?? null},
        ${token.uses},
        ${token.revokedAt ? new Date(token.revokedAt) : null},
        ${token.lastUsedAt ? new Date(token.lastUsedAt) : null},
        ${token.bake},
        ${token.legacy}
      )
      ON CONFLICT (id) DO UPDATE SET
        name            = EXCLUDED.name,
        secret          = EXCLUDED.secret,
        expires_at      = EXCLUDED.expires_at,
        max_enrollments = EXCLUDED.max_enrollments,
        uses            = EXCLUDED.uses,
        revoked_at      = EXCLUDED.revoked_at,
        last_used_at    = EXCLUDED.last_used_at,
        bake            = EXCLUDED.bake,
        legacy          = EXCLUDED.legacy
    `;
  }

  async deleteEnrollmentToken(id: string): Promise<void> {
    const sql = this.sql;
    await sql`DELETE FROM enrollment_tokens WHERE id = ${id}`;
  }

  async listPreRegistrations(): Promise<PersistedPreRegistration[]> {
    const sql = this.sql;
    const rows = await sql<PreRegistrationRow[]>`
      SELECT id, label, tags, auto_approve, machine_id, dmi_serial, mac, note, created_at, matched_machine_id, matched_at, matched_on
      FROM pre_registrations ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      const tags = z.array(z.string()).safeParse(row.tags);
      const matchedOn = z.enum(["machineId", "dmiSerial", "mac"]).safeParse(row.matched_on);
      return {
        id: row.id,
        label: row.label ?? undefined,
        tags: tags.success ? tags.data : [],
        autoApprove: row.auto_approve,
        machineId: row.machine_id ?? undefined,
        dmiSerial: row.dmi_serial ?? undefined,
        mac: row.mac ?? undefined,
        note: row.note ?? undefined,
        createdAt: row.created_at.toISOString(),
        matchedMachineId: row.matched_machine_id ?? undefined,
        matchedAt: row.matched_at ? row.matched_at.toISOString() : undefined,
        matchedOn: matchedOn.success ? matchedOn.data : undefined,
      };
    });
  }

  async upsertPreRegistration(record: PersistedPreRegistration): Promise<void> {
    const sql = this.sql;
    await sql`
      INSERT INTO pre_registrations (id, label, tags, auto_approve, machine_id, dmi_serial, mac, note, created_at, matched_machine_id, matched_at, matched_on)
      VALUES (
        ${record.id},
        ${record.label ?? null},
        ${sql.json(record.tags)},
        ${record.autoApprove},
        ${record.machineId ?? null},
        ${record.dmiSerial ?? null},
        ${record.mac ?? null},
        ${record.note ?? null},
        ${new Date(record.createdAt)},
        ${record.matchedMachineId ?? null},
        ${record.matchedAt ? new Date(record.matchedAt) : null},
        ${record.matchedOn ?? null}
      )
      ON CONFLICT (id) DO UPDATE SET
        label              = EXCLUDED.label,
        tags               = EXCLUDED.tags,
        auto_approve       = EXCLUDED.auto_approve,
        machine_id         = EXCLUDED.machine_id,
        dmi_serial         = EXCLUDED.dmi_serial,
        mac                = EXCLUDED.mac,
        note               = EXCLUDED.note,
        matched_machine_id = EXCLUDED.matched_machine_id,
        matched_at         = EXCLUDED.matched_at,
        matched_on         = EXCLUDED.matched_on
    `;
  }

  async deletePreRegistration(id: string): Promise<void> {
    const sql = this.sql;
    await sql`DELETE FROM pre_registrations WHERE id = ${id}`;
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

  // ── Agent-mTLS posture (POL-134) ─────────────────────────────────────────────

  async getAgentMtlsPosture(): Promise<PersistedAgentMtlsPosture | undefined> {
    const sql = this.sql;
    const rows = await sql<{ required: boolean; promoted_at: Date | null }[]>`
      SELECT required, promoted_at FROM agent_mtls_posture WHERE id = 1 LIMIT 1
    `;
    const row = rows[0];
    if (!row) return undefined;
    return { required: row.required, promotedAt: row.promoted_at ? row.promoted_at.toISOString() : undefined };
  }

  async setAgentMtlsPosture(posture: PersistedAgentMtlsPosture): Promise<void> {
    const sql = this.sql;
    await sql`
      INSERT INTO agent_mtls_posture (id, required, promoted_at)
      VALUES (1, ${posture.required}, ${posture.promotedAt ? new Date(posture.promotedAt) : null})
      ON CONFLICT (id) DO UPDATE SET required = EXCLUDED.required, promoted_at = EXCLUDED.promoted_at
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
        first_build_at: Date | null;
        rings: unknown;
        last_build_started_at: Date | null;
        last_build_finished_at: Date | null;
        last_build_status: string | null;
        last_build_log: string | null;
        last_build_kind: string | null;
      }[]
    >`SELECT schedule_enabled, schedule_time, full_schedule_enabled, full_schedule_day, full_schedule_time, urgent, first_build_at, rings, last_build_started_at, last_build_finished_at, last_build_status, last_build_log, last_build_kind FROM image_rollout WHERE id = 1 LIMIT 1`;
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
      // POL-105 — a corrupt/legacy rings value degrades to NO rings, i.e. one image for the whole
      // fleet. Parse at the edge: an unreadable ring must never point a box at a build we invented.
      rings: ImageRings.safeParse(row.rings).data ?? [],
      firstBuildAt: row.first_build_at?.toISOString() ?? null,
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
      INSERT INTO image_rollout (id, schedule_enabled, schedule_time, full_schedule_enabled, full_schedule_day, full_schedule_time, urgent, first_build_at, rings, last_build_started_at, last_build_finished_at, last_build_status, last_build_log, last_build_kind)
      VALUES (1, ${rollout.scheduleEnabled}, ${rollout.scheduleTime}, ${rollout.fullScheduleEnabled}, ${rollout.fullScheduleDay}, ${rollout.fullScheduleTime}, ${rollout.urgent}, ${rollout.firstBuildAt}, ${sql.json(rollout.rings ?? [])}, ${rollout.lastBuildStartedAt}, ${rollout.lastBuildFinishedAt}, ${rollout.lastBuildStatus}, ${rollout.lastBuildLog}, ${rollout.lastBuildKind})
      ON CONFLICT (id) DO UPDATE SET
        schedule_enabled = EXCLUDED.schedule_enabled,
        schedule_time = EXCLUDED.schedule_time,
        full_schedule_enabled = EXCLUDED.full_schedule_enabled,
        full_schedule_day = EXCLUDED.full_schedule_day,
        full_schedule_time = EXCLUDED.full_schedule_time,
        urgent = EXCLUDED.urgent,
        -- The first-image latch (POL-121) is claimed ONCE and never cleared: COALESCE keeps the
        -- original stamp even if a later write carries a null, so no code path can un-latch it.
        first_build_at = COALESCE(image_rollout.first_build_at, EXCLUDED.first_build_at),
        rings = EXCLUDED.rings,
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

  async getBootOrderPolicy(): Promise<PersistedBootOrderPolicy | undefined> {
    const sql = this.sql;
    const rows = await sql<BootOrderPolicyRow[]>`
      SELECT reassert FROM boot_order_policy WHERE id = 1 LIMIT 1
    `;
    const row = rows[0];
    if (!row) return undefined;
    return { reassert: row.reassert };
  }

  async setBootOrderPolicy(policy: PersistedBootOrderPolicy): Promise<void> {
    const sql = this.sql;
    await sql`
      INSERT INTO boot_order_policy (id, reassert) VALUES (1, ${policy.reassert})
      ON CONFLICT (id) DO UPDATE SET reassert = EXCLUDED.reassert
    `;
  }

  // ── Panel power (POL-101) ──────────────────────────────────────────────────

  async getPanelPower(): Promise<PersistedPanelPower | undefined> {
    const sql = this.sql;
    const rows = await sql<PanelPowerRow[]>`
      SELECT timezone, hours FROM panel_power WHERE id = 1 LIMIT 1
    `;
    const row = rows[0];
    if (!row) return undefined;
    return { timezone: row.timezone, hours: row.hours ?? {} };
  }

  async setPanelPower(power: PersistedPanelPower): Promise<void> {
    const sql = this.sql;
    await sql`
      INSERT INTO panel_power (id, timezone, hours)
      VALUES (1, ${power.timezone}, ${sql.json(power.hours)})
      ON CONFLICT (id) DO UPDATE SET timezone = EXCLUDED.timezone, hours = EXCLUDED.hours
    `;
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}
