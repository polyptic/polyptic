/**
 * @polyptic/e2e, NETBOOT boot depot (POL-33).
 *
 * A bare box HTTP-boots a live Polyptic image straight into RAM, no OS install, no disk. This suite
 * drives the server-side boot-depot HTTP surface (added to provision.ts) against the REAL control plane.
 *
 * The box has no operator session, so the boot routes are TOP-LEVEL + UNGATED (like /install, /healthz):
 *   - GET /boot.ipxe                         → the iPXE chain script, control-plane base baked from the
 *                                              Host header, enrolment token baked in GATED mode only.
 *                                              `?offload=1` tags the cmdline for the offload flow.
 *   - GET /dist/image/:arch/{vmlinuz,initrd,squashfs} → the live-image artifacts, Range-streamed (206).
 *   - GET /dist/ipxe/:file                   → the tokenless prebuilt boot medium (polyptic-boot-*.efi).
 * And one operator-facing route, GATED under /api/v1 (reachable cookie-free here with AUTH_ENABLED=false):
 *   - GET /api/v1/settings/netboot           → NetbootInfo {baseUrl, mode, bootIpxeUrl, bootMediumUrl}.
 *
 * We fabricate IMAGE_DIST_DIR + IPXE_DIST_DIR on disk with marker files (no real image build) and a
 * SECRET canary OUTSIDE both roots to prove traversal never leaks. Two servers are spawned on their own
 * ports: OPEN (no token) on 8111 and GATED (POLYPTIC_BOOTSTRAP_TOKEN set) on 8112, so both enrolment
 * modes are asserted. Temp dirs are removed + both servers torn down in afterAll.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const OPEN_PORT = 8111;
const GATED_PORT = 8112;
const OPEN_HOST = `localhost:${OPEN_PORT}`;
const GATED_HOST = `localhost:${GATED_PORT}`;
const OPEN_BASE = `http://${OPEN_HOST}`;
const GATED_BASE = `http://${GATED_HOST}`;
const FLEET_TOKEN = "netboot-e2e-fleet-token-abc123";
const TEST_TIMEOUT = 10_000;

// Marker bytes, unique sentinels so an assertion can prove EXACTLY which file answered. The squashfs is
// deliberately long enough to range over.
const VMLINUZ_BYTES = "FAKE_POLYPTIC_VMLINUZ\x00kernel-marker\n";
const INITRD_BYTES = "FAKE_POLYPTIC_INITRD\x00initrd-marker\n";
const SQUASHFS_BYTES =
  "FAKE_POLYPTIC_SQUASHFS_ROOTFS_" + "0123456789abcdef".repeat(8) + "\x00rootfs-marker\n";
const BOOT_MEDIUM_NAME = "polyptic-boot-amd64.efi";
const BOOT_MEDIUM_BYTES = "FAKE_POLYPTIC_IPXE_EFI\x00MZ-marker\n";
const SECRET_MARKER = "TOP_SECRET_OUT_OF_ROOT_FILE_CONTENTS_DO_NOT_LEAK";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const serverEntry = resolve(repoRoot, "packages", "server", "src", "index.ts");

/** The shape of GET /api/v1/settings/netboot (NetbootInfo), for typing the parsed JSON in assertions. */
type NetbootInfoShape = {
  baseUrl: string;
  mode: string;
  bootIpxeUrl: string;
  bootMediumUrl: string | null;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// Temp dist roots: fabricate the netboot artifact layout WITHOUT a real image build.
//   imageDir/amd64/{vmlinuz,initrd,squashfs}   (NO arm64 dir, asserts a clean 404)
//   ipxeDir/polyptic-boot-amd64.efi
//   rootDir/secret.txt                          (traversal canary, OUTSIDE both roots)
// ─────────────────────────────────────────────────────────────────────────────

let rootDir = "";
let imageDir = "";
let ipxeDir = "";

function fabricateDistRoots(): void {
  rootDir = mkdtempSync(join(tmpdir(), "polyptic-netboot-e2e-"));
  imageDir = join(rootDir, "image");
  ipxeDir = join(rootDir, "ipxe");

  const amd64 = join(imageDir, "amd64");
  mkdirSync(amd64, { recursive: true });
  writeFileSync(join(amd64, "vmlinuz"), VMLINUZ_BYTES, "binary");
  writeFileSync(join(amd64, "initrd"), INITRD_BYTES, "binary");
  writeFileSync(join(amd64, "squashfs"), SQUASHFS_BYTES, "binary");

  mkdirSync(ipxeDir, { recursive: true });
  writeFileSync(join(ipxeDir, BOOT_MEDIUM_NAME), BOOT_MEDIUM_BYTES, "binary");

  writeFileSync(join(rootDir, "secret.txt"), SECRET_MARKER, "utf8");
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
// Server process lifecycle, two servers (open + gated)
// ─────────────────────────────────────────────────────────────────────────────

let openProc: ReturnType<typeof Bun.spawn> | null = null;
let gatedProc: ReturnType<typeof Bun.spawn> | null = null;

function spawnServer(port: number, token?: string): ReturnType<typeof Bun.spawn> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    STORE: "memory",
    PORT: String(port),
    // The boot routes are UNGATED by design; the settings route is under /api/v1 but AUTH_ENABLED=false
    // lets the e2e reach it cookie-free (the gate no-ops).
    AUTH_ENABLED: "false",
    IMAGE_DIST_DIR: imageDir,
    IPXE_DIST_DIR: ipxeDir,
    LOG_LEVEL: "error",
  };
  if (token) env.POLYPTIC_BOOTSTRAP_TOKEN = token;
  return Bun.spawn(["bun", serverEntry], {
    cwd: repoRoot,
    env,
    stdout: "inherit",
    stderr: "inherit",
  });
}

