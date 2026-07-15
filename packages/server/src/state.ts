/**
 * Desired-state for the Polyptic control plane, backed by a durable Store.
 *
 * This module owns the single global `DesiredState` (revision starts at 0) plus the machine
 * registry. It knows nothing about sockets or HTTP — it is state + mutations + write-through.
 *
 * Persistence (Phase 2a): on `init()` it LOADs the persisted registry from the Store into the
 * in-memory working copy and RESUMES the revision; every mutation WRITES THROUGH to the Store before
 * returning, so a rename — and everything else — survives a server restart.
 *
 * Enrollment (Phase 2b): a machine now carries an `EnrollmentStatus` and (off-band, never on the
 * wire `Machine`) a credential hash. Three registration paths replace the single Phase 2a one:
 *   - `registerMachine`  — OPEN MODE / admit: status `approved`, ensure a Screen per output, apply.
 *   - `enrollPending`    — GATED first contact: status `pending`, persist outputs, NO screens.
 *   - `approveMachine`   — operator approval: flip to `approved` + create screens from the persisted
 *                          outputs, returning assignments for a live `server/apply`.
 * `rejectMachine` flips status to `rejected`. The credential hash is held in a side map (the wire
 * `Machine` never carries it) and flows to/from storage via the `PersistedMachine` DTO.
 *
 * Screen ids are assigned sequentially ("screen-1", "screen-2", …) GLOBALLY across machines in
 * registration/approval order. The mapping is stable per (machineId, connector): a reconnecting
 * machine reuses its existing screen ids, and the counter resumes past the highest persisted id.
 */
import { randomUUID } from "node:crypto";

import {
  ContentSource,
  DashboardSurface,
  Daypart,
  ImageSurface,
  PlaylistSurface,
  PageSurface,
  Scene,
  Schedule,
  SchedulerSettings,
  VideoSurface,
  VideoWall,
  WebSurface,
  Zoom,
  isValidTimeZone,
  meaningfulHostname,
} from "@polyptic/protocol";
import type {
  ContentKind,
  CreateDaypartBody,
  CreateScheduleBody,
  ScheduleSet,
  UpdateDaypartBody,
  UpdateScheduleBody,
  UpdateSchedulerSettingsBody,
  CreateContentSourceBody,
  PlaylistEntry,
  PlaylistItem,
  CreateCredentialProfileBody,
  CredentialProfileView,
  DesiredState,
  DisplayBackend,
  DisplaySettings,
  Geometry,
  HostIdentity,
  KioskBrowser,
  Machine,
  Mural,
  Output,
  PageData,
  PageDefinition,
  PageEmbedResolution,
  PageFeedData,
  PageImageResolution,
  PageWeatherData,
  Placement,
  PreRegistration,
  SceneContent,
  Screen,
  ScreenSlice,
  Surface,
  UpdateContentSourceBody,
  UpdateCredentialProfileBody,
  UpdateSceneBody,
} from "@polyptic/protocol";

import type {
  PersistedCredentialProfile,
  PersistedMachine,
  PersistedScene,
  PersistedSchedulerSettings,
  Store,
} from "./store/types";
import type { TokenService } from "./tokens";
import type { ActivityLog } from "./activity";
import { matchPreRegistration, normalizeMac } from "./preregistration";
import type { PreRegistrationMatch } from "./preregistration";

/** Where players live. The agent points each output's browser at this base + ?screen=<id>. */
const PLAYER_BASE_URL = process.env.PLAYER_BASE_URL ?? "http://localhost:5173";

/** Fallback canvas for a player that connects before its screen is known. */
const DEFAULT_CANVAS = { x: 0, y: 0, w: 1920, h: 1080 } as const;

/**
 * POL-6 — the fleet-wide badge DEFAULT: ON in dev, OFF in production, decided here (server-side) so it
 * is a runtime setting, not a build-time flag baked into the player. `NODE_ENV` is the same dev/prod
 * signal the auth layer uses for secure cookies. An operator's persisted override (loaded in `init`)
 * supersedes this; absent an override, a deployment simply follows its `NODE_ENV` on each boot.
 */
const DEFAULT_SHOW_BADGES = process.env.NODE_ENV !== "production";

/** POL-57 — an unzoomed page: 100%, the same scale a browser opens a tab at. */
const DEFAULT_ZOOM = 1;

/**
 * POL-89 — the scheduler's defaults until the operator first touches Settings. The TIMEZONE defaults
 * to the SERVER's own zone (a deployment has exactly one — a wall lives in one building) but is
 * stored explicitly the moment anything is saved, so "what plays when" never silently depends on the
 * host's `TZ` changing under it. `TZ`/the runtime's resolved zone is only ever the seed.
 */
export function defaultSchedulerSettings(): SchedulerSettings {
  const hostZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    enabled: true,
    timezone: hostZone && isValidTimeZone(hostZone) ? hostZone : "UTC",
    defaultSceneId: null,
  };
}

/** The two surface kinds that frame a page, and so are the only ones that can be zoomed. */
type FramedSurface = Extract<Surface, { type: "web" | "dashboard" }>;

function isFramed(surface: Surface): surface is FramedSurface {
  return surface.type === "web" || surface.type === "dashboard";
}

/** Composite key for a remembered zoom — the (target, page) pair. The NUL separator can appear in
 *  neither half, so no screen/URL combination can collide with another. */
function zoomKey(targetId: string, sourceKey: string): string {
  return `${targetId}\u0000${sourceKey}`;
}

/** "125%" — how a zoom factor reads in the activity feed. */
function zoomLabel(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}

/** A copy of `slice` whose FIRST surface carries `zoom`. The surface keeps its id and url, so the
 *  player restyles the element it already has rather than remounting it (the INSTANT property, D5). */
function withZoomedFirstSurface(
  slice: ScreenSlice,
  surface: FramedSurface,
  zoom: number,
): ScreenSlice {
  return { ...slice, surfaces: [{ ...surface, zoom }, ...slice.surfaces.slice(1)] };
}

/** POL-54 — whoever can mint a screen's player token (the PlayerAuth service, wired after
 *  construction like the token provider; absent in unit tests → tokenless URLs). */
export type PlayerTokenMinter = (screenId: string) => string;

/** POL-46 — the page a PENDING machine shows on every output until an operator approves it. Same
 *  player app, same base URL; no screen id, because a pending machine has no screens yet. */
export function pendingUrlFor(machineId: string): string {
  return `${PLAYER_BASE_URL}/?pending=${encodeURIComponent(machineId)}`;
}

/**
 * POL-117 — which label a (re)registering machine keeps. An operator's name always wins; a label
 * that merely equals the machineId (the unnamed sentinel) or a meaningless live-image hostname
 * adopted before this fix ("localhost.localdomain" on every netbooted box) is NOT an operator name
 * and never wins. Otherwise adopt the box's hostname when it actually means something, else keep
 * the machineId sentinel — the console renders that honestly as "Unnamed box", never as a hostname
 * pretending to identify a panel.
 */
function labelForHello(existing: Machine | undefined, input: RegisterMachineInput): string {
  if (existing && existing.label !== existing.id && meaningfulHostname(existing.label) !== null) {
    return existing.label;
  }
  return meaningfulHostname(input.hostname) ?? input.machineId;
}

/** One entry of the `server/apply` payload: which screen an output is, and where to point its player. */
export interface ScreenAssignment {
  connector: string;
  screenId: string;
  playerUrl: string;
  /** POL-119 — run a cast (AirPlay) receiver on this connector, advertised as `friendlyName`. */
  castEnabled: boolean;
  friendlyName: string;
}

export interface RegisterMachineInput {
  machineId: string;
  agentVersion: string;
  backend: DisplayBackend;
  /** POL-67 — the kiosk browser the agent reported (chrome = remote DevTools). Held in memory only:
   *  it is re-reported on every hello, and only matters while the box is online. */
  browser?: KioskBrowser;
  outputs: Output[];
  /** The box's os.hostname(), used as the human machine label on first registration. */
  hostname?: string;
  /** POL-104 — what the box IS (MACs / DMI serial / arch). Persisted, so a pending card is informative
   *  even while the box is offline. A hello that carries none NEVER blanks what we already know. */
  hardware?: HostIdentity;
  /** POL-104 — the enrolment token this hello authenticated against. Stamped onto the machine at FIRST
   *  enrolment only (provenance: which stick/batch the box came in on) and never rewritten after. */
  enrolledTokenId?: string;
  enrolledTokenName?: string;
}

export interface RegisterMachineResult {
  /** True if registration changed desired state (new screen(s) created) and bumped the revision. */
  changed: boolean;
  assignments: ScreenAssignment[];
}

/**
 * Result of `combineScreens`. On success carries the new wall + the member slices that were cleared
 * (the caller pushes a `server/render` to each). On failure carries a machine-readable reason the
 * REST layer maps to an HTTP status (`unknown-*` → 404, `already-combined` → 409, else 400).
 */
export type CombineScreensResult =
  | { ok: true; wall: VideoWall; slices: ScreenSlice[] }
  | {
      ok: false;
      error:
        | "too-few"
        | "unknown-mural"
        | "unknown-screen"
        | "not-placed"
        | "wrong-mural"
        | "already-combined";
      screenId?: string;
      wallId?: string;
    };

/** Result of `setWallContent`: the per-member slices to render, or why it could not be computed. */
export type SetWallContentResult =
  | { ok: true; slices: ScreenSlice[] }
  | { ok: false; error: "unknown-wall" | "no-placements" | "unknown-source" };

/** Result of `setScreenContent`: the new slice, or why the single-screen content was rejected. */
export type SetScreenContentResult =
  | { ok: true; slice: ScreenSlice }
  | { ok: false; error: "unknown-screen" | "wall-member" | "unknown-source"; wallId?: string };

/** Result of `setScreenZoom` / `setWallZoom` (POL-57): the re-styled slices to push, or why not.
 *  `not-zoomable` = the target shows media, which has no page to zoom. */
export type SetZoomResult =
  | { ok: true; slices: ScreenSlice[] }
  | {
      ok: false;
      error: "unknown-screen" | "unknown-wall" | "wall-member" | "no-content" | "not-zoomable";
      wallId?: string;
    };

/** Result of `setScreenPlaylistEntryZoom` / `setWallPlaylistEntryZoom` (POL-133).
 *  `not-zoomable` = the target isn't showing a playlist; `unknown-entry` = the rotation has no
 *  framed step resolved from that source (media steps have no page to zoom). */
export type SetPlaylistEntryZoomResult =
  | { ok: true; slices: ScreenSlice[] }
  | {
      ok: false;
      error:
        | "unknown-screen"
        | "unknown-wall"
        | "wall-member"
        | "no-content"
        | "not-zoomable"
        | "unknown-entry";
      wallId?: string;
    };

/**
 * An assignment of content to a screen or wall (Phase 3c): EITHER a library source (`sourceId`) OR an
 * ad-hoc link (`url`). Exactly one is set (the REST edge validates this via `SetContentBody`).
 */
export interface ContentAssignment {
  sourceId?: string;
  url?: string;
}

/** A resolved content spec: the kind to build and the URL to point it at. A playlist (POL-34) has
 *  no URL of its own — it carries the resolved rotation (`entries`) plus the shared rotation anchor
 *  (`startedAt`, resolved ONCE per assignment so every wall member anchors to the same instant). A
 *  page (POL-42) has no url either — it carries the authored definition (embeds inside it resolve
 *  at send time). */
type ResolvedSpec =
  | { kind: Exclude<ContentKind, "page">; url: string; entries?: PlaylistEntry[]; startedAt?: string }
  | { kind: "page"; definition: PageDefinition };

/** The url half of a zoom/name key. Pages carry no url (and take no zoom), so they contribute an
 *  empty url — their sourceId always identifies them. */
function specUrl(spec: ResolvedSpec): string {
  return spec.kind === "page" ? "" : spec.url;
}

/** POL-42 — the live data the poller holds for pages: last-good feed items + cached weather. The
 *  ControlPlane consumes it at send time (decorateSliceForSend); the PageDataService implements it. */
export interface PageDataProvider {
  feedFor(url: string): PageFeedData | undefined;
  weatherFor(location: string): PageWeatherData | undefined;
}

/** POL-34 — the fallback hold time for a playlist entry that should be timed but carries no duration
 *  (its source's kind drifted after authoring). Authoring-time validation makes this rare. */
const DEFAULT_PLAYLIST_ITEM_SECONDS = 15;

/** Phase 3b spanning descriptor (a sub-rectangle of contentW×contentH at an offset). */
interface Span {
  contentW: number;
  contentH: number;
  offsetX: number;
  offsetY: number;
}

/** Internal result of ensuring a Screen (+ slice) exists for each of a machine's outputs. */
interface EnsureScreensResult {
  assignments: ScreenAssignment[];
  newScreens: Screen[];
  touchedSlices: ScreenSlice[];
  /** Ids of stale UNUSED screens pruned because the machine no longer advertises their connector. */
  prunedScreenIds: string[];
  changed: boolean;
}

export class ControlPlane {
  /** The single global desired state. Held by reference; mutated in place, revision-bumped on change. */
  readonly state: DesiredState = {
    revision: 0,
    activeSceneId: null,
    screens: [],
    slices: {},
  };

  private readonly machines = new Map<string, Machine>();
  /** machineId → sha256(credential) hex. Kept off the wire `Machine`; persisted via the DTO. */
  private readonly credentialHashes = new Map<string, string>();
  /** POL-104 — boxes declared before they ever booted, keyed by record id. */
  private readonly preRegistrations = new Map<string, PreRegistration>();
  private screenCounter = 0;

  /** Phase 3 — the named, switchable canvases. */
  private readonly murals = new Map<string, Mural>();
  /** Phase 3 — placements keyed by screenId (a screen is placed on at most one mural at a time). */
  private readonly placements = new Map<string, Placement>();
  private muralCounter = 0;

  /** Phase 3b — combined surfaces (video walls), keyed by wall id. */
  private readonly videoWalls = new Map<string, VideoWall>();
  private wallCounter = 0;

  /** Phase 3c — the content library, keyed by source id. */
  private readonly contentSources = new Map<string, ContentSource>();
  private sourceCounter = 0;
  /** screenId → the library source it currently shows (only present for library-assigned screens). */
  private readonly screenSourceIds = new Map<string, string>();
  /** wallId → the library source it currently spans (only present for library-assigned walls). */
  private readonly wallSourceIds = new Map<string, string>();

  /** POL-57 — remembered page zoom, keyed by `zoomKey(targetId, sourceKey)`. A target is a screen or
   *  a wall; a sourceKey identifies the page. Assigning that page there again restores this zoom. */
  private readonly zoomPrefs = new Map<string, number>();

  /** Phase 3d — saved wall snapshots (scenes), keyed by scene id. */
  private readonly scenes = new Map<string, Scene>();
  private sceneCounter = 0;

  /** POL-89 — the scene scheduler: the daypart library, the schedules bound to it, and the one
   *  deployment-wide settings row. The server's ticker and the console's week strip both resolve
   *  from exactly this set (it rides `admin/state`), so they can never disagree. */
  private readonly dayparts = new Map<string, Daypart>();
  private daypartCounter = 0;
  private readonly schedules = new Map<string, Schedule>();
  private scheduleCounter = 0;
  private schedulerSettings: SchedulerSettings = defaultSchedulerSettings();

  /** POL-24 — credential profiles keyed by id. Held as the FULL persisted row (incl. the client
   *  secret) because the control plane is where the secret is written through; every outward-facing
   *  read goes via `getCredentialProfileViews`, which never carries it. */
  private readonly credentialProfiles = new Map<string, PersistedCredentialProfile>();
  private credentialCounter = 0;
  /** POL-24 — wired after construction (the TokenService needs the control plane's profiles first).
   *  When absent (unit tests), URLs simply go out unstamped. */
  private tokenProvider?: Pick<TokenService, "getToken" | "statusFor">;

  /** POL-42 — the poller's live feed/weather data, consumed at send time (buildPageData). */
  private pageDataProvider?: PageDataProvider;

  /** POL-54 — mints the per-screen token stamped into every playerUrl the server hands an agent, so
   *  the /player WS can authenticate the hello that comes back. Wired after construction (same
   *  pattern as setTokenProvider); when absent (unit tests), playerUrls simply go out tokenless. */
  private playerTokenMinter?: PlayerTokenMinter;

  /** POL-6 — fleet-wide display settings (on-screen badge visibility) pushed to every player. Starts
   *  at the env default; `init()` loads any persisted operator override on top. */
  private displaySettings: DisplaySettings = { showBadges: DEFAULT_SHOW_BADGES };

  /**
   * @param store    the durable backing store.
   * @param activity OPTIONAL Live Activity feed (D25). When present, notable mutations push a short
   *                 human line; when absent (e.g. a unit test that doesn't care), emits are no-ops.
   */
  constructor(
    private readonly store: Store,
    private readonly activity?: ActivityLog,
  ) {}

  /**
   * When set, per-operation `emit` calls are swallowed. Used while a high-level composition (applyScene)
   * runs the lower-level primitives (split/combine/setContent) so the feed gets ONE summary line for
   * the whole apply instead of a flood of intermediate ones.
   */
  private suppressEmit = false;

  /** Push a Live Activity line if a log is wired (no-op otherwise). Never throws into a mutation. */
  private emit(severity: "info" | "good" | "warn" | "bad", text: string): void {
    if (this.suppressEmit) return;
    this.activity?.push(severity, text);
  }

  /** Project an in-memory Scene onto the storage DTO (layout + grouping + content → `snapshot` jsonb). */
  private toPersistedScene(scene: Scene): PersistedScene {
    return {
      id: scene.id,
      name: scene.name,
      muralId: scene.muralId,
      snapshot: {
        placements: scene.placements,
        walls: scene.walls,
        screens: scene.screens,
      },
    };
  }

