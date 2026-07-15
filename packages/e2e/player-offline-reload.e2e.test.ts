/**
 * @polyptic/e2e — POL-132: the player survives a page RELOAD while the control plane is down.
 *
 * The v0.2.29 outage drill found the hole POL-32/D83 left: content survived an outage, but the
 * player APP was fetched from the control plane on every load — a reload mid-outage rendered the
 * browser's "no available server" page and the wall stayed dark. The fix is a shell service worker
 * (cache-first, /player scope only); THIS suite is the drill itself, automated in a real Chromium:
 *
 *   1. built player served by the real server (PLAYER_DIR) → content up, worker installed+claimed;
 *   2. SIGKILL the control plane → RELOAD the page → the wall paints last-good content from the
 *      shell cache + localStorage slice, and the diag trail says "shell from cache, restored slice
 *      rev N" (D78: the trail is how walls get debugged — it must stay honest);
 *   3. the server comes back carrying a NEWER build → the player reconciles live with no manual
 *      action, revalidates on contact, and swaps into the new build (D107 version discipline).
 *
 * Needs a real browser: playwright-core (no bundled download) + any locally-installed Chrome or a
 * ms-playwright cache. When none exists the suite SKIPS — the SW logic itself is pinned by
 * packages/player/test/shell-sw.test.ts either way.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VERSION } from "@polyptic/protocol";
import { chromium } from "playwright-core";
import type { Browser, Page } from "playwright-core";

const PORT = 8323; // outside every other suite's range (8090–8272)
const BASE = `http://localhost:${PORT}`;
const WS = `ws://localhost:${PORT}`;
const MACHINE_ID = "outage-drill-host";
const CONNECTOR = "HDMI-1";
const V1 = "0.132.1-drill";
const V2 = "0.132.2-drill";
/** Where the reload-mid-outage frame is written for the PR (pr-assets/pol-132). */
const SCREENSHOT_DIR = process.env.POL132_SHOT_DIR ?? join(tmpdir(), "pol132-shots");

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const serverEntry = resolve(repoRoot, "packages", "server", "src", "index.ts");
const playerDir = resolve(repoRoot, "packages", "player");

// Distinguishable-by-size test images (SVG data URIs): naturalWidth is the assertion.
const svg = (w: number, h: number, fill: string): string =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="${fill}"/></svg>`,
  )}`;
const IMAGE_BEFORE = svg(300, 200, "tomato");
const IMAGE_AFTER = svg(400, 200, "steelblue");

// ─────────────────────────────────────────────────────────────────────────────
// Find a Chromium this suite can drive (playwright-core ships no browser).
// ─────────────────────────────────────────────────────────────────────────────

