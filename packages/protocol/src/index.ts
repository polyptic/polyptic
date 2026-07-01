/**
 * @polyptic/protocol — the single source of truth for every cross-process message.
 *
 * Two WS channels (see CLAUDE.md):
 *   - agent channel  (machine ↔ server): enrollment, heartbeat, placement, capture, ident, lifecycle
 *   - player channel (screen  ↔ server): content for that screen's slice, pushed live (the "instant" path)
 *
 * Everything that crosses a process boundary is defined and validated here. Parse at the edge,
 * trust the inferred types within.
 */
import { z } from "zod";

export const PROTOCOL_VERSION = 1;

// ─────────────────────────────────────────────────────────────────────────────
// Primitives
// ─────────────────────────────────────────────────────────────────────────────

/** A rectangle on a virtual canvas or within a screen, in pixels. */
export const Geometry = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
});
export type Geometry = z.infer<typeof Geometry>;

/** A physical video output as enumerated by the compositor (e.g. sway `get_outputs`). */
export const Output = z.object({
  connector: z.string(), // "DP-1", "HDMI-A-1"
  make: z.string().optional(),
  model: z.string().optional(),
  serial: z.string().optional(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  position: z.object({ x: z.number().int(), y: z.number().int() }).optional(),
});
export type Output = z.infer<typeof Output>;

// "dev-open" is the development backend: it just opens player URLs in the host's default
// browser (macOS `open` / Linux `xdg-open`) so the system runs on any dev machine with no
// compositor. The real placement backends (wayland-sway, x11-i3) land in Phase 4.
export const DisplayBackend = z.enum(["wayland-sway", "x11-i3", "dev-open"]);
export type DisplayBackend = z.infer<typeof DisplayBackend>;

/** Enrollment lifecycle of a machine (Phase 2b). New machines arrive `pending`; an operator
 * approves them. Existing/auto-registered machines default to `approved`. */
export const EnrollmentStatus = z.enum(["pending", "approved", "rejected"]);
export type EnrollmentStatus = z.infer<typeof EnrollmentStatus>;

/** A client machine. Plumbing — users address screens, not machines. */
export const Machine = z.object({
  id: z.string(), // stable; sourced from /etc/machine-id
  label: z.string(),
  agentVersion: z.string().optional(),
  backend: DisplayBackend.optional(),
  outputs: z.array(Output).default([]),
  status: EnrollmentStatus.default("approved"),
  lastSeen: z.string().datetime().optional(),
});
export type Machine = z.infer<typeof Machine>;

/** A screen: the first-class, named entity users actually configure. */
export const Screen = z.object({
  id: z.string(), // control-plane assigned, stable
  friendlyName: z.string(), // "Nessie", "Big-Bertha"
  machineId: z.string(),
  connector: z.string(), // which Output on that machine
});
export type Screen = z.infer<typeof Screen>;

// ─────────────────────────────────────────────────────────────────────────────
// Typed surfaces — what renders inside a region of a screen
// ─────────────────────────────────────────────────────────────────────────────

const SurfaceBase = z.object({
  id: z.string(),
  region: Geometry, // position within the screen
  /** Video-wall spanning (Phase 3b): when set, this surface shows the sub-rectangle at
   *  (offsetX,offsetY) of a contentW×contentH content. The player sizes the content to
   *  contentW×contentH and translates it by -(offsetX,offsetY) so this screen renders only its
   *  slice of the spanning content. Unset = an ordinary single-screen tile. */
  span: z
    .object({
      contentW: z.number().positive(),
      contentH: z.number().positive(),
      offsetX: z.number(),
      offsetY: z.number(),
    })
    .optional(),
});

export const WebSurface = SurfaceBase.extend({
  type: z.literal("web"),
  url: z.string().url(),
  /** "iframe" (default) or "window" — a top-level OS window placed by the agent (framing-blocked/native escape hatch). */
  placement: z.enum(["iframe", "window"]).default("iframe"),
  interactive: z.boolean().default(false),
});

export const DashboardSurface = SurfaceBase.extend({
  type: z.literal("dashboard"),
  url: z.string().url(), // adapter-built (e.g. a single-panel dashboard embed URL)
  refreshSeconds: z.number().int().positive().optional(),
});

export const ImageSurface = SurfaceBase.extend({
  type: z.literal("image"),
  src: z.string().url(),
  fit: z.enum(["cover", "contain"]).default("cover"),
});

export const VideoSurface = SurfaceBase.extend({
  type: z.literal("video"),
  src: z.string().url(),
  loop: z.boolean().default(true),
  muted: z.boolean().default(true),
});

export const Surface = z.discriminatedUnion("type", [
  WebSurface,
  DashboardSurface,
  ImageSurface,
  VideoSurface,
]);
export type Surface = z.infer<typeof Surface>;

/** The renderable unit a single player receives: its screen's canvas + the surfaces on it. */
export const ScreenSlice = z.object({
  screenId: z.string(),
  canvas: Geometry, // the screen's own pixel space (x/y usually 0,0)
  surfaces: z.array(Surface),
});
export type ScreenSlice = z.infer<typeof ScreenSlice>;

/** The control plane's desired state. `revision` increments on every change; agents/players reconcile to it.
 *  (The full Scene snapshot model lives below, near the other Phase-3 console types.) */
export const DesiredState = z.object({
  revision: z.number().int().nonnegative(),
  activeSceneId: z.string().nullable(),
  screens: z.array(Screen),
  /** screenId → slice to render right now. */
  slices: z.record(z.string(), ScreenSlice),
});
export type DesiredState = z.infer<typeof DesiredState>;

// ─────────────────────────────────────────────────────────────────────────────
// Agent channel  (machine ↔ server)
// ─────────────────────────────────────────────────────────────────────────────

export const AgentHello = z.object({
  t: z.literal("agent/hello"),
  protocol: z.literal(PROTOCOL_VERSION),
  machineId: z.string(),
  agentVersion: z.string(),
  backend: DisplayBackend,
  outputs: z.array(Output),
  /** The box's os.hostname(), used as the human machine label (additive-safe; optional). */
  hostname: z.string().optional(),
  /** First contact only: the operator-configured enrollment secret. The server validates it,
   * creates the machine as `pending`, and replies `server/enrolled` with a durable credential. */
  bootstrapToken: z.string().optional(),
  /** Subsequent connections: the durable per-machine credential issued by `server/enrolled`. */
  credential: z.string().optional(),
});

export const AgentStatus = z.object({
  t: z.literal("agent/status"),
  machineId: z.string(),
  observedRevision: z.number().int().nonnegative(),
  screens: z.array(
    z.object({ connector: z.string(), ok: z.boolean(), note: z.string().optional() }),
  ),
});

export const AgentThumbnail = z.object({
  t: z.literal("agent/thumbnail"),
  machineId: z.string(),
  connector: z.string(),
  mime: z.string(), // "image/jpeg"
  dataBase64: z.string(),
});

export const AgentMessage = z.discriminatedUnion("t", [AgentHello, AgentStatus, AgentThumbnail]);
export type AgentMessage = z.infer<typeof AgentMessage>;

export const ServerToAgentApply = z.object({
  t: z.literal("server/apply"),
  revision: z.number().int().nonnegative(),
  machineId: z.string(),
  /** For each output: which screen it is and the URL to point a player at. */
  screens: z.array(
    z.object({ connector: z.string(), screenId: z.string(), playerUrl: z.string().url() }),
  ),
});

export const ServerToAgentIdent = z.object({
  t: z.literal("server/ident"),
  on: z.boolean(),
});

export const ServerToAgentCapture = z.object({
  t: z.literal("server/capture"),
  connector: z.string().optional(), // omit = all outputs
});

/** Issued after a valid first-contact enrollment: the durable credential the agent persists and
 * presents on every reconnect (instead of the bootstrap token). `status` tells the agent whether
 * it still needs operator approval. */
export const ServerToAgentEnrolled = z.object({
  t: z.literal("server/enrolled"),
  machineId: z.string(),
  credential: z.string(),
  status: EnrollmentStatus,
});

/** The machine is recognised but still awaiting operator approval — keep the connection open; no
 * screens are admitted yet. The agent receives `server/apply` once approved. */
export const ServerToAgentPending = z.object({
  t: z.literal("server/pending"),
  reason: z.string().optional(),
});

/** Authentication failed (bad/absent token or credential, or the machine was rejected). The server
 * closes the connection after this frame. */
export const ServerToAgentRejected = z.object({
  t: z.literal("server/rejected"),
  reason: z.string(),
});

export const ServerToAgentMessage = z.discriminatedUnion("t", [
  ServerToAgentApply,
  ServerToAgentIdent,
  ServerToAgentCapture,
  ServerToAgentEnrolled,
  ServerToAgentPending,
  ServerToAgentRejected,
]);
export type ServerToAgentMessage = z.infer<typeof ServerToAgentMessage>;

// ─────────────────────────────────────────────────────────────────────────────
// Player channel  (screen ↔ server) — the instant content path
// ─────────────────────────────────────────────────────────────────────────────

export const PlayerHello = z.object({
  t: z.literal("player/hello"),
  protocol: z.literal(PROTOCOL_VERSION),
  screenId: z.string(),
});

export const PlayerAck = z.object({
  t: z.literal("player/ack"),
  screenId: z.string(),
  revision: z.number().int().nonnegative(),
});

export const PlayerMessage = z.discriminatedUnion("t", [PlayerHello, PlayerAck]);
export type PlayerMessage = z.infer<typeof PlayerMessage>;

/** Pushed whenever this screen's slice changes. The player applies it via DOM diff — no reload. */
export const ServerToPlayerRender = z.object({
  t: z.literal("server/render"),
  revision: z.number().int().nonnegative(),
  slice: ScreenSlice,
});

/** Ident overlay: flash the screen's friendly name so an operator can map physical panels. */
export const ServerToPlayerIdent = z.object({
  t: z.literal("server/ident-pulse"),
  on: z.boolean(),
  friendlyName: z.string(),
  color: z.string().default("#00c2ff"),
});

/** Fleet-wide, operator-toggleable display settings pushed to every player (POL-6). Structured as an
 *  object so future on-screen overlay flags slot in without a new message. Sent to a player right after
 *  its first `server/render` (on hello) and re-broadcast to ALL players whenever an operator flips it. */
export const DisplaySettings = z.object({
  /** Show the player status badge (`live · screen-N · rev`) and any passive dev overlays on every
   *  screen. Default is decided SERVER-side — prod off, dev on — so it is a runtime setting, not a
   *  build-time flag; an operator can override the default in either direction from the console. */
  showBadges: z.boolean(),
});
export type DisplaySettings = z.infer<typeof DisplaySettings>;

/** Push the current fleet-wide display settings to a player (badge visibility, …). */
export const ServerToPlayerSettings = z.object({
  t: z.literal("server/settings"),
  settings: DisplaySettings,
});

export const ServerToPlayerMessage = z.discriminatedUnion("t", [
  ServerToPlayerRender,
  ServerToPlayerIdent,
  ServerToPlayerSettings,
]);
export type ServerToPlayerMessage = z.infer<typeof ServerToPlayerMessage>;

// ─────────────────────────────────────────────────────────────────────────────
// Admin channel  (admin UI ↔ server) — registry views + live status
// ─────────────────────────────────────────────────────────────────────────────

export const ConnectionState = z.enum(["online", "offline"]);
export type ConnectionState = z.infer<typeof ConnectionState>;

/** A screen plus its live status, denormalized for the admin UI. */
export const ScreenView = Screen.extend({
  online: z.boolean(), // is a player currently connected for this screen?
  revision: z.number().int().nonnegative(), // last revision this screen's player observed
  surfaceCount: z.number().int().nonnegative(),
  /** What's on the screen now — a library source's name+kind, an ad-hoc URL's derived name, or null.
   *  Lets the console tiles + inspector show the actual content, not just a surface count. */
  content: z
    .object({ name: z.string(), kind: z.enum(["web", "dashboard", "image", "video"]) })
    .nullable()
    .optional(),
});
export type ScreenView = z.infer<typeof ScreenView>;

/** A machine plus its screens and live status, denormalized for the admin UI. */
export const MachineView = z.object({
  id: z.string(),
  label: z.string(),
  agentVersion: z.string().optional(),
  backend: DisplayBackend.optional(),
  online: z.boolean(), // is the agent's WS currently connected?
  status: EnrollmentStatus, // pending machines await operator approval
  outputCount: z.number().int().nonnegative(), // outputs the agent reported (shown for pending machines with no screens yet)
  lastSeen: z.string().datetime().optional(),
  screens: z.array(ScreenView),
});
export type MachineView = z.infer<typeof MachineView>;

// ─────────────────────────────────────────────────────────────────────────────
// Murals & placement (Phase 3) — the spatial canvas model
// ─────────────────────────────────────────────────────────────────────────────

/** A named, switchable canvas. A deployment has several murals; screens are placed onto one. */
export const Mural = z.object({
  id: z.string(),
  name: z.string(),
});
export type Mural = z.infer<typeof Mural>;

/** A screen placed on a mural at a position/size in canvas pixels (default size = the screen's
 *  native resolution). A screen with NO placement is "unplaced" (lives in the tray). A screen is
 *  placed on at most one mural at a time. */
export const Placement = z.object({
  muralId: z.string(),
  screenId: z.string(),
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
});
export type Placement = z.infer<typeof Placement>;

/** A "combined surface" (video wall): adjacent placed screens combined so one piece of content
 *  spans across all of them. The combined geometry is the union of the members' placements; each
 *  member shows its slice (see Surface.span). Split returns them to individual screens. */
export const VideoWall = z.object({
  id: z.string(),
  muralId: z.string(),
  memberScreenIds: z.array(z.string()).min(2),
  /** Operator-given name (e.g. "Atrium Wall"). Optional for back-compat with walls stored before
   *  naming existed; the console falls back to a member-derived label when absent. */
  name: z.string().min(1).max(80).optional(),
});
export type VideoWall = z.infer<typeof VideoWall>;

/** The kind of a content source — mirrors the renderable Surface types. */
export const ContentKind = z.enum(["web", "dashboard", "image", "video"]);
export type ContentKind = z.infer<typeof ContentKind>;

/** A reusable, named entry in the content LIBRARY. A screen or video wall is assigned a source by id;
 *  the server resolves it to the surface(s) it renders. 3c carries linkable URLs; Phase 7 adds uploaded
 *  media served from a disk volume (an upload becomes a source whose url points at the media route). */
export const ContentSource = z.object({
  id: z.string(),
  name: z.string().min(1).max(120),
  kind: ContentKind,
  url: z.string().url(),
});
export type ContentSource = z.infer<typeof ContentSource>;

// ── Scenes (Phase 3d) ────────────────────────────────────────────────────────
// A Scene is a named SNAPSHOT of a mural's whole wall — its layout (placements), grouping (video
// walls) and content (per screen + per wall) — re-appliable in one click. Content is captured as the
// assignment (a library sourceId or an ad-hoc url), so applying re-resolves a source to its CURRENT url.

/** A content assignment captured in a scene: a library source, an ad-hoc url, or nothing (null). */
export const SceneContent = z
  .object({ sourceId: z.string().optional(), url: z.string().url().optional() })
  .nullable();
export type SceneContent = z.infer<typeof SceneContent>;

export const ScenePlacement = z.object({
  screenId: z.string(),
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
});

export const SceneWall = z.object({
  memberScreenIds: z.array(z.string()).min(2),
  content: SceneContent,
});

export const SceneScreen = z.object({
  screenId: z.string(),
  content: SceneContent,
});

export const Scene = z.object({
  id: z.string(),
  name: z.string().min(1).max(120),
  muralId: z.string(),
  placements: z.array(ScenePlacement), // layout
  walls: z.array(SceneWall), // grouping + each wall's content
  screens: z.array(SceneScreen), // content for placed, non-walled screens
  scheduleAt: z.string().optional(), // "HH:MM" — illustrative; stored, not fired
});
export type Scene = z.infer<typeof Scene>;

export const AdminHello = z.object({
  t: z.literal("admin/hello"),
  protocol: z.literal(PROTOCOL_VERSION),
});
export const AdminMessage = z.discriminatedUnion("t", [AdminHello]);
export type AdminMessage = z.infer<typeof AdminMessage>;

/** A line in the Live Activity feed — a human-readable record of a notable event. */
export const ActivityEvent = z.object({
  id: z.string(),
  at: z.string(), // ISO timestamp
  severity: z.enum(["info", "good", "warn", "bad"]),
  text: z.string(),
});
export type ActivityEvent = z.infer<typeof ActivityEvent>;

/** Full registry snapshot, pushed to admin clients on connect and on every change. */
export const ServerToAdminState = z.object({
  t: z.literal("admin/state"),
  revision: z.number().int().nonnegative(),
  machines: z.array(MachineView),
  murals: z.array(Mural), // Phase 3
  placements: z.array(Placement), // Phase 3 — which screen sits where on which mural
  videoWalls: z.array(VideoWall), // Phase 3b — combined surfaces
  contentSources: z.array(ContentSource), // Phase 3c — the content library
  scenes: z.array(Scene), // Phase 3d — saved wall snapshots
  activity: z.array(ActivityEvent).optional(), // Live Activity feed (newest first); optional = back-compat
  settings: DisplaySettings.optional(), // POL-6 — fleet-wide display settings (badge toggle); optional = back-compat
});
export const ServerToAdminMessage = z.discriminatedUnion("t", [ServerToAdminState]);
export type ServerToAdminMessage = z.infer<typeof ServerToAdminMessage>;

// REST bodies — admin actions
export const RenameScreenBody = z.object({ friendlyName: z.string().min(1).max(64) });
export type RenameScreenBody = z.infer<typeof RenameScreenBody>;

/** Ident pulse request: flash a screen's friendly name so an operator can map physical panels. */
export const IdentBody = z.object({
  on: z.boolean(),
  ttlMs: z.number().int().positive().optional(), // optional auto-off, for fire-and-forget pulses
});
export type IdentBody = z.infer<typeof IdentBody>;

// REST bodies — murals & placement (Phase 3)
export const CreateMuralBody = z.object({ name: z.string().min(1).max(64) });
export type CreateMuralBody = z.infer<typeof CreateMuralBody>;

export const RenameMuralBody = z.object({ name: z.string().min(1).max(64) });
export type RenameMuralBody = z.infer<typeof RenameMuralBody>;

/** Place or move a screen on a mural (canvas pixels; w/h default to the screen's resolution). */
export const PlaceScreenBody = z.object({
  muralId: z.string(),
  x: z.number(),
  y: z.number(),
  w: z.number().positive().optional(),
  h: z.number().positive().optional(),
});
export type PlaceScreenBody = z.infer<typeof PlaceScreenBody>;

// REST bodies — combined surfaces (Phase 3b)
export const CombineScreensBody = z.object({
  muralId: z.string(),
  memberScreenIds: z.array(z.string()).min(2),
  name: z.string().min(1).max(80).optional(), // optional name at creation; else a default is derived
});
export type CombineScreensBody = z.infer<typeof CombineScreensBody>;

/** Rename a combined surface (video wall). */
export const RenameVideoWallBody = z.object({ name: z.string().min(1).max(80) });
export type RenameVideoWallBody = z.infer<typeof RenameVideoWallBody>;

/** Assign content to a single screen OR a video wall (it spans across members): either a library
 *  source (`sourceId`) or an ad-hoc link (`url`). Exactly one of the two. */
export const SetContentBody = z
  .object({
    sourceId: z.string().optional(),
    url: z.string().url().optional(),
  })
  .refine((b) => (b.sourceId === undefined) !== (b.url === undefined), {
    message: "provide exactly one of sourceId or url",
  });
export type SetContentBody = z.infer<typeof SetContentBody>;

// REST bodies — content library (Phase 3c)
export const CreateContentSourceBody = z.object({
  name: z.string().min(1).max(120),
  kind: ContentKind,
  url: z.string().url(),
});
export type CreateContentSourceBody = z.infer<typeof CreateContentSourceBody>;

/** Partial update of a library source (any subset of fields). */
export const UpdateContentSourceBody = z.object({
  name: z.string().min(1).max(120).optional(),
  kind: ContentKind.optional(),
  url: z.string().url().optional(),
});
export type UpdateContentSourceBody = z.infer<typeof UpdateContentSourceBody>;

// REST bodies — scenes (Phase 3d)
/** Save the CURRENT state of a mural as a new scene — the server snapshots placements + walls +
 *  content itself; the client only names it. */
export const CreateSceneBody = z.object({
  name: z.string().min(1).max(120),
  muralId: z.string(),
});
export type CreateSceneBody = z.infer<typeof CreateSceneBody>;

/** Rename a scene and/or set its illustrative schedule time (null clears it). */
export const UpdateSceneBody = z.object({
  name: z.string().min(1).max(120).optional(),
  scheduleAt: z.string().nullable().optional(),
});
export type UpdateSceneBody = z.infer<typeof UpdateSceneBody>;

// ── Auth + settings (Phase 3f) ───────────────────────────────────────────────
// Local operator accounts (D29): argon2id password hashing, HTTP-only secure session cookies,
// login rate-limit/lockout, no plaintext anywhere. OIDC is a later add-on on the same seam.

export const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
});
export type LoginBody = z.infer<typeof LoginBody>;

