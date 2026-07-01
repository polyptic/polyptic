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
import {
  ContentSource,
  DashboardSurface,
  ImageSurface,
  Scene,
  VideoSurface,
  VideoWall,
  WebSurface,
} from "@polyptic/protocol";
import type {
  ContentKind,
  CreateContentSourceBody,
  DesiredState,
  DisplayBackend,
  Geometry,
  Machine,
  Mural,
  Output,
  Placement,
  SceneContent,
  Screen,
  ScreenSlice,
  Surface,
  UpdateContentSourceBody,
  UpdateSceneBody,
} from "@polyptic/protocol";
import type { AgentUpdateState } from "@polyptic/protocol";

import type { PersistedMachine, PersistedScene, Store } from "./store/types";
import type { ActivityLog } from "./activity";

/** Where players live. The agent points each output's Chromium/browser at this base + ?screen=<id>. */
const PLAYER_BASE_URL = process.env.PLAYER_BASE_URL ?? "http://localhost:5173";

/** Fallback canvas for a player that connects before its screen is known. */
const DEFAULT_CANVAS = { x: 0, y: 0, w: 1920, h: 1080 } as const;

function playerUrlFor(screenId: string): string {
  return `${PLAYER_BASE_URL}/?screen=${encodeURIComponent(screenId)}`;
}

/** One entry of the `server/apply` payload: which screen an output is, and where to point its player. */
export interface ScreenAssignment {
  connector: string;
  screenId: string;
  playerUrl: string;
}

export interface RegisterMachineInput {
  machineId: string;
  agentVersion: string;
  /** OTA (POL-28) — the agent's provisioning epoch, if it reported one (pre-OTA agents omit it). */
  provisionEpoch?: number;
  backend: DisplayBackend;
  outputs: Output[];
  /** The box's os.hostname(), used as the human machine label on first registration. */
  hostname?: string;
}

/** OTA (POL-28) — a machine's LIVE self-update runtime (ephemeral; never persisted). */
export interface AgentReport {
  updateState?: AgentUpdateState;
  updateError?: string;
  /** The version the agent said it is updating toward, if any. */
  targetVersion?: string;
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

/**
 * An assignment of content to a screen or wall (Phase 3c): EITHER a library source (`sourceId`) OR an
 * ad-hoc link (`url`). Exactly one is set (the REST edge validates this via `SetContentBody`).
 */
export interface ContentAssignment {
  sourceId?: string;
  url?: string;
}

/** A resolved content spec: the kind to build and the URL to point it at. */
interface ResolvedSpec {
  kind: ContentKind;
  url: string;
}

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
  /** OTA (POL-28) — machineId → live self-update runtime (ephemeral; from agent/status heartbeats). */
  private readonly agentReports = new Map<string, AgentReport>();
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