  /** Project the in-memory machine (+ its side-mapped credential hash) onto the storage DTO. */
  private toPersistedMachine(machine: Machine): PersistedMachine {
    return {
      id: machine.id,
      label: machine.label,
      agentVersion: machine.agentVersion,
      backend: machine.backend,
      outputs: machine.outputs,
      status: machine.status,
      credentialHash: this.credentialHashes.get(machine.id),
      lastSeen: machine.lastSeen,
      shellEnabled: machine.shellEnabled ?? false,
      shellArmedAt: machine.shellArmedAt,
      hardware: machine.hardware,
      enrolledTokenId: machine.enrolledTokenId,
      enrolledTokenName: machine.enrolledTokenName,
      preRegistered: machine.preRegistered ?? false,
      mtlsCertIssuedAt: machine.mtlsCertIssuedAt,
      mtlsSeenAt: machine.mtlsSeenAt,
    };
  }

  /**
   * Load persisted registry state into memory and resume the revision + screen counter.
   * Call once on boot, after `store.migrate()`.
   */
  async init(): Promise<void> {
    const persisted = await this.store.load();

    this.state.revision = persisted.revision;

    for (const m of persisted.machines) {
      this.machines.set(m.id, {
        id: m.id,
        label: m.label,
        agentVersion: m.agentVersion,
        backend: m.backend,
        outputs: m.outputs,
        // Legacy rows without a status load as `approved` (Phase 2a parity).
        status: m.status ?? "approved",
        lastSeen: m.lastSeen,
        shellEnabled: m.shellEnabled ?? false,
        shellArmedAt: m.shellArmedAt,
        hardware: m.hardware,
        enrolledTokenId: m.enrolledTokenId,
        enrolledTokenName: m.enrolledTokenName,
        preRegistered: m.preRegistered ?? false,
        mtlsCertIssuedAt: m.mtlsCertIssuedAt,
        mtlsSeenAt: m.mtlsSeenAt,
      });
      if (m.credentialHash) this.credentialHashes.set(m.id, m.credentialHash);
    }

    // POL-104 — pre-registrations: boxes an operator declared before they ever booted.
    for (const record of await this.store.listPreRegistrations()) {
      this.preRegistrations.set(record.id, record);
    }

    for (const s of persisted.screens) {
      this.state.screens.push({
        id: s.id,
        friendlyName: s.friendlyName,
        machineId: s.machineId,
        connector: s.connector,
        castEnabled: s.castEnabled ?? false,
      });
    }

    for (const c of persisted.content) {
      this.state.slices[c.screenId] = {
        screenId: c.screenId,
        canvas: c.canvas,
        surfaces: c.surfaces,
      };
      // Phase 3c — remember which library source (if any) this screen is showing, so a source edit
      // re-resolves + re-pushes it.
      if (c.sourceId) this.screenSourceIds.set(c.screenId, c.sourceId);
    }

    // Resume the global counter past the highest persisted "screen-N" so new ids stay unique.
    let max = 0;
    for (const s of this.state.screens) {
      const match = /^screen-(\d+)$/.exec(s.id);
      if (match) {
        const n = Number(match[1]);
        if (Number.isFinite(n)) max = Math.max(max, n);
      }
    }
    this.screenCounter = max;

    // Heal: every known screen must have a slice (in case content rows lag behind screen rows).
    for (const s of this.state.screens) {
      if (this.state.slices[s.id] === undefined) {
        this.state.slices[s.id] = {
          screenId: s.id,
          canvas: { ...DEFAULT_CANVAS },
          surfaces: [],
        };
      }
    }

    // ── Murals & placement (Phase 3) ──────────────────────────────────────────
    for (const m of persisted.murals) {
      this.murals.set(m.id, { id: m.id, name: m.name });
    }
    // Resume the mural counter past the highest persisted "mural-N" so seeded/new ids stay unique.
    let maxMural = 0;
    for (const m of this.murals.values()) {
      const match = /^mural-(\d+)$/.exec(m.id);
      if (match) {
        const n = Number(match[1]);
        if (Number.isFinite(n)) maxMural = Math.max(maxMural, n);
      }
    }
    this.muralCounter = maxMural;

    for (const p of persisted.placements) {
      this.placements.set(p.screenId, {
        muralId: p.muralId,
        screenId: p.screenId,
        x: p.x,
        y: p.y,
        w: p.w,
        h: p.h,
      });
    }

    // ── Combined surfaces / video walls (Phase 3b) ────────────────────────────
    for (const w of persisted.videoWalls) {
      // Re-validate at the edge; a wall needs ≥2 members, so drop any malformed/legacy row.
      const parsed = VideoWall.safeParse({
        id: w.id,
        muralId: w.muralId,
        memberScreenIds: w.memberScreenIds,
        // NULL on legacy/pre-naming rows → undefined (the console derives a member-name label).
        name: w.name ?? undefined,
      });
      if (parsed.success) {
        this.videoWalls.set(parsed.data.id, parsed.data);
        // Phase 3c — remember which library source (if any) this wall is spanning.
        if (w.contentSourceId) this.wallSourceIds.set(parsed.data.id, w.contentSourceId);
      }
    }
    // Resume the wall counter past the highest persisted "wall-N" so new ids stay unique.
    let maxWall = 0;
    for (const w of this.videoWalls.values()) {
      const match = /^wall-(\d+)$/.exec(w.id);
      if (match) {
        const n = Number(match[1]);
        if (Number.isFinite(n)) maxWall = Math.max(maxWall, n);
      }
    }
    this.wallCounter = maxWall;

    // ── Page zoom preferences (POL-57) ────────────────────────────────────────
    for (const p of persisted.zoomPreferences) {
      // Re-validate at the edge; a row outside the allowed range is simply ignored (the target falls
      // back to 100%) rather than pushed to a player as an unrenderable scale.
      const zoom = Zoom.safeParse(p.zoom);
      if (zoom.success) this.zoomPrefs.set(zoomKey(p.targetId, p.sourceKey), zoom.data);
    }

    // ── Content library (Phase 3c) ────────────────────────────────────────────
    for (const cs of persisted.contentSources) {
      // Re-validate at the edge; drop a malformed/legacy row rather than crash the boot. Storage
      // NULLs (a playlist's url, a non-playlist's items, a page's definition) become the absences
      // the contract expects.
      const parsed = ContentSource.safeParse({
        id: cs.id,
        name: cs.name,
        kind: cs.kind,
        url: cs.url ?? undefined,
        credentialProfileId: cs.credentialProfileId ?? null,
        items: cs.items ?? undefined,
        definition: cs.definition ?? undefined,
      });
      if (parsed.success) this.contentSources.set(parsed.data.id, parsed.data);
    }
    // Resume the source counter past the highest persisted "source-N" so new ids stay unique.
    let maxSource = 0;
    for (const s of this.contentSources.values()) {
      const match = /^source-(\d+)$/.exec(s.id);
      if (match) {
        const n = Number(match[1]);
        if (Number.isFinite(n)) maxSource = Math.max(maxSource, n);
      }
    }
    this.sourceCounter = maxSource;
    // Drop any dangling assignment whose source no longer exists (defensive against manual edits).
    for (const [screenId, sid] of this.screenSourceIds) {
      if (!this.contentSources.has(sid)) this.screenSourceIds.delete(screenId);
    }
    for (const [wallId, sid] of this.wallSourceIds) {
      if (!this.contentSources.has(sid)) this.wallSourceIds.delete(wallId);
    }

    // ── Scenes (Phase 3d) ─────────────────────────────────────────────────────
    for (const ps of persisted.scenes) {
      // Re-validate at the edge; drop a malformed/legacy row rather than crash the boot.
      const parsed = Scene.safeParse({
        id: ps.id,
        name: ps.name,
        muralId: ps.muralId,
        placements: ps.snapshot.placements ?? [],
        walls: ps.snapshot.walls ?? [],
        screens: ps.snapshot.screens ?? [],
      });
      if (parsed.success) this.scenes.set(parsed.data.id, parsed.data);
    }
    // Resume the scene counter past the highest persisted "scene-N" so new ids stay unique.
    let maxScene = 0;
    for (const s of this.scenes.values()) {
      const match = /^scene-(\d+)$/.exec(s.id);
      if (match) {
        const n = Number(match[1]);
        if (Number.isFinite(n)) maxScene = Math.max(maxScene, n);
      }
    }
    this.sceneCounter = maxScene;

    // ── Scene scheduler (POL-89) ──────────────────────────────────────────────
    for (const pd of persisted.dayparts) {
      const parsed = Daypart.safeParse(pd);
      if (parsed.success) this.dayparts.set(parsed.data.id, parsed.data);
    }
    let maxDaypart = 0;
    for (const d of this.dayparts.values()) {
      const match = /^daypart-(\d+)$/.exec(d.id);
      if (match) {
        const n = Number(match[1]);
        if (Number.isFinite(n)) maxDaypart = Math.max(maxDaypart, n);
      }
    }
    this.daypartCounter = maxDaypart;

    for (const psch of persisted.schedules) {
      const parsed = Schedule.safeParse(psch);
      if (parsed.success) this.schedules.set(parsed.data.id, parsed.data);
    }
    let maxSchedule = 0;
    for (const s of this.schedules.values()) {
      const match = /^schedule-(\d+)$/.exec(s.id);
      if (match) {
        const n = Number(match[1]);
        if (Number.isFinite(n)) maxSchedule = Math.max(maxSchedule, n);
      }
    }
    this.scheduleCounter = maxSchedule;

    const persistedScheduler = await this.store.getSchedulerSettings();
    if (persistedScheduler) {
      const parsed = SchedulerSettings.safeParse(persistedScheduler);
      // A stored zone the runtime does not know (an ICU/tzdata downgrade) must not silently become
      // UTC on a live wall — keep it loud and fall back to the host's zone.
      if (parsed.success && isValidTimeZone(parsed.data.timezone)) {
        this.schedulerSettings = parsed.data;
      } else {
        this.emit("warn", `Scheduler timezone "${persistedScheduler.timezone}" is unknown here — using ${this.schedulerSettings.timezone}`);
      }
    }

    // ── Credential profiles (POL-24) ──────────────────────────────────────────
    for (const cp of persisted.credentialProfiles) {
      this.credentialProfiles.set(cp.id, cp);
    }
    // Resume the counter past the highest persisted "credential-N" so new ids stay unique.
    let maxCredential = 0;
    for (const cp of this.credentialProfiles.values()) {
      const match = /^credential-(\d+)$/.exec(cp.id);
      if (match) {
        const n = Number(match[1]);
        if (Number.isFinite(n)) maxCredential = Math.max(maxCredential, n);
      }
    }
    this.credentialCounter = maxCredential;
    // Drop a dangling profile reference off any source whose profile no longer exists (defensive).
    for (const source of this.contentSources.values()) {
      if (source.credentialProfileId && !this.credentialProfiles.has(source.credentialProfileId)) {
        source.credentialProfileId = null;
      }
    }

    // Seed a default mural the first time a deployment boots, so the Wall view always has a canvas.
    if (this.murals.size === 0) {
      const id = this.nextMuralId();
      const mural: Mural = { id, name: "Wall" };
      this.murals.set(id, mural);
      await this.store.upsertMural({ id: mural.id, name: mural.name });
    }

    // POL-6 — a persisted operator override supersedes the env badge default; absent one, keep the
    // default (so a deployment that never touches the setting follows its NODE_ENV each boot).
    const persistedSettings = await this.store.getDisplaySettings();
    if (persistedSettings) this.displaySettings = { showBadges: persistedSettings.showBadges };
  }

  private nextMuralId(): string {
    this.muralCounter += 1;
    return `mural-${this.muralCounter}`;
  }

  /** The native resolution to default a placement's w/h to: the screen's output, then its slice canvas. */
  private screenResolution(screen: Screen): { w: number; h: number } {
    const machine = this.machines.get(screen.machineId);
    const output = machine?.outputs.find((o) => o.connector === screen.connector);
    if (output) return { w: output.width, h: output.height };
    const slice = this.state.slices[screen.id];
    if (slice) return { w: slice.canvas.w, h: slice.canvas.h };
    return { w: DEFAULT_CANVAS.w, h: DEFAULT_CANVAS.h };
  }

  private bumpRevision(): number {
    this.state.revision += 1;
    return this.state.revision;
  }

  /**
   * Ensure a Screen (+ empty slice) exists for each output, creating + healing as needed. Pure in
   * memory: the caller is responsible for write-through. `changed` is true if a screen or slice was
   * created/healed (so the caller bumps + persists the revision).
   */
  private ensureScreens(machineId: string, outputs: Output[]): EnsureScreensResult {
    let changed = false;
    const assignments: ScreenAssignment[] = [];
    const newScreens: Screen[] = [];
    const touchedSlices: ScreenSlice[] = [];
    const prunedScreenIds: string[] = [];

    for (const output of outputs) {
      let screen = this.state.screens.find(
        (s) => s.machineId === machineId && s.connector === output.connector,
      );

      if (!screen) {
        this.screenCounter += 1;
        const id = `screen-${this.screenCounter}`;
        screen = {
          id,
          friendlyName: `Screen ${this.screenCounter}`,
          machineId,
          connector: output.connector,
          castEnabled: false,
        } satisfies Screen;
        this.state.screens.push(screen);
        const slice: ScreenSlice = {
          screenId: id,
          canvas: { x: 0, y: 0, w: output.width, h: output.height },
          surfaces: [],
        };
        this.state.slices[id] = slice;
        newScreens.push(screen);
        touchedSlices.push(slice);
        changed = true;
      } else if (this.state.slices[screen.id] === undefined) {
        // Screen known but its slice is missing (shouldn't normally happen) — heal it.
        const slice: ScreenSlice = {
          screenId: screen.id,
          canvas: { x: 0, y: 0, w: output.width, h: output.height },
          surfaces: [],
        };
        this.state.slices[screen.id] = slice;
        touchedSlices.push(slice);
        changed = true;
      }

      assignments.push({
        connector: output.connector,
        screenId: screen.id,
        playerUrl: this.playerUrlFor(screen.id),
        castEnabled: screen.castEnabled,
        friendlyName: screen.friendlyName,
      });
    }

    // POL-9 — reconcile away stale, UNUSED screens for connectors this machine no longer advertises,
    // so a connector-name change (a guessed phantom → the real name, or a hotplug) doesn't leave a
    // straggler. Guards that keep this safe:
    //   - Only when a NON-EMPTY set is advertised. An empty advertise means "no compositor yet / no
    //     info" (the POL-9 headless Stage-A case), NOT "these outputs are gone" — so we must never
    //     wipe on it.
    //   - Only screens that are genuinely UNUSED (never placed, not in a wall, no surfaces, no
    //     library source). A phantom carries no operator work; anything in use is left untouched so a
    //     transient compositor flap can never silently destroy a layout.
    if (outputs.length > 0) {
      const advertised = new Set(outputs.map((o) => o.connector));
      const stale = this.state.screens.filter(
        (s) =>
          s.machineId === machineId &&
          !advertised.has(s.connector) &&
          this.isScreenUnused(s.id),
      );
      for (const screen of stale) {
        const idx = this.state.screens.findIndex((s) => s.id === screen.id);
        if (idx >= 0) this.state.screens.splice(idx, 1);
        delete this.state.slices[screen.id];
        this.screenSourceIds.delete(screen.id);
        prunedScreenIds.push(screen.id);
        changed = true;
      }
    }

    return { assignments, newScreens, touchedSlices, prunedScreenIds, changed };
  }

  /**
   * Is a screen genuinely UNUSED — i.e. safe to prune when its machine stops advertising the
   * connector (POL-9)? Unused = not placed on any mural, not a member of a video wall, has no
   * surfaces on its slice, and carries no library-source assignment. A guessed phantom is unused;
   * any screen an operator has actually configured is NOT, and is never pruned out from under them.
   */
  private isScreenUnused(screenId: string): boolean {
    if (this.placements.has(screenId)) return false;
    if (this.screenSourceIds.has(screenId)) return false;
    if (this.getWallForScreen(screenId)) return false;
    const slice = this.state.slices[screenId];
    if (slice && slice.surfaces.length > 0) return false;
    return true;
  }

  /** Write-through newly created screens + their (empty) content rows, and drop any pruned ones. */
  private async persistScreens(result: EnsureScreensResult): Promise<void> {
    for (const s of result.newScreens) {
      await this.store.upsertScreen({
        id: s.id,
        friendlyName: s.friendlyName,
        machineId: s.machineId,
        connector: s.connector,
        castEnabled: s.castEnabled,
      });
    }
    for (const slice of result.touchedSlices) {
      await this.store.upsertContent({
        screenId: slice.screenId,
        canvas: slice.canvas,
        surfaces: slice.surfaces,
      });
    }
    for (const screenId of result.prunedScreenIds) {
      await this.store.deleteContent(screenId);
      await this.store.deleteScreen(screenId);
      await this.forgetZooms(screenId);
    }
  }

  /**
   * OPEN MODE / admit path. Upsert an `approved` machine and ensure a Screen (+ empty slice) exists
   * per output. Write-through: persists the machine, any newly created screens/content, and the
   * revision (if it changed). Returns the per-output assignments for the `server/apply` reply.
   *
   * `credentialHash`, when given (a token re-enrol of an approved machine), is stored so the machine
   * row persists the freshly issued credential alongside the screen work.
   */
  async registerMachine(
    input: RegisterMachineInput,
    credentialHash?: string,
  ): Promise<RegisterMachineResult> {
    if (credentialHash) this.credentialHashes.set(input.machineId, credentialHash);

    const existing = this.machines.get(input.machineId);
    const machine: Machine = {
      id: input.machineId,
      // An operator rename wins; a MEANINGFUL box hostname is adopted otherwise (POL-117 — see
      // labelForHello: `localhost.localdomain` from the shared live image is never a name).
      label: labelForHello(existing, input),
      agentVersion: input.agentVersion,
      backend: input.backend,
      browser: input.browser,
      outputs: input.outputs,
      status: "approved",
      lastSeen: new Date().toISOString(),
      shellEnabled: existing?.shellEnabled ?? false,
      shellArmedAt: existing?.shellArmedAt,
      // POL-104: never blank what we already know. An agent too old to report hardware (or one that
      // could not read its own DMI this boot) must not erase the card an operator relies on. And a
      // machine's enrolment provenance is written ONCE, at first enrolment — a later token re-enrol
      // does not rewrite which batch the box came in on.
      hardware: input.hardware ?? existing?.hardware,
      enrolledTokenId: existing?.enrolledTokenId ?? input.enrolledTokenId,
      enrolledTokenName: existing?.enrolledTokenName ?? input.enrolledTokenName,
      preRegistered: existing?.preRegistered ?? false,
      mtlsCertIssuedAt: existing?.mtlsCertIssuedAt,
      mtlsSeenAt: existing?.mtlsSeenAt,
    };
    this.machines.set(input.machineId, machine);

    const ensured = this.ensureScreens(input.machineId, input.outputs);
    if (ensured.changed) this.bumpRevision();

    await this.store.upsertMachine(this.toPersistedMachine(machine));
    await this.persistScreens(ensured);
    if (ensured.changed) await this.store.setRevision(this.state.revision);

    return { changed: ensured.changed, assignments: ensured.assignments };
  }

