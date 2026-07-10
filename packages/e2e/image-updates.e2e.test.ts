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
  writeFileSync(join(imageRoot, "arm64", "rootfs.squashfs"), "fake-rootfs");
  writeFileSync(
    join(imageRoot, "arm64", "SHA256SUMS"),
    "1111111111111111111111111111111111111111111111111111111111111111  vmlinuz\n" +
      "2222222222222222222222222222222222222222222222222222222222222222  rootfs.squashfs\n",
  );
  proc = Bun.spawn(["bun", SERVER_ENTRY], {
    env: {
      ...process.env,
      PORT: String(PORT),
      STORE: "memory",
      AUTH_ENABLED: "false",
      IMAGE_DIST_DIR: imageRoot,
      // The hooks bump the image id — instant, observable, and exactly what a real refresh does.
      IMAGE_REBUILD_CMD: `sh -c 'echo rebuilt-by-test; printf "20260708T111111Z-eeff0011\\n" > ${join(imageRoot, "arm64", "image-id.txt")}'`,
      // POL-43: the weekly FULL rebuild (kernel + base ISO) is a second, separately-configured hook.
      IMAGE_FULL_REBUILD_CMD: `sh -c 'echo full-rebuilt-by-test; printf "20260708T222222Z-ffff0022\\n" > ${join(imageRoot, "arm64", "image-id.txt")}'`,
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
      // POL-43: the weekly full-rebuild cycle defaults to Sundays 02:00, on.
      expect(body.fullScheduleEnabled).toBe(true);
      expect(body.fullScheduleDay).toBe(0);
      expect(body.fullScheduleTime).toBe("02:00");
      expect(body.fullRebuildConfigured).toBe(true);
    },
    TEST_TIMEOUT,
  );

  test(
    "PUT persists the weekly full-rebuild schedule and rejects a bad weekday",
    async () => {
      const put = await fetch(`${BASE}/api/v1/settings/image`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fullScheduleDay: 3, fullScheduleTime: "04:30" }),
      });
      expect(put.status).toBe(200);
      const body = (await put.json()) as Record<string, unknown>;
      expect(body.fullScheduleDay).toBe(3);
      expect(body.fullScheduleTime).toBe("04:30");

      const bad = await fetch(`${BASE}/api/v1/settings/image`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fullScheduleDay: 9 }),
      });
      expect(bad.status).toBeGreaterThanOrEqual(400);
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
    "POST /rebuild returns without blocking on the hook, then the outcome + new image id land",
    async () => {
      const kicked = (await (
        await fetch(`${BASE}/api/v1/settings/image/rebuild`, { method: "POST" })
      ).json()) as Record<string, { status?: string } | unknown>;
      const lastBuild = kicked.lastBuild as { status: string };
      // The endpoint is non-blocking by contract (D51): it persists "running", spawns the hook, and
      // answers with a FRESH state read. With a near-instant stub hook the honest snapshot is
      // therefore EITHER "running" or already "success" — a fast CI runner regularly wins that race
      // (seen on the POL-35 follow-up PR). What must never appear here is a failure state.
      expect(["running", "success"]).toContain(lastBuild.status);

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

  test(
    "POST /rebuild {kind:'full'} runs the SECOND hook and reports kind on the outcome (POL-43)",
    async () => {
      const kicked = (await (
        await fetch(`${BASE}/api/v1/settings/image/rebuild`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: "full" }),
        })
      ).json()) as Record<string, unknown>;
      // Same non-blocking race as the refresh test above: "running" or an instant "success".
      expect(["running", "success"]).toContain((kicked.lastBuild as { status: string }).status);
      expect((kicked.lastBuild as { kind: string }).kind).toBe("full");

      let settled: Record<string, unknown> | null = null;
      for (let i = 0; i < 50; i++) {
        const body = (await (await fetch(`${BASE}/api/v1/settings/image`)).json()) as Record<string, unknown>;
        const lb = body.lastBuild as { status: string } | null;
        if (lb && lb.status !== "running") {
          settled = body;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(settled).not.toBeNull();
      const lb = settled?.lastBuild as { status: string; kind: string; logTail: string };
      expect(lb.status).toBe("success");
      expect(lb.kind).toBe("full");
      expect(lb.logTail).toContain("full-rebuilt-by-test");

      const manifest = (await (await fetch(`${BASE}/dist/image/arm64/manifest.json`)).json()) as Record<string, unknown>;
      expect(manifest.imageId).toBe("20260708T222222Z-ffff0022");
    },
    TEST_TIMEOUT,
  );
});