  /** Phase 3d — saved wall snapshots (scenes), keyed by scene id. */
  private readonly scenes = new Map<string, Scene>();
  private sceneCounter = 0;

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
      scheduleAt: scene.scheduleAt ?? null,
    };
  }

  /** Project the in-memory machine (+ its side-mapped credential hash) onto the storage DTO. */
  private toPersistedMachine(machine: Machine): PersistedMachine {
    return {
      id: machine.id,
      label: machine.label,
      agentVersion: machine.agentVersion,
      provisionEpoch: machine.provisionEpoch,
      backend: machine.backend,
      outputs: machine.outputs,
      status: machine.status,
      credentialHash: this.credentialHashes.get(machine.id),
      lastSeen: machine.lastSeen,
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
        provisionEpoch: m.provisionEpoch,
        backend: m.backend,
        outputs: m.outputs,
        // Legacy rows without a status load as `approved` (Phase 2a parity).
        status: m.status ?? "approved",
        lastSeen: m.lastSeen,
      });
      if (m.credentialHash) this.credentialHashes.set(m.id, m.credentialHash);
    }

    for (const s of persisted.screens) {
      this.state.screens.push({
        id: s.id,
        friendlyName: s.friendlyName,
        machineId: s.machineId,
        connector: s.connector,
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

    // ── Content library (Phase 3c) ────────────────────────────────────────────
    for (const cs of persisted.contentSources) {
      // Re-validate at the edge; drop a malformed/legacy row rather than crash the boot.
      const parsed = ContentSource.safeParse(cs);
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
        ...(ps.scheduleAt ? { scheduleAt: ps.scheduleAt } : {}),
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

    // Seed a default mural the first time a deployment boots, so the Wall view always has a canvas.
    if (this.murals.size === 0) {
      const id = this.nextMuralId();
      const mural: Mural = { id, name: "Wall" };
      this.murals.set(id, mural);
      await this.store.upsertMural({ id: mural.id, name: mural.name });
    }
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
        playerUrl: playerUrlFor(screen.id),
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
      // An operator rename wins (label diverged from the machineId default); otherwise adopt the box
      // hostname, so an already-registered machine still UUID-labelled relabels on its next hello.
      label: existing && existing.label !== existing.id ? existing.label : (input.hostname ?? input.machineId),
      agentVersion: input.agentVersion,
      provisionEpoch: input.provisionEpoch ?? existing?.provisionEpoch,
      backend: input.backend,
      outputs: input.outputs,
      status: "approved",
      lastSeen: new Date().toISOString(),
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
      // An operator rename wins (label diverged from the machineId default); otherwise adopt the box
      // hostname, so an already-registered machine still UUID-labelled relabels on its next hello.
      label: existing && existing.label !== existing.id ? existing.label : (input.hostname ?? input.machineId),
      agentVersion: input.agentVersion,
      provisionEpoch: input.provisionEpoch ?? existing?.provisionEpoch,
      backend: input.backend,
      outputs: input.outputs,
      status: "pending",
      lastSeen: new Date().toISOString(),
    };
    this.machines.set(input.machineId, machine);
    await this.store.upsertMachine(this.toPersistedMachine(machine));
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
      for (const s of this.clearSlices(wall.memberScreenIds)) touched.set(s.screenId, s);
    }

    // Clear + drop each of the machine's screens (slice, placement, desired-state entry).
    for (const id of screenIds) {
      for (const s of this.clearSlices([id])) touched.set(s.screenId, s);
      this.placements.delete(id); // store.deleteMachine cascades the placement row
      delete this.state.slices[id];
      const idx = this.state.screens.findIndex((s) => s.id === id);
      if (idx >= 0) this.state.screens.splice(idx, 1);
    }

    // Drop the machine itself (+ its off-band credential + live OTA runtime). deleteMachine cascades
    // screens/content/placements.
    this.machines.delete(machineId);
    this.credentialHashes.delete(machineId);
    this.agentReports.delete(machineId);
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

  /**
   * OTA (POL-28) — fold an agent's heartbeat report into the registry. Updates the DURABLE version +
   * provisioning epoch on the machine (write-through, only when they actually change — heartbeats are
   * frequent) and the EPHEMERAL live update runtime (updateState/updateError/targetVersion) held off
   * the persisted row. Returns true iff the persisted machine changed (so the caller knows a durable
   * write happened). No-op for an unknown machine.
   */
  async recordAgentReport(
    machineId: string,
    report: {
      agentVersion?: string;
      provisionEpoch?: number;
      updateState?: AgentUpdateState;
      updateError?: string;
      targetVersion?: string;
    },
  ): Promise<boolean> {
    const machine = this.machines.get(machineId);
    if (!machine) return false;

    // Live runtime (ephemeral) — always refreshed from the latest heartbeat.
    this.agentReports.set(machineId, {
      updateState: report.updateState,
      updateError: report.updateError,
      targetVersion: report.targetVersion,
    });

    // Durable fields — persist only on a real change to avoid write amplification on every heartbeat.
    let changed = false;
    if (report.agentVersion !== undefined && report.agentVersion !== machine.agentVersion) {
      machine.agentVersion = report.agentVersion;
      changed = true;
    }
    if (report.provisionEpoch !== undefined && report.provisionEpoch !== machine.provisionEpoch) {
      machine.provisionEpoch = report.provisionEpoch;
      changed = true;
    }
    if (changed) {
      machine.lastSeen = new Date().toISOString();
      await this.store.upsertMachine(this.toPersistedMachine(machine));
    }
    return changed;
  }

  /** OTA (POL-28) — the machine's last reported live update runtime, if any. */
  agentReport(machineId: string): AgentReport | undefined {
    return this.agentReports.get(machineId);
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
    });
    if (previousName !== friendlyName) this.emit("info", `${previousName} renamed`);
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
  screenContentSummary(screenId: string): { name: string; kind: ContentKind } | null {
    const wall = this.getWallForScreen(screenId);
    const sourceId = wall ? this.wallSourceIds.get(wall.id) : this.screenSourceIds.get(screenId);
    if (sourceId) {
      const src = this.contentSources.get(sourceId);
      if (src) return { name: src.name, kind: src.kind };
    }
    const surface = this.state.slices[screenId]?.surfaces[0];
    if (!surface) return null;
    const kind = surface.type as ContentKind;
    const raw = "url" in surface ? surface.url : "src" in surface ? surface.src : "";
    return { name: this.contentNameFromUrl(raw, kind), kind };
  }

  /** A friendly name for ad-hoc content: the URL host, else a kind label. */
  private contentNameFromUrl(raw: string, kind: ContentKind): string {
    try {
      const h = new URL(raw).host;
      if (h) return h;
    } catch {
      /* not a URL */
    }
    return kind === "web" ? "Web page" : kind === "dashboard" ? "Dashboard" : kind === "image" ? "Image" : "Video";
  }

  /** A human content name for an activity line: the library source's name, else the ad-hoc URL's host. */
  private resolvedContentName(spec: ResolvedSpec, sourceId: string | null): string {
    if (sourceId) {
      const src = this.contentSources.get(sourceId);
      if (src) return src.name;
    }
    return this.contentNameFromUrl(spec.url, spec.kind);
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
   * the INSTANT property — D5).
   */
  private buildSurface(spec: ResolvedSpec, id: string, region: Geometry, span?: Span): Surface {
    const base = span ? { id, region, span } : { id, region };
    switch (spec.kind) {
      case "web":
        return WebSurface.parse({
          ...base,
          type: "web",
          url: spec.url,
          placement: "iframe",
          interactive: false,
        });
      case "dashboard":
        return DashboardSurface.parse({ ...base, type: "dashboard", url: spec.url });
      case "image":
        return ImageSurface.parse({ ...base, type: "image", src: spec.url, fit: "cover" });
      case "video":
        return VideoSurface.parse({ ...base, type: "video", src: spec.url, loop: true, muted: true });
    }
  }

  /**
   * Resolve a content assignment to a concrete spec + the sourceId to record (null for ad-hoc). An
   * ad-hoc `url` becomes a web spec (exactly the Phase 3b behaviour); a `sourceId` is looked up in the
   * library and resolved to its kind+url (error if unknown).
   */
  private resolveSpec(
    a: ContentAssignment,
  ): { spec: ResolvedSpec; sourceId: string | null } | { error: "unknown-source" } {
    if (a.url !== undefined) {
      return { spec: { kind: "web", url: a.url }, sourceId: null };
    }
    const source = a.sourceId !== undefined ? this.contentSources.get(a.sourceId) : undefined;
    if (!source) return { error: "unknown-source" };
    return { spec: { kind: source.kind, url: source.url }, sourceId: source.id };
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
   */
  private computeWallSlices(wall: VideoWall, spec: ResolvedSpec): ScreenSlice[] {
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

    // Recompute each member's span slice (union-bbox math, any surface kind — Phase 3b + 3c).
    const slices = this.computeWallSlices(wall, resolved.spec);
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

    // Stable surface id ("content-web") so repeated assignments patch the player's tile in place (D5).
    const surface = this.buildSurface(resolved.spec, "content-web", {
      x: 0,
      y: 0,
      w: slice.canvas.w,
      h: slice.canvas.h,
    });
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

  /** Create a new library source with a server-assigned id. Write-through. */
  async createContentSource(body: CreateContentSourceBody): Promise<ContentSource> {
    const id = this.nextSourceId();
    const source = ContentSource.parse({ id, name: body.name, kind: body.kind, url: body.url });
    this.contentSources.set(id, source);
    await this.store.upsertContentSource({
      id: source.id,
      name: source.name,
      kind: source.kind,
      url: source.url,
    });
    return source;
  }

  /**
   * Update a library source (any subset of name/kind/url). If the source is currently assigned to any
   * screen(s) or wall(s), each is RE-RESOLVED against the new kind/url and the touched slices are
   * returned (one revision bump, write-through) for the caller to push live. Returns null if unknown.
   */
  async updateContentSource(
    id: string,
    patch: UpdateContentSourceBody,
  ): Promise<{ source: ContentSource; slices: ScreenSlice[] } | null> {
    const existing = this.contentSources.get(id);
    if (existing === undefined) return null;

    const source = ContentSource.parse({
      id: existing.id,
      name: patch.name ?? existing.name,
      kind: patch.kind ?? existing.kind,
      url: patch.url ?? existing.url,
    });
    this.contentSources.set(id, source);
    await this.store.upsertContentSource({
      id: source.id,
      name: source.name,
      kind: source.kind,
      url: source.url,
    });

    // Re-resolve every screen + wall currently showing this source.
    const spec: ResolvedSpec = { kind: source.kind, url: source.url };
    const byScreen = new Map<string, ScreenSlice>();

    for (const [screenId, sid] of this.screenSourceIds) {
      if (sid !== id) continue;
      const slice = this.state.slices[screenId];
      if (slice === undefined) continue;
      const surface = this.buildSurface(spec, "content-web", {
        x: 0,
        y: 0,
        w: slice.canvas.w,
        h: slice.canvas.h,
      });
      const next: ScreenSlice = { ...slice, surfaces: [surface] };
      this.state.slices[screenId] = next;
      byScreen.set(screenId, next);
    }

    for (const [wallId, sid] of this.wallSourceIds) {
      if (sid !== id) continue;
      const wall = this.videoWalls.get(wallId);
      if (wall === undefined) continue;
      for (const next of this.computeWallSlices(wall, spec)) byScreen.set(next.screenId, next);
    }

    const slices = [...byScreen.values()];
    if (slices.length > 0) {
      this.bumpRevision();
      for (const slice of slices) {
        await this.store.upsertContent({
          screenId: slice.screenId,
          canvas: slice.canvas,
          surfaces: slice.surfaces,
          sourceId: id,
        });
      }
      await this.store.setRevision(this.state.revision);
    }

    return { source, slices };
  }

  /**
   * Delete a library source. Any screen(s)/wall(s) currently showing it have their content CLEARED
   * (empty slices — the assignment is gone), and those cleared slices are returned (one revision bump,
   * write-through) for the caller to push. A cleared wall keeps its combined structure but spans no
   * content until reassigned. Returns null if the source is unknown.
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

    const slices = [...byScreen.values()];
    if (slices.length > 0) {
      this.bumpRevision();
      for (const slice of slices) {
        await this.store.upsertContent({
          screenId: slice.screenId,
          canvas: slice.canvas,
          surfaces: slice.surfaces,
          sourceId: null,
        });
      }
      await this.store.setRevision(this.state.revision);
    }

    return { slices };
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
  // url. `scheduleAt` ("HH:MM") is ILLUSTRATIVE: it is stored, NOT fired (D24) — nothing here activates
  // a scene at that time.

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

  /** The renderable URL a surface points at (web/dashboard → `url`, image/video → `src`), if any. */
  private surfaceUrl(surface: Surface): string | undefined {
    switch (surface.type) {
      case "web":
      case "dashboard":
        return surface.url;
      case "image":
      case "video":
        return surface.src;
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
   * Update a saved scene: rename it and/or set its ILLUSTRATIVE schedule time (`scheduleAt` is "HH:MM";
   * null clears it — STORED, NOT FIRED, D24). Write-through. Does NOT bump the revision (registry
   * metadata). Returns the updated scene, or null if unknown.
   */
  async updateScene(id: string, patch: UpdateSceneBody): Promise<Scene | null> {
    const existing = this.scenes.get(id);
    if (existing === undefined) return null;

    const next: Scene = { ...existing };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.scheduleAt !== undefined) {
      if (patch.scheduleAt === null) delete next.scheduleAt;
      else next.scheduleAt = patch.scheduleAt;
    }

    const scene = Scene.parse(next);
    this.scenes.set(id, scene);
    await this.store.upsertScene(this.toPersistedScene(scene));
    return scene;
  }

  /**
   * Delete a saved scene. If it was the active scene, clears DesiredState.activeSceneId. Write-through.
   * Does NOT touch the live wall (a scene is just a saved snapshot). Returns false if unknown.
   */
  async deleteScene(id: string): Promise<boolean> {
    if (!this.scenes.has(id)) return false;
    this.scenes.delete(id);
    if (this.state.activeSceneId === id) this.state.activeSceneId = null;
    await this.store.deleteScene(id);
    return true;
  }
}