  /**
   * GATED first contact. Create (or refresh) the machine as `pending`, persist its reported outputs
   * and the issued credential hash, but create NO screens and do NOT bump the revision — pending
   * machines hold no desired state until an operator approves them.
   */
  async enrollPending(input: RegisterMachineInput, credentialHash: string): Promise<void> {
    this.credentialHashes.set(input.machineId, credentialHash);
    const existing = this.machines.get(input.machineId);
    const machine: Machine = {
      id: input.machineId,
      // An operator rename wins; a MEANINGFUL box hostname is adopted otherwise (POL-117 — see
      // labelForHello: `localhost.localdomain` from the shared live image is never a name).
      label: labelForHello(existing, input),
      agentVersion: input.agentVersion,
      backend: input.backend,
      browser: input.browser,
      outputs: input.outputs,
      status: "pending",
      lastSeen: new Date().toISOString(),
      shellEnabled: existing?.shellEnabled ?? false,
      shellArmedAt: existing?.shellArmedAt,
      hardware: input.hardware ?? existing?.hardware,
      enrolledTokenId: existing?.enrolledTokenId ?? input.enrolledTokenId,
      enrolledTokenName: existing?.enrolledTokenName ?? input.enrolledTokenName,
      preRegistered: existing?.preRegistered ?? false,
      mtlsCertIssuedAt: existing?.mtlsCertIssuedAt,
      mtlsSeenAt: existing?.mtlsSeenAt,
    };
    this.machines.set(input.machineId, machine);
    await this.store.upsertMachine(this.toPersistedMachine(machine));
  }

  // ── Pre-registration (POL-104) ────────────────────────────────────────────

  /** Every pre-registration record, creation-ordered. */
  listPreRegistrations(): PreRegistration[] {
    return [...this.preRegistrations.values()].map((r) => ({ ...r }));
  }

  /** Declare a box before it boots. Write-through. */
  async addPreRegistration(input: Omit<PreRegistration, "id" | "createdAt">): Promise<PreRegistration> {
    const record: PreRegistration = {
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      // Normalize the soft keys at the door, so a paste of `AA-BB-CC-DD-EE-01` matches a box that
      // reports `aa:bb:cc:dd:ee:01`.
      mac: normalizeMac(input.mac) ?? input.mac,
    };
    this.preRegistrations.set(record.id, record);
    await this.store.upsertPreRegistration(record);
    return { ...record };
  }

  /** Forget a pre-registration. A box that already matched it keeps its name/approval — the record is
   *  a declaration, not a lease. */
  async removePreRegistration(id: string): Promise<boolean> {
    if (!this.preRegistrations.delete(id)) return false;
    await this.store.deletePreRegistration(id);
    return true;
  }

  /**
   * A box has just enrolled and AUTHENTICATED. Does an operator's pre-registration claim it? If so:
   * adopt its label, mark the machine pre-registered, and claim the record for this machine. The
   * caller (the WS hello handler) then approves the box if the record says `autoApprove` — that is
   * the zero-click commissioning path (DoD: "a pre-registered box enrolls, auto-names, auto-tags and
   * auto-approves with zero clicks").
   *
   * Returns the match so the handler can log/announce WHICH key matched — a MAC match is a weaker
   * claim than a serial, and an operator debugging a mis-named box needs to know which it was.
   */
  async applyPreRegistration(
    machineId: string,
    hardware: HostIdentity | undefined,
  ): Promise<PreRegistrationMatch | undefined> {
    const machine = this.machines.get(machineId);
    if (!machine) return undefined;

    const match = matchPreRegistration(this.listPreRegistrations(), machineId, hardware);
    if (!match) return undefined;

    const record: PreRegistration = {
      ...match.record,
      matchedMachineId: machineId,
      matchedAt: new Date().toISOString(),
      matchedOn: match.matchedOn,
    };
    this.preRegistrations.set(record.id, record);
    await this.store.upsertPreRegistration(record);

    if (record.label) machine.label = record.label;
    machine.preRegistered = true;
    await this.store.upsertMachine(this.toPersistedMachine(machine));

    return { record, matchedOn: match.matchedOn };
  }

  /**
   * Re-issue a credential for an EXISTING machine without changing its status or creating screens
   * (a token re-enrol of a still-pending machine, or refreshing a pending machine's reported
   * outputs on reconnect). Write-through. No-op if the machine is unknown.
   */
  async setMachineCredential(
    machineId: string,
    credentialHash: string,
    outputs?: Output[],
  ): Promise<void> {
    this.credentialHashes.set(machineId, credentialHash);
    const machine = this.machines.get(machineId);
    if (!machine) return;
    machine.lastSeen = new Date().toISOString();
    if (outputs) machine.outputs = outputs;
    await this.store.upsertMachine(this.toPersistedMachine(machine));
  }

  /**
   * Refresh a known machine's lastSeen (+ reported outputs) on reconnect, without touching status or
   * screens. Used when a recognised pending machine re-presents a valid credential. No-op if unknown.
   */
  async touchMachine(machineId: string, outputs: Output[]): Promise<void> {
    const machine = this.machines.get(machineId);
    if (!machine) return;
    machine.lastSeen = new Date().toISOString();
    machine.outputs = outputs;
    await this.store.upsertMachine(this.toPersistedMachine(machine));
  }

  /**
   * POL-134 — record that the server signed this machine's CSR into a client cert. Write-through;
   * no-op if the machine is unknown (open-mode issuance can precede registration on first contact —
   * the next hello registers the machine and the following issuance lands the timestamp).
   */
  async noteMachineCertIssued(machineId: string): Promise<void> {
    const machine = this.machines.get(machineId);
    if (!machine) return;
    machine.mtlsCertIssuedAt = new Date().toISOString();
    await this.store.upsertMachine(this.toPersistedMachine(machine));
  }

  /**
   * POL-134 — record that this machine connected over the mTLS listener (proof it presents a
   * working cert). Returns true on the FIRST time — the caller narrates the migration in the feed.
   * Write-through; no-op (false) if the machine is unknown.
   */
  async noteMachineMtlsSeen(machineId: string): Promise<boolean> {
    const machine = this.machines.get(machineId);
    if (!machine) return false;
    if (machine.mtlsSeenAt) return false;
    machine.mtlsSeenAt = new Date().toISOString();
    await this.store.upsertMachine(this.toPersistedMachine(machine));
    return true;
  }

  /**
   * Operator approval. Flip the machine to `approved` and create a Screen (+ empty slice) per its
   * PERSISTED output, returning assignments for a live `server/apply`. Write-through (status, any
   * new screens/content, revision). Returns null if the machine is unknown; idempotent if already
   * approved (returns the existing screens' assignments).
   */
  async approveMachine(machineId: string): Promise<RegisterMachineResult | null> {
    const machine = this.machines.get(machineId);
    if (!machine) return null;

    machine.status = "approved";
    const ensured = this.ensureScreens(machineId, machine.outputs);
    if (ensured.changed) this.bumpRevision();

    await this.store.setMachineStatus(machineId, "approved");
    await this.persistScreens(ensured);
    if (ensured.changed) await this.store.setRevision(this.state.revision);

    this.emit("good", `${machine.label} approved`);
    return { changed: ensured.changed, assignments: ensured.assignments };
  }

  /**
   * Operator rejection. Flip the machine to `rejected` (terminal — it will never be admitted) and
   * write-through. Returns false if the machine is unknown.
   */
  async rejectMachine(machineId: string): Promise<boolean> {
    const machine = this.machines.get(machineId);
    if (!machine) return false;
    machine.status = "rejected";
    await this.store.setMachineStatus(machineId, "rejected");
    this.emit("bad", `${machine.label} rejected`);
    return true;
  }

  /**
   * Arm/disarm a machine for the remote shell (POL-59). Returns the machine when it exists (so the
   * caller can broadcast the new state), else null. Disarming does NOT itself kill a live session —
   * the WS relay checks `shellEnabled` on every frame, so a disarm is enforced on the next byte and
   * the caller also closes any open session explicitly.
   */
  async setShellEnabled(machineId: string, enabled: boolean): Promise<Machine | null> {
    const machine = this.machines.get(machineId);
    if (!machine) return null;
    if (machine.shellEnabled !== enabled) {
      machine.shellEnabled = enabled;
      machine.shellArmedAt = enabled ? new Date().toISOString() : undefined;
      await this.store.setMachineShellEnabled(machineId, enabled, machine.shellArmedAt ?? null);
      // POL-68 — the console's vocabulary: enabling is security-relevant (red), disabling is calm.
      this.emit(
        enabled ? "bad" : "good",
        `Console ${enabled ? "enabled" : "disabled"} on ${machine.label}`,
      );
    }
    return machine;
  }

  /** Refresh the arm timestamp (POL-59) — called when a terminal opens, so an actively-used box
   *  keeps extending its TTL window and only a FORGOTTEN armed box auto-disarms. No-op if disarmed. */
  async refreshShellArmed(machineId: string): Promise<void> {
    const machine = this.machines.get(machineId);
    if (!machine || !machine.shellEnabled) return;
    machine.shellArmedAt = new Date().toISOString();
    await this.store.setMachineShellEnabled(machineId, true, machine.shellArmedAt);
  }

  /**
   * Auto-disarm boxes armed-and-idle past `ttlMs` (POL-59 hardening): a forgotten armed box must not
   * stay a standing shell-openable target. `keepArmed(id)` lets the caller spare a box with a LIVE
   * session (the relay knows liveness). `ttlMs <= 0` disables the sweep. Returns the disarmed
   * machines so the caller can close their sessions + broadcast. Testable: `nowMs` is injected.
   */
  async disarmExpiredShells(ttlMs: number, nowMs: number, keepArmed: (id: string) => boolean): Promise<Machine[]> {
    if (ttlMs <= 0) return [];
    const disarmed: Machine[] = [];
    for (const machine of this.machines.values()) {
      if (!machine.shellEnabled) continue;
      if (keepArmed(machine.id)) continue;
      const armedAt = machine.shellArmedAt ? Date.parse(machine.shellArmedAt) : 0;
      if (!armedAt || nowMs - armedAt < ttlMs) continue;
      machine.shellEnabled = false;
      machine.shellArmedAt = undefined;
      await this.store.setMachineShellEnabled(machine.id, false, null);
      this.emit("good", `Console auto-disabled on ${machine.label} (idle past the TTL)`);
      disarmed.push(machine);
    }
    return disarmed;
  }

  /** Whether a machine is currently armed for the remote shell (the WS relay's gate). */
  isShellEnabled(machineId: string): boolean {
    return this.machines.get(machineId)?.shellEnabled === true;
  }

  /**
   * Permanently FORGET a machine and everything derived from it: every screen it drives (dissolving
   * any combined surface those screens belong to), their placements + content, its off-band
   * credential, and the machine row itself. Write-through — `store.deleteMachine` cascades the
   * screens/content/placements. Bumps the revision iff desired state actually changed (a pending
   * machine with no screens is registry-only, like a rename). Returns the slices to push a
   * `server/render` for — the cleared slices of the removed screens PLUS any surviving wall members on
   * OTHER machines (so no stale fragment keeps rendering) — or null if the machine is unknown.
   *
   * Unlike `rejectMachine` (a terminal-but-remembered state), a removed machine is GONE: in gated mode
   * a reconnect with the now-unknown credential is rejected, and presenting the bootstrap token
   * re-enrols it fresh as pending; in open mode it re-registers as a brand-new machine.
   */
  async removeMachine(machineId: string): Promise<{ slices: ScreenSlice[] } | null> {
    const machine = this.machines.get(machineId);
    if (machine === undefined) return null;

    const screenIds = this.state.screens.filter((s) => s.machineId === machineId).map((s) => s.id);
    const removed = new Set(screenIds);
    const touched = new Map<string, ScreenSlice>();

    // Dissolve every combined surface that includes a removed screen (a wall may also hold members on
    // OTHER machines — those survivors need a render clear). Clearing walks all their members' slices.
    for (const wall of [...this.videoWalls.values()]) {
      if (!wall.memberScreenIds.some((id) => removed.has(id))) continue;
      this.videoWalls.delete(wall.id);
      this.wallSourceIds.delete(wall.id);
      await this.store.deleteVideoWall(wall.id);
      await this.forgetZooms(wall.id);
      for (const s of this.clearSlices(wall.memberScreenIds)) touched.set(s.screenId, s);
    }

    // Clear + drop each of the machine's screens (slice, placement, desired-state entry).
    for (const id of screenIds) {
      for (const s of this.clearSlices([id])) touched.set(s.screenId, s);
      this.placements.delete(id); // store.deleteMachine cascades the placement row
      delete this.state.slices[id];
      const idx = this.state.screens.findIndex((s) => s.id === id);
      if (idx >= 0) this.state.screens.splice(idx, 1);
      await this.forgetZooms(id);
    }

    // Drop the machine itself (+ its off-band credential). deleteMachine cascades screens/content/placements.
    this.machines.delete(machineId);
    this.credentialHashes.delete(machineId);
    await this.store.deleteMachine(machineId);

    // Removing screens shrinks desired state; a screenless (pending) machine is registry-only (no bump).
    const changed = screenIds.length > 0 || touched.size > 0;
    if (changed) {
      this.bumpRevision();
      // Persist the cleared content of SURVIVING screens only — removed screens' rows are already gone.
      for (const s of touched.values()) {
        if (removed.has(s.screenId)) continue;
        await this.store.upsertContent({
          screenId: s.screenId,
          canvas: s.canvas,
          surfaces: s.surfaces,
        });
      }
      await this.store.setRevision(this.state.revision);
    }

    this.emit("warn", `${machine.label} removed`);
    return { slices: [...touched.values()] };
  }

  getScreens(): Screen[] {
    return this.state.screens;
  }

  getScreen(screenId: string): Screen | undefined {
    return this.state.screens.find((s) => s.id === screenId);
  }

  getMachines(): Machine[] {
    return [...this.machines.values()];
  }

  getMachine(machineId: string): Machine | undefined {
    return this.machines.get(machineId);
  }

  /** The stored credential hash for a machine, if it has ever been issued one. */
  getCredentialHash(machineId: string): string | undefined {
    return this.credentialHashes.get(machineId);
  }

  /** The stored slice for a screen, if any. */
  getSlice(screenId: string): ScreenSlice | undefined {
    return this.state.slices[screenId];
  }

  /** The slice to render for a connecting player — stored slice, or a synthesized empty default. */
  sliceForPlayer(screenId: string): ScreenSlice {
    return (
      this.state.slices[screenId] ?? {
        screenId,
        canvas: { ...DEFAULT_CANVAS },
        surfaces: [],
      }
    );
  }

  /** The current fleet-wide display settings (POL-6). Returned by value so callers can't mutate state. */
  getDisplaySettings(): DisplaySettings {
    return { ...this.displaySettings };
  }

  /**
   * Set + persist the fleet-wide display settings (POL-6). Does NOT bump the revision — badge
   * visibility is a presentation setting broadcast on its own `server/settings` channel, not part of
   * the content reconcile loop players ack. The caller fans it out to players + the admin console.
   * Returns the new settings.
   */
  async setDisplaySettings(next: DisplaySettings): Promise<DisplaySettings> {
    this.displaySettings = { showBadges: next.showBadges };
    await this.store.setDisplaySettings({ showBadges: next.showBadges });
    this.emit("info", `On-screen badges ${next.showBadges ? "shown on" : "hidden from"} every screen`);
    return this.getDisplaySettings();
  }

  /**
   * Replace a screen's surfaces wholesale, bump the revision, write-through, return the new slice.
   * Returns null if the screen is unknown.
   */
  async setScreenSurfaces(screenId: string, surfaces: Surface[]): Promise<ScreenSlice | null> {
    const slice = this.state.slices[screenId];
    if (slice === undefined) return null;
    const next: ScreenSlice = { ...slice, surfaces };
    this.state.slices[screenId] = next;
    // Replacing surfaces wholesale drops any library-source assignment this screen carried.
    this.setScreenSourceAssignment(screenId, null);
    this.bumpRevision();

    await this.store.upsertContent({
      screenId,
      canvas: next.canvas,
      surfaces: next.surfaces,
      sourceId: null,
    });
    await this.store.setRevision(this.state.revision);
    return next;
  }

  /**
   * Convenience for the demo: replace a screen's slice with ONE full-canvas web surface.
   * Returns null if the screen is unknown.
   */
  async setDemoWeb(screenId: string, url: string): Promise<ScreenSlice | null> {
    const slice = this.state.slices[screenId];
    if (slice === undefined) return null;
    const surface = WebSurface.parse({
      // Stable id so consecutive demo pushes reconcile to the SAME keyed tile — the player
      // mutates the existing <iframe> src in place (DOM diff) instead of tearing it down.
      id: "demo-web",
      type: "web",
      region: { x: 0, y: 0, w: slice.canvas.w, h: slice.canvas.h },
      url,
      placement: "iframe",
      interactive: false,
    });
    const next: ScreenSlice = { ...slice, surfaces: [surface] };
    this.state.slices[screenId] = next;
    // The demo push is an ad-hoc web surface — drop any library-source assignment.
    this.setScreenSourceAssignment(screenId, null);
    this.bumpRevision();

    await this.store.upsertContent({
      screenId,
      canvas: next.canvas,
      surfaces: next.surfaces,
      sourceId: null,
    });
    await this.store.setRevision(this.state.revision);
    return next;
  }

