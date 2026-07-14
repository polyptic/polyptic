/**
 * Backup / restore + declarative state export (POL-113).
 *
 * The control plane owns a fleet's entire configuration. Until now, losing its volume meant
 * re-enrolling every box, re-authoring every page and re-building every scene by hand — and there was
 * no way to move a deployment, stage a change, or see what a week of edits did to the wall.
 *
 * `GET /api/v1/export` produces ONE portable JSON document of the DECLARATIVE state (see
 * `BackupDocument` in @polyptic/protocol for what is in it and what is deliberately not).
 * `POST /api/v1/import` applies it back: a DRY RUN first, which reports every add, update and delete
 * it would make, and then an apply that runs exactly that plan.
 *
 * Three properties this module exists to hold:
 *
 *   1. **No secret ever leaves.** The exporter reads credential profiles through the contract's
 *      secret-free `CredentialProfile` shape — the client secret is not merely omitted, it is not
 *      reachable from the type. Machine credentials, the enrolment token, the mTLS CA key, the
 *      player-token secret and operator password hashes are not touched at all.
 *
 *   2. **A restore goes through the ordinary state paths.** Content is re-applied with
 *      `setScreenContent` / `setWallContent`, exactly as an operator's click would, so the revision
 *      bumps and the fan-out is the normal instant push. A restore cannot strand a wall, because it
 *      is not a special path that could forget to render.
 *
 *   3. **Ids are preserved, never remapped.** The document is a graph keyed by id — placements name
 *      screens, scenes name screens, playlists name sources, zooms name screens and walls. The same
 *      id means the same thing: an existing one is updated in place.
 *
 * The two endpoints are also, deliberately, the GitOps seam: a wall's desired state reviewed in a
 * pull request and applied to a fresh cluster is just `POST /api/v1/import` of a file in git.
 */
import {
  BACKUP_FORMAT_VERSION,
  BackupDocument,
  CredentialProfile,
  ImportResult,
} from "@polyptic/protocol";
import type {
  BackupMediaItem,
  ImportChange,
  ImportMode,
  Mural,
  Placement,
  SceneContent,
} from "@polyptic/protocol";

import type { MediaStore } from "./media";
import type { ControlPlane, ContentAssignment } from "./state";
import type { ScreenSlice } from "@polyptic/protocol";

/** The image-update settings the document carries. Structural, so the ImageUpdates class satisfies it
 *  without this module depending on it (and a unit test can hand in a stub). */
export interface ImageSettingsPort {
  state(): Promise<{
    scheduleEnabled: boolean;
    scheduleTime: string;
    fullScheduleEnabled: boolean;
    fullScheduleDay: number;
    fullScheduleTime: string;
    urgent: boolean;
  }>;
  updateSettings(patch: {
    scheduleEnabled?: boolean;
    scheduleTime?: string;
    fullScheduleEnabled?: boolean;
    fullScheduleDay?: number;
    fullScheduleTime?: string;
    urgent?: boolean;
  }): Promise<unknown>;
}

/** What the exporter needs from the media catalogue: the manifest, and "is this upload here?". */
export interface MediaPort {
  list(): BackupMediaItem[];
  has(id: string): boolean;
}

/** Adapt the real MediaStore to the port (keeps `backup.ts` unaware of disk paths and sidecars). */
export function mediaPort(media: MediaStore): MediaPort {
  return {
    list: () =>
      media.list().map((r) => ({
        id: r.id,
        mime: r.mime,
        size: r.size,
        originalName: r.originalName,
        sourceId: r.sourceId,
      })),
    has: (id) => media.get(id) !== undefined,
  };
}

/** The plain-English "what isn't in here" note the exporter writes into every document. */
const NOT_INCLUDED = [
  "Secrets. Credential-profile client secrets, the enrolment bootstrap token, per-machine credentials, the mTLS CA private key, the player-token secret, operator password hashes and sessions are never exported. A backup file is copied around; a file that is copied around must not be a credential. Credential profiles are exported without their secret (secretExcluded: true) — re-enter each secret after a restore.",
  "Machines and their enrolment. A machine credential is a per-box identity minted by one deployment for one box; replaying it would forge an identity the new deployment never issued. Boxes re-enrol by dialling out, as they always do — and each one then ADOPTS its screen from this backup, because a screen is keyed by (machineId, connector).",
  "Live state. Presence, revisions, thumbnails, live tokens and the activity feed are derived, not desired.",
  "Media files. Uploads are files, not configuration, and can be gigabytes. The `media` manifest lists them by id so a restore can tell you exactly which uploads are missing on the target — re-upload those.",
  "Host configuration. Ports, database URLs, volume paths, TLS material and image-rebuild hooks describe the HOST, not the fleet; they stay in the environment.",
];

