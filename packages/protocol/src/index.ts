/**
 * @polyptych/protocol — the single source of truth for every cross-process message.
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

export const DisplayBackend = z.enum(["wayland-sway", "x11-i3"]);
export type DisplayBackend = z.infer<typeof DisplayBackend>;

/** A client machine. Plumbing — users address screens, not machines. */
export const Machine = z.object({
  id: z.string(), // stable; sourced from /etc/machine-id
  label: z.string(),
  agentVersion: z.string().optional(),
  backend: DisplayBackend.optional(),
  outputs: z.array(Output).default([]),
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
  url: z.string().url(), // adapter-built (e.g. Grafana /d-solo ...&kiosk)
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

/** A named, versioned preset: which surfaces sit on which screens. */
export const Scene = z.object({
  id: z.string(),
  name: z.string(),
  version: z.number().int().nonnegative(),
  placements: z.array(z.object({ screenId: z.string(), surfaces: z.array(Surface) })),
});
export type Scene = z.infer<typeof Scene>;

/** The control plane's desired state. `revision` increments on every change; agents/players reconcile to it. */
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
  /** Present only on first enrollment; burned after claim. */
  bootstrapToken: z.string().optional(),
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

export const ServerToAgentMessage = z.discriminatedUnion("t", [
  ServerToAgentApply,
  ServerToAgentIdent,
  ServerToAgentCapture,
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

export const ServerToPlayerMessage = z.discriminatedUnion("t", [
  ServerToPlayerRender,
  ServerToPlayerIdent,
]);
export type ServerToPlayerMessage = z.infer<typeof ServerToPlayerMessage>;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Parse an unknown WS frame (string or already-parsed JSON) with a schema. Throws on mismatch. */
export function parseMessage<T extends z.ZodTypeAny>(schema: T, raw: unknown): z.infer<T> {
  const json = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  return schema.parse(json);
}
