/**
 * @polyptic/e2e — staged (canary) image roll-outs, against the REAL control plane (POL-105).
 *
 * This is the ticket's DoD, executed end to end on one depot:
 *
 *   1. Two boxes enrol over the real agent WS and each reports the image id it BOOTED
 *      (`agent/hello.imageId`). The control plane persists it, so the fleet's version distribution
 *      is answerable — including for a box that has since gone offline.
 *   2. One box is TAGGED `canary` (POL-103's tag route, unchanged).
 *   3. The operator pins a ring: `tag=canary` → the new build. From then on the SAME ungated depot
 *      manifest answers the canary box with the new build and every other box with the fleet's —
 *      which is exactly what each box's 5-minute `update-poll` reads, so it is what they boot.
 *   4. PROMOTE makes the canary's build the fleet's in one call, and the ring retires: both boxes
 *      now resolve to the same id.
 *
 * The boxes are plain WebSocket clients speaking the real protocol — no agent binary, no image.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 8281;
const BASE = `http://localhost:${PORT}`;
const TEST_TIMEOUT = 20_000;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER_ENTRY = join(REPO_ROOT, "packages", "server", "src", "index.ts");

const FLEET_BUILD = "20260714T010000Z-aaaaaaaa";
const CANARY_BUILD = "20260714T020000Z-bbbbbbbb";

let imageRoot = "";
let proc: ReturnType<typeof Bun.spawn> | null = null;

/** Seed `builds/<id>/` for a build, and (when active) publish it at the arch root. */
function seedBuild(imageId: string, minute: number, active: boolean): void {
  const arch = join(imageRoot, "amd64");
  const dir = join(arch, "builds", imageId);
  mkdirSync(dir, { recursive: true });
  for (const name of ["rootfs.squashfs", "vmlinuz", "initrd"]) writeFileSync(join(dir, name), `${name}-${imageId}`);
  writeFileSync(join(dir, "SHA256SUMS"), `sum-${imageId}  rootfs.squashfs\n`);
  const t = new Date(Date.UTC(2026, 6, 14, 1, minute));
  utimesSync(join(dir, "rootfs.squashfs"), t, t);
  if (active) {
    for (const name of ["rootfs.squashfs", "vmlinuz", "initrd", "SHA256SUMS"]) {
      writeFileSync(join(arch, name), `${name}-${imageId}`);
    }
    writeFileSync(join(arch, "image-id.txt"), `${imageId}\n`);
  }
}

async function waitHealthy(): Promise<void> {
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server never became healthy");
}

/** Enrol a box over the real agent WS, reporting the image id it booted. Resolves once applied. */
async function enrol(machineId: string, imageId: string): Promise<void> {
  const ws = new WebSocket(`ws://localhost:${PORT}/agent`);
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`${machineId} never got server/apply`)), 8000);
    ws.addEventListener("open", () => {
      ws.send(
        JSON.stringify({
          t: "agent/hello",
          protocol: 1,
          machineId,
          agentVersion: "e2e",
          backend: "wayland-sway",
          outputs: [{ connector: "DP-1", width: 1920, height: 1080 }],
          hostname: machineId,
          imageId,
        }),
      );
    });
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as { t: string };
      if (msg.t === "server/apply") {
        clearTimeout(timer);
        ws.close();
        done();
      }
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      fail(new Error(`${machineId} socket error`));
    });
  });
  // The socket is closed: from here on both boxes are OFFLINE, which is the interesting case — a
  // roll-out's stranded box is a dark box, and its reported build must still be there.
  await new Promise((r) => setTimeout(r, 150));
}

const manifest = async (machineId?: string): Promise<Record<string, unknown>> => {
  const url = machineId
    ? `${BASE}/dist/image/amd64/manifest.json?machineId=${machineId}`
    : `${BASE}/dist/image/amd64/manifest.json`;
  const res = await fetch(url);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
};

const settings = async (): Promise<Record<string, unknown>> =>
  (await (await fetch(`${BASE}/api/v1/settings/image`)).json()) as Record<string, unknown>;

/** The Live Activity feed, read the way the console reads it: the first `admin/state` frame. */
async function activityFeed(): Promise<string[]> {
  const ws = new WebSocket(`ws://localhost:${PORT}/admin`);
  return new Promise<string[]>((done, fail) => {
    const timer = setTimeout(() => fail(new Error("no admin/state frame")), 8000);
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as { t: string; activity?: { text: string }[] };
      if (msg.t !== "admin/state") return;
      clearTimeout(timer);
      ws.close();
      done((msg.activity ?? []).map((e) => e.text));
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      fail(new Error("admin socket error"));
    });
  });
}