/**
 * Build retention over HTTP (POL-45). The filesystem semantics — hardlink vs copy, prune order,
 * rollback — are pinned in packages/server/test/image-updates.builds.test.ts; here we only prove the
 * routes exist, are shaped right, and cannot be walked out of.
 */
describe("image build history (POL-45)", () => {
  test(
    "GET /api/v1/settings/image carries the retained builds, exactly one active per arch",
    async () => {
      const body = (await (await fetch(`${BASE}/api/v1/settings/image`)).json()) as Record<string, unknown>;
      const builds = body.builds as Array<{ arch: string; imageId: string; active: boolean; liveIsoUrl: string | null }>;
      expect(Array.isArray(builds)).toBe(true);
      expect(builds.length).toBeGreaterThan(0);
      // The server adopted the depot on boot, so the published image is a retained build.
      expect(builds.filter((b) => b.arch === "arm64" && b.active)).toHaveLength(1);
      // No live ISO was fabricated, so no build offers one.
      expect(builds.every((b) => b.liveIsoUrl === null)).toBe(true);
      expect(body.retainBuilds).toBe(3);
    },
    TEST_TIMEOUT,
  );

  test(
    "GET /dist/image/:arch/builds/:imageId/:file serves a retained artifact, UNGATED",
    async () => {
      const body = (await (await fetch(`${BASE}/api/v1/settings/image`)).json()) as Record<string, unknown>;
      const active = (body.builds as Array<{ arch: string; imageId: string; active: boolean }>).find(
        (b) => b.arch === "arm64" && b.active,
      )!;
      const res = await fetch(`${BASE}/dist/image/arm64/builds/${active.imageId}/rootfs.squashfs`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("fake-rootfs");

      expect((await fetch(`${BASE}/dist/image/arm64/builds/${active.imageId}/manifest.json`)).status).toBe(404);
      expect((await fetch(`${BASE}/dist/image/arm64/builds/20260101T000000Z-nosuchhh/rootfs.squashfs`)).status).toBe(404);
    },
    TEST_TIMEOUT,
  );

  test(
    "a build id cannot traverse out of the depot",
    async () => {
      // The WHATWG URL parser collapses any segment that IS a double-dot — `..`, `%2e%2e`, `.%2e` —
      // before fetch() sends it, so those never reach the route as a param and prove nothing here.
      // Only an encoded SLASH keeps the segment intact; it lands on the handler as the id, where
      // IMAGE_ID_RE rejects it. (safeResolve is the second line of defence, unit-tested separately.)
      for (const id of ["..%2f..", "%2e%2e%2f%2e%2e"]) {
        const res = await fetch(`${BASE}/dist/image/arm64/builds/${id}/rootfs.squashfs`);
        expect(res.status).toBe(404);
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "POST /api/v1/settings/image/activate 404s on an unknown build and on a junk arch",
    async () => {
      const post = (body: unknown) =>
        fetch(`${BASE}/api/v1/settings/image/activate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      expect((await post({ arch: "arm64", imageId: "20260101T000000Z-nosuchhh" })).status).toBe(404);
      // A junk arch fails the protocol's enum before it reaches the depot.
      expect((await post({ arch: "riscv", imageId: "20260101T000000Z-nosuchhh" })).status).toBeGreaterThanOrEqual(400);
    },
    TEST_TIMEOUT,
  );

  test(
    "activating a retained build republishes its id to the fleet's manifest",
    async () => {
      const before = (await (await fetch(`${BASE}/api/v1/settings/image`)).json()) as Record<string, unknown>;
      const builds = before.builds as Array<{ arch: string; imageId: string; active: boolean }>;
      const older = builds.find((b) => b.arch === "arm64" && !b.active);
      // The earlier rebuild tests each stamped a new image id, so history has more than one entry.
      expect(older).toBeDefined();

      const res = await fetch(`${BASE}/api/v1/settings/image/activate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ arch: "arm64", imageId: older!.imageId }),
      });
      expect(res.status).toBe(200);

      // This is the rollback: every netbooted box compares THIS id against its own every 5 minutes.
      const manifest = (await (await fetch(`${BASE}/dist/image/arm64/manifest.json`)).json()) as Record<string, unknown>;
      expect(manifest.imageId).toBe(older!.imageId);
    },
    TEST_TIMEOUT,
  );
});