/** The signed-in operator, as returned by /auth/login and /auth/me (never any secret). */
export const AuthUser = z.object({ id: z.string(), email: z.string().email() });
export type AuthUser = z.infer<typeof AuthUser>;

/** Change the current operator's password. */
export const ChangePasswordBody = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(8).max(200),
});
export type ChangePasswordBody = z.infer<typeof ChangePasswordBody>;

/** Enrollment-token visibility for Settings + the cold-start wizard. `open` mode auto-approves with
 *  no token; `gated` mode requires the bootstrap token (shown only to a signed-in operator). */
export const EnrollmentInfo = z.object({
  mode: z.enum(["open", "gated"]),
  token: z.string().nullable(),
});
export type EnrollmentInfo = z.infer<typeof EnrollmentInfo>;

/** Update the fleet-wide display settings from the console (POL-6). Currently just the badge toggle. */
export const UpdateDisplaySettingsBody = z.object({
  showBadges: z.boolean(),
});
export type UpdateDisplaySettingsBody = z.infer<typeof UpdateDisplaySettingsBody>;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Parse an unknown WS frame (string or already-parsed JSON) with a schema. Throws on mismatch. */
export function parseMessage<T extends z.ZodTypeAny>(schema: T, raw: unknown): z.infer<T> {
  const json = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  return schema.parse(json);
}