function findChromium(): string | null {
  const flat = [
    process.env.POL132_CHROME?.trim(),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  for (const c of flat) if (c && existsSync(c)) return c;
  for (const root of [join(homedir(), "Library/Caches/ms-playwright"), join(homedir(), ".cache/ms-playwright")]) {
    if (!existsSync(root)) continue;
    for (const dir of readdirSync(root).sort().reverse()) {
      for (const rel of [
        "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
        "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium",
        "chrome-headless-shell-mac-arm64/chrome-headless-shell",
        "chrome-headless-shell-mac-x64/chrome-headless-shell",
        "chrome-linux/chrome",
        "chrome-headless-shell-linux64/chrome-headless-shell",
      ]) {
        const p = join(root, dir, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  return null;
}

const CHROMIUM = findChromium();

// ─────────────────────────────────────────────────────────────────────────────
// Harness: build the player, run the server, fake an agent, drive the browser.
// ─────────────────────────────────────────────────────────────────────────────

async function buildPlayer(outDir: string, version: string): Promise<void> {
  const proc = Bun.spawn(["bun", "x", "vite", "build", "--outDir", outDir, "--emptyOutDir"], {
    cwd: playerDir,
    // NODE_ENV must be production: `bun test` exports NODE_ENV=test, and a vite build inheriting it
    // emits a bundle with `import.meta.env.PROD === false` — where the player (correctly, for dev)
    // never registers its service worker, and this whole drill silently tests nothing. Found live.
    env: { ...process.env, NODE_ENV: "production", POLYPTIC_VERSION: version },
    stdout: "ignore",
    stderr: "pipe",
  });
  if ((await proc.exited) !== 0) {
    throw new Error(`vite build (${version}) failed: ${await new Response(proc.stderr).text()}`);
  }
  if (!existsSync(join(outDir, "sw.js"))) throw new Error("built player has no sw.js");
}

function spawnServer(dist: string): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(["bun", serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(PORT),
      STORE: "memory",
      AUTH_ENABLED: "false",
      LOG_LEVEL: "error",
      PLAYER_DIR: dist,
    },
    // Both streams ignored: an orphaned server holding an inherited pipe open makes the RUNNER
    // look hung after a failure (seen live — the memory of POL-32's verify script, re-learned).
    stdout: "ignore",
    stderr: "ignore",
  });
}

async function waitHealthy(): Promise<void> {
  for (let i = 0; i < 150; i++) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) {
        await res.body?.cancel();
        return;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server never became healthy");
}

/** Fake agent: one output → one screen. Returns the screenId; the socket stays open (a screen whose
 *  machine vanished is a different drill). Memory store + identical event order ⇒ the respawned
 *  server mints the SAME sequential id, which is what lets the reloaded page find its screen again. */
async function attachAgent(): Promise<{ screenId: string; ws: WebSocket }> {
  const ws = new WebSocket(`${WS}/agent`);
  const screenId = await new Promise<string>((resolveId, rejectId) => {
    const timer = setTimeout(() => rejectId(new Error("no server/apply within 5s")), 5_000);
    ws.addEventListener("open", () =>
      ws.send(
        JSON.stringify({
          t: "agent/hello",
          protocol: PROTOCOL_VERSION,
          machineId: MACHINE_ID,
          agentVersion: "e2e",
          backend: "dev-open",
          outputs: [{ connector: CONNECTOR, width: 1280, height: 720 }],
        }),
      ),
    );
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as { t: string; screens?: { screenId: string }[] };
      if (msg.t !== "server/apply" || !msg.screens?.[0]) return;
      clearTimeout(timer);
      resolveId(msg.screens[0].screenId);
    });
    ws.addEventListener("error", () => rejectId(new Error("agent ws error")));
  });
  return { screenId, ws };
}

async function assignImage(screenId: string, url: string, name: string): Promise<void> {
  const created = await fetch(`${BASE}/api/v1/content-sources`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, kind: "image", url }),
  });
  expect(created.status).toBe(201);
  const body = (await created.json()) as { source: { id: string } };
  const assigned = await fetch(`${BASE}/api/v1/screens/${screenId}/content`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceId: body.source.id }),
  });
  expect(assigned.ok).toBe(true);
  await assigned.body?.cancel();
}

// In-page snippets are STRINGS (playwright evaluates them in the browser): the e2e tsconfig is a
// bun environment on purpose — no DOM lib — and these few lines don't justify widening it.

/** The painted wall, as the drill sees it: the one <img> surface's intrinsic width (or null). */
async function paintedWidth(page: Page): Promise<number | null> {
  return (await page.evaluate(
    `(() => { const img = document.querySelector("img.surface-media"); return img && img.naturalWidth > 0 ? img.naturalWidth : null; })()`,
  )) as number | null;
}

async function waitForWidth(page: Page, width: number, timeoutMs: number): Promise<void> {
  await page.waitForFunction(
    `(() => { const img = document.querySelector("img.surface-media"); return !!img && img.naturalWidth === ${width}; })()`,
    undefined,
    { timeout: timeoutMs },
  );
}

async function diagTrail(page: Page): Promise<string> {
  return (await page.evaluate(`localStorage.getItem("polyptic:diag") ?? ""`)) as string;
}

// ─────────────────────────────────────────────────────────────────────────────
// The drill
// ─────────────────────────────────────────────────────────────────────────────

let distV1 = "";
let distV2 = "";
let server: ReturnType<typeof Bun.spawn> | null = null;
let agentWs: WebSocket | null = null;
let browser: Browser | null = null;
let page: Page | null = null;
let screenId = "";