  /**
   * Rename a screen's friendly name and write-through. Does NOT bump the revision: the friendly name
   * is registry metadata (used by ident + the admin UI), not part of any player's render slice — so
   * bumping would make every screen look "behind" in the admin UI (no render is pushed to ack).
   * Returns the updated screen, or null if unknown.
   */
  async renameScreen(screenId: string, friendlyName: string): Promise<Screen | null> {
    const screen = this.state.screens.find((s) => s.id === screenId);
    if (screen === undefined) return null;
    const previousName = screen.friendlyName;
    screen.friendlyName = friendlyName;

    await this.store.upsertScreen({
      id: screen.id,
      friendlyName: screen.friendlyName,
      machineId: screen.machineId,
      connector: screen.connector,
      castEnabled: screen.castEnabled,
    });
    if (previousName !== friendlyName) this.emit("info", `${previousName} renamed`);
    return screen;
  }

  /**
   * POL-117 — rename a machine (any machine, any status: naming a still-PENDING box is the point,
   * because several identical netbooted boxes are indistinguishable exactly while they queue for
   * approval). Writes `Machine.label` — the same field the hostname used to default into — so the
   * operator's name simply wins from here on (labelForHello never overwrites a real name).
   * Registry metadata like renameScreen: write-through, NO revision bump; the caller broadcasts
   * admin/state so every open console relabels live. Returns the machine, or null if unknown.
   */
  async renameMachine(machineId: string, label: string): Promise<Machine | null> {
    const machine = this.machines.get(machineId);
    if (!machine) return null;
    const previous = machine.label;
    machine.label = label;
    await this.store.upsertMachine(this.toPersistedMachine(machine));
    if (previous !== label) {
      // The previous label may be the unnamed sentinel (= machineId) — say so honestly.
      const from = previous === machine.id ? "Unnamed box" : previous;
      this.emit("info", `${from} renamed to ${label}`);
    }
    return machine;
  }

  /**
   * Enable/disable casting (the AirPlay receiver) on one screen (POL-119). Persistent and TTL-less —
   * unlike the shell arm, a castable meeting-room panel is meant to STAY castable; the on-glass PIN
   * is the per-session gate. Like renameScreen this is registry metadata: write-through, no revision
   * bump. The caller re-applies to the driving agent (start/stop the receiver) and re-pushes the
   * same-revision render (the player's badge glyph). Returns the screen, or null if unknown.
   */
  async setScreenCastEnabled(screenId: string, enabled: boolean): Promise<Screen | null> {
    const screen = this.state.screens.find((s) => s.id === screenId);
    if (screen === undefined) return null;
    if (screen.castEnabled !== enabled) {
      screen.castEnabled = enabled;
      await this.store.upsertScreen({
        id: screen.id,
        friendlyName: screen.friendlyName,
        machineId: screen.machineId,
        connector: screen.connector,
        castEnabled: enabled,
      });
      this.emit("info", `Casting ${enabled ? "enabled" : "disabled"} on ${screen.friendlyName}`);
    }
    return screen;
  }

  // ── Murals & placement (Phase 3) ────────────────────────────────────────────
  //
  // Murals and placements are spatial layout metadata for the console — they do NOT affect any
  // player's render slice, so (like renameScreen) these mutations write-through but do NOT bump the
  // revision. The admin/state broadcast re-reads the current murals/placements regardless.

  getMurals(): Mural[] {
    return [...this.murals.values()];
  }

  getMural(id: string): Mural | undefined {
    return this.murals.get(id);
  }

  getPlacements(): Placement[] {
    return [...this.placements.values()];
  }

  getPlacement(screenId: string): Placement | undefined {
    return this.placements.get(screenId);
  }

  /** Create a new mural with a server-assigned id. Write-through. */
  async createMural(name: string): Promise<Mural> {
    const id = this.nextMuralId();
    const mural: Mural = { id, name };
    this.murals.set(id, mural);
    await this.store.upsertMural({ id, name });
    return mural;
  }

  /** Rename a mural. Write-through. Returns the updated mural, or null if unknown. */
  async renameMural(id: string, name: string): Promise<Mural | null> {
    const mural = this.murals.get(id);
    if (mural === undefined) return null;
    mural.name = name;
    await this.store.upsertMural({ id: mural.id, name: mural.name });
    return mural;
  }

  /**
   * Delete a mural. Every screen placed on it is unplaced (its placement removed and written through)
   * so those screens fall back to the unplaced tray. Write-through. Returns false if the mural is
   * unknown.
   */
  async deleteMural(id: string): Promise<{ slices: ScreenSlice[] } | null> {
    const mural = this.murals.get(id);
    if (mural === undefined) return null;

    // Delete any combined surfaces on this mural first — their members are about to be unplaced, so
    // the wall (which requires ≥2 placed members) can no longer exist. A wall's span content is
    // meaningless once the wall is gone, so CLEAR each member's slice (a render change → push). (A
    // lone placed screen's own content is left as-is, matching how it survives its mural's deletion.)
    const wallsHere = [...this.videoWalls.values()].filter((w) => w.muralId === id);
    const memberIds: string[] = [];
    for (const w of wallsHere) {
      this.videoWalls.delete(w.id);
      this.wallSourceIds.delete(w.id);
      await this.store.deleteVideoWall(w.id);
      await this.forgetZooms(w.id);
      memberIds.push(...w.memberScreenIds);
    }
    const slices = this.clearSlices(memberIds);

    const placedHere = [...this.placements.values()].filter((p) => p.muralId === id);
    for (const p of placedHere) {
      this.placements.delete(p.screenId);
      await this.store.deletePlacement(p.screenId);
    }

    this.murals.delete(id);
    await this.store.deleteMural(id);

    if (slices.length > 0) {
      this.bumpRevision();
      for (const slice of slices) {
        await this.store.upsertContent({
          screenId: slice.screenId,
          canvas: slice.canvas,
          surfaces: slice.surfaces,
        });
      }
      await this.store.setRevision(this.state.revision);
    }
    return { slices };
  }

  /**
   * Place (or move) a screen on a mural at `{x,y}`; `w`/`h` default to the screen's native resolution
   * (preserving an existing placement's size when omitted, e.g. on a drag-move). A screen is placed
   * on at most one mural, so placing it elsewhere MOVES it. Write-through. Returns the placement, or
   * null if the screen or the mural is unknown.
   */
  async placeScreen(
    screenId: string,
    muralId: string,
    x: number,
    y: number,
    w?: number,
    h?: number,
  ): Promise<Placement | null> {
    const screen = this.getScreen(screenId);
    if (screen === undefined) return null;
    if (!this.murals.has(muralId)) return null;

    const existing = this.placements.get(screenId);
    const res = this.screenResolution(screen);
    const placement: Placement = {
      muralId,
      screenId,
      x,
      y,
      w: w ?? existing?.w ?? res.w,
      h: h ?? existing?.h ?? res.h,
    };
    this.placements.set(screenId, placement);
    await this.store.upsertPlacement(placement);
    return placement;
  }

  /**
   * Remove a screen's placement (return it to the unplaced tray). Write-through. Returns `false` if it
   * was not placed, otherwise the slices to render. If the screen belonged to a video wall, unplacing
   * it breaks the combined surface, so the whole wall is DISSOLVED — every member's span slice is
   * cleared (the operator re-combines what remains) — and those cleared slices are returned to push.
   */
  async unplaceScreen(screenId: string): Promise<{ slices: ScreenSlice[] } | false> {
    if (!this.placements.has(screenId)) return false;
    this.placements.delete(screenId);
    await this.store.deletePlacement(screenId);

    const wall = this.getWallForScreen(screenId);
    if (wall === undefined) return { slices: [] };

    this.videoWalls.delete(wall.id);
    this.wallSourceIds.delete(wall.id);
    await this.store.deleteVideoWall(wall.id);
    await this.forgetZooms(wall.id);
    const slices = this.clearSlices(wall.memberScreenIds); // includes the just-unplaced screen
    this.bumpRevision();
    for (const slice of slices) {
      await this.store.upsertContent({
        screenId: slice.screenId,
        canvas: slice.canvas,
        surfaces: slice.surfaces,
      });
    }
    await this.store.setRevision(this.state.revision);
    return { slices };
  }

  /**
   * Permanently FORGET a single screen: dissolve any combined surface it belongs to (clearing every
   * member's slice), drop its placement + content-source assignment, remove it from desired state, and
   * write through (`store.deleteScreen` cascades its content + placement rows). Bumps the revision.
   * Returns the slices to push a `server/render` for — the cleared slices of any surviving wall members
   * PLUS the removed screen itself (an empty slice, so a still-connected player clears) — or null if the
   * screen is unknown.
   *
   * Note: the screen is derived from its machine's reported outputs, so if that machine is still
   * connected and reports this output it will be RE-CREATED on the machine's next `agent/hello`. This
   * is aimed at forgetting a STALE screen (an output the machine no longer drives) or clearing one out
   * ahead of removing its whole machine.
   */
  async removeScreen(screenId: string): Promise<{ slices: ScreenSlice[] } | null> {
    const screen = this.getScreen(screenId);
    if (screen === undefined) return null;

    const touched = new Map<string, ScreenSlice>();

    // Dissolve a wall this screen is a member of — a combined surface can't outlive a member. Clears
    // every member's slice (surviving members need a render clear; the removed screen is cleared too).
    const wall = this.getWallForScreen(screenId);
    if (wall) {
      this.videoWalls.delete(wall.id);
      this.wallSourceIds.delete(wall.id);
      await this.store.deleteVideoWall(wall.id);
      await this.forgetZooms(wall.id);
      for (const s of this.clearSlices(wall.memberScreenIds)) touched.set(s.screenId, s);
    }

    // Clear the removed screen's own slice too (so a still-connected player renders nothing).
    for (const s of this.clearSlices([screenId])) touched.set(s.screenId, s);

    // Drop its placement, slice + desired-state entry, then delete the rows (screen + its content +
    // placement are separate store deletes — deleteScreen removes only the screen row).
    this.placements.delete(screenId);
    delete this.state.slices[screenId];
    const idx = this.state.screens.findIndex((s) => s.id === screenId);
    if (idx >= 0) this.state.screens.splice(idx, 1);
    await this.store.deleteContent(screenId);
    await this.store.deletePlacement(screenId);
    await this.store.deleteScreen(screenId);
    await this.forgetZooms(screenId);

    this.bumpRevision();
    // Persist the cleared content of SURVIVING screens only — the removed one's row is already gone.
    for (const s of touched.values()) {
      if (s.screenId === screenId) continue;
      await this.store.upsertContent({
        screenId: s.screenId,
        canvas: s.canvas,
        surfaces: s.surfaces,
      });
    }
    await this.store.setRevision(this.state.revision);

    this.emit("warn", `${screen.friendlyName} removed`);
    return { slices: [...touched.values()] };
  }

  // ── Combined surfaces / video walls (Phase 3b) ──────────────────────────────
  //
  // A video wall combines ≥2 adjacent placed screens on one mural into a single logical surface that
  // one piece of content SPANS across (each member renders its slice — see Surface.span + THE SPAN
  // MATH). Combining and splitting both CLEAR the members' slices (a render change → bump + push);
  // setting wall content recomputes the union bounding box and gives each member one web surface with
  // a span. Membership is exclusive: a screen belongs to at most one wall, and a wall member cannot
  // also carry single-screen content.

  getVideoWalls(): VideoWall[] {
    return [...this.videoWalls.values()];
  }

  getVideoWall(id: string): VideoWall | undefined {
    return this.videoWalls.get(id);
  }

  /** The wall a screen is a member of, if any. */
  getWallForScreen(screenId: string): VideoWall | undefined {
    for (const wall of this.videoWalls.values()) {
      if (wall.memberScreenIds.includes(screenId)) return wall;
    }
    return undefined;
  }

  /** What's on a screen now, for the console's tiles/inspector: the library source's name+kind (a
   *  wall member shows the wall's source), an ad-hoc URL's derived name, or null when nothing's on air. */
  screenContentSummary(
    screenId: string,
  ): {
    name: string;
    kind: ContentKind;
    zoom?: number;
    entries?: { sourceId?: string; name: string; kind: PlaylistEntry["kind"]; zoom?: number }[];
  } | null {
    const surface = this.state.slices[screenId]?.surfaces[0];
    // POL-57 — the live zoom, present only for framed content. Its absence is how the console knows
    // this screen has nothing to zoom (media, or no content at all) and hides the control.
    const zoom = surface && isFramed(surface) ? surface.zoom : undefined;
    // POL-133 — for a playlist, the rotation's steps with each framed step's live zoom on THIS
    // screen, so the console can draw one zoom control per zoomable step.
    const entries =
      surface?.type === "playlist"
        ? surface.items.map((entry) => ({
            ...(entry.sourceId !== undefined ? { sourceId: entry.sourceId } : {}),
            name:
              (entry.sourceId && this.contentSources.get(entry.sourceId)?.name) ||
              this.contentNameFromUrl(entry.url, entry.kind),
            kind: entry.kind,
            ...(ControlPlane.entryFramed(entry) ? { zoom: entry.zoom } : {}),
          }))
        : undefined;

    const wall = this.getWallForScreen(screenId);
    const sourceId = wall ? this.wallSourceIds.get(wall.id) : this.screenSourceIds.get(screenId);
    if (sourceId) {
      const src = this.contentSources.get(sourceId);
      if (src) return { name: src.name, kind: src.kind, zoom, entries };
    }
    if (!surface) return null;
    const kind = surface.type as ContentKind;
    const raw = "url" in surface ? surface.url : "src" in surface ? surface.src : "";
    return { name: this.contentNameFromUrl(raw, kind), kind, zoom, entries };
  }

  /** A friendly name for ad-hoc content: the URL host, else a kind label. */
  private contentNameFromUrl(raw: string, kind: ContentKind): string {
    try {
      const h = new URL(raw).host;
      if (h) return h;
    } catch {
      /* not a URL */
    }
    return kind === "web"
      ? "Web page"
      : kind === "dashboard"
        ? "Dashboard"
        : kind === "image"
          ? "Image"
          : kind === "video"
            ? "Video"
            : kind === "playlist"
              ? "Playlist"
              : "Page";
  }

  /** A human content name for an activity line: the library source's name, else the ad-hoc URL's host. */
  private resolvedContentName(spec: ResolvedSpec, sourceId: string | null): string {
    if (sourceId) {
      const src = this.contentSources.get(sourceId);
      if (src) return src.name;
    }
    return this.contentNameFromUrl(specUrl(spec), spec.kind);
  }

  private nextWallId(): string {
    this.wallCounter += 1;
    return `wall-${this.wallCounter}`;
  }

  /**
   * Clear (empty the surfaces of) each given screen's slice in memory; return the touched slices.
   * Clearing a screen's content also drops any library-source assignment it carried (the slice no
   * longer shows that source), so a later source edit won't try to re-resolve a now-empty screen.
   */
  private clearSlices(screenIds: string[]): ScreenSlice[] {
    const touched: ScreenSlice[] = [];
    for (const screenId of screenIds) {
      this.screenSourceIds.delete(screenId);
      const slice = this.state.slices[screenId];
      if (slice === undefined) continue;
      const next: ScreenSlice = { ...slice, surfaces: [] };
      this.state.slices[screenId] = next;
      touched.push(next);
    }
    return touched;
  }

  // ── Content library: resolution helpers (Phase 3c) ──────────────────────────

  /**
   * Build the renderable surface for a resolved spec. The kind decides the surface type (web/dashboard
   * → URL-bearing; image/video → src-bearing); zod fills the type-specific defaults. `span` (when set)
   * makes the surface render only its slice of a larger spanning content (video walls). The surface id
   * is caller-supplied and STABLE so consecutive pushes reconcile to the same keyed tile (in-place swap,
   * the INSTANT property — D5). `zoom` (POL-57) rides on framed kinds only; media has no page to zoom.
   */
  private buildSurface(
    spec: ResolvedSpec,
    id: string,
    region: Geometry,
    span?: Span,
    zoom: number = DEFAULT_ZOOM,
  ): Surface {
    const base = span ? { id, region, span } : { id, region };
    switch (spec.kind) {
      case "page":
        // POL-42 — the STORED surface carries only the clean definition; embeds/feeds/weather are
        // resolved + stamped into `data` at send time (decorateSliceForSend). No zoom: pages scale
        // by design (% regions + container units), so zoom is ignored for page surfaces (No-Gos).
        return PageSurface.parse({ ...base, type: "page", definition: spec.definition });
      case "web":
        return WebSurface.parse({
          ...base,
          type: "web",
          url: spec.url,
          placement: "iframe",
          interactive: false,
          zoom,
        });
      case "dashboard":
        return DashboardSurface.parse({ ...base, type: "dashboard", url: spec.url, zoom });
      case "image":
        return ImageSurface.parse({ ...base, type: "image", src: spec.url, fit: "cover" });
      case "video":
        return VideoSurface.parse({ ...base, type: "video", src: spec.url, loop: true, muted: true });
      case "playlist":
        // POL-34 — the whole resolved rotation ships in one surface; the player advances it locally.
        // `startedAt` came off the spec (resolved once per assignment), so every wall member anchors
        // its rotation to the same instant. Zoom does not apply — a playlist is not one page.
        return PlaylistSurface.parse({
          ...base,
          type: "playlist",
          items: spec.entries ?? [],
          startedAt: spec.startedAt ?? new Date().toISOString(),
        });
    }
  }

  // ── Page zoom (POL-57) ──────────────────────────────────────────────────────
  //
  // Zoom is a property of the (target, page) PAIR, not of the screen and not of the library source:
  // the same dashboard wants different zoom on a 4K panel than on a 1080p one, and one panel wants
  // different zoom for each page it cycles through. So we remember it against both, and re-apply it
  // whenever that page lands on that target again — including after a scene switch or a server
  // restart. The live value additionally rides on the surface itself, which is what the player reads.

  /** The remembered zoom for a (target, page) pair, or 100% when the operator has never set one. */
  private zoomFor(targetId: string, sourceKey: string): number {
    return this.zoomPrefs.get(zoomKey(targetId, sourceKey)) ?? DEFAULT_ZOOM;
  }

  /** Remember the zoom for a pair, write-through. An explicit 100% is stored rather than dropped: a
   *  reset is a choice the operator made and must survive a restart, not the absence of one. */
  private async rememberZoom(targetId: string, sourceKey: string, zoom: number): Promise<void> {
    this.zoomPrefs.set(zoomKey(targetId, sourceKey), zoom);
    await this.store.upsertZoomPreference({ targetId, sourceKey, zoom });
  }

