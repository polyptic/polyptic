/**
 * POL-113 — backup / restore + declarative state export, driven directly against the MemoryStore.
 *
 * Pins the four claims the feature is worth nothing without:
 *
 *   1. **Round trip.** Export a configured deployment, import the document into an EMPTY one, and the
 *      murals, screens, placements, walls, scenes, library and live content all come back — ids and
 *      all — such that a second export of the fresh deployment matches the first.
 *   2. **Secrets never leave.** A credential profile's client secret is not in the document, in any
 *      form, and a restore never blanks a secret that already exists on the target.
 *   3. **The dry run tells the truth.** It reports adds/updates/deletes without touching anything, and
 *      the apply performs exactly what it promised.
 *   4. **Id collisions resolve deterministically.** The same id means the same entity (updated in
 *      place, never duplicated); and the one real collision — a screen that already exists under a
 *      DIFFERENT id for the same (machineId, connector) panel — is resolved in the backup's favour so
 *      that every placement/scene/wall edge in the document still points at something real.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import type { BackupDocument, Output } from "@polyptic/protocol";
import { applyImport, buildBackup, mediaPort, planImport, rehomeMediaUrl } from "../src/backup";
import type { MediaPort } from "../src/backup";
import { ControlPlane, type RegisterMachineInput } from "../src/state";
import { MemoryStore } from "../src/store/memory";

const SECRET = "s3cr3t-client-secret-never-exported";

function hello(machineId: string, ...connectors: string[]): RegisterMachineInput {
  return {
    machineId,
    agentVersion: "test",
    backend: "wayland-sway",
    outputs: connectors.map((connector) => ({ connector, width: 1920, height: 1080 }) satisfies Output),
    hostname: "test-box",
  };
}

/** An empty media catalogue (uploads are files; the document only ever carries their manifest). */
const noMedia: MediaPort = { list: () => [], has: () => false };

/** A media catalogue that knows about exactly one upload. */
function mediaWith(id: string): MediaPort {
  return {
    list: () => [{ id, mime: "image/png", size: 1234, originalName: "poster.png", sourceId: null }],
    has: (candidate) => candidate === id,
  };
}

async function fresh(): Promise<ControlPlane> {
  const cp = new ControlPlane(new MemoryStore());
  await cp.init();
  return cp;
}

/**
 * A fully-furnished deployment: two machines, three screens, a mural with two of them COMBINED into a
 * wall spanning a library source, the third showing a page, a playlist, a credential profile with a
 * secret, a scene, and a remembered zoom. Everything a real wall has.
 */
async function furnished(): Promise<{ cp: ControlPlane; screens: string[]; muralId: string; wallId: string }> {
  const cp = await fresh();
  await cp.registerMachine(hello("box-a", "HDMI-1", "HDMI-2"));
  await cp.registerMachine(hello("box-b", "DP-1"));
  const screens = cp.getScreens().map((s) => s.id);
  const [a, b, c] = screens as [string, string, string];
  const muralId = cp.getMurals()[0]!.id;

  await cp.renameScreen(a, "Atrium Left");
  await cp.renameScreen(b, "Atrium Right");
  await cp.renameScreen(c, "Reception");

  const profile = await cp.createCredentialProfile({
    name: "Grafana",
    tokenEndpoint: "https://idp.example.com/token",
    clientId: "polyptic",
    clientSecret: SECRET,
    tokenParam: "auth_token",
  });

  const dash = await cp.createContentSource({
    name: "Ops dashboard",
    kind: "dashboard",
    url: "https://grafana.example.com/d/ops",
    credentialProfileId: profile.id,
  });
  if (!dash.ok) throw new Error("fixture: dashboard source");

  const still = await cp.createContentSource({
    name: "Poster",
    kind: "image",
    url: "https://cdn.example.com/poster.png",
  });
  if (!still.ok) throw new Error("fixture: image source");

  const rotation = await cp.createContentSource({
    name: "Lobby rotation",
    kind: "playlist",
    items: [
      { sourceId: dash.source.id, durationSeconds: 30 },
      { sourceId: still.source.id, durationSeconds: 10 },
    ],
  });
  if (!rotation.ok) throw new Error("fixture: playlist source");

  await cp.placeScreen(a, muralId, 0, 0);
  await cp.placeScreen(b, muralId, 1920, 0);
  await cp.placeScreen(c, muralId, 4000, 0);

  const combined = await cp.combineScreens(muralId, [a, b], "Atrium Wall");
  if (!combined.ok) throw new Error("fixture: combine");
  await cp.setWallContent(combined.wall.id, { sourceId: dash.source.id });
  await cp.setScreenContent(c, { sourceId: rotation.source.id });

  // A remembered zoom on the wall (POL-57) — restores must bring these back too.
  await cp.setWallZoom(combined.wall.id, 1.5);

  await cp.snapshotScene("Opening", muralId);

  return { cp, screens, muralId, wallId: combined.wall.id };
}