describe.skipIf(!CHROMIUM)("player offline reload (POL-132 outage drill)", () => {
  beforeAll(async () => {
    distV1 = mkdtempSync(join(tmpdir(), "pol132-dist-v1-"));
    distV2 = mkdtempSync(join(tmpdir(), "pol132-dist-v2-"));
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    // Two real builds: the one the wall boots on, and the "newer build shipped" it must adopt.
    await buildPlayer(distV1, V1);
    await buildPlayer(distV2, V2);

    server = spawnServer(distV1);
    await waitHealthy();
    const attached = await attachAgent();
    screenId = attached.screenId;
    agentWs = attached.ws;
    await assignImage(screenId, IMAGE_BEFORE, "Drill image (before outage)");

    browser = await chromium.launch({ executablePath: CHROMIUM!, headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  }, 180_000);

  afterAll(async () => {
    await browser?.close().catch(() => {});
    agentWs?.close();
    server?.kill();
    for (const d of [distV1, distV2]) if (d) rmSync(d, { recursive: true, force: true });
  }, 20_000);

  test(
    "the built player paints content and the shell worker installs + claims the page",
    async () => {
      await page!.goto(`${BASE}/player/?screen=${screenId}`, { waitUntil: "load" });
      await waitForWidth(page!, 300, 15_000);
      // localhost is a secure context, so no Chrome flag is needed HERE; on a wall the agent's
      // --unsafely-treat-insecure-origin-as-secure=<origin> provides the same (chrome.test.ts).
      await page!.waitForFunction(`navigator.serviceWorker.controller !== null`, undefined, {
        timeout: 15_000,
      });
      expect(await diagTrail(page!)).toContain(`v${V1}`);
    },
    30_000,
  );

  test(
    "SIGKILL the control plane → RELOAD → the wall paints last-good content, not an error page",
    async () => {
      server!.kill("SIGKILL");
      await server!.exited;
      // Prove the plane is really dark before reloading into it.
      await expect(fetch(`${BASE}/healthz`)).rejects.toThrow();

      await page!.reload({ waitUntil: "load" });

      // Not Chrome's "no available server" page: OUR shell, with the restored slice painted.
      expect(await page!.title()).toBe("Polyptic Player");
      await waitForWidth(page!, 300, 15_000);

      // D78: the trail must say so — a reload-from-cache that can't explain itself doesn't count.
      const trail = await diagTrail(page!);
      expect(trail).toContain("shell from cache, restored slice rev");

      await page!.screenshot({ path: join(SCREENSHOT_DIR, "reload-mid-outage.png") });
    },
    30_000,
  );

  test(
    "the server returns with a NEWER build → live reconcile, revalidate, swap — no manual action",
    async () => {
      server = spawnServer(distV2);
      await waitHealthy();
      // Same machine, same connector, fresh memory store → the SAME sequential screen id.
      const attached = await attachAgent();
      expect(attached.screenId).toBe(screenId);
      agentWs = attached.ws;
      await assignImage(screenId, IMAGE_AFTER, "Drill image (after outage)");

      // The player's WS backoff reconnects (≤10s) → new render paints live (D5, no manual action)…
      await waitForWidth(page!, 400, 30_000);

      // …and server contact revalidates the shell: the v2 worker installs, the page swaps into it
      // (one reload at the safe moment) and boots stamped with the new build's version (D107).
      await page!.waitForFunction(
        `(localStorage.getItem("polyptic:diag") ?? "").includes(${JSON.stringify(`v${V2}`)})`,
        undefined,
        { timeout: 30_000 },
      );
      // The swapped-in page still shows the live content — the reload cost the wall nothing.
      await waitForWidth(page!, 400, 15_000);
      expect(await paintedWidth(page!)).toBe(400);
    },
    90_000,
  );
});

// Keep `bun test` output honest when the suite can't run.
test.skipIf(!!CHROMIUM)("player offline reload drill SKIPPED — no Chromium found (set POL132_CHROME)", () => {
  expect(CHROMIUM).toBeNull();
});