  /** Forget every remembered zoom for a screen/wall that is being removed. Ids are never reused, so a
   *  pref that outlived its target could only ever be dead weight. */
  private async forgetZooms(targetId: string): Promise<void> {
    for (const key of [...this.zoomPrefs.keys()]) {
      if (key.startsWith(`${targetId}\u0000`)) this.zoomPrefs.delete(key);
    }
    await this.store.deleteZoomPreferencesForTarget(targetId);
  }

  /** The page identity a zoom is remembered against: a library source by id, else the ad-hoc URL. */
  private sourceKeyFor(sourceId: string | null, url: string): string {
    return sourceId ? `source:${sourceId}` : `url:${url}`;
  }

  // ── Playlist step zoom (POL-133) ────────────────────────────────────────────
  //
  // The same D62 model, one level down: a page playing as a playlist STEP is still "this content on
  // this target", so its zoom is remembered against the (target, step source) pair — in the SAME
  // zoom_preferences table, under the same `source:<id>` key a direct assignment of that source
  // would use. That is deliberate: the pair identifies the content and the glass, not the route the
  // content took to get there.

  /** True for a playlist entry that frames a page — the only kind of step that can be zoomed. */
  private static entryFramed(entry: PlaylistEntry): boolean {
    return entry.kind === "web" || entry.kind === "dashboard";
  }

  /** Each framed entry stamped with the zoom remembered for (target, its source); media untouched. */
  private entriesWithZoom(targetId: string, entries: PlaylistEntry[]): PlaylistEntry[] {
    return entries.map((entry) =>
      ControlPlane.entryFramed(entry) && entry.sourceId
        ? { ...entry, zoom: this.zoomFor(targetId, this.sourceKeyFor(entry.sourceId, entry.url)) }
        : entry,
    );
  }

  /** A resolved spec specialised to ONE target: playlist entries pick up that target's remembered
   *  per-step zooms. Non-playlists (and target-agnostic fields like `startedAt`) pass through. */
  private specForTarget(targetId: string, spec: ResolvedSpec): ResolvedSpec {
    if (spec.kind !== "playlist" || spec.entries === undefined) return spec;
    return { ...spec, entries: this.entriesWithZoom(targetId, spec.entries) };
  }

  /** The playlist surface a step-zoom request targets, or the reason there isn't one. */
  private playlistSurfaceOf(
    slice: ScreenSlice | undefined,
  ): { ok: true; surface: PlaylistSurface } | { ok: false; error: "no-content" | "not-zoomable" } {
    const surface = slice?.surfaces[0];
    if (slice === undefined || surface === undefined) return { ok: false, error: "no-content" };
    if (surface.type !== "playlist") return { ok: false, error: "not-zoomable" };
    return { ok: true, surface };
  }

  /** `surface` with every framed entry resolved from `sourceId` re-stamped to `zoom`, in place in
   *  `slice` — same surface id, same `startedAt`, so the player's rotation identity is untouched
   *  and the live iframe (if that step is on air) restyles without a reload. */
  private static withEntryZoom(
    slice: ScreenSlice,
    surface: PlaylistSurface,
    sourceId: string,
    zoom: number,
  ): { slice: ScreenSlice; matched: boolean } {
    let matched = false;
    const items = surface.items.map((entry) => {
      if (entry.sourceId !== sourceId || !ControlPlane.entryFramed(entry)) return entry;
      matched = true;
      return { ...entry, zoom };
    });
    return {
      slice: { ...slice, surfaces: [{ ...surface, items }, ...slice.surfaces.slice(1)] },
      matched,
    };
  }

  /**
   * Set the page zoom on ONE step of the playlist a single screen is showing (POL-133). Patches the
   * step's entries in the EXISTING surface — same surface id, same `startedAt`, so the rotation keeps
   * its position (the player's rotation signature ignores zoom) and, if the step is on air, the live
   * iframe rescales without a reload. Remembered against (screen, step source), exactly like D62.
   */
  async setScreenPlaylistEntryZoom(
    screenId: string,
    sourceId: string,
    zoom: number,
  ): Promise<SetPlaylistEntryZoomResult> {
    const screen = this.getScreen(screenId);
    if (screen === undefined) return { ok: false, error: "unknown-screen" };
    const wall = this.getWallForScreen(screenId);
    if (wall) return { ok: false, error: "wall-member", wallId: wall.id };

    const found = this.playlistSurfaceOf(this.state.slices[screenId]);
    if (!found.ok) return { ok: false, error: found.error };
    const patched = ControlPlane.withEntryZoom(this.state.slices[screenId]!, found.surface, sourceId, zoom);
    if (!patched.matched) return { ok: false, error: "unknown-entry" };

    this.state.slices[screenId] = patched.slice;
    this.bumpRevision();

    await this.rememberZoom(screenId, this.sourceKeyFor(sourceId, ""), zoom);
    await this.store.upsertContent({
      screenId,
      canvas: patched.slice.canvas,
      surfaces: patched.slice.surfaces,
      sourceId: this.screenSourceIds.get(screenId) ?? null,
    });
    await this.store.setRevision(this.state.revision);

    const stepName = this.contentSources.get(sourceId)?.name ?? sourceId;
    this.emit("good", `${screen.friendlyName} · ${stepName} zoom ${zoomLabel(zoom)}`);
    return { ok: true, slices: [patched.slice] };
  }

  /**
   * Set the page zoom on ONE step of the playlist spanning a combined surface: every member carries
   * the same rotation, so the step re-stamps on all of them and the wall keeps reading as one page.
   */
  async setWallPlaylistEntryZoom(
    wallId: string,
    sourceId: string,
    zoom: number,
  ): Promise<SetPlaylistEntryZoomResult> {
    const wall = this.videoWalls.get(wallId);
    if (wall === undefined) return { ok: false, error: "unknown-wall" };

    const slices: ScreenSlice[] = [];
    let matchedAny = false;
    for (const screenId of wall.memberScreenIds) {
      const slice = this.state.slices[screenId];
      const found = this.playlistSurfaceOf(slice);
      if (!found.ok) {
        if (found.error === "not-zoomable") return { ok: false, error: "not-zoomable" };
        continue;
      }
      const patched = ControlPlane.withEntryZoom(slice!, found.surface, sourceId, zoom);
      if (!patched.matched) continue;
      matchedAny = true;
      this.state.slices[screenId] = patched.slice;
      slices.push(patched.slice);
    }
    if (slices.length === 0) return { ok: false, error: matchedAny ? "no-content" : "unknown-entry" };

    this.bumpRevision();
    await this.rememberZoom(wallId, this.sourceKeyFor(sourceId, ""), zoom);
    for (const slice of slices) {
      await this.store.upsertContent({
        screenId: slice.screenId,
        canvas: slice.canvas,
        surfaces: slice.surfaces,
        sourceId: this.wallSourceIds.get(wallId) ?? null,
      });
    }
    await this.store.setRevision(this.state.revision);

    const stepName = this.contentSources.get(sourceId)?.name ?? sourceId;
    this.emit("good", `${wall.name ?? wall.id} · ${stepName} zoom ${zoomLabel(zoom)}`);
    return { ok: true, slices };
  }

  /**
   * Set the page zoom on a single screen's framed content. Zoom changes the surface and nothing else,
   * so we patch the EXISTING surface rather than re-resolve it: the keyed id is untouched, the player
   * restyles the same iframe in place, and the page never reloads (D5). Rejected if the screen is a
   * wall member (zoom belongs to the combined surface), shows nothing, or shows media.
   *
   * Bumps the revision, persists the slice, and remembers the zoom against (screen, page).
   */
  async setScreenZoom(screenId: string, zoom: number): Promise<SetZoomResult> {
    const screen = this.getScreen(screenId);
    if (screen === undefined) return { ok: false, error: "unknown-screen" };

    const wall = this.getWallForScreen(screenId);
    if (wall) return { ok: false, error: "wall-member", wallId: wall.id };

    const slice = this.state.slices[screenId];
    const surface = slice?.surfaces[0];
    if (slice === undefined || surface === undefined) return { ok: false, error: "no-content" };
    if (!isFramed(surface)) return { ok: false, error: "not-zoomable" };

    // Zoom the screen's content surface (the first one); anything else on the slice rides along
    // untouched. Assigned content is always a single surface, but the slice shape allows more.
    const next: ScreenSlice = withZoomedFirstSurface(slice, surface, zoom);
    this.state.slices[screenId] = next;
    this.bumpRevision();

    await this.rememberZoom(screenId, this.sourceKeyFor(this.screenSourceIds.get(screenId) ?? null, surface.url), zoom);
    await this.store.upsertContent({
      screenId,
      canvas: next.canvas,
      surfaces: next.surfaces,
      sourceId: this.screenSourceIds.get(screenId) ?? null,
    });
    await this.store.setRevision(this.state.revision);

    this.emit("good", `${screen.friendlyName} zoom ${zoomLabel(zoom)}`);
    return { ok: true, slices: [next] };
  }

  /**
   * Set the page zoom on a combined surface: every member frames the same page, so they all take the
   * same zoom. The span math is untouched — zoom scales the page INSIDE each member's window onto the
   * spanning content, so the wall still reads as one continuous, larger page.
   */
  async setWallZoom(wallId: string, zoom: number): Promise<SetZoomResult> {
    const wall = this.videoWalls.get(wallId);
    if (wall === undefined) return { ok: false, error: "unknown-wall" };

    const slices: ScreenSlice[] = [];
    let sourceKey: string | undefined;
    for (const screenId of wall.memberScreenIds) {
      const slice = this.state.slices[screenId];
      const surface = slice?.surfaces[0];
      if (slice === undefined || surface === undefined) continue;
      if (!isFramed(surface)) return { ok: false, error: "not-zoomable" };
      sourceKey ??= this.sourceKeyFor(this.wallSourceIds.get(wallId) ?? null, surface.url);
      const next: ScreenSlice = withZoomedFirstSurface(slice, surface, zoom);
      this.state.slices[screenId] = next;
      slices.push(next);
    }
    if (slices.length === 0 || sourceKey === undefined) return { ok: false, error: "no-content" };

    this.bumpRevision();
    await this.rememberZoom(wallId, sourceKey, zoom);
    for (const slice of slices) {
      await this.store.upsertContent({
        screenId: slice.screenId,
        canvas: slice.canvas,
        surfaces: slice.surfaces,
        sourceId: this.wallSourceIds.get(wallId) ?? null,
      });
    }
    await this.store.setRevision(this.state.revision);

    this.emit("good", `${wall.name ?? wall.id} zoom ${zoomLabel(zoom)}`);
    return { ok: true, slices };
  }

  /**
   * Resolve a library source to its renderable spec. A playlist (POL-34) resolves each authored item
   * to a concrete entry AT THIS MOMENT — an item whose source was deleted (or somehow became another
   * playlist) is skipped, and a timed kind that lost its duration to authoring-time drift falls back
   * to the default hold — and stamps the rotation anchor once, shared by every surface built from it.
   */
  private specFor(source: ContentSource): ResolvedSpec {
    if (source.kind === "page") {
      // A malformed row that lost its definition resolves to an EMPTY page rather than crashing.
      return {
        kind: "page",
        definition: source.definition ?? { aspect: "16:9", bg: "#0b0b0e", elements: [] },
      };
    }
    if (source.kind !== "playlist") return { kind: source.kind, url: source.url ?? "" };
    const entries: PlaylistEntry[] = [];
    for (const item of source.items ?? []) {
      const step = this.contentSources.get(item.sourceId);
      if (!step || step.kind === "playlist" || step.kind === "page" || !step.url) continue;
      entries.push({
        kind: step.kind,
        url: step.url,
        ...(item.durationSeconds !== undefined
          ? { durationSeconds: item.durationSeconds }
          : step.kind !== "video"
            ? { durationSeconds: DEFAULT_PLAYLIST_ITEM_SECONDS }
            : {}),
        sourceId: step.id,
        // POL-133 — target-agnostic default; specForTarget stamps the remembered per-step zoom in.
        zoom: DEFAULT_ZOOM,
      });
    }
    return { kind: "playlist", url: "", entries, startedAt: new Date().toISOString() };
  }

  /**
   * Resolve a content assignment to a concrete spec + the sourceId to record (null for ad-hoc). An
   * ad-hoc `url` becomes a web spec (exactly the Phase 3b behaviour); a `sourceId` is looked up in the
   * library and resolved to its kind+url — or, for a playlist, its entries (error if unknown).
   */
  private resolveSpec(
    a: ContentAssignment,
  ): { spec: ResolvedSpec; sourceId: string | null } | { error: "unknown-source" } {
    if (a.url !== undefined) {
      return { spec: { kind: "web", url: a.url }, sourceId: null };
    }
    const source = a.sourceId !== undefined ? this.contentSources.get(a.sourceId) : undefined;
    if (!source) return { error: "unknown-source" };
    return { spec: this.specFor(source), sourceId: source.id };
  }

  /** Record (or clear) the library source a screen currently shows. */
  private setScreenSourceAssignment(screenId: string, sourceId: string | null): void {
    if (sourceId) this.screenSourceIds.set(screenId, sourceId);
    else this.screenSourceIds.delete(screenId);
  }

  /** Record (or clear) the library source a wall currently spans, writing the wall row through. */
  private async setWallSourceAssignment(wall: VideoWall, sourceId: string | null): Promise<void> {
    if (sourceId) this.wallSourceIds.set(wall.id, sourceId);
    else this.wallSourceIds.delete(wall.id);
    await this.store.upsertVideoWall({
      id: wall.id,
      muralId: wall.muralId,
      memberScreenIds: wall.memberScreenIds,
      // Carry the wall's name through so a content change never wipes it from the row.
      name: wall.name ?? null,
      contentSourceId: sourceId,
    });
  }

  /**
   * Recompute every member's span slice for a wall showing `spec` and apply it in memory. Reuses the
   * Phase 3b union-bbox span math (works for ANY surface kind). Returns the touched member slices (empty
   * if none of the wall's members are still placed on its mural). Does NOT bump/persist — the caller does.
   *
   * POL-57: `zoom` is the wall's remembered zoom for this page, applied uniformly to every member.
   */
  private computeWallSlices(wall: VideoWall, spec: ResolvedSpec, zoom = DEFAULT_ZOOM): ScreenSlice[] {
    const members: { screenId: string; placement: Placement }[] = [];
    for (const screenId of wall.memberScreenIds) {
      const placement = this.placements.get(screenId);
      if (placement && placement.muralId === wall.muralId) members.push({ screenId, placement });
    }
    if (members.length === 0) return [];

    // Union bounding box of the member placements (canvas pixels).
    let unionMinX = Infinity;
    let unionMinY = Infinity;
    let unionMaxX = -Infinity;
    let unionMaxY = -Infinity;
    for (const { placement } of members) {
      unionMinX = Math.min(unionMinX, placement.x);
      unionMinY = Math.min(unionMinY, placement.y);
      unionMaxX = Math.max(unionMaxX, placement.x + placement.w);
      unionMaxY = Math.max(unionMaxY, placement.y + placement.h);
    }
    const contentW = unionMaxX - unionMinX;
    const contentH = unionMaxY - unionMinY;

    const slices: ScreenSlice[] = [];
    for (const { screenId, placement } of members) {
      const slice = this.state.slices[screenId];
      if (slice === undefined) continue;
      const surface = this.buildSurface(
        spec,
        // Stable per-wall id: consecutive content pushes reconcile to the SAME keyed surface, so the
        // player mutates the existing element in place (no remount) — INSTANT (D5).
        `wall:${wall.id}`,
        { x: 0, y: 0, w: placement.w, h: placement.h },
        {
          contentW,
          contentH,
          offsetX: placement.x - unionMinX,
          offsetY: placement.y - unionMinY,
        },
        zoom,
      );
      const next: ScreenSlice = { ...slice, surfaces: [surface] };
      this.state.slices[screenId] = next;
      slices.push(next);
    }
    return slices;
  }

  /**
   * Combine ≥2 placed screens on a mural into a new video wall. Validates: the mural exists, each
   * member exists, is placed on THAT mural, and is not already a member of another wall. On success
   * creates the wall (server-assigned id), clears each member's slice (the wall now owns them; content
   * is assigned separately), bumps the revision, and writes through. Returns the new wall + the cleared
   * member slices (the caller pushes a `server/render` to each member). Returns an error result the
   * REST layer maps to a status code otherwise.
   */
  async combineScreens(
    muralId: string,
    memberScreenIds: string[],
    name?: string,
  ): Promise<CombineScreensResult> {
    if (!this.murals.has(muralId)) return { ok: false, error: "unknown-mural" };

    // Dedupe while preserving order; a wall needs ≥2 DISTINCT members.
    const ids = [...new Set(memberScreenIds)];
    if (ids.length < 2) return { ok: false, error: "too-few" };

    for (const screenId of ids) {
      if (!this.getScreen(screenId)) {
        return { ok: false, error: "unknown-screen", screenId };
      }
      const placement = this.placements.get(screenId);
      if (!placement) return { ok: false, error: "not-placed", screenId };
      if (placement.muralId !== muralId) return { ok: false, error: "wrong-mural", screenId };
      const existing = this.getWallForScreen(screenId);
      if (existing) {
        return { ok: false, error: "already-combined", screenId, wallId: existing.id };
      }
    }

    const id = this.nextWallId();
    // Name the wall: use the operator-provided name (trimmed), else derive a default from the members'
    // friendly names joined " + " (e.g. "Screen 1 + Screen 2"), capped to the contract's 80 chars.
    const wallName = this.resolveWallName(name, ids);
    const wall = VideoWall.parse({ id, muralId, memberScreenIds: ids, name: wallName });
    this.videoWalls.set(id, wall);
    await this.store.upsertVideoWall({
      id: wall.id,
      muralId: wall.muralId,
      memberScreenIds: wall.memberScreenIds,
      name: wall.name ?? null,
    });

    // Combining clears the members' previous (single-screen) content — render change → bump + push.
    const slices = this.clearSlices(ids);
    this.bumpRevision();
    for (const slice of slices) {
      await this.store.upsertContent({
        screenId: slice.screenId,
        canvas: slice.canvas,
        surfaces: slice.surfaces,
      });
    }
    await this.store.setRevision(this.state.revision);

    this.emit("good", `Combined ${ids.length} panels into ${wall.name ?? id}`);
    return { ok: true, wall, slices };
  }

