/**
 * @polyptic/e2e, the depot self-heals the PINNED build path (POL-79).
 *
 * A netbooted box's LOCAL boot medium pins `root=live:…/dist/image/<arch>/builds/<active-id>/
 * rootfs.squashfs` (POL-63/D67) — it fetches the BUILD-SPECIFIC path, never the arch root. The depot
 * only ever created that `builds/<active-id>/` mirror from the server's reconcile (startup, or a
 * server-triggered successful rebuild). A build that reached the arch root by any OTHER path — an
 * externally-run rebuild Job (`bun deploy/k8s-run-job.ts full amd64` invoked directly), or a
 * partially-failed multi-arch hook run whose non-zero exit skipped the post-rebuild retain — left no
 * mirror, so the box 404'd on its pinned path and retried forever (diagnosed live on the homelab
 * depot: builds/ held the OLDER builds but not the ACTIVE one, though the arch root + image-id.txt
 * WERE that build; the interim fix was a manual hardlink, which no rebuild survives).
 *
 * This drives the REAL control plane (provision.ts + image-updates.ts). The depot is fabricated with
 * the active build present ONLY at the arch root (image-id.txt + artifacts, NO builds/ mirror) AFTER
 * the server has booted — so the boot-time reconcile has already run and cannot have pre-healed it,
 * isolating the on-fetch LAZY heal. The pinned path must then serve 200, and a non-active id must
 * still 404.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 8113;
const BASE = `http://localhost:${PORT}`;
const ACTIVE_ID = "20260711T191928Z-981386cb"; // the homelab's active build id shape
const ROOTFS_BYTES = "ROOTFS_SQUASHFS_" + "R".repeat(64) + `\x00${ACTIVE_ID}\n`;
const VMLINUZ_BYTES = "VMLINUZ_" + ACTIVE_ID + "\n";
const INITRD_BYTES = "INITRD_" + ACTIVE_ID + "\n";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const serverEntry = resolve(repoRoot, "packages", "server", "src", "index.ts");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let rootDir = "";
let imageDir = "";
let arch = "";
let proc: ReturnType<typeof Bun.spawn> | null = null;

/** The active build's artifacts + image-id.txt at the arch root, with NO builds/<id>/ mirror — the
 *  exact 404-causing state an externally-triggered rebuild leaves behind. */
function writeActiveAtRootOnly(): void {
  writeFileSync(join(arch, "image-id.txt"), `${ACTIVE_ID}\n`);
  writeFileSync(join(arch, "rootfs.squashfs"), ROOTFS_BYTES, "binary");
  writeFileSync(join(arch, "vmlinuz"), VMLINUZ_BYTES, "binary");
  writeFileSync(join(arch, "initrd"), INITRD_BYTES, "binary");
  writeFileSync(join(arch, "SHA256SUMS"), "feedface  rootfs.squashfs\n");
}

async function waitForServer(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "never responded";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) {
        await res.body?.cancel();
        return;
      }
      lastErr = `status ${res.status}`;
    } catch (err) {
      lastErr = String(err);
    }
    await sleep(100);
  }
  throw new Error(`server did not become ready on ${BASE}: ${lastErr}`);
}

beforeAll(async () => {
  rootDir = mkdtempSync(join(tmpdir(), "polyptic-pol79-e2e-"));
  imageDir = join(rootDir, "image");
  arch = join(imageDir, "amd64");
  // Boot the server against an EMPTY depot (no image-id.txt yet) so its startup reconcile has
  // nothing to adopt — the mirror can only appear via the on-fetch heal we are testing.
  mkdirSync(arch, { recursive: true });
  proc = Bun.spawn(["bun", serverEntry], {
    cwd: repoRoot,
    env: {
      ...(process.env as Record<string, string>),
      STORE: "memory",
      PORT: String(PORT),
      AUTH_ENABLED: "false",
      IMAGE_DIST_DIR: imageDir,
      LOG_LEVEL: "error",
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  await waitForServer();
  // Now simulate the external rebuild: publish the active build at the arch root, mirror-less.
  writeActiveAtRootOnly();
}, 30_000);

afterAll(async () => {
  if (proc) {
    proc.kill();
    try {
      await proc.exited;
    } catch {
      /* already gone */
    }
  }
  if (rootDir) rmSync(rootDir, { recursive: true, force: true });
}, 10_000);

describe("depot heals the pinned builds/<active-id>/ path on fetch (POL-79)", () => {
  test("the mirror is genuinely absent before the first pinned fetch", () => {
    expect(statSync(join(arch, "builds", ACTIVE_ID), { throwIfNoEntry: false })).toBeUndefined();
  });

  test("GET /dist/image/amd64/builds/<active-id>/rootfs.squashfs serves 200 (was a 404)", async () => {
    const res = await fetch(`${BASE}/dist/image/amd64/builds/${ACTIVE_ID}/rootfs.squashfs`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(ROOTFS_BYTES);
    // The heal materialised the mirror on disk, hardlinked from the arch root (shared inode).
    expect(statSync(join(arch, "builds", ACTIVE_ID, "rootfs.squashfs")).ino).toBe(
      statSync(join(arch, "rootfs.squashfs")).ino,
    );
  });

  test("the pinned vmlinuz + initrd serve too, with a real Content-Length (GRUB needs it)", async () => {
    const kernel = await fetch(`${BASE}/dist/image/amd64/builds/${ACTIVE_ID}/vmlinuz`);
    expect(kernel.status).toBe(200);
    expect(kernel.headers.get("content-length")).toBe(String(VMLINUZ_BYTES.length));
    expect(await kernel.text()).toBe(VMLINUZ_BYTES);

    const initrd = await fetch(`${BASE}/dist/image/amd64/builds/${ACTIVE_ID}/initrd`);
    expect(initrd.status).toBe(200);
    expect(await initrd.text()).toBe(INITRD_BYTES);
  });

  test("a non-active / unknown build id still 404s — the heal only materialises the ACTIVE build", async () => {
    const res = await fetch(`${BASE}/dist/image/amd64/builds/20260101T000000Z-nosuchhh/rootfs.squashfs`);
    expect(res.status).toBe(404);
    await res.body?.cancel();
  });
});