// ─────────────────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────────────────

export interface ExportOptions {
  version?: string;
  revision?: string;
  now?: Date;
}

/** Assemble the export document from the live control plane. Pure read — nothing is mutated. */
export async function buildBackup(
  control: ControlPlane,
  media: MediaPort,
  imageSettings: ImageSettingsPort | undefined,
  options: ExportOptions = {},
): Promise<BackupDocument> {
  const walls = control.getVideoWalls();
  const walledScreenIds = new Set(walls.flatMap((w) => w.memberScreenIds));

  const imageState = imageSettings ? await imageSettings.state() : undefined;

  return BackupDocument.parse({
    polypticBackup: BACKUP_FORMAT_VERSION,
    exportedAt: (options.now ?? new Date()).toISOString(),
    generator: {
      product: "polyptic",
      ...(options.version ? { version: options.version } : {}),
      ...(options.revision ? { revision: options.revision } : {}),
    },
    murals: control.getMurals(),
    screens: control.getScreens(),
    placements: control.getPlacements(),
    videoWalls: walls.map((w) => ({ ...w, content: control.contentForWall(w) })),
    // A wall owns its members' content, so only the placed, NON-walled screens carry their own.
    screenContent: control
      .getScreens()
      .filter((s) => !walledScreenIds.has(s.id))
      .map((s) => ({ screenId: s.id, content: control.contentForScreen(s.id) })),
    contentSources: control.getContentSources(),
    // Read through the contract's secret-free shape: the secret is not omitted here, it is unreachable.
    credentialProfiles: control
      .getCredentialProfileViews()
      .map((v) => ({ ...CredentialProfile.parse(v), secretExcluded: true as const })),
    scenes: control.getScenes(),
    zoomPreferences: control.getZoomPreferences(),
    settings: {
      display: control.getDisplaySettings(),
      ...(imageState
        ? {
            imageUpdates: {
              scheduleEnabled: imageState.scheduleEnabled,
              scheduleTime: imageState.scheduleTime,
              fullScheduleEnabled: imageState.fullScheduleEnabled,
              fullScheduleDay: imageState.fullScheduleDay,
              fullScheduleTime: imageState.fullScheduleTime,
              urgent: imageState.urgent,
            },
          }
        : {}),
    },
    media: media.list(),
    notIncluded: NOT_INCLUDED,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Plan (the dry run)
// ─────────────────────────────────────────────────────────────────────────────

/** Stable structural comparison — two entities are "unchanged" when they serialise identically. */
function same(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b);
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
}

/** How a content assignment reads in the diff ("Grafana overview", "https://…", "nothing"). */
function contentLabel(control: ControlPlane, content: SceneContent): string {
  if (!content) return "nothing";
  if (content.sourceId) {
    return control.getContentSource(content.sourceId)?.name ?? `source ${content.sourceId}`;
  }
  return content.url ?? "nothing";
}

function placementLabel(p: Placement): string {
  return `${p.screenId} on ${p.muralId} at ${Math.round(p.x)},${Math.round(p.y)}`;
}

function muralLabel(m: Mural): string {
  return m.name;
}

/**
 * How an UPDATE reads in the diff. Ids are sequential per deployment (`source-3`, `mural-1`), so two
 * deployments that grew independently WILL have minted the same ids for different things — and a
 * merge, which is id-keyed, then overwrites one with the other. That is the honest semantics of
 * "restore this configuration", but it must never be a surprise: when the name changes, the diff line
 * shows BOTH, so the operator reads "Local only → Ops dashboard" in the dry run and can back out.
 */
function updateLabel(before: string, after: string): string {
  return before === after ? after : `${before} → ${after}`;
}

/**
 * Compute what a restore WOULD do — the dry-run diff an operator confirms before anything is touched.
 * Pure: it reads the live control plane and the document, and writes nothing.
 *
 * `merge` (default) plans creates + updates only. `replace` additionally plans the DELETE of every
 * mural, screen, placement, wall, scene, content source and credential profile the document does not
 * mention — i.e. "make this deployment look exactly like the file". Machines and media files are never
 * deleted by a restore in either mode.
 */
export function planImport(
  control: ControlPlane,
  media: MediaPort,
  doc: BackupDocument,
  mode: ImportMode,
): ImportResult {
  const changes: ImportChange[] = [];
  const warnings: string[] = [];
  const push = (
    entity: ImportChange["entity"],
    action: ImportChange["action"],
    id: string,
    label: string,
  ): void => {
    changes.push({ entity, action, id, label });
  };

  // ── Murals ────────────────────────────────────────────────────────────────
  const currentMurals = new Map(control.getMurals().map((m) => [m.id, m]));
  for (const mural of doc.murals) {
    const existing = currentMurals.get(mural.id);
    if (!existing) push("mural", "create", mural.id, muralLabel(mural));
    else if (!same(existing, mural)) {
      push("mural", "update", mural.id, updateLabel(muralLabel(existing), muralLabel(mural)));
    } else push("mural", "unchanged", mural.id, muralLabel(mural));
  }

  // ── Screens ───────────────────────────────────────────────────────────────
  const currentScreens = new Map(control.getScreens().map((s) => [s.id, s]));
  const screensWithoutMachine: string[] = [];
  for (const screen of doc.screens) {
    const existing = currentScreens.get(screen.id);
    if (!existing) push("screen", "create", screen.id, screen.friendlyName);
    else if (!same(existing, screen)) {
      push("screen", "update", screen.id, updateLabel(existing.friendlyName, screen.friendlyName));
    } else push("screen", "unchanged", screen.id, screen.friendlyName);

    if (!control.getMachine(screen.machineId)) screensWithoutMachine.push(screen.id);

    // The one real identity collision: the panel (machineId, connector) is already held here by a
    // DIFFERENT screen id — the target auto-created it when that box enrolled. The backup wins and
    // the auto-created row is removed, so every edge in the document still resolves.
    const conflict = control
      .getScreens()
      .find(
        (s) =>
          s.machineId === screen.machineId && s.connector === screen.connector && s.id !== screen.id,
      );
    if (conflict) {
      push("screen", "delete", conflict.id, `${conflict.friendlyName} (same panel as ${screen.id})`);
      warnings.push(
        `${conflict.id} (${conflict.friendlyName}) drives the same panel as the backup's ${screen.id} — it is replaced, so the backup's placement, content and scenes still resolve.`,
      );
    }
  }

  // ── Placements ────────────────────────────────────────────────────────────
  const currentPlacements = new Map(control.getPlacements().map((p) => [p.screenId, p]));
  const docScreenIds = new Set(doc.screens.map((s) => s.id));
  for (const placement of doc.placements) {
    if (!docScreenIds.has(placement.screenId) && !currentScreens.has(placement.screenId)) {
      warnings.push(`placement for unknown screen ${placement.screenId} — skipped`);
      continue;
    }
    const existing = currentPlacements.get(placement.screenId);
    const action = !existing ? "create" : same(existing, placement) ? "unchanged" : "update";
    push("placement", action, placement.screenId, placementLabel(placement));
  }

  // ── Video walls ───────────────────────────────────────────────────────────
  const currentWalls = new Map(control.getVideoWalls().map((w) => [w.id, w]));
  for (const wall of doc.videoWalls) {
    const { content, ...bare } = wall;
    const existing = currentWalls.get(wall.id);
    const label = `${wall.name ?? wall.id} → ${contentLabel(control, content)}`;
    if (!existing) push("videoWall", "create", wall.id, label);
    else if (!same(existing, bare) || !same(control.contentForWall(existing), content)) {
      push("videoWall", "update", wall.id, label);
    } else push("videoWall", "unchanged", wall.id, label);
  }

  // ── Per-screen content ────────────────────────────────────────────────────
  for (const entry of doc.screenContent) {
    const label = `${
      doc.screens.find((s) => s.id === entry.screenId)?.friendlyName ?? entry.screenId
    } → ${contentLabel(control, entry.content)}`;
    const known = currentScreens.has(entry.screenId);
    const current = known ? control.contentForScreen(entry.screenId) : null;
    if (!known) push("screenContent", "create", entry.screenId, label);
    else if (!same(current, entry.content)) push("screenContent", "update", entry.screenId, label);
    else push("screenContent", "unchanged", entry.screenId, label);
  }

  // ── Content library ───────────────────────────────────────────────────────
  const currentSources = new Map(control.getContentSources().map((s) => [s.id, s]));
  const docSourceIds = new Set(doc.contentSources.map((s) => s.id));
  for (const source of doc.contentSources) {
    const existing = currentSources.get(source.id);
    const label = `${source.name} (${source.kind})`;
    if (!existing) push("contentSource", "create", source.id, label);
    else if (!same(existing, source)) {
      push("contentSource", "update", source.id, updateLabel(`${existing.name} (${existing.kind})`, label));
    } else push("contentSource", "unchanged", source.id, label);

    // Dangling references inside the document itself (a playlist step whose source was pruned).
    for (const item of source.items ?? []) {
      if (!docSourceIds.has(item.sourceId) && !currentSources.has(item.sourceId)) {
        warnings.push(`playlist "${source.name}" references unknown source ${item.sourceId}`);
      }
    }
  }

  // ── Credential profiles ───────────────────────────────────────────────────
  const currentProfiles = new Map(control.getCredentialProfileViews().map((p) => [p.id, p]));
  const credentialProfilesNeedingSecret: string[] = [];
  for (const profile of doc.credentialProfiles) {
    const { secretExcluded: _ignored, ...bare } = profile;
    const existing = currentProfiles.get(profile.id);
    if (!existing) {
      push("credentialProfile", "create", profile.id, `${profile.name} (secret needed)`);
      credentialProfilesNeedingSecret.push(profile.name);
    } else if (!same(CredentialProfile.parse(existing), bare)) {
      push("credentialProfile", "update", profile.id, updateLabel(existing.name, profile.name));
    } else push("credentialProfile", "unchanged", profile.id, profile.name);
  }

  // ── Scenes ────────────────────────────────────────────────────────────────
  const currentScenes = new Map(control.getScenes().map((s) => [s.id, s]));
  for (const scene of doc.scenes) {
    const existing = currentScenes.get(scene.id);
    if (!existing) push("scene", "create", scene.id, scene.name);
    else if (!same(existing, scene)) {
      push("scene", "update", scene.id, updateLabel(existing.name, scene.name));
    } else push("scene", "unchanged", scene.id, scene.name);
  }

  // ── Zoom preferences ──────────────────────────────────────────────────────
  const currentZooms = new Map(
    control.getZoomPreferences().map((p) => [`${p.targetId} ${p.sourceKey}`, p.zoom]),
  );
  for (const pref of doc.zoomPreferences) {
    const key = `${pref.targetId} ${pref.sourceKey}`;
    const label = `${pref.targetId} ${Math.round(pref.zoom * 100)}%`;
    const existing = currentZooms.get(key);
    if (existing === undefined) push("zoomPreference", "create", key, label);
    else if (existing !== pref.zoom) push("zoomPreference", "update", key, label);
    else push("zoomPreference", "unchanged", key, label);
  }

  // ── Settings ──────────────────────────────────────────────────────────────
  if (doc.settings.display) {
    const current = control.getDisplaySettings();
    const action = same(current, doc.settings.display) ? "unchanged" : "update";
    push("settings", action, "display", `on-screen badges ${doc.settings.display.showBadges ? "on" : "off"}`);
  }
  if (doc.settings.imageUpdates) {
    // Image-update settings are compared at apply time (they live behind an async read); the plan
    // always lists them as an update so the operator sees that the restore touches them.
    push("settings", "update", "imageUpdates", "image update schedule");
  }

  // ── Deletions (replace mode only) ─────────────────────────────────────────
  if (mode === "replace") {
    for (const scene of control.getScenes()) {
      if (!doc.scenes.some((s) => s.id === scene.id)) push("scene", "delete", scene.id, scene.name);
    }
    for (const wall of control.getVideoWalls()) {
      if (!doc.videoWalls.some((w) => w.id === wall.id)) {
        push("videoWall", "delete", wall.id, wall.name ?? wall.id);
      }
    }
    for (const placement of control.getPlacements()) {
      if (!doc.placements.some((p) => p.screenId === placement.screenId)) {
        push("placement", "delete", placement.screenId, placementLabel(placement));
      }
    }
    for (const screen of control.getScreens()) {
      if (!docScreenIds.has(screen.id)) {
        // Not already planned for deletion as a same-panel conflict.
        if (!changes.some((c) => c.entity === "screen" && c.action === "delete" && c.id === screen.id)) {
          push("screen", "delete", screen.id, screen.friendlyName);
        }
      }
    }
    for (const mural of control.getMurals()) {
      if (!doc.murals.some((m) => m.id === mural.id)) push("mural", "delete", mural.id, mural.name);
    }
    for (const source of control.getContentSources()) {
      if (!docSourceIds.has(source.id)) {
        push("contentSource", "delete", source.id, `${source.name} (${source.kind})`);
      }
    }
    for (const profile of control.getCredentialProfileViews()) {
      if (!doc.credentialProfiles.some((p) => p.id === profile.id)) {
        push("credentialProfile", "delete", profile.id, profile.name);
      }
    }
  }

  // ── Media the target does not have ────────────────────────────────────────
  const missingMedia = doc.media.filter((m) => !media.has(m.id));

  const summary = {
    create: changes.filter((c) => c.action === "create").length,
    update: changes.filter((c) => c.action === "update").length,
    delete: changes.filter((c) => c.action === "delete").length,
    unchanged: changes.filter((c) => c.action === "unchanged").length,
  };

  return ImportResult.parse({
    dryRun: true,
    mode,
    format: doc.polypticBackup,
    exportedAt: doc.exportedAt,
    changes,
    summary,
    screensWithoutMachine,
    missingMedia,
    credentialProfilesNeedingSecret,
    warnings,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Apply
// ─────────────────────────────────────────────────────────────────────────────

export interface ApplyOptions {
  mode: ImportMode;
  /** This deployment's public base for `/media/<id>` URLs — an upload's URL bakes in the ORIGIN of
   *  the deployment that served it, so a document moving between hosts has its media URLs re-homed
   *  here. Without this, restored uploads would point at the old server forever. */
  mediaPublicBase?: string;
  /** Register a profile with the token service after import (only ones that have a usable secret). */
  onCredentialProfile?: (profileId: string) => void;
}

export interface ApplyOutcome {
  result: ImportResult;
  /** Every slice the restore touched, for the caller to push `server/render` to (the instant path). */
  slices: ScreenSlice[];
}

/** Re-home a `/media/<id>` URL onto this deployment; leave every other URL exactly as authored. */
export function rehomeMediaUrl(url: string | undefined, base: string | undefined): string | undefined {
  if (!url || !base) return url;
  try {
    const parsed = new URL(url);
    const match = /^\/media\/([A-Za-z0-9_-]+)$/.exec(parsed.pathname);
    if (!match) return url;
    return `${base.replace(/\/$/, "")}/media/${match[1]}`;
  } catch {
    return url;
  }
}

/**
 * Apply a document. Runs the plan first (so what an operator confirmed is what runs), then writes it
 * through the control plane's ordinary mutation paths — which is what makes the fan-out the normal
 * instant push rather than a special restore path that could forget to render.
 *
 * Order matters and follows the dependency graph: credential profiles → content sources (which
 * reference profiles; non-playlists before playlists, whose steps reference other sources) → murals →
 * screens → placements → walls → zooms → content assignments → scenes → settings → (replace) deletes.
 */
export async function applyImport(
  control: ControlPlane,
  media: MediaPort,
  imageSettings: ImageSettingsPort | undefined,
  doc: BackupDocument,
  options: ApplyOptions,
): Promise<ApplyOutcome> {
  const plan = planImport(control, media, doc, options.mode);
  const touched = new Map<string, ScreenSlice>();
  const accumulate = (slices: ScreenSlice[]): void => {
    for (const slice of slices) touched.set(slice.screenId, slice);
  };
  const assignmentFor = (content: SceneContent): ContentAssignment | null => {
    if (!content) return null;
    if (content.sourceId !== undefined) return { sourceId: content.sourceId };
    if (content.url !== undefined) return { url: content.url };
    return null;
  };

  await control.runQuiet(async () => {
    // 1. Credential profiles (a source may reference one).
    for (const profile of doc.credentialProfiles) {
      const { secretExcluded: _ignored, ...bare } = profile;
      const { needsSecret } = await control.importCredentialProfile(CredentialProfile.parse(bare));
      // Only a profile that HAS a usable secret is handed to the token service — a blank one would
      // just hammer the IdP with a doomed grant. The operator types the secret in and that path
      // registers it (POST/PATCH /credential-profiles already does).
      if (!needsSecret) options.onCredentialProfile?.(profile.id);
    }

    // 2. Content library: plain sources first, then the composites that reference them.
    const plain = doc.contentSources.filter((s) => s.kind !== "playlist");
    const composite = doc.contentSources.filter((s) => s.kind === "playlist");
    for (const source of [...plain, ...composite]) {
      const url = rehomeMediaUrl(source.url, options.mediaPublicBase);
      const { slices } = await control.importContentSource({ ...source, ...(url ? { url } : {}) });
      accumulate(slices);
    }

    // 3. Murals, screens, placements.
    for (const mural of doc.murals) await control.importMural(mural);
    for (const screen of doc.screens) await control.importScreen(screen);
    for (const placement of doc.placements) {
      await control.placeScreen(
        placement.screenId,
        placement.muralId,
        placement.x,
        placement.y,
        placement.w,
        placement.h,
      );
    }

    // 4. Walls (their members must be placed first).
    for (const wall of doc.videoWalls) {
      const { content: _content, ...bare } = wall;
      const result = await control.importVideoWall(bare);
      if (result.ok) accumulate(result.slices);
    }

    // 5. Remembered zooms — BEFORE content, so each assignment picks its zoom up on the way through.
    for (const pref of doc.zoomPreferences) await control.importZoomPreference(pref);

    // 6. Content: through setWallContent / setScreenContent, i.e. the paths a click uses.
    for (const wall of doc.videoWalls) {
      const assignment = assignmentFor(wall.content);
      if (!assignment) continue;
      const result = await control.setWallContent(wall.id, assignment);
      if (result.ok) accumulate(result.slices);
    }
    for (const entry of doc.screenContent) {
      const assignment = assignmentFor(entry.content);
      if (assignment) {
        const result = await control.setScreenContent(entry.screenId, assignment);
        if (result.ok) accumulate([result.slice]);
        continue;
      }
      // The backup says "nothing on air here" — make it so, deterministically.
      const cleared = await control.setScreenSurfaces(entry.screenId, []);
      if (cleared) accumulate([cleared]);
    }

    // 7. Scenes.
    for (const scene of doc.scenes) await control.importScene(scene);

    // 8. Settings.
    if (doc.settings.display) await control.setDisplaySettings(doc.settings.display);
    if (doc.settings.imageUpdates && imageSettings) {
      await imageSettings.updateSettings(doc.settings.imageUpdates);
    }

    // 9. Replace mode: delete what the document does not mention, in dependency-safe order.
    if (options.mode === "replace") {
      for (const change of plan.changes.filter((c) => c.action === "delete")) {
        switch (change.entity) {
          case "scene":
            await control.deleteScene(change.id);
            break;
          case "videoWall": {
            const split = await control.splitWall(change.id);
            if (split) accumulate(split.slices);
            break;
          }
          case "placement": {
            const unplaced = await control.unplaceScreen(change.id);
            if (unplaced !== false) accumulate(unplaced.slices);
            break;
          }
          case "screen": {
            const removed = await control.removeScreen(change.id);
            if (removed) accumulate(removed.slices);
            break;
          }
          case "mural": {
            const deleted = await control.deleteMural(change.id);
            if (deleted) accumulate(deleted.slices);
            break;
          }
          case "contentSource": {
            const deleted = await control.deleteContentSource(change.id);
            if (deleted) accumulate(deleted.slices);
            break;
          }
          case "credentialProfile":
            await control.deleteCredentialProfile(change.id);
            break;
          default:
            break;
        }
      }
    }
  });

  // A removed screen has no slice left to render; drop it from the push list.
  const known = new Set(control.getScreens().map((s) => s.id));
  const slices = [...touched.values()].filter((s) => known.has(s.screenId));

  return { result: { ...plan, dryRun: false }, slices };
}
