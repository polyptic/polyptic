/**
 * The console's single source of live truth (Pinia).
 *
 * Holds the latest `admin/state` snapshot (machines + murals + placements) pushed over the admin
 * WebSocket, plus client-only UI state (active mural, selection, theme). Every inbound frame is
 * zod-validated at the edge against the shared contract; malformed frames are dropped. Mutations go
 * out through `src/api.ts` (REST) and are reflected optimistically for a snappy feel — the server's
 * coalesced `admin/state` broadcast is always authoritative and overwrites local state on arrival.
 *
 * The wall view (owned by console-wall) reads exclusively through this store's getters/actions.
 */
import { defineStore } from "pinia";
import { PROTOCOL_VERSION, ServerToAdminMessage, parseMessage } from "@polyptic/protocol";
import type {
  ActivityEvent,
  AuthUser,
  ChangePasswordBody,
  ContentKind,
  ContentSource,
  CreateContentSourceBody,
  CreateCredentialProfileBody,
  CredentialProfileTestResult,
  CredentialProfileView,
  DisplaySettings,
  EnrollmentInfo,
  LoginBody,
  MachineView,
  Mural,
  NetbootInfo,
  Placement,
  Scene,
  ScreenView,
  UpdateContentSourceBody,
  UpdateCredentialProfileBody,
  UpdateSceneBody,
  VideoWall,
  ImageUpdateInfo,
} from "@polyptic/protocol";

import * as api from "../api";
import * as auth from "../auth";

/** Assigning content takes EITHER a library source by id OR an ad-hoc URL — exactly one (the
 *  contract's SetContentBody refinement). The ad-hoc URL path is the Phase-3b behaviour. */
export type ContentAssignment = { sourceId: string } | { url: string };

