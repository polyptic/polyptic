/**
 * @polyptic/e2e — the first image builds itself (POL-121).
 *
 * Drives the REAL control plane against an EMPTY image depot — a fresh `helm install`'s PVC — and
 * proves the thing that used to be missing entirely: the server, on its own, notices it has nothing
 * a screen could netboot and fires the FULL build once. Before this, the depot sat empty until the
 * weekly full rebuild came round (up to seven days), and the boot-medium install hook, finding no
 * image, silently baked the LEAN wired-only medium (D68).
 *
 * Two servers, two depots, one point each:
 *   - EMPTY depot  → a `full` build starts by itself, the image lands, and the Live Activity feed
 *     says why it matters ("screens can't netboot until this finishes").
 *   - depot with an image → nothing is triggered. We never rebuild over an image we already have.
 *
 * The hook here is a shell one-liner that publishes an image id (a real full build is ~15 minutes and
 * a privileged k8s Job); the CONTRACT under test is the server's, not the build script's.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EMPTY_PORT = 8271;
const SEEDED_PORT = 8272;
const EMPTY_BASE = `http://localhost:${EMPTY_PORT}`;
const SEEDED_BASE = `http://localhost:${SEEDED_PORT}`;
const TEST_TIMEOUT = 20_000;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER_ENTRY = join(REPO_ROOT, "packages", "server", "src", "index.ts");

interface ImageInfo {
  images: { arch: string; imageId: string }[];
  lastBuild: { status: string; kind: string | null } | null;
  fullRebuildConfigured: boolean;
}

let emptyRoot = "";
let seededRoot = "";
const procs: ReturnType<typeof Bun.spawn>[] = [];

/** The stand-in full-rebuild hook: publishes an arm64 image, and appends a byte per run so a build
 *  STORM would be countable rather than merely suspected. */
function fullRebuildCmd(root: string): string {
  const arch = join(root, "arm64");
  return (
    `sh -c 'mkdir -p ${arch}; printf "20260714T090909Z-f1r57bui\\n" > ${arch}/image-id.txt; ` +
    `printf rootfs > ${arch}/rootfs.squashfs; printf x >> ${join(root, "runs")}; echo built-by-test'`
  );
}

function runs(root: string): number {
  const marker = join(root, "runs");
  return existsSync(marker) ? Bun.file(marker).size : 0;
}

function spawnServer(port: number, imageRoot: string): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(["bun", SERVER_ENTRY], {
    env: {
      ...process.env,
      PORT: String(port),
      STORE: "memory",
      AUTH_ENABLED: "false",
      IMAGE_DIST_DIR: imageRoot,
      IMAGE_FULL_REBUILD_CMD: fullRebuildCmd(imageRoot),
    },
    stdout: "ignore",
    stderr: "ignore",
  });
}

async function waitHealthy(base: string): Promise<void> {
  for (let i = 0; i < 150; i++) {
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) {
        await res.body?.cancel();
        return;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server at ${base} never became healthy`);
}

async function imageInfo(base: string): Promise<ImageInfo> {
  const res = await fetch(`${base}/api/v1/settings/image`);
  expect(res.status).toBe(200);
  return (await res.json()) as ImageInfo;
}

/** Poll the settings surface until `done`, or give up. */
async function until(base: string, done: (info: ImageInfo) => boolean, what: string): Promise<ImageInfo> {
  for (let i = 0; i < 120; i++) {
    const info = await imageInfo(base);
    if (done(info)) return info;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The Live Activity feed, read the way the console reads it: a fresh /admin snapshot. */
async function activityTexts(port: number): Promise<string[]> {
  const ws = new WebSocket(`ws://localhost:${port}/admin`);
  try {
    return await new Promise<string[]>((resolveTexts, rejectTexts) => {
      const timer = setTimeout(() => rejectTexts(new Error("no admin/state within 5s")), 5_000);
      ws.addEventListener("open", () => ws.send(JSON.stringify({ t: "admin/hello" })));
      ws.addEventListener("message", (ev: { data: unknown }) => {
        const msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data)) as {
          t: string;
          activity?: { text: string }[];
        };
        if (msg.t !== "admin/state") return;
        clearTimeout(timer);
        resolveTexts((msg.activity ?? []).map((a) => a.text));
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        rejectTexts(new Error("admin ws error"));
      });
    });
  } finally {
    ws.close();
  }
}

beforeAll(async () => {
  emptyRoot = mkdtempSync(join(tmpdir(), "pol121-empty-"));

  seededRoot = mkdtempSync(join(tmpdir(), "pol121-seeded-"));
  mkdirSync(join(seededRoot, "arm64"), { recursive: true });
  writeFileSync(join(seededRoot, "arm64", "image-id.txt"), "20260701T000000Z-a1b2c3d4\n");
  writeFileSync(join(seededRoot, "arm64", "rootfs.squashfs"), "fake-rootfs");

  procs.push(spawnServer(EMPTY_PORT, emptyRoot), spawnServer(SEEDED_PORT, seededRoot));
  await Promise.all([waitHealthy(EMPTY_BASE), waitHealthy(SEEDED_BASE)]);
}, 40_000);

afterAll(() => {
  for (const p of procs) p.kill();
  for (const root of [emptyRoot, seededRoot]) if (root) rmSync(root, { recursive: true, force: true });
});

describe("first image (POL-121)", () => {
  test(
    "a fresh install with an EMPTY depot builds its first image with no operator action",
    async () => {
      const info = await until(EMPTY_BASE, (i) => i.images.length > 0, "the first image to be published");
      expect(info.images[0]?.imageId).toBe("20260714T090909Z-f1r57bui");
      // The FULL path — the one whose Job re-bakes the boot medium, so the download stops being the
      // LEAN fallback that was baked against the empty depot.
      expect(info.lastBuild?.kind).toBe("full");
      expect(info.lastBuild?.status).toBe("success");
      expect(runs(emptyRoot)).toBe(1);
    },
    TEST_TIMEOUT,
  );

  test(
    "the console can see, from the feed alone, that a first image is building and why it matters",
    async () => {
      // The image lands (the hook stamps image-id.txt) a beat before the completion line is pushed,
      // so poll rather than snapshot once.
      let texts: string[] = [];
      for (let i = 0; i < 60; i++) {
        texts = await activityTexts(EMPTY_PORT);
        if (texts.some((t) => t.includes("First OS image built"))) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(texts.some((t) => t.includes("Building the first OS image") && t.includes("can't netboot"))).toBe(true);
      expect(texts.some((t) => t.includes("First OS image built"))).toBe(true);
    },
    TEST_TIMEOUT,
  );

  test(
    "a depot that already has an image is left alone — no build, no overwrite",
    async () => {
      const info = await imageInfo(SEEDED_BASE);
      expect(info.fullRebuildConfigured).toBe(true);
      expect(info.lastBuild).toBeNull();
      expect(info.images[0]?.imageId).toBe("20260701T000000Z-a1b2c3d4");
      expect(runs(seededRoot)).toBe(0);
    },
    TEST_TIMEOUT,
  );
});