  /**
   * Resolve a video wall's display name. A provided name is trimmed and capped to 80 chars; an absent
   * or blank name falls back to a default derived from the members' friendly names joined " + "
   * (e.g. "Screen 1 + Screen 2"), also capped to 80. Always returns a non-empty string (≥2 members).
   */
  private resolveWallName(name: string | undefined, memberScreenIds: string[]): string {
    const provided = name?.trim();
    if (provided) return provided.slice(0, 80);
    const derived = memberScreenIds
      .map((id) => this.getScreen(id)?.friendlyName ?? id)
      .join(" + ");
    return derived.slice(0, 80);
  }

  /**
   * Rename a combined surface (video wall). Updates the in-memory wall + writes the row through, then
   * returns the updated wall. Returns null if the wall is unknown. The name is trimmed and capped to
   * the contract's 80 chars. No render change (the wall's content is unaffected) — the REST layer just
   * re-broadcasts admin/state so the console's label updates.
   */
  async renameVideoWall(wallId: string, name: string): Promise<VideoWall | null> {
    const wall = this.videoWalls.get(wallId);
    if (wall === undefined) return null;

    const previousName = wall.name ?? wall.id;
    const next: VideoWall = { ...wall, name: name.trim().slice(0, 80) };
    this.videoWalls.set(wallId, next);
    await this.store.upsertVideoWall({
      id: next.id,
      muralId: next.muralId,
      memberScreenIds: next.memberScreenIds,
      name: next.name ?? null,
      // Preserve the wall's current library-source assignment so the rename doesn't clear it.
      contentSourceId: this.wallSourceIds.get(wallId) ?? null,
    });
    if (previousName !== next.name) this.emit("info", `${previousName} renamed`);
    return next;
  }

  /**
   * Split a video wall back into individual screens: delete the wall and clear its members' slices
   * (render change → bump + push). Write-through. Returns the (now removed) wall + the cleared member
   * slices, or null if the wall is unknown.
   */
  async splitWall(wallId: string): Promise<{ wall: VideoWall; slices: ScreenSlice[] } | null> {
    const wall = this.videoWalls.get(wallId);
    if (wall === undefined) return null;

    this.videoWalls.delete(wallId);
    this.wallSourceIds.delete(wallId);
    await this.store.deleteVideoWall(wallId);
    await this.forgetZooms(wallId);

    const slices = this.clearSlices(wall.memberScreenIds);
    this.bumpRevision();
    for (const slice of slices) {
      await this.store.upsertContent({
        screenId: slice.screenId,
        canvas: slice.canvas,
        surfaces: slice.surfaces,
      });
    }
    await this.store.setRevision(this.state.revision);

    this.emit("info", `Split ${wall.name ?? wall.id}`);
    return { wall, slices };
  }

  /**
   * Assign content (a web URL) to a video wall so it SPANS across the members. Computes the union
   * bounding box of the members' placements (canvas px) and gives EACH member one web surface whose
   * region is its full screen and whose `span` slices the contentW×contentH content at the member's
   * offset — see THE SPAN MATH. The surface id is stable per wall so a content change patches the
   * player's existing iframe in place (the INSTANT property, D5). Bumps the revision and writes
   * through. Returns the per-member slices (the caller pushes a `server/render` to each), or an error
   * if the wall is unknown / none of its members are placed.
   */
  async setWallContent(wallId: string, a: ContentAssignment): Promise<SetWallContentResult> {
    const wall = this.videoWalls.get(wallId);
    if (wall === undefined) return { ok: false, error: "unknown-wall" };

    const resolved = this.resolveSpec(a);
    if ("error" in resolved) return { ok: false, error: resolved.error };

    // POL-57 — restore the zoom this wall last used FOR THIS PAGE (100% if it never has).
    const zoom = this.zoomFor(wallId, this.sourceKeyFor(resolved.sourceId, specUrl(resolved.spec)));

    // Recompute each member's span slice (union-bbox math, any surface kind — Phase 3b + 3c).
    // POL-133 — a playlist's framed steps pick up this wall's remembered per-step zooms.
    const slices = this.computeWallSlices(wall, this.specForTarget(wallId, resolved.spec), zoom);
    if (slices.length === 0) return { ok: false, error: "no-placements" };

    // Record which library source (if any) this wall now spans, persisting the wall row.
    await this.setWallSourceAssignment(wall, resolved.sourceId);

    this.bumpRevision();
    for (const slice of slices) {
      await this.store.upsertContent({
        screenId: slice.screenId,
        canvas: slice.canvas,
        surfaces: slice.surfaces,
        sourceId: resolved.sourceId,
      });
    }
    await this.store.setRevision(this.state.revision);

    this.emit(
      "good",
      `${wall.name ?? wall.id} → ${this.resolvedContentName(resolved.spec, resolved.sourceId)}`,
    );
    return { ok: true, slices };
  }

  /**
   * Assign content (a web URL) to a SINGLE screen: one full-canvas web surface, NO span. Rejected if
   * the screen is a member of a video wall (combined screens take their content from the wall). The
   * surface id is stable so repeated assignments patch the player's iframe in place (INSTANT, D5).
   * Bumps the revision and writes through. Returns the new slice, or an error result.
   */
  async setScreenContent(screenId: string, a: ContentAssignment): Promise<SetScreenContentResult> {
    const screen = this.getScreen(screenId);
    if (screen === undefined) return { ok: false, error: "unknown-screen" };

    const wall = this.getWallForScreen(screenId);
    if (wall) return { ok: false, error: "wall-member", wallId: wall.id };

    const slice = this.state.slices[screenId];
    if (slice === undefined) return { ok: false, error: "unknown-screen" };

    const resolved = this.resolveSpec(a);
    if ("error" in resolved) return { ok: false, error: resolved.error };

    // POL-57 — restore the zoom this screen last used FOR THIS PAGE (100% if it never has), so the
    // operator dials a dashboard in once per screen and it comes back that way every time.
    const zoom = this.zoomFor(screenId, this.sourceKeyFor(resolved.sourceId, specUrl(resolved.spec)));

    // Stable surface id ("content-web") so repeated assignments patch the player's tile in place (D5).
    // POL-133 — a playlist's framed steps pick up this screen's remembered per-step zooms.
    const surface = this.buildSurface(
      this.specForTarget(screenId, resolved.spec),
      "content-web",
      { x: 0, y: 0, w: slice.canvas.w, h: slice.canvas.h },
      undefined,
      zoom,
    );
    const next: ScreenSlice = { ...slice, surfaces: [surface] };
    this.state.slices[screenId] = next;
    this.setScreenSourceAssignment(screenId, resolved.sourceId);
    this.bumpRevision();

    await this.store.upsertContent({
      screenId,
      canvas: next.canvas,
      surfaces: next.surfaces,
      sourceId: resolved.sourceId,
    });
    await this.store.setRevision(this.state.revision);

    this.emit(
      "good",
      `${screen.friendlyName} → ${this.resolvedContentName(resolved.spec, resolved.sourceId)}`,
    );
    return { ok: true, slice: next };
  }

  // ── Content library (Phase 3c) ──────────────────────────────────────────────
  //
  // A ContentSource is a reusable, named library entry ({id, name, kind, url}). Screens/walls are
  // assigned a source by id and the server resolves it to the surface(s) it renders. The library CRUD
  // is registry metadata — creating/renaming a source does not by itself change any render — EXCEPT
  // that editing or deleting an IN-USE source re-resolves (or clears) every screen/wall showing it and
  // returns those slices for the caller to push.

  getContentSources(): ContentSource[] {
    return [...this.contentSources.values()];
  }

  getContentSource(id: string): ContentSource | undefined {
    return this.contentSources.get(id);
  }

  private nextSourceId(): string {
    this.sourceCounter += 1;
    return `source-${this.sourceCounter}`;
  }

  /** Project a library source onto its storage DTO (contract absences → storage NULLs). */
  private toPersistedSource(source: ContentSource) {
    return {
      id: source.id,
      name: source.name,
      kind: source.kind,
      url: source.url ?? null,
      credentialProfileId: source.credentialProfileId ?? null,
      items: source.items ?? null,
      definition: source.definition ?? null,
    };
  }

  /**
   * Authoring-time validation of a playlist's items (POL-34): every step must reference an EXISTING,
   * NON-PLAYLIST source (playlists cannot nest — the player would otherwise need a rotation stack and
   * the console a cycle detector, for no operator value), and any step whose content never ends by
   * itself (everything but video) must say how long it holds the screen.
   */
  private validatePlaylistItems(
    items: PlaylistItem[],
  ):
    | { ok: true }
    | {
        ok: false;
        error: "unknown-item-source" | "nested-playlist" | "item-needs-duration";
        itemSourceId: string;
      } {
    for (const item of items) {
      const step = this.contentSources.get(item.sourceId);
      if (!step) return { ok: false, error: "unknown-item-source", itemSourceId: item.sourceId };
      if (step.kind === "playlist")
        return { ok: false, error: "nested-playlist", itemSourceId: item.sourceId };
      if (step.kind !== "video" && item.durationSeconds === undefined)
        return { ok: false, error: "item-needs-duration", itemSourceId: item.sourceId };
    }
    return { ok: true };
  }

  /** Create a new library source with a server-assigned id. Write-through. Rejects a reference to a
   *  credential profile that doesn't exist (POL-24) and invalid playlist items (POL-34). */
  async createContentSource(
    body: CreateContentSourceBody,
  ): Promise<
    | { ok: true; source: ContentSource }
    | {
        ok: false;
        error: "unknown-profile" | "unknown-item-source" | "nested-playlist" | "item-needs-duration";
        itemSourceId?: string;
      }
  > {
    const credentialProfileId = body.credentialProfileId ?? null;
    if (credentialProfileId && !this.credentialProfiles.has(credentialProfileId)) {
      return { ok: false, error: "unknown-profile" };
    }
    if (body.kind === "playlist") {
      const valid = this.validatePlaylistItems(body.items ?? []);
      if (!valid.ok) return { ok: false, error: valid.error, itemSourceId: valid.itemSourceId };
    }
    const id = this.nextSourceId();
    const source = ContentSource.parse({
      id,
      name: body.name,
      kind: body.kind,
      url: body.url,
      credentialProfileId,
      items: body.items,
      definition: body.definition,
    });
    this.contentSources.set(id, source);
    await this.store.upsertContentSource(this.toPersistedSource(source));
    return { ok: true, source };
  }

  /**
   * Re-resolve every screen + wall currently ASSIGNED a source and apply the fresh surfaces in memory,
   * returning the touched slices (the caller bumps + persists). The zoom is remembered against the
   * SOURCE ID, not its URL, so re-pointing a source at a new URL keeps each target's dialled-in zoom.
   */
  private reresolveAssignments(sourceId: string): ScreenSlice[] {
    const source = this.contentSources.get(sourceId);
    if (!source) return [];
    const spec = this.specFor(source);
    const sourceKey = this.sourceKeyFor(sourceId, specUrl(spec));
    const byScreen = new Map<string, ScreenSlice>();

    for (const [screenId, sid] of this.screenSourceIds) {
      if (sid !== sourceId) continue;
      const slice = this.state.slices[screenId];
      if (slice === undefined) continue;
      const surface = this.buildSurface(
        this.specForTarget(screenId, spec),
        "content-web",
        { x: 0, y: 0, w: slice.canvas.w, h: slice.canvas.h },
        undefined,
        this.zoomFor(screenId, sourceKey),
      );
      const next: ScreenSlice = { ...slice, surfaces: [surface] };
      this.state.slices[screenId] = next;
      byScreen.set(screenId, next);
    }

    for (const [wallId, sid] of this.wallSourceIds) {
      if (sid !== sourceId) continue;
      const wall = this.videoWalls.get(wallId);
      if (wall === undefined) continue;
      const zoom = this.zoomFor(wallId, sourceKey);
      for (const next of this.computeWallSlices(wall, this.specForTarget(wallId, spec), zoom))
        byScreen.set(next.screenId, next);
    }

    return [...byScreen.values()];
  }

  /**
   * Update a library source (any subset of name/kind/url/credentialProfileId/items — null DETACHES
   * the profile; `items` replaces a playlist's whole carousel). Kind/url/items consistency is
   * validated against the MERGED source. If the source is currently assigned to any screen(s) or
   * wall(s) — or referenced by a PLAYLIST that is (POL-34) — each is RE-RESOLVED and the touched
   * slices are returned (one revision bump, write-through) for the caller to push live.
   */
  async updateContentSource(
    id: string,
    patch: UpdateContentSourceBody,
  ): Promise<
    | { ok: true; source: ContentSource; slices: ScreenSlice[] }
    | {
        ok: false;
        error:
          | "unknown-source"
          | "unknown-profile"
          | "invalid-source"
          | "invalid-shape"
          | "unknown-item-source"
          | "nested-playlist"
          | "item-needs-duration";
        itemSourceId?: string;
      }
  > {
    const existing = this.contentSources.get(id);
    if (existing === undefined) return { ok: false, error: "unknown-source" };

    const credentialProfileId =
      patch.credentialProfileId !== undefined
        ? patch.credentialProfileId
        : (existing.credentialProfileId ?? null);
    if (credentialProfileId && !this.credentialProfiles.has(credentialProfileId)) {
      return { ok: false, error: "unknown-profile" };
    }

    const kind = patch.kind ?? existing.kind;
    const items = kind === "playlist" ? (patch.items ?? existing.items ?? []) : undefined;
    if (kind === "playlist") {
      const valid = this.validatePlaylistItems(items ?? []);
      if (!valid.ok) return { ok: false, error: valid.error, itemSourceId: valid.itemSourceId };
    }
    // POL-42 — a partial patch must not produce a source the resolver can't render: a page needs
    // its definition, everything else (bar a playlist) needs a url.
    const definition = kind === "page" ? (patch.definition ?? existing.definition) : undefined;
    const nextUrl =
      kind === "playlist" || kind === "page" ? undefined : (patch.url ?? existing.url ?? undefined);
    if (kind === "page" ? definition === undefined : kind !== "playlist" && nextUrl === undefined) {
      return { ok: false, error: "invalid-shape" };
    }

    const merged = ContentSource.safeParse({
      id: existing.id,
      name: patch.name ?? existing.name,
      kind,
      // A kind change across the playlist/page boundary sheds the field the new kind cannot carry.
      url: nextUrl,
      credentialProfileId,
      items,
      definition,
    });
    if (!merged.success) return { ok: false, error: "invalid-source" };
    const source = merged.data;
    this.contentSources.set(id, source);
    await this.store.upsertContentSource(this.toPersistedSource(source));

    // Re-resolve the source's own assignments, then (POL-34) every playlist that references it — a
    // playlist shows this source's CONTENT, so its targets are just as stale as direct ones.
    const groups: { sourceId: string; slices: ScreenSlice[] }[] = [
      { sourceId: id, slices: this.reresolveAssignments(id) },
    ];
    for (const pl of this.contentSources.values()) {
      if (pl.kind !== "playlist" || pl.id === id) continue;
      if (!(pl.items ?? []).some((i) => i.sourceId === id)) continue;
      groups.push({ sourceId: pl.id, slices: this.reresolveAssignments(pl.id) });
    }

    // Assignments are exclusive (a screen shows one source; wall members carry no direct assignment),
    // so the groups never overlap and a flat concat cannot double-push a screen.
    const slices = groups.flatMap((g) => g.slices);
    if (slices.length > 0) {
      this.bumpRevision();
      for (const g of groups) {
        for (const slice of g.slices) {
          await this.store.upsertContent({
            screenId: slice.screenId,
            canvas: slice.canvas,
            surfaces: slice.surfaces,
            sourceId: g.sourceId,
          });
        }
      }
      await this.store.setRevision(this.state.revision);
    }

    // POL-42 — pages EMBEDDING this source resolve it at send time, so their stored slices are
    // already correct; they just need a re-push so live walls pick the edit up. Never upserted here
    // (their screens' source assignment is the PAGE's id, not the edited source's).
    const seen = new Set(slices.map((s) => s.screenId));
    const pageSlices = this.slicesShowingPagesEmbedding(id).filter((s) => !seen.has(s.screenId));

    return { ok: true, source, slices: [...slices, ...pageSlices] };
  }

  /** POL-42 — the slices of every screen currently showing a PAGE whose definition embeds (or draws
   *  an image from) source `id`. These re-push on that source's edit/delete: the page's stored slice
   *  is untouched (resolution is send-time), but the wall must repaint with the new resolution. */
  private slicesShowingPagesEmbedding(id: string): ScreenSlice[] {
    const pageIds = new Set<string>();
    for (const source of this.contentSources.values()) {
      if (source.kind !== "page" || !source.definition) continue;
      const embeds = source.definition.elements.some(
        (el) => (el.kind === "embed" || el.kind === "image") && el.props.sourceId === id,
      );
      if (embeds) pageIds.add(source.id);
    }
    if (pageIds.size === 0) return [];
    return this.slicesShowingSources(pageIds);
  }

  /** The slices of every screen showing any of these library sources, directly or via a video wall. */
  slicesShowingSources(sourceIds: ReadonlySet<string>): ScreenSlice[] {
    const byScreen = new Map<string, ScreenSlice>();
    for (const [screenId, sid] of this.screenSourceIds) {
      if (!sourceIds.has(sid)) continue;
      const slice = this.state.slices[screenId];
      if (slice) byScreen.set(screenId, slice);
    }
    for (const [wallId, sid] of this.wallSourceIds) {
      if (!sourceIds.has(sid)) continue;
      const wall = this.videoWalls.get(wallId);
      for (const screenId of wall?.memberScreenIds ?? []) {
        const slice = this.state.slices[screenId];
        if (slice) byScreen.set(screenId, slice);
      }
    }
    return [...byScreen.values()];
  }

