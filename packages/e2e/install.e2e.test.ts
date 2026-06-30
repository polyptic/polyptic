/**
 * @polyptic/e2e — ZERO-TOUCH AIR-GAPPED EDGE PROVISIONING surface (k3s-style).
 *
 * The control plane learns to provision an edge box that can reach ONLY the server (no internet).
 * The box does `curl -sfL http://HOST:8080/install | POLYPTIC_TOKEN=xyz sh -` and everything it needs
 * — the install script, the agent binary, and the bundled substrate .debs — is streamed back from the
 * SAME server. This suite drives that HTTP surface against the REAL control plane.
 *
 * Everything here is TOP-LEVEL + UNGATED (like /healthz): the box has no operator session, sends no
 * cookie. The server learns two new env knobs:
 *
 *   - AGENT_DIST_DIR — a directory holding the prebuilt agent binaries, one file per arch named
 *       `polyptic-agent-<arch>` (arch ∈ arm64|amd64). Served at GET /dist/agent/:arch.
 *   - DEPS_DIST_DIR — a directory holding the bundled substrate .debs under
 *       `deps/<distro>/<arch>/{manifest.json,<file>}`. Served at:
 *         · GET /dist/deps/:distro/:arch/manifest.json
 *         · GET /dist/deps/:distro/:arch/:file
 *
 * THE ASSERTIONS (all cookie-free):
 *   - GET /install → 200, shell-ish content-type, body starts with '#!' AND contains the spawned
 *     server's host:port — proving the script's base URL was injected from the Host header (the box
 *     uses the exact URL it curled, so the air-gapped flow targets the server only).
 *   - GET /dist/agent/arm64 → 200 with the fake bytes, byte-for-byte.
 *   - GET /dist/agent/<bad arch> → 404/400 (never streams an unknown arch).
 *   - PATH TRAVERSAL attempts (encoded ../) on both /dist/agent and /dist/deps → never escape the
 *     dist root: 404/400, and NEVER the contents of an out-of-root file (e.g. /etc/passwd).
 *   - GET /dist/deps/ubuntu-24.04/arm64/manifest.json → 200 JSON (the offline bundle exists).
 *   - GET /dist/deps/ubuntu-24.04/arm64/<file> → 200 with the fake .deb bytes.
 *   - GET /dist/deps/fedora-99/arm64/manifest.json → 404 (no bundle → the script falls back to
 *     online package managers / errors clearly).
 *
 * We fabricate AGENT_DIST_DIR + DEPS_DIST_DIR on disk with marker files (no real agent build, no real
 * .debs — the bytes just need to be uniquely identifiable). We spawn the actual server
 * (`packages/server/src/index.ts`) against the MemoryStore (STORE=memory) on its OWN PORT (8099) with
 * AUTH_ENABLED=false and the two DIR envs pointed at the temp dirs, then drive every surface over plain
 * `fetch`. Temp dirs are removed and the server is torn down in afterAll; its port + fresh memory store
 * keep it independent of the other e2e suites (which run sequentially).
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
const HOST = `localhost:${PORT}`;
const BASE = `http://${HOST}`;
const TEST_TIMEOUT = 10_000;

// Marker bytes — unique sentinels so an assertion can prove EXACTLY which file answered.
const AGENT_ARM64_BYTES = "FAKE_POLYPTIC_AGENT_ARM64_BINARY\x00\x01\x02ELFish-marker\n";
const DEPS_DISTRO = "ubuntu-24.04";
const DEPS_ARCH = "arm64";
const DEPS_DEB_NAME = "fake.deb";
const DEPS_DEB_BYTES = "FAKE_DEB_PACKAGE_PAYLOAD\x00sway+greetd+chromium-marker\n";
const DEPS_MANIFEST = {
  distro: DEPS_DISTRO,
  arch: DEPS_ARCH,
  packages: [{ file: DEPS_DEB_NAME, name: "fake", version: "1.0.0" }],
};

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const serverEntry = resolve(repoRoot, "packages", "server", "src", "index.ts");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// Temp dist roots: fabricate the bundled-artifact layout WITHOUT a real agent build or real .debs.
//
//   agentDir/polyptic-agent-arm64
//   depsDir/deps/ubuntu-24.04/arm64/manifest.json
//   depsDir/deps/ubuntu-24.04/arm64/fake.deb
//
// A SECRET file is planted OUTSIDE both roots (a sibling of the mkdtemp root) so a successful path
// traversal would visibly leak its contents — and we assert it never does.
// ─────────────────────────────────────────────────────────────────────────────

let rootDir = "";
let agentDir = "";
let depsDir = "";
let secretFile = "";
const SECRET_MARKER = "TOP_SECRET_OUT_OF_ROOT_FILE_CONTENTS_DO_NOT_LEAK";

function fabricateDistRoots(): void {
  rootDir = mkdtempSync(join(tmpdir(), "polyptic-install-e2e-"));
  agentDir = join(rootDir, "agent");
  depsDir = join(rootDir, "deps-root");

  // Agent binaries: one file per arch.
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "polyptic-agent-arm64"), AGENT_ARM64_BYTES, "binary");

  // Deps bundle: deps/<distro>/<arch>/{manifest.json,fake.deb}
  const bundleDir = join(depsDir, "deps", DEPS_DISTRO, DEPS_ARCH);
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(join(bundleDir, "manifest.json"), JSON.stringify(DEPS_MANIFEST), "utf8");
  writeFileSync(join(bundleDir, DEPS_DEB_NAME), DEPS_DEB_BYTES, "binary");

  // A secret OUTSIDE every dist root — the traversal canary.
  secretFile = join(rootDir, "secret.txt");
  writeFileSync(secretFile, SECRET_MARKER, "utf8");
}

function removeDistRoots(): void {
  if (!rootDir) return;
  try {
    rmSync(rootDir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
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
  fabricateDistRoots();

  proc = Bun.spawn(["bun", serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      STORE: "memory",
      PORT: String(PORT),
      // Auth OFF: this surface is UNGATED by design (the box has no session) — keep requests cookie-free.
      AUTH_ENABLED: "false",
      // The two air-gapped-provisioning knobs under test.
      AGENT_DIST_DIR: agentDir,
      DEPS_DIST_DIR: depsDir,
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
  removeDistRoots();
}, 10_000);

// ─────────────────────────────────────────────────────────────────────────────
// GET /install — the bootstrap script, base URL baked in from the Host header
// ─────────────────────────────────────────────────────────────────────────────

describe("air-gapped provisioning: GET /install", () => {
  test(
    "returns an ungated shell script whose base URL is injected from the Host header",
    async () => {
      // No cookie — the box has no operator session.
      const res = await fetch(`${BASE}/install`);
      expect(res.status).toBe(200);

      // Shell-ish content type (text/x-shellscript, application/x-sh, or text/plain — all acceptable).
      const ct = (res.headers.get("content-type") ?? "").toLowerCase();
      expect(ct.includes("sh") || ct.includes("text/plain") || ct.includes("shell")).toBe(true);

      const body = await res.text();

      // It's an executable script.
      expect(body.startsWith("#!")).toBe(true);

      // CRUCIAL: the base URL is the exact host:port the box curled (injected from the Host header),
      // so the air-gapped flow only ever targets THIS server. If the host weren't injected, a baked-in
      // placeholder would point the box somewhere it can't reach.
      expect(body).toContain(HOST);
    },
    TEST_TIMEOUT,
  );

  test(
    "the script references the server-only download surfaces it will curl (agent + deps)",
    async () => {
      // A light sanity check that the script wires up the air-gapped paths — not the SPA, not the API.
      const res = await fetch(`${BASE}/install`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("/dist/agent/");
      expect(body).toContain("/dist/deps/");
    },
    TEST_TIMEOUT,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /dist/agent/:arch — the prebuilt agent binary, streamed
// ─────────────────────────────────────────────────────────────────────────────

describe("air-gapped provisioning: GET /dist/agent/:arch", () => {
  test(
    "serves the bundled arm64 agent binary byte-for-byte (ungated)",
    async () => {
      const res = await fetch(`${BASE}/dist/agent/arm64`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toBe(AGENT_ARM64_BYTES);
    },
    TEST_TIMEOUT,
  );

  test(
    "404/400 for an arch with no bundled binary (e.g. amd64 not provided)",
    async () => {
      const res = await fetch(`${BASE}/dist/agent/amd64`);
      // amd64 was deliberately NOT fabricated — the server must not invent it.
      expect([400, 404]).toContain(res.status);
      const body = await res.text();
      expect(body).not.toContain(AGENT_ARM64_BYTES);
    },
    TEST_TIMEOUT,
  );

  test(
    "404/400 for an unknown/invalid arch token (e.g. x86)",
    async () => {
      const res = await fetch(`${BASE}/dist/agent/x86`);
      expect([400, 404]).toContain(res.status);
      const body = await res.text();
      expect(body).not.toContain(AGENT_ARM64_BYTES);
    },
    TEST_TIMEOUT,
  );

  test(
    "path traversal in :arch never escapes the agent dist root",
    async () => {
      // Several encodings of ../../etc/passwd-style escapes. None may return file contents.
      const attempts = [
        "/dist/agent/..%2f..%2f..%2fetc%2fpasswd",
        "/dist/agent/..%2F..%2Fsecret.txt",
        "/dist/agent/%2e%2e%2f%2e%2e%2fsecret.txt",
        // A raw (non-encoded) traversal — fetch/the server may normalize, but it must not leak.
        `/dist/agent/../../secret.txt`,
      ];
      for (const path of attempts) {
        const res = await fetch(`${BASE}${path}`);
        // Either a clean rejection, or a route-miss — but NEVER 200-with-secret.
        const body = await res.text();
        expect(body).not.toContain(SECRET_MARKER);
        expect(body).not.toContain("root:x:0:0"); // a typical /etc/passwd line
        if (res.status === 200) {
          // If anything 200s, it must not be out-of-root content (defensive — should be 400/404).
          expect(body).not.toContain(SECRET_MARKER);
        }
      }
    },
    TEST_TIMEOUT,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /dist/deps/:distro/:arch/... — the bundled substrate .debs
// ─────────────────────────────────────────────────────────────────────────────

describe("air-gapped provisioning: GET /dist/deps/:distro/:arch", () => {
  test(
    "serves the manifest.json for a bundled distro+arch (200 JSON)",
    async () => {
      const res = await fetch(`${BASE}/dist/deps/${DEPS_DISTRO}/${DEPS_ARCH}/manifest.json`);
      expect(res.status).toBe(200);
      const ct = (res.headers.get("content-type") ?? "").toLowerCase();
      expect(ct).toContain("json");
      const parsed = JSON.parse(await res.text());
      expect(parsed.distro).toBe(DEPS_DISTRO);
      expect(parsed.arch).toBe(DEPS_ARCH);
      expect(Array.isArray(parsed.packages)).toBe(true);
      expect(parsed.packages[0].file).toBe(DEPS_DEB_NAME);
    },
    TEST_TIMEOUT,
  );

  test(
    "serves a bundled .deb file byte-for-byte",
    async () => {
      const res = await fetch(`${BASE}/dist/deps/${DEPS_DISTRO}/${DEPS_ARCH}/${DEPS_DEB_NAME}`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toBe(DEPS_DEB_BYTES);
    },
    TEST_TIMEOUT,
  );

  test(
    "404 for a distro with no bundle (so the install script falls back to online/errors clearly)",
    async () => {
      const res = await fetch(`${BASE}/dist/deps/fedora-99/${DEPS_ARCH}/manifest.json`);
      expect(res.status).toBe(404);
      const body = await res.text();
      expect(body).not.toContain(DEPS_DEB_NAME);
    },
    TEST_TIMEOUT,
  );

  test(
    "404 for an unbundled arch under a known distro",
    async () => {
      const res = await fetch(`${BASE}/dist/deps/${DEPS_DISTRO}/amd64/manifest.json`);
      expect(res.status).toBe(404);
    },
    TEST_TIMEOUT,
  );

  test(
    "404 for a missing file under a real bundle (never the SPA fallback)",
    async () => {
      const res = await fetch(`${BASE}/dist/deps/${DEPS_DISTRO}/${DEPS_ARCH}/nope.deb`);
      expect(res.status).toBe(404);
      const body = await res.text();
      expect(body).not.toContain(DEPS_DEB_BYTES);
    },
    TEST_TIMEOUT,
  );

  test(
    "path traversal under /dist/deps never escapes the deps dist root",
    async () => {
      const attempts = [
        `/dist/deps/${DEPS_DISTRO}/${DEPS_ARCH}/..%2f..%2f..%2f..%2fsecret.txt`,
        `/dist/deps/${DEPS_DISTRO}/${DEPS_ARCH}/%2e%2e%2f%2e%2e%2fsecret.txt`,
        `/dist/deps/${DEPS_DISTRO}/..%2f..%2fsecret.txt`,
        `/dist/deps/..%2f..%2f..%2fsecret.txt`,
        `/dist/deps/${DEPS_DISTRO}/${DEPS_ARCH}/../../../../etc/passwd`,
      ];
      for (const path of attempts) {
        const res = await fetch(`${BASE}${path}`);
        const body = await res.text();
        expect(body).not.toContain(SECRET_MARKER);
        expect(body).not.toContain("root:x:0:0");
      }
    },
    TEST_TIMEOUT,
  );
});