/**
 * The comparable shape of a deployment: what a restore is supposed to reproduce.
 *
 * A playlist surface's `startedAt` is deliberately normalised away: it is the rotation ANCHOR, minted
 * when the playlist is assigned, so a restore re-anchors it to now (and must — wall members have to
 * share one anchor to stay in phase, POL-34). Everything else has to come back byte-identical.
 */
function shapeOf(cp: ControlPlane): unknown {
  const slices = cp.getScreens().map((s) => cp.getSlice(s.id));
  const normalized = JSON.parse(
    JSON.stringify(slices, (key, value) => (key === "startedAt" ? "<anchor>" : value)),
  ) as unknown;
  return {
    murals: cp.getMurals(),
    screens: cp.getScreens(),
    placements: cp.getPlacements(),
    walls: cp.getVideoWalls(),
    sources: cp.getContentSources(),
    scenes: cp.getScenes(),
    zooms: cp.getZoomPreferences(),
    slices: normalized,
  };
}

let source: ControlPlane;
let doc: BackupDocument;
let ids: { screens: string[]; muralId: string; wallId: string };

beforeEach(async () => {
  const f = await furnished();
  source = f.cp;
  ids = { screens: f.screens, muralId: f.muralId, wallId: f.wallId };
  doc = await buildBackup(source, noMedia, undefined, { version: "test" });
});

describe("export", () => {
  test("is a version-stamped document of the declarative state", () => {
    expect(doc.polypticBackup).toBe(1);
    expect(doc.generator.product).toBe("polyptic");
    expect(Date.parse(doc.exportedAt)).not.toBeNaN();

    expect(doc.murals).toHaveLength(1);
    expect(doc.screens.map((s) => s.friendlyName).sort()).toEqual([
      "Atrium Left",
      "Atrium Right",
      "Reception",
    ]);
    expect(doc.placements).toHaveLength(3);
    expect(doc.videoWalls).toHaveLength(1);
    expect(doc.videoWalls[0]!.content).toEqual({ sourceId: "source-1" });
    expect(doc.contentSources).toHaveLength(3);
    expect(doc.scenes).toHaveLength(1);
    expect(doc.zoomPreferences).toHaveLength(1);
    expect(doc.zoomPreferences[0]!.zoom).toBe(1.5);

    // A wall owns its members' content, so only the non-walled screen carries its own.
    expect(doc.screenContent).toHaveLength(1);
    expect(doc.screenContent[0]!.content).toEqual({ sourceId: "source-3" });
  });

  test("carries the page/playlist DEFINITIONS, not just names", () => {
    const playlist = doc.contentSources.find((s) => s.kind === "playlist");
    expect(playlist?.items).toEqual([
      { sourceId: "source-1", durationSeconds: 30 },
      { sourceId: "source-2", durationSeconds: 10 },
    ]);
  });

  test("NEVER contains a secret, and says so", () => {
    const serialized = JSON.stringify(doc);
    expect(serialized).not.toContain(SECRET);
    // Belt and braces: no key anywhere in the document is named like a secret.
    expect(serialized).not.toContain("clientSecret");
    expect(serialized).not.toContain("credentialHash");
    expect(serialized).not.toContain("passwordHash");

    const profile = doc.credentialProfiles[0]!;
    expect(profile.name).toBe("Grafana");
    expect(profile.clientId).toBe("polyptic");
    expect(profile.secretExcluded).toBe(true);

    // The document explains its own omissions to whoever opens it.
    expect(doc.notIncluded.join(" ")).toContain("Secrets");
    expect(doc.notIncluded.join(" ")).toContain("Machines");
  });

  test("excludes machines and live state entirely", () => {
    expect(Object.keys(doc).sort()).toEqual(
      [
        "contentSources",
        "credentialProfiles",
        "exportedAt",
        "generator",
        "media",
        "murals",
        "notIncluded",
        "placements",
        "polypticBackup",
        "scenes",
        "screenContent",
        "screens",
        "settings",
        "videoWalls",
        "zoomPreferences",
      ].sort(),
    );
    expect(JSON.stringify(doc)).not.toContain("agentVersion");
  });

  test("lists uploaded media as a MANIFEST (ids, not bytes)", async () => {
    const withMedia = await buildBackup(source, mediaWith("abc123"), undefined);
    expect(withMedia.media).toEqual([
      { id: "abc123", mime: "image/png", size: 1234, originalName: "poster.png", sourceId: null },
    ]);
  });
});

