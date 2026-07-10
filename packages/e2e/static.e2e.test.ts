/**
 * @polyptic/e2e — Phase 8 SPA-SERVING suite against the REAL control plane.
 *
 * Phase 8 packages Polyptic as ONE artifact: the server can SERVE the built Console SPA (and the
 * Player SPA) as static assets straight from disk, same-origin. Same-origin is the real simplification
 * — the session cookie "just works" with no cross-origin CORS dance. The server learns two new env
 * knobs:
 *
 *   - CONSOLE_DIR — a directory holding the built Console SPA (index.html + assets/…). When set:
 *       · GET /                       → 200, the Console index.html
 *       · GET /assets/<file>          → 200, the static asset, byte-for-byte
 *       · GET /<any-spa-route>        → 200, index.html (history/SPA fallback — client router takes over)
 *   - PLAYER_DIR — a directory holding the built Player SPA, mounted under /player:
 *       · GET /player and /player/    → 200, the Player index.html
 *
 * THE CRUCIAL INVARIANT (a packaging regression magnet): the SPA history fallback must NEVER shadow
 * the API / device / ops surfaces. Those routes win; only genuinely unmatched, non-API paths fall
 * through to index.html. So with the SPA mounted we STILL assert:
 *
 *   - GET /api/v1/screens   → 200 JSON array (the real REST handler, NOT index.html)
 *   - GET /healthz          → 200 JSON liveness  (ungated ops route, NOT index.html)
 *   - GET /metrics          → 200 text/plain Prometheus exposition (NOT index.html)
 *   - GET /api/v1/unknown   → 404 JSON (an unmatched API route is a real 404 — NOT the SPA html, which
 *                             would make every typo look like a working page)
 *
 * We avoid a real `vite build` entirely (it can't run in this sandbox, and shouldn't need to): we
 * fabricate a CONSOLE_DIR and a PLAYER_DIR on disk with hand-written marker files. The marker strings
 * let every assertion distinguish "the SPA index was served" from "a JSON/text handler answered".
 *
 * We spawn the actual server (`packages/server/src/index.ts`) against the MemoryStore (STORE=memory)
 * on its OWN PORT (8099) with AUTH_ENABLED=false and the two DIR envs pointed at the temp dirs, then
 * drive every surface over plain `fetch`. The temp dirs are removed in afterAll; the server process is
 * torn down there too. Its port + fresh memory store keep it independent of the other e2e suites.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const PORT = 8099;
const BASE = `http://localhost:${PORT}`;
const TEST_TIMEOUT = 10_000;

// Marker bodies — unique sentinels so an assertion can tell EXACTLY which file/handler answered.
const CONSOLE_INDEX_HTML = "<!doctype html><html><head><title>polyptic-console</title></head><body><div id=\"app\">CONSOLE_INDEX_MARKER</div></body></html>";
const CONSOLE_APP_JS = "/* CONSOLE_APP_JS_MARKER */ window.__polyptic_console__ = true;\n";
const PLAYER_INDEX_HTML = "<!doctype html><html><head><title>polyptic-player</title></head><body><div id=\"app\">PLAYER_INDEX_MARKER</div></body></html>";
// Favicons (POL-56) live at each SPA's dist ROOT, not under assets/ — a placement @fastify/static's
// boot-time glob has to pick up for the browser's bare /favicon.ico request to be answered.
const CONSOLE_FAVICON_SVG = "<svg xmlns=\"http://www.w3.org/2000/svg\"><!-- CONSOLE_FAVICON_MARKER --></svg>";
const PLAYER_FAVICON_SVG = "<svg xmlns=\"http://www.w3.org/2000/svg\"><!-- PLAYER_FAVICON_MARKER --></svg>";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const serverEntry = resolve(repoRoot, "packages", "server", "src", "index.ts");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// Temp SPA roots: fabricate the built-artifact layout WITHOUT a real vite build.
//
//   consoleDir/index.html
//   consoleDir/assets/app.js
//   consoleDir/favicon.svg
//   playerDir/index.html
//   playerDir/favicon.svg
//
// ─────────────────────────────────────────────────────────────────────────────

let consoleDir = "";
let playerDir = "";