async function waitForServer(base: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "never responded";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/healthz`);
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
  throw new Error(`server did not become ready on ${base}: ${lastErr}`);
}

beforeAll(async () => {
  fabricateDistRoots();
  openProc = spawnServer(OPEN_PORT);
  gatedProc = spawnServer(GATED_PORT, FLEET_TOKEN);
  await Promise.all([waitForServer(OPEN_BASE), waitForServer(GATED_BASE)]);
}, 30_000);

afterAll(async () => {
  for (const proc of [openProc, gatedProc]) {
    if (!proc) continue;
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
// GET /boot.ipxe, the iPXE chain script
// ─────────────────────────────────────────────────────────────────────────────

describe("netboot: GET /boot.ipxe", () => {
  test(
    "OPEN mode: an ungated iPXE script with the base baked from the Host header, NO token",
    async () => {
      const res = await fetch(`${OPEN_BASE}/boot.ipxe`);
      expect(res.status).toBe(200);
      const ct = (res.headers.get("content-type") ?? "").toLowerCase();
      expect(ct.includes("text/plain") || ct.includes("ipxe")).toBe(true);

      const body = await res.text();
      expect(body.startsWith("#!ipxe")).toBe(true);
      // The control-plane base is the exact host the box fetched from (Host header), like /install.
      expect(body).toContain(`set polyptic_base ${OPEN_BASE}`);
      // Derived WS agent URL.
      expect(body).toContain(`set polyptic_ws ws://${OPEN_HOST}/agent`);
      expect(body).toContain("/dist/image/");
      expect(body).toContain("boot=casper");
      // OPEN mode carries NO enrolment token.
      expect(body).not.toContain("set polyptic_token");
      expect(body).not.toContain("polyptic.token=");
    },
    TEST_TIMEOUT,
  );

  test(
    "GATED mode: bakes in the current enrolment token so the diskless box carries it",
    async () => {
      const res = await fetch(`${GATED_BASE}/boot.ipxe`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain(`set polyptic_base ${GATED_BASE}`);
      expect(body).toContain(`set polyptic_token ${FLEET_TOKEN}`);
      expect(body).toContain("polyptic.token=${polyptic_token}");
    },
    TEST_TIMEOUT,
  );

  test(
    "?offload=1 tags the kernel cmdline for the one-shot ESP-loader install",
    async () => {
      const plain = await (await fetch(`${GATED_BASE}/boot.ipxe`)).text();
      expect(plain).not.toContain("polyptic.offload=1");

      const off = await (await fetch(`${GATED_BASE}/boot.ipxe?offload=1`)).text();
      expect(off).toContain("polyptic.offload=1");
    },
    TEST_TIMEOUT,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /dist/image/:arch/:file, the live-image artifacts, Range-aware
// ─────────────────────────────────────────────────────────────────────────────

describe("netboot: GET /dist/image/:arch/:file", () => {
  test(
    "streams the full squashfs (200) with Accept-Ranges",
    async () => {
      const res = await fetch(`${OPEN_BASE}/dist/image/amd64/squashfs`);
      expect(res.status).toBe(200);
      expect((res.headers.get("accept-ranges") ?? "").toLowerCase()).toBe("bytes");
      expect(await res.text()).toBe(SQUASHFS_BYTES);
    },
    TEST_TIMEOUT,
  );

  test(
    "serves vmlinuz + initrd byte-for-byte",
    async () => {
      expect(await (await fetch(`${OPEN_BASE}/dist/image/amd64/vmlinuz`)).text()).toBe(VMLINUZ_BYTES);
      expect(await (await fetch(`${OPEN_BASE}/dist/image/amd64/initrd`)).text()).toBe(INITRD_BYTES);
    },
    TEST_TIMEOUT,
  );

  test(
    "honours a byte Range with a 206 + exact Content-Range + partial body",
    async () => {
      const res = await fetch(`${OPEN_BASE}/dist/image/amd64/squashfs`, {
        headers: { Range: "bytes=0-9" },
      });
      expect(res.status).toBe(206);
      expect(res.headers.get("content-range")).toBe(`bytes 0-9/${SQUASHFS_BYTES.length}`);
      expect(res.headers.get("content-length")).toBe("10");
      expect(await res.text()).toBe(SQUASHFS_BYTES.slice(0, 10));
    },
    TEST_TIMEOUT,
  );

  test(
    "a suffix Range (last N bytes) returns the tail",
    async () => {
      const res = await fetch(`${OPEN_BASE}/dist/image/amd64/squashfs`, {
        headers: { Range: "bytes=-8" },
      });
      expect(res.status).toBe(206);
      const len = SQUASHFS_BYTES.length;
      expect(res.headers.get("content-range")).toBe(`bytes ${len - 8}-${len - 1}/${len}`);
      expect(await res.text()).toBe(SQUASHFS_BYTES.slice(len - 8));
    },
    TEST_TIMEOUT,
  );

  test(
    "a Range past EOF is 416 with a Content-Range of the size",
    async () => {
      const len = SQUASHFS_BYTES.length;
      const res = await fetch(`${OPEN_BASE}/dist/image/amd64/squashfs`, {
        headers: { Range: `bytes=${len}-${len + 10}` },
      });
      expect(res.status).toBe(416);
      expect(res.headers.get("content-range")).toBe(`bytes */${len}`);
    },
    TEST_TIMEOUT,
  );

  test(
    "404 for a file outside the {vmlinuz,initrd,squashfs} whitelist (never leaks a sibling)",
    async () => {
      const res = await fetch(`${OPEN_BASE}/dist/image/amd64/passwd`);
      expect(res.status).toBe(404);
      const body = await res.text();
      expect(body).not.toContain(SECRET_MARKER);
    },
    TEST_TIMEOUT,
  );

  test(
    "404 for an unknown arch, and for an arch with no image bundled (arm64)",
    async () => {
      expect((await fetch(`${OPEN_BASE}/dist/image/x86/vmlinuz`)).status).toBe(404);
      expect((await fetch(`${OPEN_BASE}/dist/image/arm64/squashfs`)).status).toBe(404);
    },
    TEST_TIMEOUT,
  );

  test(
    "path traversal in :file never escapes the image dist root",
    async () => {
      const attempts = [
        "/dist/image/amd64/..%2f..%2f..%2fsecret.txt",
        "/dist/image/amd64/%2e%2e%2f%2e%2e%2fsecret.txt",
        "/dist/image/amd64/../../../secret.txt",
      ];
      for (const path of attempts) {
        const res = await fetch(`${OPEN_BASE}${path}`);
        const body = await res.text();
        expect(body).not.toContain(SECRET_MARKER);
      }
    },
    TEST_TIMEOUT,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /dist/ipxe/:file, the tokenless boot medium
// ─────────────────────────────────────────────────────────────────────────────

describe("netboot: GET /dist/ipxe/:file", () => {
  test(
    "serves the bundled boot medium byte-for-byte (ungated) with a download filename",
    async () => {
      const res = await fetch(`${OPEN_BASE}/dist/ipxe/${BOOT_MEDIUM_NAME}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition") ?? "").toContain(BOOT_MEDIUM_NAME);
      expect(await res.text()).toBe(BOOT_MEDIUM_BYTES);
    },
    TEST_TIMEOUT,
  );

  test(
    "404 for a filename outside the polyptic-boot-<arch>.{efi,img} whitelist",
    async () => {
      for (const name of ["evil.sh", "polyptic-boot-amd64.txt", "polyptic-boot-x86.efi", "../secret.txt"]) {
        const res = await fetch(`${OPEN_BASE}/dist/ipxe/${encodeURIComponent(name)}`);
        expect(res.status).toBe(404);
        const body = await res.text();
        expect(body).not.toContain(SECRET_MARKER);
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "404 for a well-formed-but-unbundled medium (arm64)",
    async () => {
      expect((await fetch(`${OPEN_BASE}/dist/ipxe/polyptic-boot-arm64.efi`)).status).toBe(404);
    },
    TEST_TIMEOUT,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/settings/netboot, the operator-facing (gated) info
// ─────────────────────────────────────────────────────────────────────────────

describe("netboot: GET /api/v1/settings/netboot", () => {
  test(
    "GATED server reports mode=gated, the correct URLs, and the bundled medium",
    async () => {
      const res = await fetch(`${GATED_BASE}/api/v1/settings/netboot`);
      expect(res.status).toBe(200);
      const info = (await res.json()) as NetbootInfoShape;
      expect(info.mode).toBe("gated");
      expect(info.baseUrl).toBe(GATED_BASE);
      expect(info.bootIpxeUrl).toBe(`${GATED_BASE}/boot.ipxe`);
      expect(info.bootMediumUrl).toBe(`${GATED_BASE}/dist/ipxe/${BOOT_MEDIUM_NAME}`);
      // Secret-free: the token is NOT surfaced here (it lives in EnrollmentInfo).
      expect(JSON.stringify(info)).not.toContain(FLEET_TOKEN);
    },
    TEST_TIMEOUT,
  );

  test(
    "OPEN server reports mode=open",
    async () => {
      const res = await fetch(`${OPEN_BASE}/api/v1/settings/netboot`);
      expect(res.status).toBe(200);
      const info = (await res.json()) as NetbootInfoShape;
      expect(info.mode).toBe("open");
      expect(info.bootMediumUrl).toBe(`${OPEN_BASE}/dist/ipxe/${BOOT_MEDIUM_NAME}`);
    },
    TEST_TIMEOUT,
  );
});
