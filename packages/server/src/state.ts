/**
 * Desired-state for the Polyptych control plane, backed by a durable Store.
 *
 * This module owns the single global `DesiredState` (revision starts at 0) plus the machine
 * registry. It knows nothing about sockets or HTTP — it is state + mutations + write-through.
 *
 * Persistence (Phase 2a): on `init()` it LOADs the persisted registry from the Store into the
 * in-memory working copy and RESUMES the revision; every mutation (registerMachine,
 * setScreenSurfaces, setDemoWeb, renameScreen) WRITES THROUGH to the Store before returning, so a
 * rename — and everything else — survives a server restart. The in-memory copy + revision semantics
 * are unchanged from Phase 1; the Store is added underneath.
 *
 * Screen ids are assigned sequentially ("screen-1", "screen-2", …) GLOBALLY across machines in
 * registration order. The mapping is stable per (machineId, connector): a reconnecting machine
 * reuses its existing screen ids, and the counter resumes past the highest persisted id on boot.
 */
import { WebSurface } from "@polyptych/protocol";
import type {
  DesiredState,
  DisplayBackend,
  Machine,
  Output,
  Screen,
  ScreenSlice,
  Surface,
} from "@polyptych/protocol";

import type { PersistedMachine, Store } from "./store/types";

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
  backend: DisplayBackend;
  outputs: Output[];
}

export interface RegisterMachineResult {
  /** True if registration changed desired state (new screen(s) created) and bumped the revision. */
  changed: boolean;
  assignments: ScreenAssignment[];
}

function toPersistedMachine(machine: Machine): PersistedMachine {
  return {
    id: machine.id,
    label: machine.label,
    agentVersion: machine.agentVersion,
    backend: machine.backend,
    outputs: machine.outputs,
    lastSeen: machine.lastSeen,
  };
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
  private screenCounter = 0;

  constructor(private readonly store: Store) {}

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
        lastSeen: m.lastSeen,
      });
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
  }

  private bumpRevision(): number {
    this.state.revision += 1;
    return this.state.revision;
  }

  /**
   * Upsert a machine and ensure a Screen (+ empty slice) exists per output. Write-through: persists
   * the machine, any newly created screens/content, and the revision (if it changed).
   * Returns the per-output assignments for the `server/apply` reply.
   */
  async registerMachine(input: RegisterMachineInput): Promise<RegisterMachineResult> {
    const machine: Machine = {
      id: input.machineId,
      label: input.machineId,
      agentVersion: input.agentVersion,
      backend: input.backend,
      outputs: input.outputs,
      lastSeen: new Date().toISOString(),
    };
    this.machines.set(input.machineId, machine);

    let changed = false;
    const assignments: ScreenAssignment[] = [];
    const newScreens: Screen[] = [];
    const touchedSlices: ScreenSlice[] = [];

    for (const output of input.outputs) {
      let screen = this.state.screens.find(
        (s) => s.machineId === input.machineId && s.connector === output.connector,
      );

      if (!screen) {
        this.screenCounter += 1;
        const id = `screen-${this.screenCounter}`;
        screen = {
          id,
          friendlyName: `Screen ${this.screenCounter}`,
          machineId: input.machineId,
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

    if (changed) this.bumpRevision();

    // Write-through: machine (lastSeen always changes), new screens, new/healed content, revision.
    await this.store.upsertMachine(toPersistedMachine(machine));
    for (const s of newScreens) {
      await this.store.upsertScreen({
        id: s.id,
        friendlyName: s.friendlyName,
        machineId: s.machineId,
        connector: s.connector,
      });
    }
    for (const slice of touchedSlices) {
      await this.store.upsertContent({
        screenId: slice.screenId,
        canvas: slice.canvas,
        surfaces: slice.surfaces,
      });
    }
    if (changed) await this.store.setRevision(this.state.revision);

    return { changed, assignments };
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
    this.bumpRevision();

    await this.store.upsertContent({
      screenId,
      canvas: next.canvas,
      surfaces: next.surfaces,
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
    this.bumpRevision();

    await this.store.upsertContent({
      screenId,
      canvas: next.canvas,
      surfaces: next.surfaces,
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
    screen.friendlyName = friendlyName;

    await this.store.upsertScreen({
      id: screen.id,
      friendlyName: screen.friendlyName,
      machineId: screen.machineId,
      connector: screen.connector,
    });
    return screen;
  }
}