function fabricateSpaRoots(): void {
  const root = mkdtempSync(join(tmpdir(), "polyptic-static-e2e-"));
  consoleDir = join(root, "console");
  playerDir = join(root, "player");

  mkdirSync(join(consoleDir, "assets"), { recursive: true });
  writeFileSync(join(consoleDir, "index.html"), CONSOLE_INDEX_HTML, "utf8");
  writeFileSync(join(consoleDir, "assets", "app.js"), CONSOLE_APP_JS, "utf8");
  writeFileSync(join(consoleDir, "favicon.svg"), CONSOLE_FAVICON_SVG, "utf8");

  mkdirSync(playerDir, { recursive: true });
  writeFileSync(join(playerDir, "index.html"), PLAYER_INDEX_HTML, "utf8");
  writeFileSync(join(playerDir, "favicon.svg"), PLAYER_FAVICON_SVG, "utf8");
}

function removeSpaRoots(): void {
  // Both dirs share a parent mkdtemp root; remove that parent.
  for (const dir of [consoleDir, playerDir]) {
    if (!dir) continue;
    try {
      rmSync(dirname(dir), { recursive: true, force: true });
      return;
    } catch {
      /* fall through to per-dir cleanup */
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Server process lifecycle
// ─────────────────────────────────────────────────────────────────────────────

let proc: ReturnType<typeof Bun.spawn> | null = null;

async function waitForServer(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "never responded";
  while (Date.now() < deadline) {
    try {
      // /healthz is ungated + dependency-light — the right readiness probe.
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
  fabricateSpaRoots();

  proc = Bun.spawn(["bun", serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      STORE: "memory",
      PORT: String(PORT),
      // Auth OFF: this suite is about static serving, not the gate — keep requests cookie-free.
      AUTH_ENABLED: "false",
      // The two Phase 8 knobs under test: serve the (fabricated) built SPAs from disk, same-origin.
      CONSOLE_DIR: consoleDir,
      PLAYER_DIR: playerDir,
      LOG_LEVEL: "error",
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  await waitForServer();
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
  removeSpaRoots();
}, 10_000);

// ─────────────────────────────────────────────────────────────────────────────
// The SPA is served from disk, same-origin
// ─────────────────────────────────────────────────────────────────────────────

describe("phase 8 static SPA serving", () => {
  test(
    "GET / serves the Console index.html",
    async () => {
      const res = await fetch(`${BASE}/`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("CONSOLE_INDEX_MARKER");
      // It's the HTML doc, not some JSON envelope.
      expect((res.headers.get("content-type") ?? "").toLowerCase()).toContain("html");
    },
    TEST_TIMEOUT,
  );

  test(
    "GET /assets/app.js serves the static asset byte-for-byte",
    async () => {
      const res = await fetch(`${BASE}/assets/app.js`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toBe(CONSOLE_APP_JS);
      // A real asset, NOT the SPA fallback index.html.
      expect(body).not.toContain("CONSOLE_INDEX_MARKER");
    },
    TEST_TIMEOUT,
  );

  test(
    "GET /<deep-spa-route> with no matching file falls back to the Console index.html (SPA history fallback)",
    async () => {
      const res = await fetch(`${BASE}/murals/some-id/edit`);
      expect(res.status).toBe(200);
      const body = await res.text();
      // The client-side router handles the route; the server just returns the shell.
      expect(body).toContain("CONSOLE_INDEX_MARKER");
      expect((res.headers.get("content-type") ?? "").toLowerCase()).toContain("html");
    },
    TEST_TIMEOUT,
  );

  test(
    "GET /player and /player/ serve the Player index.html",
    async () => {
      for (const path of ["/player", "/player/"]) {
        const res = await fetch(`${BASE}${path}`);
        expect(res.status).toBe(200);
        const body = await res.text();
        // The PLAYER shell, distinct from the Console shell.
        expect(body).toContain("PLAYER_INDEX_MARKER");
        expect(body).not.toContain("CONSOLE_INDEX_MARKER");
        expect((res.headers.get("content-type") ?? "").toLowerCase()).toContain("html");
      }
    },
    TEST_TIMEOUT,
  );

  // ───────────────────────────────────────────────────────────────────────────
  // Favicons (POL-56): served from each SPA's dist root, each under its own base.
  // ───────────────────────────────────────────────────────────────────────────

  test(
    "GET /favicon.svg serves the Console favicon from the dist root",
    async () => {
      const res = await fetch(`${BASE}/favicon.svg`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("CONSOLE_FAVICON_MARKER");
      // The real icon bytes, NOT the SPA fallback html — a browser would silently drop an HTML icon.
      expect(body).not.toContain("CONSOLE_INDEX_MARKER");
      expect((res.headers.get("content-type") ?? "").toLowerCase()).toContain("image/svg+xml");
    },
    TEST_TIMEOUT,
  );

  test(
    "GET /player/favicon.svg serves the PLAYER favicon, not the Console's",
    async () => {
      const res = await fetch(`${BASE}/player/favicon.svg`);
      expect(res.status).toBe(200);
      const body = await res.text();
      // Each SPA root carries its own copy; /player/ must resolve within the player dist.
      expect(body).toContain("PLAYER_FAVICON_MARKER");
      expect(body).not.toContain("CONSOLE_FAVICON_MARKER");
      expect((res.headers.get("content-type") ?? "").toLowerCase()).toContain("image/svg+xml");
    },
    TEST_TIMEOUT,
  );

  test(
    "GET /favicon.ico with no such file is a real 404, NOT the SPA fallback html",
    async () => {
      // The regression this pins: `looksLikeNavigation` must treat an icon request as an ASSET fetch.
      // Answering it with index.html would make a missing favicon look like a 200 to every crawler
      // and bury the real breakage.
      const res = await fetch(`${BASE}/favicon.ico`);
      expect(res.status).toBe(404);
      const body = await res.text();
      expect(body).not.toContain("CONSOLE_INDEX_MARKER");
      expect((res.headers.get("content-type") ?? "").toLowerCase()).toContain("json");
    },
    TEST_TIMEOUT,
  );

  // ───────────────────────────────────────────────────────────────────────────
  // CRUCIAL: the API / ops surfaces still WIN — the SPA fallback never shadows them.
  // ───────────────────────────────────────────────────────────────────────────

  test(
    "GET /api/v1/screens returns the REST JSON array, NOT the SPA index.html",
    async () => {
      const res = await fetch(`${BASE}/api/v1/screens`);
      expect(res.status).toBe(200);
      expect((res.headers.get("content-type") ?? "").toLowerCase()).toContain("json");
      const body = await res.text();
      expect(body).not.toContain("CONSOLE_INDEX_MARKER");
      // It parses as JSON and is an array of screens (empty here — fresh memory store).
      const parsed = JSON.parse(body);
      expect(Array.isArray(parsed)).toBe(true);
    },
    TEST_TIMEOUT,
  );

  test(
    "GET /healthz returns ungated liveness JSON, NOT the SPA index.html",
    async () => {
      const res = await fetch(`${BASE}/healthz`);
      expect(res.status).toBe(200);
      expect((res.headers.get("content-type") ?? "").toLowerCase()).toContain("json");
      const body = await res.text();
      expect(body).not.toContain("CONSOLE_INDEX_MARKER");
      const parsed = JSON.parse(body);
      expect(typeof parsed).toBe("object");
      expect(parsed).not.toBeNull();
      // /healthz reports a status field.
      expect(typeof parsed.status).toBe("string");
    },
    TEST_TIMEOUT,
  );

  test(
    "GET /metrics returns Prometheus text exposition, NOT the SPA index.html",
    async () => {
      const res = await fetch(`${BASE}/metrics`);
      expect(res.status).toBe(200);
      const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
      expect(contentType).toContain("text/plain");
      const body = await res.text();
      expect(body).not.toContain("CONSOLE_INDEX_MARKER");
      // A Prometheus exposition carries HELP/TYPE comment lines.
      expect(body).toContain("# HELP");
      expect(body).toContain("# TYPE");
    },
    TEST_TIMEOUT,
  );

  test(
    "GET /api/v1/unknown is a real 404 JSON, NOT the SPA fallback html",
    async () => {
      const res = await fetch(`${BASE}/api/v1/unknown`);
      expect(res.status).toBe(404);
      const body = await res.text();
      // The fallback must not turn an unmatched API route into a 200 page — that would mask typos
      // and make every bad endpoint look like a working SPA route.
      expect(body).not.toContain("CONSOLE_INDEX_MARKER");
      expect(body).not.toContain("PLAYER_INDEX_MARKER");
      expect((res.headers.get("content-type") ?? "").toLowerCase()).toContain("json");
    },
    TEST_TIMEOUT,
  );
});