beforeAll(async () => {
  imageRoot = mkdtempSync(join(tmpdir(), "pol105-image-"));
  seedBuild(FLEET_BUILD, 0, true);
  seedBuild(CANARY_BUILD, 30, false);

  proc = Bun.spawn(["bun", SERVER_ENTRY], {
    env: { ...process.env, PORT: String(PORT), STORE: "memory", AUTH_ENABLED: "false", IMAGE_DIST_DIR: imageRoot },
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitHealthy();

  await enrol("box-canary", FLEET_BUILD);
  await enrol("box-fleet", FLEET_BUILD);
}, 30_000);

afterAll(() => {
  proc?.kill();
  if (imageRoot) rmSync(imageRoot, { recursive: true, force: true });
});

describe("canary roll-outs (POL-105)", () => {
  test(
    "every box reports the image it booted, and the control plane keeps it while the box is offline",
    async () => {
      const machines = (await (await fetch(`${BASE}/api/v1/machines`)).json()) as {
        id: string;
        imageId?: string;
      }[];
      const byId = new Map(machines.map((m) => [m.id, m]));
      // Both sockets are closed, so this is PERSISTED registry state, not live presence: the build a
      // dark box last reported is exactly what a stranded-box hunt needs.
      expect(byId.get("box-canary")?.imageId).toBe(FLEET_BUILD);
      expect(byId.get("box-fleet")?.imageId).toBe(FLEET_BUILD);
    },
    TEST_TIMEOUT,
  );

  test(
    "with no rings, every box — named or anonymous — is served the fleet's active build",
    async () => {
      expect((await manifest())["imageId"]).toBe(FLEET_BUILD); // a pre-POL-105 box sends no machineId
      expect((await manifest("box-canary"))["imageId"]).toBe(FLEET_BUILD);
      expect((await manifest("nobody-knows-me"))["imageId"]).toBe(FLEET_BUILD);
    },
    TEST_TIMEOUT,
  );

  test(
    "a ring cannot pin a build the depot does not retain, or a selector that does not parse",
    async () => {
      const bad = await fetch(`${BASE}/api/v1/settings/image/rings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rings: [{ selector: "tag=canary", arch: "amd64", imageId: "20990101T000000Z-ffff" }] }),
      });
      expect(bad.status).toBe(400);

      const junk = await fetch(`${BASE}/api/v1/settings/image/rings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rings: [{ selector: "everything", arch: "amd64", imageId: CANARY_BUILD }] }),
      });
      expect(junk.status).toBe(400);
      expect((await settings())["rings"]).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  test(
    "THE DoD: a canary-tagged box boots a different build than the fleet, from the same depot",
    async () => {
      // Tag the box (POL-103's route, untouched by this ticket).
      const tagged = await fetch(`${BASE}/api/v1/machines/box-canary/tags`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tags: ["canary"] }),
      });
      expect(tagged.status).toBe(200);

      // Pin the new build to that tag, urgently — the fleet stays on its build, un-urgently.
      const pinned = await fetch(`${BASE}/api/v1/settings/image/rings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          rings: [{ selector: "tag=canary", arch: "amd64", imageId: CANARY_BUILD, urgent: true }],
        }),
      });
      expect(pinned.status).toBe(200);

      // The same ungated URL every box polls, answered per machine.
      const canary = await manifest("box-canary");
      expect(canary["imageId"]).toBe(CANARY_BUILD);
      expect(canary["urgent"]).toBe(true); // it reboots within minutes…
      expect(canary["sha256"]).toBe(`sum-${CANARY_BUILD}`); // …into ITS build's artifacts

      const fleet = await manifest("box-fleet");
      expect(fleet["imageId"]).toBe(FLEET_BUILD);
      expect(fleet["urgent"]).toBe(false); // …while the fleet waits for the nightly window

      // And the artifacts that build's boot pins are actually servable from this depot.
      const artifact = await fetch(`${BASE}/dist/image/amd64/builds/${CANARY_BUILD}/rootfs.squashfs`);
      expect(artifact.status).toBe(200);
    },
    TEST_TIMEOUT,
  );

  test(
    "PROMOTE serves the canary's build to the whole fleet and retires the ring, in one call",
    async () => {
      const res = await fetch(`${BASE}/api/v1/settings/image/promote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ arch: "amd64", selector: "tag=canary", urgent: true }),
      });
      expect(res.status).toBe(200);
      const info = (await res.json()) as Record<string, unknown>;
      expect(info["rings"]).toEqual([]); // the canary is retired, not left pinned to the fleet build
      expect(info["urgent"]).toBe(true);

      // Everyone converges on one id — the canary box included.
      expect((await manifest("box-canary"))["imageId"]).toBe(CANARY_BUILD);
      expect((await manifest("box-fleet"))["imageId"]).toBe(CANARY_BUILD);
      expect((await manifest())["imageId"]).toBe(CANARY_BUILD);

      // The evidence: one Live Activity line naming what was promoted (the feed rides admin/state).
      const feed = await activityFeed();
      expect(feed.some((t) => t.includes("whole fleet") && t.includes(CANARY_BUILD))).toBe(true);
    },
    TEST_TIMEOUT,
  );

  test(
    "promoting a ring that does not exist is a 404, never a silent fleet-wide activate",
    async () => {
      const res = await fetch(`${BASE}/api/v1/settings/image/promote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ arch: "amd64", selector: "tag=ghost" }),
      });
      expect(res.status).toBe(404);
      expect((await manifest())["imageId"]).toBe(CANARY_BUILD); // unchanged
    },
    TEST_TIMEOUT,
  );
});