describe("import into an EMPTY deployment", () => {
  test("reproduces the murals, screens, walls, scenes and content", async () => {
    const target = await fresh();
    const { result, slices } = await applyImport(target, noMedia, undefined, doc, { mode: "merge" });

    expect(result.dryRun).toBe(false);
    expect(result.summary.delete).toBe(0);

    // The seeded default mural is the SAME id as the source's, so it is updated, not duplicated.
    expect(target.getMurals()).toHaveLength(1);
    expect(target.getScreens().map((s) => s.friendlyName).sort()).toEqual([
      "Atrium Left",
      "Atrium Right",
      "Reception",
    ]);
    expect(target.getVideoWalls()).toHaveLength(1);
    expect(target.getVideoWalls()[0]!.name).toBe("Atrium Wall");
    expect(target.getScenes().map((s) => s.name)).toEqual(["Opening"]);
    expect(target.getContentSources()).toHaveLength(3);

    // The content is back ON THE GLASS: the wall members span the dashboard, the third screen rotates.
    const [a, b, c] = ids.screens as [string, string, string];
    const wallSurface = target.getSlice(a)!.surfaces[0]!;
    expect(wallSurface.type).toBe("dashboard");
    expect(wallSurface.span).toBeDefined();
    expect(target.getSlice(b)!.surfaces[0]!.span).toBeDefined();
    expect(target.getSlice(c)!.surfaces[0]!.type).toBe("playlist");

    // Every touched slice comes back for the caller to push — the restore rides the instant path.
    expect(slices.map((s) => s.screenId).sort()).toEqual([a, b, c].sort());

    // And the remembered zoom rode along, so the wall re-renders at the operator's dialled-in scale.
    expect(target.getZoomPreferences()).toHaveLength(1);
    expect((wallSurface as { zoom?: number }).zoom).toBe(1.5);
  });

  test("a re-export of the restored deployment matches the original document", async () => {
    const target = await fresh();
    await applyImport(target, noMedia, undefined, doc, { mode: "merge" });

    const again = await buildBackup(target, noMedia, undefined, { version: "test" });
    // Everything but the timestamp (which is when the export ran, by definition).
    const { exportedAt: _a, ...originalRest } = doc;
    const { exportedAt: _b, ...restoredRest } = again;
    expect(restoredRest).toEqual(originalRest);
    expect(shapeOf(target)).toEqual(shapeOf(source));
  });

  test("screens whose machine is not enrolled here are imported anyway, and reported", async () => {
    const target = await fresh();
    const plan = planImport(target, noMedia, doc, "merge");
    expect(plan.screensWithoutMachine.sort()).toEqual([...ids.screens].sort());

    await applyImport(target, noMedia, undefined, doc, { mode: "merge" });
    expect(target.getScreens()).toHaveLength(3);

    // The pay-off: when the box finally dials in, it ADOPTS its screens — same ids, same names, same
    // placements, same content. A restored deployment is not a deployment of unnamed strangers.
    const registered = await target.registerMachine(hello("box-a", "HDMI-1", "HDMI-2"));
    expect(registered.assignments.map((a) => a.screenId).sort()).toEqual(
      [ids.screens[0]!, ids.screens[1]!].sort(),
    );
    expect(target.getScreens()).toHaveLength(3); // adopted, not re-created
    expect(target.getScreen(ids.screens[0]!)!.friendlyName).toBe("Atrium Left");
  });

  test("media the target does not hold is reported as missing, not silently broken", async () => {
    const target = await fresh();
    const docWithMedia = await buildBackup(source, mediaWith("abc123"), undefined);
    const plan = planImport(target, noMedia, docWithMedia, "merge");
    expect(plan.missingMedia.map((m) => m.originalName)).toEqual(["poster.png"]);

    // And when the upload IS here, nothing is flagged.
    expect(planImport(target, mediaWith("abc123"), docWithMedia, "merge").missingMedia).toEqual([]);
  });
});