  /** POL-42 — what the poller needs to keep fresh: the feed URLs and weather locations used by pages
   *  currently assigned to ≥1 screen (directly or via a wall). Unassigned pages cost no polling. */
  pageDataRequirements(): { feeds: Set<string>; locations: Set<string>; sourcesByFeed: Map<string, Set<string>>; sourcesByLocation: Map<string, Set<string>> } {
    const assigned = new Set<string>([...this.screenSourceIds.values(), ...this.wallSourceIds.values()]);
    const feeds = new Set<string>();
    const locations = new Set<string>();
    const sourcesByFeed = new Map<string, Set<string>>();
    const sourcesByLocation = new Map<string, Set<string>>();
    for (const source of this.contentSources.values()) {
      if (source.kind !== "page" || !source.definition || !assigned.has(source.id)) continue;
      for (const el of source.definition.elements) {
        if (el.kind === "feed" && el.props.url.trim()) {
          const url = el.props.url.trim();
          feeds.add(url);
          (sourcesByFeed.get(url) ?? sourcesByFeed.set(url, new Set()).get(url)!).add(source.id);
        } else if (el.kind === "weather" && el.props.location.trim()) {
          const location = el.props.location.trim();
          locations.add(location);
          (sourcesByLocation.get(location) ?? sourcesByLocation.set(location, new Set()).get(location)!).add(source.id);
        }
      }
    }
    return { feeds, locations, sourcesByFeed, sourcesByLocation };
  }

  /**
   * Delete a library source. Any screen(s)/wall(s) currently showing it have their content CLEARED
   * (empty slices — the assignment is gone), and those cleared slices are returned (one revision bump,
   * write-through) for the caller to push. A cleared wall keeps its combined structure but spans no
   * content until reassigned. POL-34: the source is also STRIPPED out of every playlist that
   * references it, and targets showing those playlists re-resolve to the shortened rotation (a
   * playlist emptied this way keeps its library slot but renders nothing until refilled). Returns
   * null if the source is unknown.
   */
  async deleteContentSource(id: string): Promise<{ slices: ScreenSlice[] } | null> {
    if (!this.contentSources.has(id)) return null;

    const byScreen = new Map<string, ScreenSlice>();

    // Screens directly assigned this source → clear their slice (also drops the assignment).
    const screenIds = [...this.screenSourceIds.entries()]
      .filter(([, sid]) => sid === id)
      .map(([screenId]) => screenId);
    for (const next of this.clearSlices(screenIds)) byScreen.set(next.screenId, next);

    // Walls spanning this source → clear every member's slice and drop the wall's assignment.
    const wallIds = [...this.wallSourceIds.entries()]
      .filter(([, sid]) => sid === id)
      .map(([wallId]) => wallId);
    for (const wallId of wallIds) {
      const wall = this.videoWalls.get(wallId);
      if (wall === undefined) {
        this.wallSourceIds.delete(wallId);
        continue;
      }
      for (const next of this.clearSlices(wall.memberScreenIds)) byScreen.set(next.screenId, next);
      await this.setWallSourceAssignment(wall, null);
    }

    this.contentSources.delete(id);
    await this.store.deleteContentSource(id);

    // POL-34 — strip the deleted source out of every playlist referencing it (persisting the
    // shortened carousel), then re-resolve any screen/wall showing that playlist so no rotation keeps
    // cycling through dead content. These slices carry the PLAYLIST as their assignment.
    const retargeted: { sourceId: string; slices: ScreenSlice[] }[] = [];
    for (const pl of this.contentSources.values()) {
      if (pl.kind !== "playlist") continue;
      const items = pl.items ?? [];
      const kept = items.filter((i) => i.sourceId !== id);
      if (kept.length === items.length) continue;
      pl.items = kept;
      await this.store.upsertContentSource(this.toPersistedSource(pl));
      retargeted.push({ sourceId: pl.id, slices: this.reresolveAssignments(pl.id) });
    }

    const slices = [...byScreen.values(), ...retargeted.flatMap((g) => g.slices)];
    if (slices.length > 0) {
      this.bumpRevision();
      for (const slice of byScreen.values()) {
        await this.store.upsertContent({
          screenId: slice.screenId,
          canvas: slice.canvas,
          surfaces: slice.surfaces,
          sourceId: null,
        });
      }
      for (const g of retargeted) {
        for (const slice of g.slices) {
          await this.store.upsertContent({
            screenId: slice.screenId,
            canvas: slice.canvas,
            surfaces: slice.surfaces,
            sourceId: g.sourceId,
          });
        }
      }
      await this.store.setRevision(this.state.revision);
    }

    // POL-42 — pages embedding the deleted source re-push so their embed regions fall back to the
    // placeholder (send-time resolution now finds nothing). Their stored slices are untouched.
    const seen = new Set(slices.map((sl) => sl.screenId));
    const pageSlices = this.slicesShowingPagesEmbedding(id).filter((sl) => !seen.has(sl.screenId));

    return { slices: [...slices, ...pageSlices] };
  }

  // ── Credential profiles (POL-24) ─────────────────────────────────────────────
  //
  // A credential profile is a centrally-held OAuth client (Bucket-A content auth, D11/D17): the
  // server exchanges it for short-lived JWT tokens (TokenService) and STAMPS the current token into
  // a referencing source's URL at send time — `decorateSliceForSend`, called at the two
  // `server/render` sites. Stored slices and the DB always keep the CLEAN url (same pattern as
  // `friendlyName`, POL-29), so a reconnecting/cold-booting screen always loads with a live token
  // and a routine token refresh never rewrites (= reloads) a live iframe.

  /** Wire the token cache after construction (the TokenService is seeded from these profiles). */
  /** POL-54 — wire the player-token minter after construction (same pattern as setTokenProvider). */
  setPlayerTokenMinter(minter: PlayerTokenMinter): void {
    this.playerTokenMinter = minter;
  }

  /** POL-119 — the current `server/apply` assignments for ONE machine, from the screen registry.
   *  Re-pushed live when a cast toggle or a rename changes what the box's receiver should be doing,
   *  so the agent reconciles NOW instead of on its next reconnect. Same revision: neither mutation
   *  is render data. */
  assignmentsFor(machineId: string): ScreenAssignment[] {
    return this.state.screens
      .filter((s) => s.machineId === machineId)
      .map((s) => ({
        connector: s.connector,
        screenId: s.id,
        playerUrl: this.playerUrlFor(s.id),
        castEnabled: s.castEnabled,
        friendlyName: s.friendlyName,
      }));
  }

  /** The URL an agent points one output's browser at: base + `?screen=<id>` + the screen's bearer
   *  token (POL-54) when a minter is wired. The token is what lets the /player WS trust the hello. */
  private playerUrlFor(screenId: string): string {
    const base = `${PLAYER_BASE_URL}/?screen=${encodeURIComponent(screenId)}`;
    const token = this.playerTokenMinter?.(screenId);
    return token ? `${base}&token=${encodeURIComponent(token)}` : base;
  }

  setTokenProvider(provider: Pick<TokenService, "getToken" | "statusFor">): void {
    this.tokenProvider = provider;
  }

  /** FULL rows incl. the client secret — for seeding the TokenService only. Never leaves process. */
  getCredentialProfilesInternal(): PersistedCredentialProfile[] {
    return [...this.credentialProfiles.values()];
  }

  /** One FULL row incl. the secret — for the TokenService on create/update. */
  getCredentialProfileInternal(id: string): PersistedCredentialProfile | undefined {
    return this.credentialProfiles.get(id);
  }

  /** How many library sources reference a profile (drives the delete guard + console copy). */
  private profileInUseCount(id: string): number {
    let count = 0;
    for (const source of this.contentSources.values()) {
      if (source.credentialProfileId === id) count += 1;
    }
    return count;
  }

  /** The outward-facing views: profile config + live token health, NEVER the client secret. */
  getCredentialProfileViews(): CredentialProfileView[] {
    return [...this.credentialProfiles.values()].map((p) => {
      const status = this.tokenProvider?.statusFor(p.id) ?? { tokenStatus: "pending" as const };
      return {
        id: p.id,
        name: p.name,
        strategy: "oauth-client-credentials" as const,
        tokenEndpoint: p.tokenEndpoint,
        clientId: p.clientId,
        ...(p.scope ? { scope: p.scope } : {}),
        ...(p.audience ? { audience: p.audience } : {}),
        tokenParam: p.tokenParam,
        tokenStatus: status.tokenStatus,
        ...(status.tokenExpiresAt ? { tokenExpiresAt: status.tokenExpiresAt } : {}),
        ...(status.lastError ? { lastError: status.lastError } : {}),
        inUseBy: this.profileInUseCount(p.id),
      };
    });
  }

  private nextCredentialId(): string {
    this.credentialCounter += 1;
    return `credential-${this.credentialCounter}`;
  }

  /** Create a profile with a server-assigned id. Write-through. The caller seeds the TokenService. */
  async createCredentialProfile(body: CreateCredentialProfileBody): Promise<PersistedCredentialProfile> {
    const profile: PersistedCredentialProfile = {
      id: this.nextCredentialId(),
      name: body.name,
      strategy: "oauth-client-credentials",
      tokenEndpoint: body.tokenEndpoint,
      clientId: body.clientId,
      clientSecret: body.clientSecret,
      scope: body.scope ?? null,
      audience: body.audience ?? null,
      tokenParam: body.tokenParam ?? "auth_token",
    };
    this.credentialProfiles.set(profile.id, profile);
    await this.store.upsertCredentialProfile(profile);
    this.emit("good", `Credential profile ${profile.name} added`);
    return profile;
  }

  /** Update a profile (secret omitted = unchanged; scope/audience null = cleared). Null if unknown. */
  async updateCredentialProfile(
    id: string,
    patch: UpdateCredentialProfileBody,
  ): Promise<PersistedCredentialProfile | null> {
    const existing = this.credentialProfiles.get(id);
    if (existing === undefined) return null;
    const profile: PersistedCredentialProfile = {
      id: existing.id,
      name: patch.name ?? existing.name,
      strategy: existing.strategy,
      tokenEndpoint: patch.tokenEndpoint ?? existing.tokenEndpoint,
      clientId: patch.clientId ?? existing.clientId,
      clientSecret: patch.clientSecret ?? existing.clientSecret,
      scope: patch.scope !== undefined ? patch.scope : (existing.scope ?? null),
      audience: patch.audience !== undefined ? patch.audience : (existing.audience ?? null),
      tokenParam: patch.tokenParam ?? existing.tokenParam,
    };
    this.credentialProfiles.set(id, profile);
    await this.store.upsertCredentialProfile(profile);
    this.emit("info", `Credential profile ${profile.name} updated`);
    return profile;
  }

  /**
   * Delete a profile. REFUSED while any source references it (`in-use`) — silently de-authing live
   * screens is worse than making the operator reassign first. The caller drops it from the
   * TokenService on success.
   */
  async deleteCredentialProfile(
    id: string,
  ): Promise<{ ok: true } | { ok: false; error: "unknown-profile" | "in-use"; inUseBy?: number }> {
    const existing = this.credentialProfiles.get(id);
    if (existing === undefined) return { ok: false, error: "unknown-profile" };
    const inUseBy = this.profileInUseCount(id);
    if (inUseBy > 0) return { ok: false, error: "in-use", inUseBy };
    this.credentialProfiles.delete(id);
    await this.store.deleteCredentialProfile(id);
    this.emit("warn", `Credential profile ${existing.name} removed`);
    return { ok: true };
  }

  /** Does a source load content authenticated by this profile — itself, or (POL-34) via any step of
   *  its playlist? What a screen SHOWS is what needs the token, not just what it's assigned. */
  private sourceUsesProfile(sourceId: string, profileId: string): boolean {
    const source = this.contentSources.get(sourceId);
    if (!source) return false;
    if (source.credentialProfileId === profileId) return true;
    if (source.kind !== "playlist") return false;
    return (source.items ?? []).some(
      (i) => this.contentSources.get(i.sourceId)?.credentialProfileId === profileId,
    );
  }

  /** Every screen currently showing content authenticated by this profile (directly, via a wall, or
   *  via a playlist step) — the set to re-push when the profile's token becomes usable again. */
  screenIdsUsingProfile(profileId: string): string[] {
    const ids = new Set<string>();
    for (const [screenId, sid] of this.screenSourceIds) {
      if (this.sourceUsesProfile(sid, profileId)) ids.add(screenId);
    }
    for (const [wallId, sid] of this.wallSourceIds) {
      if (!this.sourceUsesProfile(sid, profileId)) continue;
      const wall = this.videoWalls.get(wallId);
      for (const screenId of wall?.memberScreenIds ?? []) ids.add(screenId);
    }
    return [...ids];
  }

  /** Append `param=token` to a URL, preserving any existing query/fragment. Falls back to the clean
   *  url if it doesn't parse (it was validated at the edge, so this is belt-and-braces). */
  private static stampToken(url: string, param: string, token: string): string {
    try {
      const parsed = new URL(url);
      parsed.searchParams.set(param, token);
      return parsed.toString();
    } catch {
      return url;
    }
  }

  /** The usable send-time token for a source's credential profile, if it has all three. */
  private tokenForSource(sourceId: string): { param: string; token: string } | undefined {
    const profileId = this.contentSources.get(sourceId)?.credentialProfileId;
    if (!profileId) return undefined;
    const profile = this.credentialProfiles.get(profileId);
    if (!profile) return undefined;
    const token = this.tokenProvider?.getToken(profileId);
    if (!token) return undefined;
    return { param: profile.tokenParam, token };
  }

  /**
   * The send-time auth stamp: if this slice's screen is showing a library source that references a
   * credential profile with a usable token, return a COPY with the token appended to the web/dashboard
   * surface URLs. A PLAYLIST surface (POL-34) stamps per ENTRY — each step resolved from its own
   * source, so each carries its own source's profile token. Otherwise return the slice untouched (no
   * token yet → the target app's login page shows until the token-usable edge re-pushes). Never
   * mutates stored state.
   */
  decorateSliceForSend(slice: ScreenSlice): ScreenSlice {
    if (slice.surfaces.length === 0) return slice;

    // POL-42 — page surfaces get their live half stamped in: resolved (credential-stamped) embeds,
    // resolved image sources, and the poller's last-good feed/weather data. Independent of the
    // framed-content token stamp below, which needs the slice's own source to carry a profile.
    let decorated: ScreenSlice = slice.surfaces.some((s) => s.type === "page")
      ? {
          ...slice,
          surfaces: slice.surfaces.map((surface) =>
            surface.type === "page" ? { ...surface, data: this.buildPageData(surface.definition) } : surface,
          ),
        }
      : slice;

    if (!this.tokenProvider) return decorated;
    const wall = this.getWallForScreen(slice.screenId);
    const sourceId = wall ? this.wallSourceIds.get(wall.id) : this.screenSourceIds.get(slice.screenId);
    const direct = sourceId ? this.tokenForSource(sourceId) : undefined;
    let changed = false;
    const surfaces = decorated.surfaces.map((surface): Surface => {
      if (surface.type === "playlist") {
        let entriesChanged = false;
        const items = surface.items.map((entry) => {
          if (entry.kind !== "web" && entry.kind !== "dashboard") return entry;
          const t = entry.sourceId ? this.tokenForSource(entry.sourceId) : undefined;
          if (!t) return entry;
          entriesChanged = true;
          return { ...entry, url: ControlPlane.stampToken(entry.url, t.param, t.token) };
        });
        if (!entriesChanged) return surface;
        changed = true;
        return { ...surface, items };
      }
      if ((surface.type !== "web" && surface.type !== "dashboard") || !direct) return surface;
      changed = true;
      return { ...surface, url: ControlPlane.stampToken(surface.url, direct.param, direct.token) };
    });
    return changed ? { ...decorated, surfaces } : decorated;
  }

  /** POL-42 — wire the poller after construction (same pattern as setTokenProvider). */
  setPageDataProvider(provider: PageDataProvider): void {
    this.pageDataProvider = provider;
  }

  /**
   * The live half of a page surface, built at SEND time: embed elements resolve their source to its
   * CURRENT url with the CURRENT credential token stamped (per-source profile — each embed may carry
   * its own); image elements resolve to their source's url; feed/weather elements take the poller's
   * last-good data. A dangling sourceId (deleted, or pointing at another page) resolves to nothing
   * and the element renders its placeholder. Stored slices never carry any of this.
   */
  private buildPageData(definition: PageDefinition): PageData {
    const embeds: Record<string, PageEmbedResolution> = {};
    const images: Record<string, PageImageResolution> = {};
    const feeds: Record<string, PageFeedData> = {};
    const weather: Record<string, PageWeatherData> = {};

    for (const el of definition.elements) {
      if (el.kind === "embed") {
        const resolution = this.resolveEmbed(el.props.sourceId, el.props.url);
        if (resolution) embeds[el.id] = resolution;
      } else if (el.kind === "image") {
        const source = el.props.sourceId ? this.contentSources.get(el.props.sourceId) : undefined;
        if (source?.kind === "image" && source.url) images[el.id] = { src: source.url };
      } else if (el.kind === "feed" && el.props.url.trim()) {
        const data = this.pageDataProvider?.feedFor(el.props.url.trim());
        if (data) feeds[el.id] = data;
      } else if (el.kind === "weather" && el.props.location.trim()) {
        const data = this.pageDataProvider?.weatherFor(el.props.location.trim());
        if (data) weather[el.id] = data;
      }
    }

    const bundle: PageData = {};
    if (Object.keys(embeds).length > 0) bundle.embeds = embeds;
    if (Object.keys(images).length > 0) bundle.images = images;
    if (Object.keys(feeds).length > 0) bundle.feeds = feeds;
    if (Object.keys(weather).length > 0) bundle.weather = weather;
    return bundle;
  }

  /** Resolve one embed element: a library source by id (its url, credential-stamped when it carries a
   *  profile with a usable token) or a raw ad-hoc url (never any credentials, by design). A page can
   *  never embed another page. */
  private resolveEmbed(
    sourceId: string | undefined,
    rawUrl: string | undefined,
  ): PageEmbedResolution | undefined {
    if (sourceId) {
      const source = this.contentSources.get(sourceId);
      if (!source || source.kind === "page" || source.kind === "playlist" || !source.url) return undefined;
      let url = source.url;
      if (source.credentialProfileId && this.tokenProvider) {
        const profile = this.credentialProfiles.get(source.credentialProfileId);
        const token = profile ? this.tokenProvider.getToken(profile.id) : undefined;
        if (profile && token) url = ControlPlane.stampToken(url, profile.tokenParam, token);
      }
      return { url, kind: source.kind };
    }
    if (rawUrl) return { url: rawUrl, kind: "web" };
    return undefined;
  }

