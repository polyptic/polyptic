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
  ContentKind,
  ContentSource,
  CreateContentSourceBody,
  MachineView,
  Mural,
  Placement,
  Scene,
  ScreenView,
  UpdateContentSourceBody,
  UpdateSceneBody,
  VideoWall,
} from "@polyptic/protocol";

import * as api from "../api";

/** Assigning content takes EITHER a library source by id OR an ad-hoc URL — exactly one (the
 *  contract's SetContentBody refinement). The ad-hoc URL path is the Phase-3b behaviour. */
export type ContentAssignment = { sourceId: string } | { url: string };

const ADMIN_WS_URL = "ws://localhost:8080/admin";
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
  connected: boolean;
  revision: number;
  machines: MachineView[];
  murals: Mural[];
  placements: Placement[];
  videoWalls: VideoWall[];
  /** The content LIBRARY (Phase 3c) — reusable named sources, mirrored from admin/state. */
  contentSources: ContentSource[];
  /** Saved wall snapshots (Phase 3d), mirrored from admin/state. */
  scenes: Scene[];
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
  theme: "light" | "dark";
}

type PlacedEntry = { screen: ScreenView; placement: Placement };
type WallBounds = { x: number; y: number; w: number; h: number };

export const useConsoleStore = defineStore("console", {
  state: (): ConsoleState => ({
    connected: false,
    revision: 0,
    machines: [],
    murals: [],
    placements: [],
    videoWalls: [],
    contentSources: [],
    scenes: [],
    activeSceneId: null,
    activeMuralId: null,
    selectedScreenIds: [],
    selectedWallId: null,
    pickedSourceId: null,
    theme: initialTheme(),
  }),

  getters: {
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

    /** A display name for a combined surface. The contract carries no wall name, so we derive one
     *  from the member screens (e.g. "Nessie + Bertha"). */
    wallName(): (wallId: string) => string {
      return (wallId: string) => {
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

    /** Library sources bucketed by kind (web/dashboard/image/video) — every kind key present. */
    sourcesByKind(state): Record<ContentKind, ContentSource[]> {
      const buckets: Record<ContentKind, ContentSource[]> = {
        web: [],
        dashboard: [],
        image: [],
        video: [],
      };
      for (const s of state.contentSources) buckets[s.kind].push(s);
      return buckets;
    },

    sourceById(): (id: string) => ContentSource | undefined {
      return (id: string) => this.contentSources.find((s) => s.id === id);
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
        this.revision = msg.revision;
        this.machines = msg.machines;
        this.murals = msg.murals;
        this.placements = msg.placements;
        this.videoWalls = msg.videoWalls;
        this.contentSources = msg.contentSources;
        this.scenes = msg.scenes;

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

    /** Flash every panel of a combined surface so an operator can map it on the wall. */
    async identWall(wallId: string): Promise<void> {
      try {
        await api.identWall(wallId, { on: true, ttlMs: 3000 });
      } catch (err) {
        console.error("[console] identWall failed", err);
      }
    },

    // ── Content library (Phase 3c) ──────────────────────────────────────────────

    /** Create a library source. The authoritative admin/state broadcast adds it to contentSources. */
    async createSource(body: CreateContentSourceBody): Promise<boolean> {
      try {
        await api.createContentSource(body);
        return true;
      } catch (err) {
        console.error("[console] createSource failed", err);
        return false;
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

    /** Arm a library source for click-to-assign (toggles off if it's already armed). */
    pickSource(id: string): void {
      this.pickedSourceId = this.pickedSourceId === id ? null : id;
    },

    /** Disarm any click-to-assign source. */
    clearPickedSource(): void {
      this.pickedSourceId = null;
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