describe("secrets on restore", () => {
  test("a NEW profile arrives without a secret and is named as needing one", async () => {
    const target = await fresh();
    const plan = planImport(target, noMedia, doc, "merge");
    expect(plan.credentialProfilesNeedingSecret).toEqual(["Grafana"]);

    await applyImport(target, noMedia, undefined, doc, { mode: "merge" });
    expect(target.getCredentialProfileInternal("credential-1")!.clientSecret).toBe("");
    expect(target.getCredentialProfileViews()[0]!.name).toBe("Grafana");
  });

  test("an EXISTING profile keeps the secret it already has — a restore never blanks a credential", async () => {
    const target = await fresh();
    const existing = await target.createCredentialProfile({
      name: "Old name",
      tokenEndpoint: "https://old.example.com/token",
      clientId: "old",
      clientSecret: "the-target-secret",
    });
    expect(existing.id).toBe("credential-1"); // same id as the document's — a genuine collision

    await applyImport(target, noMedia, undefined, doc, { mode: "merge" });

    const after = target.getCredentialProfileInternal("credential-1")!;
    expect(after.name).toBe("Grafana"); // config from the backup
    expect(after.tokenEndpoint).toBe("https://idp.example.com/token");
    expect(after.clientSecret).toBe("the-target-secret"); // secret from the target, untouched
  });
});