// Same split as api.ts BASE: cross-port in dev (Vite :5175 -> server :8080), same-origin in a
// production build served by the server itself (ws/wss follows the page protocol).
const ADMIN_WS_URL = import.meta.env.DEV
  ? "ws://localhost:8080/admin"
  : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/admin`;
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10_000;
const THEME_KEY = "polyptic.theme";

// A newly placed screen's size is filled by the server from the screen's native output resolution;
// until the authoritative broadcast lands we show it at this optimistic default (canvas pixels).
const DEFAULT_PLACEMENT_W = 1920;
const DEFAULT_PLACEMENT_H = 1080;

// Socket + reconnect bookkeeping live at module scope (not in reactive state) — the store is a
// singleton, and a WebSocket should never be made reactive.
let socket: WebSocket | null = null;

// Remote-shell frames (POL-59) bypass the strict admin-state parse: they are a hot byte stream the
// terminal component consumes directly. The store owns the single admin socket, so it fans
// `server/shell-*` frames out to whichever terminal subscribed, and lets the terminal push
// `admin/shell-*` frames back over the same socket.
type ShellFrame = { t: string; machineId?: string; sessionId?: string; ok?: boolean; reason?: string; dataBase64?: string };
const shellListeners = new Set<(f: ShellFrame) => void>();
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backoffMs = RECONNECT_MIN_MS;
let stopped = false;

// When a Combine round-trips, the server assigns the real wall id; we remember the optimistic
// member set so the next authoritative broadcast can re-point `selectedWallId` at the real wall.
let pendingWallMembers: string[] | null = null;

/** Two membership lists describe the same wall iff they hold the same screen ids (order-insensitive). */
function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

/** Normalise a content assignment for the wire: pass a `sourceId` straight through, but trim a `url`
 *  and drop it if blank. Returns null when there's nothing to send. */
function normalizeAssignment(content: ContentAssignment): ContentAssignment | null {
  if ("sourceId" in content) {
    return content.sourceId ? { sourceId: content.sourceId } : null;
  }
  const trimmed = content.url.trim();
  return trimmed ? { url: trimmed } : null;
}

function initialTheme(): "light" | "dark" {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* storage unavailable */
  }
  return "light";
}

export interface ConsoleState {
  /** The signed-in operator (D29), or null when not authenticated. The session itself lives only in
   *  an httpOnly cookie — this is just the public profile the server reports via /auth/me. */
  currentUser: AuthUser | null;
  /** Whether the initial /auth/me probe has resolved. The router guard runs it exactly once per load
   *  and then trusts `currentUser`, so navigations don't re-hit the network. */
  sessionChecked: boolean;
  /** Enrollment-token visibility for Settings + the cold-start wizard (open mode vs gated token). */
  enrollment: EnrollmentInfo | null;
  /** Netboot info for Settings (POL-33): control-plane base, the `/boot/grub.cfg` boot config URL,
   *  and the optional boot-medium download. Null until the Settings view fetches it. */
  netboot: NetbootInfo | null;
  /** Image-updates settings + published images (POL-41): schedule, urgency, last rebuild. */
  imageUpdates: ImageUpdateInfo | null;
  /** Fleet-wide display settings (POL-6) — the on-screen badge toggle. Mirrored from admin/state
   *  (optional on the wire → null until the first snapshot with it lands, or against an older server). */
  settings: DisplaySettings | null;
  connected: boolean;
  /** True once the FIRST admin/state snapshot has been folded in — the difference between "the
   *  registry is empty" and "we haven't heard yet" (deep links must not act on the latter). */
  stateReceived: boolean;
  revision: number;
  machines: MachineView[];
  murals: Mural[];
  placements: Placement[];
  videoWalls: VideoWall[];
  /** The content LIBRARY (Phase 3c) — reusable named sources, mirrored from admin/state. */
  contentSources: ContentSource[];
  /** Credential profiles (POL-24) — content-auth OAuth clients + live token health, mirrored from
   *  admin/state.credentialProfiles (optional on the wire → [] against an older server). Never
   *  carries a client secret. */
  credentialProfiles: CredentialProfileView[];
  /** Saved wall snapshots (Phase 3d), mirrored from admin/state. */
  scenes: Scene[];
  /** The Live Activity feed (D25) — bounded, newest-first human event log, mirrored from
   *  admin/state.activity. The field is OPTIONAL on the wire (back-compat), so it defaults to []
   *  when a server omits it. */
  activity: ActivityEvent[];
  /** The scene most recently applied this session. The admin/state snapshot does not surface the
   *  server's DesiredState.activeSceneId, so we track it client-side: set optimistically on apply,
   *  cleared when its scene is deleted. */
  activeSceneId: string | null;
  activeMuralId: string | null;
  selectedScreenIds: string[];
  /** A combined surface selected on the canvas (mutually exclusive with selectedScreenIds). */
  selectedWallId: string | null;
  /** A library source "armed" in the Wall's left library: click it, then click a screen/wall on the
   *  canvas to assign it (client-only UI state). Null = nothing armed. */
  pickedSourceId: string | null;
  /** The library source currently being DRAGGED onto the canvas (set on dragstart, read on drop).
   *  Carried in the store rather than the DragEvent's dataTransfer, whose getData() is unreliable
   *  across real HTML5 drops. Null = no drag in progress. */
  draggingSourceId: string | null;
  theme: "light" | "dark";
}

type PlacedEntry = { screen: ScreenView; placement: Placement };
type WallBounds = { x: number; y: number; w: number; h: number };

export const useConsoleStore = defineStore("console", {
  state: (): ConsoleState => ({
    currentUser: null,
    sessionChecked: false,
    enrollment: null,
    netboot: null,
    imageUpdates: null,
    settings: null,
    connected: false,
    stateReceived: false,
    revision: 0,
    machines: [],
    murals: [],
    placements: [],
    videoWalls: [],
    contentSources: [],
    credentialProfiles: [],
    scenes: [],
    activity: [],
    activeSceneId: null,
    activeMuralId: null,
    selectedScreenIds: [],
    selectedWallId: null,
    pickedSourceId: null,
    draggingSourceId: null,
    theme: initialTheme(),
  }),

  getters: {
    // ── Auth (Phase 3f) ─────────────────────────────────────────────────────────

    /** Whether an operator session is currently established. */
    isAuthenticated(state): boolean {
      return state.currentUser !== null;
    },

    /** The signed-in operator's email, or "" when not signed in. */
    currentEmail(state): string {
      return state.currentUser?.email ?? "";
    },

    /** Two-letter avatar initials derived from the operator's email (e.g. "operator@…" → "OP"). */
    accountInitials(state): string {
      const email = state.currentUser?.email;
      if (!email) return "OP";
      const local = email.split("@")[0] ?? email;
      const parts = local.split(/[._-]+/).filter(Boolean);
      const letters =
        parts.length >= 2 && parts[0] && parts[1]
          ? `${parts[0][0]}${parts[1][0]}`
          : local.slice(0, 2);
      return letters.toUpperCase();
    },

    // ── Enrollment (Phase 3f) ────────────────────────────────────────────────────

    /** True when the server enrolls machines in open mode (no token required). */
    enrollmentOpen(state): boolean {
      return state.enrollment?.mode === "open";
    },

    /** The gated bootstrap token, when in gated mode and loaded; else null. */
    enrollmentToken(state): string | null {
      return state.enrollment?.mode === "gated" ? state.enrollment.token : null;
    },

    /** Whether on-screen badges are shown fleet-wide (POL-6). Defaults to false until settings load. */
    showBadges(state): boolean {
      return state.settings?.showBadges ?? false;
    },

    /** Every screen across all machines, flattened. Each ScreenView already carries its machineId. */
    screens(state): ScreenView[] {
      return state.machines.flatMap((m) => m.screens);
    },

    /** Screens with no placement on any mural — these live in the unplaced tray. */
    unplacedScreens(): ScreenView[] {
      const placed = new Set(this.placements.map((p) => p.screenId));
      return this.screens.filter((s) => !placed.has(s.id));
    },

    /** The currently switched-to mural, if any. */
    activeMural(state): Mural | undefined {
      return state.murals.find((m) => m.id === state.activeMuralId);
    },

    /** Screens placed on a given mural, paired with their placement geometry. */
    placedScreens(): (muralId: string) => PlacedEntry[] {
      return (muralId: string) =>
        this.placements
          .filter((p) => p.muralId === muralId)
          .map((placement): PlacedEntry | null => {
            const screen = this.screens.find((s) => s.id === placement.screenId);
            return screen ? { screen, placement } : null;
          })
          .filter((e): e is PlacedEntry => e !== null);
    },

    screenById(): (id: string) => ScreenView | undefined {
      return (id: string) => this.screens.find((s) => s.id === id);
    },

    placementForScreen(): (screenId: string) => Placement | undefined {
      return (screenId: string) => this.placements.find((p) => p.screenId === screenId);
    },

    machineForScreen(): (screenId: string) => MachineView | undefined {
      return (screenId: string) =>
        this.machines.find((m) => m.screens.some((s) => s.id === screenId));
    },

    // ── Machines / enrollment (Phase 2b) ──────────────────────────────────────

    /** Machines awaiting an operator decision — surfaced first in the Machines view + the nav badge. */
    pendingMachines(state): MachineView[] {
      return state.machines.filter((m) => m.status === "pending");
    },

    /** Admitted machines (online first, then by label) — the ones whose screens are live. */
    approvedMachines(state): MachineView[] {
      return state.machines
        .filter((m) => m.status === "approved")
        .slice()
        .sort((a, b) => {
          if (a.online !== b.online) return a.online ? -1 : 1;
          return a.label.localeCompare(b.label);
        });
    },

    /** Machines an operator denied/revoked — kept listed so access can be restored. */
    rejectedMachines(state): MachineView[] {
      return state.machines.filter((m) => m.status === "rejected");
    },

    machineById(): (id: string) => MachineView | undefined {
      return (id: string) => this.machines.find((m) => m.id === id);
    },

    // ── Combined surfaces (video walls, Phase 3b) ─────────────────────────────

    /** The combined surfaces living on a given mural. */
    wallsForMural(): (muralId: string) => VideoWall[] {
      return (muralId: string) => this.videoWalls.filter((w) => w.muralId === muralId);
    },

    /** The combined surface a screen belongs to (if any) — members render inside it, not solo. */
    wallForScreen(): (screenId: string) => VideoWall | undefined {
      return (screenId: string) =>
        this.videoWalls.find((w) => w.memberScreenIds.includes(screenId));
    },

    wallById(): (wallId: string) => VideoWall | undefined {
      return (wallId: string) => this.videoWalls.find((w) => w.id === wallId);
    },

    /** Screens that are NOT a member of any combined surface (the ones drawn as solo tiles). */
    unwalledScreens(): ScreenView[] {
      const walled = new Set(this.videoWalls.flatMap((w) => w.memberScreenIds));
      return this.screens.filter((s) => !walled.has(s.id));
    },

    /** A wall's member screens paired with their placement geometry (members with no placement
     *  are skipped — combined surfaces only span *placed* screens). */
    wallMembers(): (wallId: string) => PlacedEntry[] {
      return (wallId: string) => {
        const wall = this.videoWalls.find((w) => w.id === wallId);
        if (!wall) return [];
        return wall.memberScreenIds
          .map((sid): PlacedEntry | null => {
            const screen = this.screens.find((s) => s.id === sid);
            const placement = this.placements.find((p) => p.screenId === sid);
            return screen && placement ? { screen, placement } : null;
          })
          .filter((e): e is PlacedEntry => e !== null);
      };
    },

    /** The union bounding box of a wall's members (canvas px) — its combined geometry/resolution.
     *  Matches the server's span math: unionMin/Max over each member's placement. */
    wallBounds(): (wallId: string) => WallBounds | undefined {
      return (wallId: string) => {
        const members = this.wallMembers(wallId);
        if (members.length === 0) return undefined;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const { placement: p } of members) {
          if (p.x < minX) minX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.x + p.w > maxX) maxX = p.x + p.w;
          if (p.y + p.h > maxY) maxY = p.y + p.h;
        }
        return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
      };
    },

    /** A display name for a combined surface. Prefer the operator-chosen `wall.name` when set;
     *  otherwise derive a label from the member screens (e.g. "Nessie + Bertha"). Walls stored
     *  before naming existed (or never named) have no `name` and fall back to the member join. */
    wallName(): (wallId: string) => string {
      return (wallId: string) => {
        const wall = this.videoWalls.find((w) => w.id === wallId);
        const named = wall?.name?.trim();
        if (named) return named;
        const members = this.wallMembers(wallId);
        if (members.length === 0) return "Combined surface";
        return members.map((m) => m.screen.friendlyName).join(" + ");
      };
    },

    /** Whether any member of the wall currently has a surface on air (the wall is showing content). */
    wallHasContent(): (wallId: string) => boolean {
      return (wallId: string) =>
        this.wallMembers(wallId).some((m) => (m.screen.surfaceCount ?? 0) > 0);
    },

    /** The currently selected combined surface, if any. */
    selectedWall(state): VideoWall | undefined {
      return state.selectedWallId
        ? state.videoWalls.find((w) => w.id === state.selectedWallId)
        : undefined;
    },

    // ── Content library (Phase 3c) ───────────────────────────────────────────

    /** Every library source, in the order the server keeps them. */
    sources(state): ContentSource[] {
      return state.contentSources;
    },

    /** Library sources bucketed by kind — every kind key present. */
    sourcesByKind(state): Record<ContentKind, ContentSource[]> {
      const buckets: Record<ContentKind, ContentSource[]> = {
        web: [],
        dashboard: [],
        image: [],
        video: [],
        playlist: [],
        page: [],
      };
      for (const s of state.contentSources) buckets[s.kind].push(s);
      return buckets;
    },

    sourceById(): (id: string) => ContentSource | undefined {
      return (id: string) => this.contentSources.find((s) => s.id === id);
    },

    /** Every credential profile (POL-24), in the order the server keeps them. */
    profiles(state): CredentialProfileView[] {
      return state.credentialProfiles;
    },

    profileById(): (id: string) => CredentialProfileView | undefined {
      return (id: string) => this.credentialProfiles.find((p) => p.id === id);
    },

    /** The library source currently armed for click-to-assign on the canvas, if any. */
    pickedSource(state): ContentSource | undefined {
      return state.pickedSourceId
        ? state.contentSources.find((s) => s.id === state.pickedSourceId)
        : undefined;
    },

    // ── Scenes (Phase 3d) ──────────────────────────────────────────────────────

    /** The saved scenes belonging to a given mural (a scene is a snapshot of one mural's wall). */
    scenesForMural(state): (muralId: string) => Scene[] {
      return (muralId: string) => state.scenes.filter((sc) => sc.muralId === muralId);
    },

    /** The saved scenes for the currently switched-to mural — what the wall strip & Scenes view show. */
    activeMuralScenes(state): Scene[] {
      return state.activeMuralId
        ? state.scenes.filter((sc) => sc.muralId === state.activeMuralId)
        : [];
    },

    sceneById(): (id: string) => Scene | undefined {
      return (id: string) => this.scenes.find((sc) => sc.id === id);
    },

    /** The scene most recently applied this session (if it still exists), else undefined. */
    activeScene(state): Scene | undefined {
      return state.activeSceneId
        ? state.scenes.find((sc) => sc.id === state.activeSceneId)
        : undefined;
    },

    /** A short "N screens · M walls" summary of what a scene captures, for the list rows. */
    sceneSummary(): (id: string) => string {
      return (id: string) => {
        const scene = this.scenes.find((sc) => sc.id === id);
        if (!scene) return "";
        const screenCount = scene.placements.length;
        const wallCount = scene.walls.length;
        const parts = [`${screenCount} ${screenCount === 1 ? "screen" : "screens"}`];
        if (wallCount > 0) parts.push(`${wallCount} ${wallCount === 1 ? "wall" : "walls"}`);
        return parts.join(" · ");
      };
    },
  },

  actions: {
    // ── Auth (Phase 3f — D29 local accounts) ─────────────────────────────────────

    /**
     * Resolve the operator session, probing GET /auth/me at most once per page load. The router
     * guard awaits this before deciding to admit or redirect; subsequent navigations reuse the
     * cached result. Returns the current user (or null when unauthenticated).
     */
    async ensureSession(): Promise<AuthUser | null> {
      if (!this.sessionChecked) await this.fetchMe();
      return this.currentUser;
    },

    /** Probe /auth/me and fold the result into state. A 401 (or any failure) means "not signed in". */
    async fetchMe(): Promise<AuthUser | null> {
      try {
        this.currentUser = await auth.fetchMe();
      } catch {
        // 401 self-report, or the control plane is unreachable — either way, treat as signed out.
        this.currentUser = null;
      } finally {
        this.sessionChecked = true;
      }
      return this.currentUser;
    },

    /**
     * Sign in with email + password. On success the server sets the session cookie and we cache the
     * returned AuthUser. Errors (401 wrong credentials, 429 lockout) propagate to the sign-in form
     * unchanged so it can show the right message — we deliberately do NOT swallow them here.
     */
    async login(body: LoginBody): Promise<AuthUser> {
      const user = await auth.login(body);
      this.currentUser = user;
      this.sessionChecked = true;
      return user;
    },

    /**
     * Sign out: revoke the server session, drop the cached user, and tear down the admin socket so no
     * authenticated channel lingers. Best-effort — a failed logout call still clears local state.
     */
    async logout(): Promise<void> {
      let endSessionUrl: string | undefined;
      try {
        ({ endSessionUrl } = await auth.logout());
      } catch (err) {
        console.error("[console] logout failed", err);
      }
      this.markSignedOut();
      // POL-106: an SSO session with RP-initiated logout on — hand the browser to the IdP so the
      // sign-out reaches it too. The local session is already revoked, so this is a courtesy, not a
      // dependency: if the IdP never answers, the operator is still signed out of Polyptic.
      if (endSessionUrl) window.location.assign(endSessionUrl);
    },

    /**
     * Clear all session-derived local state and close the live channel. Called on explicit logout and
     * when any guarded request comes back 401 (session expired/revoked mid-use).
     */
    markSignedOut(): void {
      this.currentUser = null;
      this.sessionChecked = true;
      this.enrollment = null;
      this.disconnect();
    },

    /** Change the operator's password (min 8, enforced by the contract). Errors propagate to the UI. */
    async changePassword(body: ChangePasswordBody): Promise<void> {
      await auth.changePassword(body);
    },

    // ── Enrollment token (Phase 3f) ──────────────────────────────────────────────

    /** Load the enrollment-token info for Settings + the cold-start wizard. */
    async fetchEnrollment(): Promise<void> {
      try {
        this.enrollment = await auth.getEnrollment();
      } catch (err) {
        console.error("[console] fetchEnrollment failed", err);
      }
    },

    /** Mint a fresh gated bootstrap token, replacing the shown one. Returns false (no throw) on error. */
    async regenerateEnrollment(): Promise<boolean> {
      try {
        this.enrollment = await auth.regenerateEnrollment();
        return true;
      } catch (err) {
        console.error("[console] regenerateEnrollment failed", err);
        return false;
      }
    },

    /** Load image-updates info for the Settings card (POL-41). Non-throwing, like fetchNetboot. */
    async fetchImageUpdates(): Promise<void> {
      try {
        this.imageUpdates = await auth.getImageUpdates();
      } catch (err) {
        console.error("[console] fetchImageUpdates failed", err);
      }
    },

    /** Load netboot info for the Settings card (POL-33). Non-throwing, like fetchEnrollment. */
    async fetchNetboot(): Promise<void> {
      try {
        this.netboot = await auth.getNetboot();
      } catch (err) {
        console.error("[console] fetchNetboot failed", err);
      }
    },

    // ── Display settings / badge toggle (POL-6) ──────────────────────────────────

    /** Load the current fleet-wide display settings for Settings (the admin/state broadcast also
     *  carries them, but a direct fetch makes the toggle correct even before the WS snapshot lands). */
    async fetchDisplaySettings(): Promise<void> {
      try {
        this.settings = await auth.getDisplaySettings();
      } catch (err) {
        console.error("[console] fetchDisplaySettings failed", err);
      }
    },

    /** Flip on-screen badges fleet-wide. Optimistic (snappy toggle); the authoritative admin/state
     *  broadcast reconciles. Reverts the optimistic value and rethrows on failure so the UI can react. */
    async setShowBadges(showBadges: boolean): Promise<void> {
      const previous = this.settings;
      this.settings = { showBadges };
      try {
        this.settings = await auth.updateDisplaySettings(showBadges);
      } catch (err) {
        this.settings = previous;
        console.error("[console] setShowBadges failed", err);
        throw err;
      }
    },

    // ── Admin WebSocket ───────────────────────────────────────────────────────

    /** Open (and keep open) the admin channel. Idempotent — safe to call on every shell mount. */
    connect(): void {
      if (
        socket &&
        (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)
      ) {
        return;
      }
      stopped = false;
      this.openSocket();
    },

    /** Tear down the socket and stop reconnecting. */
    disconnect(): void {
      stopped = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (socket) {
        const ws = socket;
        socket = null;
        try {
          ws.close();
        } catch {
          /* already closing */
        }
      }
      this.connected = false;
    },

    /** @internal Open one WebSocket and wire its lifecycle to the store. */
    openSocket(): void {
      let ws: WebSocket;
      try {
        ws = new WebSocket(ADMIN_WS_URL);
      } catch {
        this.scheduleReconnect();
        return;
      }
      socket = ws;

      ws.addEventListener("open", () => {
        if (socket !== ws) return;
        backoffMs = RECONNECT_MIN_MS;
        this.connected = true;
        ws.send(JSON.stringify({ t: "admin/hello", protocol: PROTOCOL_VERSION }));
      });

      ws.addEventListener("message", (ev) => {
        // Peek at the type: remote-shell frames go straight to the terminal, everything else through
        // the strict admin-state parse.
        let raw: ShellFrame | undefined;
        try {
          raw = JSON.parse(ev.data as string) as ShellFrame;
        } catch {
          raw = undefined;
        }
        if (raw && typeof raw.t === "string" && raw.t.startsWith("server/shell-")) {
          for (const cb of shellListeners) cb(raw);
          return;
        }
        let msg: ServerToAdminMessage;
        try {
          msg = parseMessage(ServerToAdminMessage, ev.data as string);
        } catch (err) {
          console.warn("[console] dropping invalid admin frame", err);
          return;
        }
        this.applyMessage(msg);
      });

      ws.addEventListener("close", () => {
        if (socket !== ws) return;
        socket = null;
        this.connected = false;
        this.scheduleReconnect();
      });

      ws.addEventListener("error", () => {
        // An error is always followed by `close`; force teardown so reconnect runs exactly once.
        try {
          ws.close();
        } catch {
          /* noop */
        }
      });
    },

    /** @internal Fold a validated server→admin frame into reactive state. */
    applyMessage(msg: ServerToAdminMessage): void {
      if (msg.t === "admin/state") {
        this.stateReceived = true;
        this.revision = msg.revision;
        this.machines = msg.machines;
        this.murals = msg.murals;
        this.placements = msg.placements;
        this.videoWalls = msg.videoWalls;
        this.contentSources = msg.contentSources;
        // POL-24 — credential profiles are optional on the wire (older servers omit them).
        this.credentialProfiles = msg.credentialProfiles ?? [];
        this.scenes = msg.scenes;
        // The Live Activity feed is optional on the wire (older servers omit it); default to [].
        // The server sends it newest-first and pre-bounded, so we mirror it as-is.
        this.activity = msg.activity ?? [];
        // POL-6 — fleet-wide display settings (badge toggle). Optional on the wire (back-compat); keep
        // the last known value when a snapshot omits it rather than clobbering the toggle to null.
        if (msg.settings) this.settings = msg.settings;

        // Forget an active-scene marker whose scene the server no longer knows (e.g. deleted).
        if (this.activeSceneId && !this.scenes.some((sc) => sc.id === this.activeSceneId)) {
          this.activeSceneId = null;
        }

        // Disarm a click-to-assign pick whose source the server no longer knows (e.g. deleted).
        if (this.pickedSourceId && !this.contentSources.some((s) => s.id === this.pickedSourceId)) {
          this.pickedSourceId = null;
        }

        // Keep the active mural valid (default to the first mural the server knows about).
        if (!this.activeMuralId || !this.murals.some((m) => m.id === this.activeMuralId)) {
          this.activeMuralId = this.murals[0]?.id ?? null;
        }

        // A freshly-combined surface had an optimistic temp id; re-point the selection at the real
        // wall the server just created (matched by its member set), then drop the pending marker.
        if (pendingWallMembers) {
          const real = this.videoWalls.find((w) => sameMembers(w.memberScreenIds, pendingWallMembers!));
          if (real) {
            this.selectedWallId = real.id;
            pendingWallMembers = null;
          }
        }

        // Prune any selection that no longer corresponds to a live, un-walled screen; members of a
        // combined surface are addressed through the wall, not individually.
        const live = new Set(this.machines.flatMap((m) => m.screens.map((s) => s.id)));
        const walled = new Set(this.videoWalls.flatMap((w) => w.memberScreenIds));
        this.selectedScreenIds = this.selectedScreenIds.filter(
          (id) => live.has(id) && !walled.has(id),
        );

        // Drop a wall selection that no longer exists (e.g. split elsewhere) unless a combine is
        // still settling.
        if (
          this.selectedWallId &&
          !pendingWallMembers &&
          !this.videoWalls.some((w) => w.id === this.selectedWallId)
        ) {
          this.selectedWallId = null;
        }
      }
    },

    /** @internal Schedule a reconnect with exponential backoff + jitter. */
    scheduleReconnect(): void {
      if (stopped || reconnectTimer !== null) return;
      const jitter = Math.random() * 0.3 * backoffMs;
      const delay = backoffMs + jitter;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        this.openSocket();
      }, delay);
      backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS);
    },

    // ── Machines / enrollment (Phase 2b) ────────────────────────────────────────

    /**
     * Admit a pending machine. Optimistically flips its status to `approved` so the UI (and the
     * cold-start wizard) advances immediately; the authoritative admin/state broadcast then arrives
     * with the machine's registered screens and overwrites local state.
     */
    async approveMachine(id: string): Promise<void> {
      const machine = this.machines.find((m) => m.id === id);
      if (machine) machine.status = "approved"; // optimistic
      try {
        await api.approveMachine(id);
      } catch (err) {
        console.error("[console] approveMachine failed", err);
      }
    },

    /**
     * Reject a pending machine, or revoke an already-approved one (same endpoint). Optimistically
     * marks it `rejected`; the server clears its screens and re-broadcasts. The optional reason is
     * advisory and only sent when provided.
     */
    async rejectMachine(id: string, reason?: string): Promise<void> {
      const machine = this.machines.find((m) => m.id === id);
      if (machine) machine.status = "rejected"; // optimistic
      try {
        await api.rejectMachine(id, reason);
      } catch (err) {
        console.error("[console] rejectMachine failed", err);
      }
    },

    /** Flash every screen a machine drives (fire-and-forget pulse) so an operator can spot the box. */
    async identMachine(id: string): Promise<void> {
      try {
        await api.identMachine(id, { on: true, ttlMs: 3000 });
      } catch (err) {
        console.error("[console] identMachine failed", err);
      }
    },

    /**
     * Arm or disarm a box's remote shell (POL-59). Optimistic so the toggle is snappy; the
     * authoritative admin/state broadcast reconciles. Disarming a box the server-side closes any
     * live session — the terminal component sees `server/shell-closed` and tears down.
     */
    async setMachineShell(id: string, enabled: boolean): Promise<void> {
      const machine = this.machines.find((m) => m.id === id);
      if (machine) machine.shellEnabled = enabled; // optimistic
      try {
        await api.setMachineShell(id, enabled);
      } catch (err) {
        if (machine) machine.shellEnabled = !enabled; // revert
        console.error("[console] setMachineShell failed", err);
      }
    },

    /** Send an `admin/shell-*` frame over the live admin socket (the terminal component's uplink). */
    sendShellFrame(frame: Record<string, unknown>): boolean {
      if (!socket || socket.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify(frame));
      return true;
    },

    /** Subscribe to `server/shell-*` frames (the terminal component's downlink). Returns unsubscribe. */
    onShellFrame(cb: (f: ShellFrame) => void): () => void {
      shellListeners.add(cb);
      return () => shellListeners.delete(cb);
    },

    /**
     * Power-cycle one box (POL-55). There is nothing to update optimistically — the machine goes
     * offline of its own accord a moment later and the admin/state broadcast reflects it. Returns an
     * operator-readable error when the server refused (offline, or not approved), else null.
     */
    async rebootMachine(id: string): Promise<string | null> {
      try {
        await api.rebootMachine(id);
        return null;
      } catch (err) {
        console.error("[console] rebootMachine failed", err);
        // The server's 409s explain themselves ("… is offline — nothing to reboot"); ApiError.message
        // is only the method/path/status, so prefer the payload's own sentence when there is one.
        const detail =
          err instanceof api.ApiError && typeof (err.payload as { error?: unknown })?.error === "string"
            ? (err.payload as { error: string }).error
            : null;
        return detail ?? "Reboot failed — the control plane could not reach that machine.";
      }
    },

    /**
     * Permanently forget a machine (POL-14): drop it, its screens, and anything derived from them
     * (placements, combined surfaces, selection) optimistically for a snappy feel; the authoritative
     * admin/state broadcast reconciles. Unlike rejectMachine (a remembered "rejected" state), this
     * deletes the machine — it must re-enrol to come back.
     */
    async removeMachine(id: string): Promise<void> {
      const machine = this.machines.find((m) => m.id === id);
      const screenIds = new Set(machine?.screens.map((s) => s.id) ?? []);
      // optimistic prune — machine, its placements, any wall touching its screens, and selection
      this.machines = this.machines.filter((m) => m.id !== id);
      this.placements = this.placements.filter((p) => !screenIds.has(p.screenId));
      this.videoWalls = this.videoWalls.filter(
        (w) => !w.memberScreenIds.some((sid) => screenIds.has(sid)),
      );
      this.selectedScreenIds = this.selectedScreenIds.filter((sid) => !screenIds.has(sid));
      if (this.selectedWallId && !this.videoWalls.some((w) => w.id === this.selectedWallId)) {
        this.selectedWallId = null;
      }
      try {
        await api.deleteMachine(id);
      } catch (err) {
        console.error("[console] removeMachine failed", err);
      }
    },

    // ── Murals ────────────────────────────────────────────────────────────────

    async createMural(name: string): Promise<void> {
      const trimmed = name.trim();
      if (!trimmed) return;
      try {
        await api.createMural(trimmed);
      } catch (err) {
        console.error("[console] createMural failed", err);
      }
    },

    async renameMural(id: string, name: string): Promise<void> {
      const trimmed = name.trim();
      if (!trimmed) return;
      const mural = this.murals.find((m) => m.id === id);
      if (mural) mural.name = trimmed; // optimistic
      try {
        await api.renameMural(id, trimmed);
      } catch (err) {
        console.error("[console] renameMural failed", err);
      }
    },

    async deleteMural(id: string): Promise<void> {
      // optimistic — drop the mural and any placements on it
      this.murals = this.murals.filter((m) => m.id !== id);
      this.placements = this.placements.filter((p) => p.muralId !== id);
      if (this.activeMuralId === id) this.activeMuralId = this.murals[0]?.id ?? null;
      try {
        await api.deleteMural(id);
      } catch (err) {
        console.error("[console] deleteMural failed", err);
      }
    },

    setActiveMural(id: string): void {
      this.activeMuralId = id;
    },

    // ── Placement ─────────────────────────────────────────────────────────────

    /** Place a screen onto a mural. Size is left to the server (native resolution) for a fresh
     *  placement; an existing placement keeps its current size while it moves murals. */
    async placeScreen(screenId: string, muralId: string, x: number, y: number): Promise<void> {
      const existing = this.placements.find((p) => p.screenId === screenId);
      if (existing) {
        existing.muralId = muralId;
        existing.x = x;
        existing.y = y;
      } else {
        this.placements.push({
          muralId,
          screenId,
          x,
          y,
          w: DEFAULT_PLACEMENT_W,
          h: DEFAULT_PLACEMENT_H,
        });
      }
      try {
        await api.placeScreen(
          screenId,
          existing
            ? { muralId, x, y, w: existing.w, h: existing.h }
            : { muralId, x, y },
        );
      } catch (err) {
        console.error("[console] placeScreen failed", err);
      }
    },

    /** Move an already-placed screen within its mural, preserving its size. */
    async moveScreen(screenId: string, x: number, y: number): Promise<void> {
      const existing = this.placements.find((p) => p.screenId === screenId);
      if (!existing) return;
      existing.x = x; // optimistic
      existing.y = y;
      try {
        await api.placeScreen(screenId, {
          muralId: existing.muralId,
          x,
          y,
          w: existing.w,
          h: existing.h,
        });
      } catch (err) {
        console.error("[console] moveScreen failed", err);
      }
    },

    async unplaceScreen(screenId: string): Promise<void> {
      this.placements = this.placements.filter((p) => p.screenId !== screenId); // optimistic
      try {
        await api.unplaceScreen(screenId);
      } catch (err) {
        console.error("[console] unplaceScreen failed", err);
      }
    },

    // ── Screen registry / content ─────────────────────────────────────────────

    async renameScreen(screenId: string, name: string): Promise<void> {
      const trimmed = name.trim();
      if (!trimmed) return;
      // optimistic — patch the screen wherever it lives
      for (const machine of this.machines) {
        const screen = machine.screens.find((s) => s.id === screenId);
        if (screen) {
          screen.friendlyName = trimmed;
          break;
        }
      }
      try {
        await api.renameScreen(screenId, trimmed);
      } catch (err) {
        console.error("[console] renameScreen failed", err);
      }
    },

    /** Flash a screen's friendly name on the physical panel (fire-and-forget pulse). */
    async identScreen(screenId: string): Promise<void> {
      try {
        await api.identScreen(screenId, { on: true, ttlMs: 3000 });
      } catch (err) {
        console.error("[console] identScreen failed", err);
      }
    },

    /**
     * Show/hide the kiosk browser's Web Inspector ON that screen's panel (POL-50). Returns an error
     * sentence for the operator, or null when the request reached the box.
     *
     * Deliberately NOT optimistic: the screen's `inspecting` flag is written only by the agent's ack,
     * arriving on the next admin/state. An optimistic flip would show an inspector on a wall where
     * surf failed to relaunch — and the operator, who is not standing at that wall, would believe it.
     */
    async inspectScreen(screenId: string, on: boolean): Promise<string | null> {
      try {
        await api.inspectScreen(screenId, { on });
        return null;
      } catch (err) {
        console.error("[console] inspectScreen failed", err);
        // The server's 409s explain themselves ("… is offline — nothing to show an inspector on").
        const detail =
          err instanceof api.ApiError && typeof (err.payload as { error?: unknown })?.error === "string"
            ? (err.payload as { error: string }).error
            : null;
        return detail ?? "The control plane could not reach that screen's machine.";
      }
    },

    /**
     * Permanently forget a single screen (POL-14): drop it from its machine, plus its placement, any
     * combined surface it belonged to, and any selection — optimistically; the authoritative
     * admin/state broadcast reconciles. If the screen's machine still reports the output, the screen
     * reappears on the machine's next reconnect (this targets stale/decommissioned screens).
     */
    async removeScreen(screenId: string): Promise<void> {
      // optimistic prune — remove the screen from whichever machine holds it
      for (const machine of this.machines) {
        const idx = machine.screens.findIndex((s) => s.id === screenId);
        if (idx >= 0) {
          machine.screens.splice(idx, 1);
          break;
        }
      }
      this.placements = this.placements.filter((p) => p.screenId !== screenId);
      this.videoWalls = this.videoWalls.filter((w) => !w.memberScreenIds.includes(screenId));
      this.selectedScreenIds = this.selectedScreenIds.filter((sid) => sid !== screenId);
      if (this.selectedWallId && !this.videoWalls.some((w) => w.id === this.selectedWallId)) {
        this.selectedWallId = null;
      }
      try {
        await api.deleteScreen(screenId);
      } catch (err) {
        console.error("[console] removeScreen failed", err);
      }
    },

    /**
     * Point a single screen at content: either a library source (`{ sourceId }`) — the server
     * resolves it to a surface of that source's kind — or an ad-hoc `{ url }` (a single full-canvas
     * web surface, the Phase-3b behaviour). A whitespace-only URL is ignored.
     */
    async setScreenContent(screenId: string, content: ContentAssignment): Promise<void> {
      const body = normalizeAssignment(content);
      if (!body) return;
      try {
        await api.setScreenContent(screenId, body);
      } catch (err) {
        console.error("[console] setScreenContent failed", err);
      }
    },

    /**
     * Zoom the page on a single screen (POL-57). The authoritative zoom comes back on the next
     * `admin/state`, but we patch the screen's content read-out optimistically so repeated clicks on
     * the − / + buttons step from the value the operator can see rather than from a stale one.
     */
    async setScreenZoom(screenId: string, zoom: number): Promise<void> {
      this.patchScreenZoom([screenId], zoom);
      try {
        await api.setScreenZoom(screenId, zoom);
      } catch (err) {
        console.error("[console] setScreenZoom failed", err);
      }
    },

    /** Write a zoom onto the given screens' content read-outs in place (optimistic; the server's
     *  broadcast overwrites it moments later). Screens with no framed content are left alone. */
    patchScreenZoom(screenIds: readonly string[], zoom: number): void {
      for (const machine of this.machines) {
        for (const screen of machine.screens) {
          if (!screenIds.includes(screen.id) || !screen.content) continue;
          if (screen.content.zoom === undefined) continue;
          screen.content = { ...screen.content, zoom };
        }
      }
    },

    // ── Combined surfaces (video walls, Phase 3b) ───────────────────────────────

    /** Combine ≥2 placed screens on a mural into one spanning surface. Optimistically shows the
     *  combined box immediately (temp id) and selects it; the server's broadcast supplies the real
     *  wall, which `applyMessage` re-points the selection onto. */
    async combine(muralId: string, memberScreenIds: string[]): Promise<void> {
      const members = [...new Set(memberScreenIds)];
      if (!muralId || members.length < 2) return;
      // Only combine screens that are actually placed on this mural.
      const placedHere = members.filter((id) =>
        this.placements.some((p) => p.screenId === id && p.muralId === muralId),
      );
      if (placedHere.length < 2) return;

      const tempId = `wall-pending-${Date.now()}`;
      this.videoWalls.push({ id: tempId, muralId, memberScreenIds: placedHere });
      this.selectedScreenIds = [];
      this.selectedWallId = tempId;
      pendingWallMembers = [...placedHere];

      try {
        await api.combineScreens(muralId, placedHere);
      } catch (err) {
        // Roll the optimistic surface back.
        this.videoWalls = this.videoWalls.filter((w) => w.id !== tempId);
        if (this.selectedWallId === tempId) this.selectedWallId = null;
        if (pendingWallMembers && sameMembers(pendingWallMembers, placedHere)) {
          pendingWallMembers = null;
        }
        console.error("[console] combine failed", err);
      }
    },

    /** Split a combined surface back into its individual screens. */
    async split(wallId: string): Promise<void> {
      this.videoWalls = this.videoWalls.filter((w) => w.id !== wallId); // optimistic
      if (this.selectedWallId === wallId) this.selectedWallId = null;
      try {
        await api.splitWall(wallId);
      } catch (err) {
        console.error("[console] split failed", err);
      }
    },

    /**
     * Assign content that spans across the whole combined surface: a library source (`{ sourceId }`,
     * which spans as a surface of that source's kind) or an ad-hoc `{ url }` (a spanning web surface,
     * the Phase-3b path the walls e2e exercises).
     */
    async setWallContent(wallId: string, content: ContentAssignment): Promise<void> {
      const body = normalizeAssignment(content);
      if (!body) return;
      // A freshly-combined wall is optimistic until the authoritative admin/state arrives with its real
      // id; sending content against the temp id would 404 (and be swallowed). Wait for the real wall.
      if (wallId.startsWith("wall-pending")) return;
      try {
        await api.setWallContent(wallId, body);
      } catch (err) {
        console.error("[console] setWallContent failed", err);
      }
    },

    /** Zoom the page spanning a combined surface (POL-57) — every member takes the same zoom. */
    async setWallZoom(wallId: string, zoom: number): Promise<void> {
      if (wallId.startsWith("wall-pending")) return;
      const wall = this.videoWalls.find((w) => w.id === wallId);
      if (wall) this.patchScreenZoom(wall.memberScreenIds, zoom);
      try {
        await api.setWallZoom(wallId, zoom);
      } catch (err) {
        console.error("[console] setWallZoom failed", err);
      }
    },

    /**
     * Rename a combined surface. Optimistically patches the wall's `name` so the canvas + inspector
     * update instantly; the authoritative admin/state broadcast reconciles. A blank name is ignored
     * (the contract requires min length 1 — a wall with no name derives a member-join label instead).
     * A freshly-combined wall is optimistic until its real id arrives, so renaming the temp id is a
     * no-op (it would 404 and be swallowed); wait for the real wall.
     */
    async renameWall(wallId: string, name: string): Promise<void> {
      const trimmed = name.trim();
      if (!trimmed) return;
      if (wallId.startsWith("wall-pending")) return;
      const wall = this.videoWalls.find((w) => w.id === wallId);
      if (wall) wall.name = trimmed; // optimistic
      try {
        await api.renameVideoWall(wallId, trimmed);
      } catch (err) {
        console.error("[console] renameWall failed", err);
      }
    },

    /** Flash every panel of a combined surface so an operator can map it on the wall. */
    async identWall(wallId: string): Promise<void> {
      try {
        await api.identWall(wallId, { on: true, ttlMs: 3000 });
      } catch (err) {
        console.error("[console] identWall failed", err);
      }
    },

    // ── Content library (Phase 3c) ──────────────────────────────────────────────

    /** Create a library source. The authoritative admin/state broadcast adds it to contentSources.
     *  Returns the created source (the Studio needs the server-assigned id), or null on failure. */
    async createSource(body: CreateContentSourceBody): Promise<ContentSource | null> {
      try {
        return await api.createContentSource(body);
      } catch (err) {
        console.error("[console] createSource failed", err);
        return null;
      }
    },

    /**
     * Update a library source (partial). The server re-resolves and re-pushes to every screen + wall
     * currently showing it — that "live library" re-render is the server's job; here we just optimistically
     * patch local state so the Content view feels instant until the authoritative broadcast lands.
     */
    async updateSource(id: string, body: UpdateContentSourceBody): Promise<boolean> {
      const existing = this.contentSources.find((s) => s.id === id);
      if (existing) Object.assign(existing, body); // optimistic
      try {
        await api.updateContentSource(id, body);
        return true;
      } catch (err) {
        console.error("[console] updateSource failed", err);
        return false;
      }
    },

    /** Delete a library source. The server clears any screen/wall assignment that referenced it. */
    async deleteSource(id: string): Promise<boolean> {
      this.contentSources = this.contentSources.filter((s) => s.id !== id); // optimistic
      if (this.pickedSourceId === id) this.pickedSourceId = null;
      try {
        await api.deleteContentSource(id);
        return true;
      } catch (err) {
        console.error("[console] deleteSource failed", err);
        return false;
      }
    },

    // ── Credential profiles (POL-24) ────────────────────────────────────────────

    /** Create a credential profile. Like createSource, the authoritative broadcast adds it (no
     *  optimistic insert — the id is server-assigned). */
    async createProfile(body: CreateCredentialProfileBody): Promise<boolean> {
      try {
        await api.createCredentialProfile(body);
        return true;
      } catch (err) {
        console.error("[console] createProfile failed", err);
        return false;
      }
    },

    /** Update a profile (clientSecret omitted = unchanged). Optimistic on the non-secret fields. */
    async updateProfile(id: string, body: UpdateCredentialProfileBody): Promise<boolean> {
      const existing = this.credentialProfiles.find((p) => p.id === id);
      if (existing) {
        const { clientSecret: _secret, ...visible } = body; // the view never holds the secret
        Object.assign(existing, visible);
      }
      try {
        await api.updateCredentialProfile(id, body);
        return true;
      } catch (err) {
        console.error("[console] updateProfile failed", err);
        return false;
      }
    },

    /**
     * Delete a profile. The server REFUSES (409) while any source references it; that surfaces here
     * as `"in-use"` so the view can tell the operator to reassign first, distinct from a plain failure.
     */
    async deleteProfile(id: string): Promise<true | "in-use" | false> {
      try {
        await api.deleteCredentialProfile(id);
        this.credentialProfiles = this.credentialProfiles.filter((p) => p.id !== id);
        return true;
      } catch (err) {
        if (err instanceof api.ApiError && err.status === 409) return "in-use";
        console.error("[console] deleteProfile failed", err);
        return false;
      }
    },

    /** Force a token exchange NOW and return the IdP's live answer (the modal's Test button). */
    async testProfile(id: string): Promise<CredentialProfileTestResult> {
      try {
        return await api.testCredentialProfile(id);
      } catch (err) {
        console.error("[console] testProfile failed", err);
        return { ok: false, error: "Request failed — is the server reachable?" };
      }
    },

    /**
     * Upload an image/video file (Phase 7). POSTs the file to the GATED /api/v1/media route; the
     * server saves it to its disk volume and mints a backing ContentSource (kind image|video) whose
     * `url` points at the ungated /media/:id serve route. As with createSource, the authoritative
     * admin/state broadcast is what actually adds the new source to `contentSources` — we don't push
     * it locally here, so the library reconciles from the wire exactly like a linked source.
     *
     * Returns a result object the view can act on: `ok` plus, on failure, a human-readable `error`
     * (special-casing 413 "too large" and 415 "unsupported type"). `onProgress` (0..1) is forwarded
     * to the transport so the picker can show an upload bar.
     */
    async uploadSource(
      file: File,
      name?: string,
      onProgress?: (fraction: number) => void,
    ): Promise<{ ok: boolean; error?: string }> {
      try {
        await api.uploadMedia(file, name, onProgress);
        return { ok: true };
      } catch (err) {
        console.error("[console] uploadSource failed", err);
        if (err instanceof api.ApiError) {
          if (err.status === 413) return { ok: false, error: "File too large for upload." };
          if (err.status === 415) {
            return { ok: false, error: "Unsupported file type — upload an image or video." };
          }
          const payloadMsg =
            err.payload && typeof err.payload === "object" && "error" in err.payload
              ? String((err.payload as { error: unknown }).error)
              : null;
          return { ok: false, error: payloadMsg ?? "Upload failed. Please try again." };
        }
        return { ok: false, error: "Upload failed. Please try again." };
      }
    },

    /** Arm a library source for click-to-assign (toggles off if it's already armed). */
    pickSource(id: string): void {
      this.pickedSourceId = this.pickedSourceId === id ? null : id;
    },

    /** Disarm any click-to-assign source. */
    clearPickedSource(): void {
      this.pickedSourceId = null;
    },

    /** A library source drag started (dragstart on the tray item). */
    beginSourceDrag(id: string): void {
      this.draggingSourceId = id;
    },

    /** The drag ended (dropped or cancelled). */
    endSourceDrag(): void {
      this.draggingSourceId = null;
    },

    /** Assign the armed source to a screen, then disarm. No-op if nothing is armed. */
    assignPickedToScreen(screenId: string): void {
      const id = this.pickedSourceId;
      if (!id) return;
      this.setScreenContent(screenId, { sourceId: id });
      this.pickedSourceId = null;
    },

    /** Assign the armed source to a combined surface (spans across it), then disarm. */
    assignPickedToWall(wallId: string): void {
      const id = this.pickedSourceId;
      if (!id) return;
      this.setWallContent(wallId, { sourceId: id });
      this.pickedSourceId = null;
    },

    // ── Scenes (Phase 3d) ───────────────────────────────────────────────────────

    /**
     * Save the CURRENT wall of a mural as a named scene. The server snapshots the mural's placements,
     * walls and per-screen/per-wall content; the authoritative admin/state broadcast adds the new
     * scene to `scenes`. Returns false (without throwing) if the name is blank or the POST fails.
     */
    async saveScene(name: string, muralId: string): Promise<boolean> {
      const trimmed = name.trim();
      if (!trimmed || !muralId) return false;
      try {
        const scene = await api.createScene({ name: trimmed, muralId });
        // Optimistically mark the freshly-saved scene active until the broadcast lands.
        if (scene && typeof scene.id === "string") this.activeSceneId = scene.id;
        return true;
      } catch (err) {
        console.error("[console] saveScene failed", err);
        return false;
      }
    },

    /**
     * Re-apply a saved scene to its mural in one click: the server re-lays the wall (split/place/move),
     * re-groups the video walls and re-assigns content, then pushes the new slices live (the instant
     * path — content rides the existing stable-id render path, so an unchanged scene refreshes in
     * place). We optimistically mark it active; the next admin/state reflects the re-laid wall.
     */
    async applyScene(id: string): Promise<void> {
      const scene = this.scenes.find((sc) => sc.id === id);
      if (!scene) return;
      this.activeSceneId = id; // optimistic
      // Switch the canvas to the scene's mural so the operator watches it re-lay live.
      if (this.murals.some((m) => m.id === scene.muralId)) this.activeMuralId = scene.muralId;
      try {
        await api.applyScene(id);
      } catch (err) {
        console.error("[console] applyScene failed", err);
      }
    },

    /**
     * Update a saved scene: rename it and/or set its illustrative schedule time (`scheduleAt` is
     * "HH:MM", or null to clear). The schedule is STORED, NOT FIRED — it's illustrative only (D24);
     * nothing in the console or server activates a scene at that time.
     */
    async updateScene(id: string, body: UpdateSceneBody): Promise<void> {
      const scene = this.scenes.find((sc) => sc.id === id);
      if (scene) {
        // optimistic patch
        if (body.name !== undefined) scene.name = body.name;
        if (body.scheduleAt !== undefined) {
          scene.scheduleAt = body.scheduleAt === null ? undefined : body.scheduleAt;
        }
      }
      try {
        await api.updateScene(id, body);
      } catch (err) {
        console.error("[console] updateScene failed", err);
      }
    },

    /** Convenience: rename a scene (a thin wrapper over updateScene). Ignores a blank name. */
    async renameSceneTo(id: string, name: string): Promise<void> {
      const trimmed = name.trim();
      if (!trimmed) return;
      await this.updateScene(id, { name: trimmed });
    },

    /** Convenience: set (or clear, with "") a scene's illustrative schedule time. */
    async scheduleScene(id: string, scheduleAt: string): Promise<void> {
      const trimmed = scheduleAt.trim();
      await this.updateScene(id, { scheduleAt: trimmed === "" ? null : trimmed });
    },

    /** Delete a saved scene. */
    async deleteScene(id: string): Promise<void> {
      this.scenes = this.scenes.filter((sc) => sc.id !== id); // optimistic
      if (this.activeSceneId === id) this.activeSceneId = null;
      try {
        await api.deleteScene(id);
      } catch (err) {
        console.error("[console] deleteScene failed", err);
      }
    },

    // ── Selection & theme ───────────────────────────────────────────────────────

    /** Select zero or more individual screens (clears any combined-surface selection). */
    select(ids: string[]): void {
      this.selectedScreenIds = [...ids];
      this.selectedWallId = null;
    },

    /** Select a combined surface (clears any individual-screen selection). */
    selectWall(wallId: string): void {
      this.selectedWallId = wallId;
      this.selectedScreenIds = [];
    },

    toggleTheme(): void {
      this.theme = this.theme === "light" ? "dark" : "light";
      try {
        localStorage.setItem(THEME_KEY, this.theme);
      } catch {
        /* storage unavailable */
      }
    },
  },
});