  /**
   * The member screens of a video wall (resolved, in membership order). Used by the "ident all" action
   * to flash every member's friendly name. Returns null if the wall is unknown.
   */
  identWall(wallId: string): Screen[] | null {
    const wall = this.videoWalls.get(wallId);
    if (wall === undefined) return null;
    const screens: Screen[] = [];
    for (const screenId of wall.memberScreenIds) {
      const screen = this.getScreen(screenId);
      if (screen) screens.push(screen);
    }
    return screens;
  }

  // ── Scenes (Phase 3d) ─────────────────────────────────────────────────────────
  //
  // A Scene is a named SNAPSHOT of a mural's WHOLE wall — its layout (placements), grouping (video
  // walls) and content (per screen + per wall) — re-appliable in one click. It composes the existing
  // placement / combine / content primitives, so the INSTANT property (stable-id render paths, D5) is
  // preserved on apply. Content is captured as the ASSIGNMENT (a library `sourceId` or an ad-hoc
  // `url`), never the resolved surface — so applying a scene re-resolves each source to its CURRENT
  // url. WHEN a scene plays is NOT here: that is a `Schedule` (POL-89/D93), resolved by the ticker in
  // `scheduler.ts`, which fires this very `applyScene` — so a scheduled switch is the operator's own
  // Apply, minus the operator.

  getScenes(): Scene[] {
    return [...this.scenes.values()];
  }

  getScene(id: string): Scene | undefined {
    return this.scenes.get(id);
  }

  private nextSceneId(): string {
    this.sceneCounter += 1;
    return `scene-${this.sceneCounter}`;
  }

  /** The renderable URL a surface points at (web/dashboard → `url`, image/video → `src`), if any.
   *  A playlist has none — it is a rotation over other sources, only ever assigned from the library. */
  private surfaceUrl(surface: Surface): string | undefined {
    switch (surface.type) {
      case "web":
      case "dashboard":
        return surface.url;
      case "image":
      case "video":
        return surface.src;
      case "playlist":
        return undefined;
    }
  }

  /**
   * Derive the SceneContent for a single (placed, non-walled) screen from its CURRENT assignment: a
   * library source → `{sourceId}`; an ad-hoc url (read off its surface) → `{url}`; nothing on air → null.
   */
  private deriveScreenContent(screenId: string): SceneContent {
    const sourceId = this.screenSourceIds.get(screenId);
    if (sourceId) return { sourceId };
    const surface = this.state.slices[screenId]?.surfaces[0];
    if (surface) {
      const url = this.surfaceUrl(surface);
      if (url) return { url };
    }
    return null;
  }

  /**
   * Derive the SceneContent a video wall currently spans: a library source → `{sourceId}`; otherwise
   * the ad-hoc url read off any member's span surface → `{url}`; nothing on air → null.
   */
  private deriveWallContent(wall: VideoWall): SceneContent {
    const sourceId = this.wallSourceIds.get(wall.id);
    if (sourceId) return { sourceId };
    for (const screenId of wall.memberScreenIds) {
      const surface = this.state.slices[screenId]?.surfaces[0];
      if (surface) {
        const url = this.surfaceUrl(surface);
        if (url) return { url };
      }
    }
    return null;
  }

  /** Turn a captured SceneContent into a ContentAssignment to feed setScreenContent/setWallContent. */
  private assignmentFor(content: SceneContent): ContentAssignment | null {
    if (!content) return null;
    if (content.sourceId !== undefined) return { sourceId: content.sourceId };
    if (content.url !== undefined) return { url: content.url };
    return null;
  }

  /**
   * Save the CURRENT state of a mural as a new scene. Captures: every placement on the mural
   * (layout); every video wall on it with its CURRENT assignment (grouping + content); and every
   * placed-but-NOT-walled screen with its CURRENT assignment. Write-through. Returns the new scene,
   * or null if the mural is unknown. Does NOT bump the revision — a scene is registry metadata, not a
   * render change (the admin/state broadcast carries scenes[]).
   */
  async snapshotScene(name: string, muralId: string): Promise<Scene | null> {
    if (!this.murals.has(muralId)) return null;

    const placementsHere = [...this.placements.values()].filter((p) => p.muralId === muralId);
    const wallsHere = [...this.videoWalls.values()].filter((w) => w.muralId === muralId);
    const walledScreenIds = new Set(wallsHere.flatMap((w) => w.memberScreenIds));

    const scenePlacements = placementsHere.map((p) => ({
      screenId: p.screenId,
      x: p.x,
      y: p.y,
      w: p.w,
      h: p.h,
    }));

    const sceneWalls = wallsHere.map((w) => ({
      memberScreenIds: [...w.memberScreenIds],
      content: this.deriveWallContent(w),
    }));

    const sceneScreens = placementsHere
      .filter((p) => !walledScreenIds.has(p.screenId))
      .map((p) => ({ screenId: p.screenId, content: this.deriveScreenContent(p.screenId) }));

    const id = this.nextSceneId();
    const scene = Scene.parse({
      id,
      name,
      muralId,
      placements: scenePlacements,
      walls: sceneWalls,
      screens: sceneScreens,
    });
    this.scenes.set(id, scene);
    await this.store.upsertScene(this.toPersistedScene(scene));
    return scene;
  }

  /**
   * Re-apply a saved scene to its mural in one click, composing existing primitives:
   *   1. split every existing wall on the mural (back to individual screens);
   *   2. unplace any screen currently on the mural that the scene does NOT include, then place/move
   *      every scene placement (a screen that no longer exists is skipped);
   *   3. recreate the scene's video walls (combineScreens);
   *   4. assign content — each wall's via setWallContent, each non-walled screen's via setScreenContent
   *      (a `{sourceId}` whose source was deleted resolves to nothing → leave that target EMPTY rather
   *      than crash); a captured `null` clears the target so apply is deterministic;
   *   5. set DesiredState.activeSceneId = scene.id.
   * Returns the scene + the affected screen slices for the caller to push `server/render` to. Idempotent:
   * re-applying the active scene is a no-op-ish refresh (content rides the stable-id paths, so unchanged
   * tiles patch in place). Returns null if the scene — or its mural — is unknown.
   */
  async applyScene(sceneId: string): Promise<{ scene: Scene; slices: ScreenSlice[] } | null> {
    const scene = this.scenes.get(sceneId);
    if (scene === undefined) return null;
    const muralId = scene.muralId;
    if (!this.murals.has(muralId)) return null;

    // Compose the lower-level primitives WITHOUT each of them emitting its own activity line — the
    // whole apply gets one summary line below.
    this.suppressEmit = true;
    try {
      return await this.applySceneInner(scene, muralId);
    } finally {
      this.suppressEmit = false;
    }
  }

  private async applySceneInner(
    scene: Scene,
    muralId: string,
  ): Promise<{ scene: Scene; slices: ScreenSlice[] }> {
    const touched = new Map<string, ScreenSlice>();
    const accumulate = (slices: ScreenSlice[]): void => {
      for (const slice of slices) touched.set(slice.screenId, slice);
    };

    // 1. Split every existing wall on the mural (clears its members' slices).
    for (const wall of [...this.videoWalls.values()].filter((w) => w.muralId === muralId)) {
      const result = await this.splitWall(wall.id);
      if (result) accumulate(result.slices);
    }

    // 2. Reconcile placements: unplace screens on the mural the scene omits, then place/move the rest.
    const wanted = new Set(scene.placements.map((p) => p.screenId));
    for (const placement of [...this.placements.values()].filter((p) => p.muralId === muralId)) {
      if (!wanted.has(placement.screenId)) {
        const result = await this.unplaceScreen(placement.screenId);
        if (result !== false) accumulate(result.slices);
      }
    }
    for (const sp of scene.placements) {
      if (!this.getScreen(sp.screenId)) continue; // a screen that no longer exists — skip it
      await this.placeScreen(sp.screenId, muralId, sp.x, sp.y, sp.w, sp.h);
    }

    // 3 + 4a. Recreate each wall, then assign its content (skip a wall whose members no longer hold).
    for (const sceneWall of scene.walls) {
      const members = sceneWall.memberScreenIds.filter(
        (id) => this.getScreen(id) && this.placements.get(id)?.muralId === muralId,
      );
      if (members.length < 2) continue; // not enough surviving members to re-form the wall
      const combined = await this.combineScreens(muralId, members);
      if (!combined.ok) continue;
      accumulate(combined.slices); // combine clears the members' slices

      const assignment = this.assignmentFor(sceneWall.content);
      if (assignment) {
        const result = await this.setWallContent(combined.wall.id, assignment);
        // A deleted source (unknown-source) / no placements → leave the wall cleared (don't crash).
        if (result.ok) accumulate(result.slices);
      }
    }

    // 4b. Assign each non-walled screen's content (or clear it when the scene captured nothing).
    for (const sceneScreen of scene.screens) {
      const screenId = sceneScreen.screenId;
      if (!this.getScreen(screenId)) continue;
      if (this.getWallForScreen(screenId)) continue; // ended up a wall member — wall owns its content

      const assignment = this.assignmentFor(sceneScreen.content);
      if (assignment) {
        const result = await this.setScreenContent(screenId, assignment);
        if (result.ok) {
          accumulate([result.slice]);
        } else {
          // A deleted source (or any rejection) → clear the screen so a stale tile never lingers.
          const cleared = await this.setScreenSurfaces(screenId, []);
          if (cleared) accumulate([cleared]);
        }
      } else {
        // Captured "nothing on air" — ensure the screen is empty (deterministic apply).
        const cleared = await this.setScreenSurfaces(screenId, []);
        if (cleared) accumulate([cleared]);
      }
    }

    // 5. Mark the scene active (in-memory desired-state; the console mirrors this on its side).
    this.state.activeSceneId = scene.id;

    // One summary line for the whole apply. Pushed straight to the log (the per-op guard is on).
    this.activity?.push("good", `Applied scene ${scene.name}`);
    return { scene, slices: [...touched.values()] };
  }

  /**
   * Rename a saved scene. Write-through. Does NOT bump the revision (registry metadata). Returns the
   * updated scene, or null if unknown. (WHEN a scene plays is a `Schedule` — POL-89/D93.)
   */
  async updateScene(id: string, patch: UpdateSceneBody): Promise<Scene | null> {
    const existing = this.scenes.get(id);
    if (existing === undefined) return null;

    const next: Scene = { ...existing };
    if (patch.name !== undefined) next.name = patch.name;

    const scene = Scene.parse(next);
    this.scenes.set(id, scene);
    await this.store.upsertScene(this.toPersistedScene(scene));
    return scene;
  }

  /**
   * Delete a saved scene. If it was the active scene, clears DesiredState.activeSceneId; any SCHEDULE
   * bound to it (and its standing as the default scene) goes with it — a schedule pointing at a scene
   * that no longer exists would resolve to nothing every tick. Write-through. Does NOT touch the live
   * wall (a scene is just a saved snapshot). Returns false if unknown.
   */
  async deleteScene(id: string): Promise<boolean> {
    if (!this.scenes.has(id)) return false;
    this.scenes.delete(id);
    if (this.state.activeSceneId === id) this.state.activeSceneId = null;
    await this.store.deleteScene(id);

    for (const schedule of [...this.schedules.values()].filter((s) => s.sceneId === id)) {
      this.schedules.delete(schedule.id);
      await this.store.deleteSchedule(schedule.id);
    }
    if (this.schedulerSettings.defaultSceneId === id) {
      this.schedulerSettings = { ...this.schedulerSettings, defaultSceneId: null };
      await this.store.setSchedulerSettings(this.toPersistedSchedulerSettings());
    }
    return true;
  }

  // ── The scene scheduler (POL-89) ──────────────────────────────────────────────
  //
  // Dayparts + schedules + one settings row. This layer only STORES and validates; the ticker
  // (`scheduler.ts`) resolves them against the clock and calls the existing applyScene path, so the
  // fan-out is the ordinary instant WS push and nothing on a box or in a player changes.

  private toPersistedSchedulerSettings(): PersistedSchedulerSettings {
    return { ...this.schedulerSettings };
  }

  getDayparts(): Daypart[] {
    return [...this.dayparts.values()];
  }

  getSchedules(): Schedule[] {
    return [...this.schedules.values()];
  }

  getSchedulerSettings(): SchedulerSettings {
    return { ...this.schedulerSettings };
  }

  /** Everything the shared resolver needs — the same set the console gets in `admin/state`. */
  getScheduleSet(): ScheduleSet {
    return {
      dayparts: this.getDayparts(),
      schedules: this.getSchedules(),
      settings: this.getSchedulerSettings(),
    };
  }

  async createDaypart(body: CreateDaypartBody): Promise<Daypart> {
    this.daypartCounter += 1;
    const daypart = Daypart.parse({
      id: `daypart-${this.daypartCounter}`,
      name: body.name,
      start: body.start,
      end: body.end,
    });
    this.dayparts.set(daypart.id, daypart);
    await this.store.upsertDaypart(daypart);
    this.emit("info", `Added daypart ${daypart.name} (${daypart.start}–${daypart.end})`);
    return daypart;
  }

  async updateDaypart(id: string, patch: UpdateDaypartBody): Promise<Daypart | null> {
    const existing = this.dayparts.get(id);
    if (existing === undefined) return null;
    const daypart = Daypart.parse({ ...existing, ...patch });
    this.dayparts.set(id, daypart);
    await this.store.upsertDaypart(daypart);
    this.emit("info", `Daypart ${daypart.name} is now ${daypart.start}–${daypart.end}`);
    return daypart;
  }

  /**
   * Delete a daypart. Refuses while any schedule is bound to it (returns the binding count) — an
   * operator must not be able to silently unschedule a wall by tidying up the library.
   */
  async deleteDaypart(id: string): Promise<{ ok: true } | { ok: false; error: "unknown" | "in-use"; schedules: number }> {
    const existing = this.dayparts.get(id);
    if (existing === undefined) return { ok: false, error: "unknown", schedules: 0 };
    const bound = [...this.schedules.values()].filter((s) => s.daypartId === id);
    if (bound.length > 0) return { ok: false, error: "in-use", schedules: bound.length };
    this.dayparts.delete(id);
    await this.store.deleteDaypart(id);
    this.emit("info", `Deleted daypart ${existing.name}`);
    return { ok: true };
  }

  async createSchedule(
    body: CreateScheduleBody,
  ): Promise<{ ok: true; schedule: Schedule } | { ok: false; error: "unknown-scene" | "unknown-daypart" }> {
    if (!this.scenes.has(body.sceneId)) return { ok: false, error: "unknown-scene" };
    if (!this.dayparts.has(body.daypartId)) return { ok: false, error: "unknown-daypart" };
    this.scheduleCounter += 1;
    const schedule = Schedule.parse({
      id: `schedule-${this.scheduleCounter}`,
      sceneId: body.sceneId,
      daypartId: body.daypartId,
      days: [...new Set(body.days)].sort((a, b) => a - b),
      priority: body.priority,
      enabled: body.enabled,
      from: body.from,
      until: body.until,
      createdAt: new Date().toISOString(),
    });
    this.schedules.set(schedule.id, schedule);
    await this.store.upsertSchedule(schedule);
    this.emit(
      "info",
      `Scheduled ${this.scenes.get(schedule.sceneId)?.name ?? schedule.sceneId} in ${this.dayparts.get(schedule.daypartId)?.name ?? schedule.daypartId}`,
    );
    return { ok: true, schedule };
  }

  async updateSchedule(
    id: string,
    patch: UpdateScheduleBody,
  ): Promise<{ ok: true; schedule: Schedule } | { ok: false; error: "unknown" | "unknown-scene" | "unknown-daypart" }> {
    const existing = this.schedules.get(id);
    if (existing === undefined) return { ok: false, error: "unknown" };
    if (patch.sceneId !== undefined && !this.scenes.has(patch.sceneId)) return { ok: false, error: "unknown-scene" };
    if (patch.daypartId !== undefined && !this.dayparts.has(patch.daypartId)) {
      return { ok: false, error: "unknown-daypart" };
    }
    const schedule = Schedule.parse({
      ...existing,
      ...patch,
      ...(patch.days ? { days: [...new Set(patch.days)].sort((a, b) => a - b) } : {}),
    });
    this.schedules.set(id, schedule);
    await this.store.upsertSchedule(schedule);
    return { ok: true, schedule };
  }

  async deleteSchedule(id: string): Promise<boolean> {
    if (!this.schedules.has(id)) return false;
    this.schedules.delete(id);
    await this.store.deleteSchedule(id);
    return true;
  }

  /**
   * Patch the deployment's scheduler settings. An unknown timezone or an unknown default scene is
   * REFUSED, not coerced: a wall's whole daily rhythm hangs off this row, so a typo must fail loudly
   * at the edge rather than quietly move every window an hour.
   */
  async updateSchedulerSettings(
    patch: UpdateSchedulerSettingsBody,
  ): Promise<{ ok: true; settings: SchedulerSettings } | { ok: false; error: "unknown-timezone" | "unknown-scene" }> {
    if (patch.timezone !== undefined && !isValidTimeZone(patch.timezone)) {
      return { ok: false, error: "unknown-timezone" };
    }
    if (patch.defaultSceneId != null && !this.scenes.has(patch.defaultSceneId)) {
      return { ok: false, error: "unknown-scene" };
    }
    const settings = SchedulerSettings.parse({ ...this.schedulerSettings, ...patch });
    this.schedulerSettings = settings;
    await this.store.setSchedulerSettings(this.toPersistedSchedulerSettings());
    if (patch.enabled !== undefined) {
      this.emit(patch.enabled ? "good" : "warn", patch.enabled ? "Scene scheduler ON" : "Scene scheduler OFF");
    }
    if (patch.timezone !== undefined) this.emit("info", `Scheduler timezone set to ${settings.timezone}`);
    return { ok: true, settings };
  }
}