describe("restore into a NON-empty deployment", () => {
  test("the dry run reports adds/updates/deletes WITHOUT touching anything", async () => {
    const target = await fresh();
    await applyImport(target, noMedia, undefined, doc, { mode: "merge" });

    // Drift: rename a mural, add a source the backup has never heard of, delete a scene.
    await target.renameMural(ids.muralId, "Renamed on the target");
    const extra = await target.createContentSource({
      name: "Local only",
      kind: "web",
      url: "https://local.example.com",
    });
    if (!extra.ok) throw new Error("fixture");
    await target.deleteScene("scene-1");

    const before = shapeOf(target);
    const plan = planImport(target, noMedia, doc, "merge");
    expect(shapeOf(target)).toEqual(before); // the dry run wrote NOTHING

    const actions = (entity: string, action: string): string[] =>
      plan.changes.filter((c) => c.entity === entity && c.action === action).map((c) => c.id);

    expect(actions("mural", "update")).toEqual([ids.muralId]); // renamed back
    expect(actions("scene", "create")).toEqual(["scene-1"]); // deleted scene returns
    expect(actions("contentSource", "delete")).toEqual([]); // merge never deletes
    expect(plan.summary.delete).toBe(0);

    // In REPLACE mode the same drift plans the deletion of the source the backup does not know.
    const replacePlan = planImport(target, noMedia, doc, "replace");
    expect(
      replacePlan.changes.filter((c) => c.entity === "contentSource" && c.action === "delete").map((c) => c.id),
    ).toEqual([extra.source.id]);
  });

  test("the apply performs exactly what the dry run promised", async () => {
    const target = await fresh();
    await applyImport(target, noMedia, undefined, doc, { mode: "merge" });
    await target.renameMural(ids.muralId, "Renamed on the target");
    const extra = await target.createContentSource({
      name: "Local only",
      kind: "web",
      url: "https://local.example.com",
    });
    if (!extra.ok) throw new Error("fixture");

    const promised = planImport(target, noMedia, doc, "replace");
    const { result } = await applyImport(target, noMedia, undefined, doc, { mode: "replace" });

    expect(result.changes).toEqual(promised.changes);
    expect(result.summary).toEqual(promised.summary);
    expect(result.dryRun).toBe(false);

    // …and the deployment now looks exactly like the file.
    expect(target.getMurals()[0]!.name).toBe(source.getMurals()[0]!.name);
    expect(target.getContentSource(extra.source.id)).toBeUndefined();
    expect(shapeOf(target)).toEqual(shapeOf(source));
  });

  test("merge leaves everything the document does not mention ALONE", async () => {
    const target = await fresh();
    await applyImport(target, noMedia, undefined, doc, { mode: "merge" });

    // Created AFTER the restore, so it gets an id the document has never used.
    const extra = await target.createContentSource({
      name: "Local only",
      kind: "web",
      url: "https://local.example.com",
    });
    if (!extra.ok) throw new Error("fixture");

    await applyImport(target, noMedia, undefined, doc, { mode: "merge" });
    expect(target.getContentSource(extra.source.id)?.name).toBe("Local only");
    expect(target.getContentSources()).toHaveLength(4);
  });

  test("a same-id entity IS overwritten — and the dry run names both sides so it can't surprise", async () => {
    // Ids are sequential per deployment, so two deployments that grew independently mint the same
    // ones for different things. A merge is id-keyed: it overwrites. The dry run is what makes that a
    // decision rather than an accident — the diff line reads "Local only → Ops dashboard".
    const target = await fresh();
    const collides = await target.createContentSource({
      name: "Local only",
      kind: "web",
      url: "https://local.example.com",
    });
    if (!collides.ok) throw new Error("fixture");
    expect(collides.source.id).toBe("source-1"); // the same id the document uses for the dashboard

    const plan = planImport(target, noMedia, doc, "merge");
    const line = plan.changes.find((c) => c.entity === "contentSource" && c.id === "source-1")!;
    expect(line.action).toBe("update");
    expect(line.label).toBe("Local only (web) → Ops dashboard (dashboard)");

    await applyImport(target, noMedia, undefined, doc, { mode: "merge" });
    expect(target.getContentSource("source-1")!.name).toBe("Ops dashboard");
  });
});

