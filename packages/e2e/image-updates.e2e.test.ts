/**
 * @polyptic/e2e — image updates (POL-41).
 *
 * Drives the REAL control plane's image-update surface:
 *   - GET /dist/image/:arch/manifest.json  (UNGATED, the box's 5-minute poll target): imageId +
 *     builtAt + sha256 from the depot files, plus the operator's urgent switch. 404 with no image.
 *   - GET /api/v1/settings/image           (gated in prod; AUTH_ENABLED=false here): schedule +
 *     urgency + last build + published images.
 *   - PUT /api/v1/settings/image           schedule/urgency updates (persisted).
 *   - POST /api/v1/settings/image/rebuild  runs IMAGE_REBUILD_CMD without blocking the request;
 *     the outcome (status + log tail) lands in the settings for the console card.
 *
 * A fabricated image depot (image-id.txt + SHA256SUMS markers) stands in for a real build, and the
 * rebuild hook is a tiny shell command that mutates the depot — proving the whole loop (schedule
 * state → hook → new manifest) without a 15-minute image build.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 8117;
const BASE = `http://localhost:${PORT}`;
const TEST_TIMEOUT = 15_000;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER_ENTRY = join(REPO_ROOT, "packages", "server", "src", "index.ts");

let imageRoot = "";
let proc: ReturnType<typeof Bun.spawn> | null = null;

async function waitHealthy(base: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server at ${base} never became healthy`);
}

beforeAll(async () => {
  imageRoot = mkdtempSync(join(tmpdir(), "pol41-image-"));
  mkdirSync(join(imageRoot, "arm64"), { recursive: true });
  writeFileSync(join(imageRoot, "arm64", "image-id.txt"), "20260708T000000Z-aabbccdd\n");
  writeFileSync(join(imageRoot, "arm64", "polyptic.iso"), "fake-iso");
  writeFileSync(
    join(imageRoot, "arm64", "SHA256SUMS"),
    "1111111111111111111111111111111111111111111111111111111111111111  vmlinuz\n" +
      "2222222222222222222222222222222222222222222222222222222222222222  polyptic.iso\n",
  );
  proc = Bun.spawn(["bun", SERVER_ENTRY], {
    env: {
      ...process.env,
      PORT: String(PORT),
      STORE: "memory",
      AUTH_ENABLED: "false",
      IMAGE_DIST_DIR: imageRoot,
      // The hook bumps the image id — instant, observable, and exactly what a real refresh does.
      IMAGE_REBUILD_CMD: `sh -c 'echo rebuilt-by-test; printf "20260708T111111Z-eeff0011\\n" > ${join(imageRoot, "arm64", "image-id.txt")}'`,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitHealthy(BASE);
}, 30_000);

afterAll(() => {
  proc?.kill();
  if (imageRoot) rmSync(imageRoot, { recursive: true, force: true });
});

describe("image updates (POL-41)", () => {
  test(
    "GET /dist/image/arm64/manifest.json is UNGATED and carries imageId + sha256 + urgent:false",
    async () => {
      const res = await fetch(`${BASE}/dist/image/arm64/manifest.json`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.arch).toBe("arm64");
      expect(body.imageId).toBe("20260708T000000Z-aabbccdd");
      expect(body.sha256).toBe("2222222222222222222222222222222222222222222222222222222222222222");
      expect(body.urgent).toBe(false);
      expect(typeof body.builtAt).toBe("string");
    },
    TEST_TIMEOUT,
  );

  test(
    "manifest 404s for an arch with no published image (and for junk arches)",
    async () => {
      expect((await fetch(`${BASE}/dist/image/amd64/manifest.json`)).status).toBe(404);
      expect((await fetch(`${BASE}/dist/image/riscv/manifest.json`)).status).toBe(404);
    },
    TEST_TIMEOUT,
  );

  test(
    "settings default to a 01:00 enabled schedule and report the configured hook",
    async () => {
      const body = (await (await fetch(`${BASE}/api/v1/settings/image`)).json()) as Record<string, unknown>;
      expect(body.scheduleEnabled).toBe(true);
      expect(body.scheduleTime).toBe("01:00");
      expect(body.urgent).toBe(false);
      expect(body.rebuildConfigured).toBe(true);
      expect(Array.isArray(body.images)).toBe(true);
    },
    TEST_TIMEOUT,
  );

  test(
    "PUT schedule + urgency persists, and the urgent flag surfaces in the UNGATED manifest",
    async () => {
      const put = await fetch(`${BASE}/api/v1/settings/image`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scheduleTime: "02:30", urgent: true }),
      });
      expect(put.status).toBe(200);
      const body = (await put.json()) as Record<string, unknown>;
      expect(body.scheduleTime).toBe("02:30");
      expect(body.urgent).toBe(true);

      const manifest = (await (await fetch(`${BASE}/dist/image/arm64/manifest.json`)).json()) as Record<string, unknown>;
      expect(manifest.urgent).toBe(true);

      // and back off, so later tests see a clean flag
      await fetch(`${BASE}/api/v1/settings/image`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ urgent: false }),
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "a malformed schedule time is rejected",
    async () => {
      const res = await fetch(`${BASE}/api/v1/settings/image`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scheduleTime: "25:99" }),
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
    },
    TEST_TIMEOUT,
  );

  test(
    "POST /rebuild returns immediately as 'running', then the hook's outcome + new image id land",
    async () => {
      const kicked = (await (
        await fetch(`${BASE}/api/v1/settings/image/rebuild`, { method: "POST" })
      ).json()) as Record<string, { status?: string } | unknown>;
      const lastBuild = kicked.lastBuild as { status: string };
      expect(lastBuild.status).toBe("running");

      // The hook is near-instant; poll the settings until it settles.
      let settled: Record<string, unknown> | null = null;
      for (let i = 0; i < 50; i++) {
        const body = (await (await fetch(`${BASE}/api/v1/settings/image`)).json()) as Record<string, unknown>;
        const lb = body.lastBuild as { status: string; logTail: string } | null;
        if (lb && lb.status !== "running") {
          settled = body;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(settled).not.toBeNull();
      const lb = settled?.lastBuild as { status: string; logTail: string };
      expect(lb.status).toBe("success");
      expect(lb.logTail).toContain("rebuilt-by-test");

      const manifest = (await (await fetch(`${BASE}/dist/image/arm64/manifest.json`)).json()) as Record<string, unknown>;
      expect(manifest.imageId).toBe("20260708T111111Z-eeff0011");
    },
    TEST_TIMEOUT,
  );
});
