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
import type { MachineView, Mural, Placement, ScreenView, VideoWall } from "@polyptic/protocol";

import * as api from "../api";

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
  activeMuralId: string | null;
  selectedScreenIds: string[];
  /** A combined surface selected on the canvas (mutually exclusive with selectedScreenIds). */
  selectedWallId: string | null;
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
    activeMuralId: null,
    selectedScreenIds: [],
    selectedWallId: null,
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

    /** Point a single screen at a URL (a single full-canvas web surface). */
    async setScreenContent(screenId: string, url: string): Promise<void> {
      const trimmed = url.trim();
      if (!trimmed) return;
      try {
        await api.setScreenContent(screenId, trimmed);
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

    /** Assign content (a URL) that spans across the whole combined surface. */
    async setWallContent(wallId: string, url: string): Promise<void> {
      const trimmed = url.trim();
      if (!trimmed) return;
      // A freshly-combined wall is optimistic until the authoritative admin/state arrives with its real
      // id; sending content against the temp id would 404 (and be swallowed). Wait for the real wall.
      if (wallId.startsWith("wall-pending")) return;
      try {
        await api.setWallContent(wallId, trimmed);
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