describe("id collisions", () => {
  test("the same id is UPDATED in place, never duplicated", async () => {
    const target = await fresh();
    await applyImport(target, noMedia, undefined, doc, { mode: "merge" });
    await applyImport(target, noMedia, undefined, doc, { mode: "merge" }); // twice — idempotent

    expect(target.getMurals()).toHaveLength(1);
    expect(target.getScreens()).toHaveLength(3);
    expect(target.getVideoWalls()).toHaveLength(1);
    expect(target.getContentSources()).toHaveLength(3);
    expect(target.getScenes()).toHaveLength(1);

    const second = planImport(target, noMedia, doc, "merge");
    expect(second.summary.create).toBe(0);
    expect(second.summary.delete).toBe(0);
  });

  test("a screen already holding the same PANEL under another id is replaced by the backup's", async () => {
    // The target's box enrolled first, so it minted its own screen ids for the same panels.
    const target = await fresh();
    await target.registerMachine(hello("box-a", "HDMI-1", "HDMI-2"));
    await target.registerMachine(hello("box-b", "DP-1"));
    // Rearranged connector order → the target's ids do NOT line up with the document's.
    await target.removeScreen(target.getScreens()[0]!.id);
    await target.registerMachine(hello("box-a", "HDMI-1", "HDMI-2"));
    const strayId = target.getScreens().find((s) => s.connector === "HDMI-1")!.id;
    expect(strayId).not.toBe(ids.screens[0]);

    const plan = planImport(target, noMedia, doc, "merge");
    expect(plan.changes.some((c) => c.entity === "screen" && c.action === "delete" && c.id === strayId)).toBe(
      true,
    );
    expect(plan.warnings.join(" ")).toContain(strayId);

    await applyImport(target, noMedia, undefined, doc, { mode: "merge" });

    // Exactly one screen per panel, and it is the BACKUP's — so its placement, wall and scene resolve.
    expect(target.getScreens()).toHaveLength(3);
    expect(target.getScreen(strayId)).toBeUndefined();
    expect(target.getScreen(ids.screens[0]!)!.friendlyName).toBe("Atrium Left");
    expect(target.getVideoWalls()[0]!.memberScreenIds).toEqual([ids.screens[0]!, ids.screens[1]!]);

    // And the box adopts them on its next hello — the wall renders, nothing stranded.
    const registered = await target.registerMachine(hello("box-a", "HDMI-1", "HDMI-2"));
    expect(registered.assignments.map((a) => a.screenId).sort()).toEqual(
      [ids.screens[0]!, ids.screens[1]!].sort(),
    );
  });

  test("new ids minted after a restore never collide with the imported ones", async () => {
    const target = await fresh();
    await applyImport(target, noMedia, undefined, doc, { mode: "merge" });

    const created = await target.createContentSource({
      name: "Post-restore",
      kind: "web",
      url: "https://example.com/new",
    });
    if (!created.ok) throw new Error("fixture");
    expect(created.source.id).toBe("source-4"); // carried past the document's source-3

    const mural = await target.createMural("Second wall");
    expect(mural.id).toBe("mural-2");
    const scene = await target.snapshotScene("Another", mural.id);
    expect(scene!.id).toBe("scene-2");
  });
});

describe("media URLs", () => {
  test("an upload's URL is re-homed onto the importing deployment", () => {
    expect(rehomeMediaUrl("http://old-host:8080/media/abc123", "https://new-host")).toBe(
      "https://new-host/media/abc123",
    );
    // Anything that is not an upload is left EXACTLY as the operator authored it.
    expect(rehomeMediaUrl("https://grafana.example.com/d/ops", "https://new-host")).toBe(
      "https://grafana.example.com/d/ops",
    );
    expect(rehomeMediaUrl("https://cdn.example.com/media/logo.png", "https://new-host")).toBe(
      "https://cdn.example.com/media/logo.png",
    );
    expect(rehomeMediaUrl(undefined, "https://new-host")).toBeUndefined();
  });

  test("a restored media source points at THIS deployment", async () => {
    const cp = await fresh();
    const uploaded = await cp.createContentSource({
      name: "Poster",
      kind: "image",
      url: "http://old-host:8080/media/abc123",
    });
    if (!uploaded.ok) throw new Error("fixture");
    const exported = await buildBackup(cp, mediaWith("abc123"), undefined);

    const target = await fresh();
    await applyImport(target, mediaWith("abc123"), undefined, exported, {
      mode: "merge",
      mediaPublicBase: "https://new-host:9090",
    });
    expect(target.getContentSource(uploaded.source.id)!.url).toBe("https://new-host:9090/media/abc123");
  });
});

describe("the media port", () => {
  test("adapts the real MediaStore's records into the manifest shape", () => {
    const fake = {
      list: () => [
        { id: "m1", filename: "m1.png", mime: "image/png", size: 10, originalName: "a.png", sourceId: "source-9" },
      ],
      get: (id: string) => (id === "m1" ? ({} as never) : undefined),
    };
    const port = mediaPort(fake as never);
    expect(port.list()).toEqual([
      { id: "m1", mime: "image/png", size: 10, originalName: "a.png", sourceId: "source-9" },
    ]);
    expect(port.has("m1")).toBe(true);
    expect(port.has("nope")).toBe(false);
  });
});
