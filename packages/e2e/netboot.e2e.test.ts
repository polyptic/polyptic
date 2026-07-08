/**
 * @polyptic/e2e, NETBOOT boot depot (POL-33/D47).
 *
 * A bare box boots Ubuntu's SIGNED shim+GRUB chain over the network into a live Polyptic image in RAM,
 * Secure Boot stays ON, no OS install, no disk. This suite drives the server-side boot-depot HTTP
 * surface (provision.ts) against the REAL control plane.
 *
 * The box has no operator session, so the boot routes are TOP-LEVEL + UNGATED (like /install, /healthz):
 *   - GET /boot/grub.cfg                     → the generated GRUB menu, control-plane base baked from
 *                                              the Host header, enrolment token baked in GATED mode only.
 *   - GET /grub/grub.cfg (+ per-arch aliases) → the same menu where an HTTP-booted grubnet looks
 *                                              ($prefix resolves to (http,host:port)/grub at server root).
 *   - GET /dist/image/:arch/{vmlinuz,initrd,polyptic.iso} → the live-image artifacts, Range-streamed (206).
 *   - GET /dist/boot/:file                   → the tokenless universal dongle (polyptic-boot.img) + the
 *                                              four signed loaders (shim + GRUB .efi). shim fetches its
 *                                              second stage as <dir>//grubx64.efi (double slash).
 * And one operator-facing route, GATED under /api/v1 (reachable cookie-free here with AUTH_ENABLED=false):
 *   - GET /api/v1/settings/netboot           → NetbootInfo {baseUrl, mode, bootConfigUrl, bootMediumUrl}.
 *
 * We fabricate IMAGE_DIST_DIR + BOOT_DIST_DIR on disk with marker files (no real image build) and a
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

// Marker bytes, unique sentinels so an assertion can prove EXACTLY which file answered. The ISO is
// deliberately long enough to range over.
// Deliberately LARGE (~5MB, above Bun's small-stream buffering) so the Content-Length regression test
// is real: Bun sends any streamed body chunked, and GRUB's shim_lock verifier refuses a chunked
// (unknown-size) kernel with "big file signature isn't implemented yet", so the route must buffer it.
const VMLINUZ_BYTES = "FAKE_POLYPTIC_VMLINUZ\x00" + "K".repeat(5_000_000) + "\nkernel-marker\n";
const INITRD_BYTES = "FAKE_POLYPTIC_INITRD\x00initrd-marker\n";
const ISO_BYTES =
  "FAKE_POLYPTIC_LIVE_ISO_" + "0123456789abcdef".repeat(8) + "\x00iso-marker\n";
// A decoy by the OLD artifact name: proves the /dist/image 404 is the whitelist, not mere absence.
const SQUASHFS_DECOY_BYTES = "FAKE_POLYPTIC_SQUASHFS_DECOY_MUST_NOT_BE_SERVED\n";
const BOOT_MEDIUM_NAME = "polyptic-boot.img";
const BOOT_MEDIUM_BYTES = "FAKE_POLYPTIC_BOOT_IMG\x00FAT32-marker\n";
// The four signed loaders (shim + network GRUB, both arches), each with its own sentinel payload.
const EFI_FILES: Record<string, string> = {
  "shimx64.efi": "FAKE_POLYPTIC_SHIMX64\x00MZ-shim-x64\n",
  "shimaa64.efi": "FAKE_POLYPTIC_SHIMAA64\x00MZ-shim-aa64\n",
  "grubx64.efi": "FAKE_POLYPTIC_GRUBX64\x00MZ-grub-x64\n",
  "grubaa64.efi": "FAKE_POLYPTIC_GRUBAA64\x00MZ-grub-aa64\n",
};
const SECRET_MARKER = "TOP_SECRET_OUT_OF_ROOT_FILE_CONTENTS_DO_NOT_LEAK";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const serverEntry = resolve(repoRoot, "packages", "server", "src", "index.ts");

/** The shape of GET /api/v1/settings/netboot (NetbootInfo), for typing the parsed JSON in assertions. */
type NetbootInfoShape = {
  baseUrl: string;
  mode: string;
  bootConfigUrl: string;
  bootMediumUrl: string | null;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// Temp dist roots: fabricate the netboot artifact layout WITHOUT a real image build.
//   imageDir/amd64/{vmlinuz,initrd,polyptic.iso,squashfs}   (squashfs is a whitelist decoy;
//                                                            NO arm64 dir, asserts a clean 404)
//   bootDir/{polyptic-boot.img,shimx64.efi,shimaa64.efi,grubx64.efi,grubaa64.efi}
//   rootDir/secret.txt                                       (traversal canary, OUTSIDE both roots)
// ─────────────────────────────────────────────────────────────────────────────

let rootDir = "";
let imageDir = "";
let bootDir = "";

function fabricateDistRoots(): void {
  rootDir = mkdtempSync(join(tmpdir(), "polyptic-netboot-e2e-"));
  imageDir = join(rootDir, "image");
  bootDir = join(rootDir, "boot");

  const amd64 = join(imageDir, "amd64");
  mkdirSync(amd64, { recursive: true });
  writeFileSync(join(amd64, "vmlinuz"), VMLINUZ_BYTES, "binary");
  writeFileSync(join(amd64, "initrd"), INITRD_BYTES, "binary");
  writeFileSync(join(amd64, "polyptic.iso"), ISO_BYTES, "binary");
  writeFileSync(join(amd64, "squashfs"), SQUASHFS_DECOY_BYTES, "binary");

  mkdirSync(bootDir, { recursive: true });
  writeFileSync(join(bootDir, BOOT_MEDIUM_NAME), BOOT_MEDIUM_BYTES, "binary");
  for (const [name, bytes] of Object.entries(EFI_FILES)) {
    writeFileSync(join(bootDir, name), bytes, "binary");
  }

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
    BOOT_DIST_DIR: bootDir,
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
// GET /boot/grub.cfg, the generated GRUB menu
// ─────────────────────────────────────────────────────────────────────────────

describe("netboot: GET /boot/grub.cfg", () => {
  test(
    "OPEN mode: an ungated GRUB menu with the base baked from the Host header, NO token",
    async () => {
      const res = await fetch(`${OPEN_BASE}/boot/grub.cfg`);
      expect(res.status).toBe(200);
      expect((res.headers.get("content-type") ?? "").toLowerCase()).toContain("text/plain");
      const body = await res.text();
      // GRUB's + the firmware's HTTP clients reject chunked encoding: Content-Length must be present.
      expect(res.headers.get("content-length")).toBe(String(Buffer.byteLength(body)));

      // The GRUB net device is the exact host the box fetched from (Host header), like /install.
      expect(body).toContain(`set net=(http,${OPEN_HOST})`);
      // Both menu entries by --id; casper pulls the whole ISO (URL must end .iso); WS agent URL baked.
      expect(body).toContain("--id live");
      expect(body).toContain("--id offload");
      expect(body).toContain(`iso-url=http://${OPEN_HOST}/dist/image/$arch/polyptic.iso`);
      // Overrides the layered image name the reused initrd bakes in, else casper panics "File system
      // layers are missing" (verified on the POL-33 arm64 VM boot). Must match build-live-image.sh.
      expect(body).toContain("layerfs-path=filesystem.squashfs");
      expect(body).toContain(`polyptic.server_url=ws://${OPEN_HOST}/agent`);
      // OPEN mode carries NO enrolment token.
      expect(body).not.toContain("polyptic.token=");
    },
    TEST_TIMEOUT,
  );

  test(
    "the menu speaks noble GRUB: plain linux/initrd, --- terminator, no iPXE remnants",
    async () => {
      const body = await (await fetch(`${OPEN_BASE}/boot/grub.cfg`)).text();
      // Noble's signed GRUB dropped linuxefi/initrdefi; only plain `linux` + `initrd` exist.
      expect(body).not.toContain("linuxefi");
      expect(body).not.toContain("initrdefi");
      expect(body).toMatch(/^ {2}linux {2}\$net\/dist\/image\/\$arch\/vmlinuz .+ ---$/m);
      expect(body).toMatch(/^ {2}initrd \$net\/dist\/image\/\$arch\/initrd$/m);
      // The iPXE first stage is gone (D47): no shebang, no chain URL.
      expect(body).not.toContain("#!ipxe");
      expect(body).not.toContain("boot.ipxe");
    },
    TEST_TIMEOUT,
  );

  test(
    "only the offload entry tags the cmdline with polyptic.offload=1 (before the --- terminator)",
    async () => {
      const body = await (await fetch(`${OPEN_BASE}/boot/grub.cfg`)).text();
      const liveStart = body.indexOf("--id live");
      const offloadStart = body.indexOf("--id offload");
      expect(liveStart).toBeGreaterThan(-1);
      expect(offloadStart).toBeGreaterThan(liveStart);
      const liveEntry = body.slice(liveStart, offloadStart);
      const offloadEntry = body.slice(offloadStart);
      expect(liveEntry).not.toContain("polyptic.offload=1");
      expect(offloadEntry).toContain("polyptic.offload=1 ---");
    },
    TEST_TIMEOUT,
  );

  test(
    "GATED mode: bakes in the current enrolment token, inside the arg list (before ---)",
    async () => {
      const res = await fetch(`${GATED_BASE}/boot/grub.cfg`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain(`set net=(http,${GATED_HOST})`);
      // `quiet splash` (POL-7/POL-38) sits between the token and the `---` terminator.
      expect(body).toMatch(new RegExp(`polyptic\\.token=${FLEET_TOKEN} quiet splash ---`));
      expect(body).toMatch(new RegExp(`polyptic\\.token=${FLEET_TOKEN} quiet splash polyptic\\.offload=1 ---`));
    },
    TEST_TIMEOUT,
  );

  test(
    "the /grub aliases (server-root prefix of an HTTP-booted grubnet) return the SAME body",
    async () => {
      const canonical = await (await fetch(`${OPEN_BASE}/boot/grub.cfg`)).text();
      for (const alias of ["/grub/grub.cfg", "/grub/x86_64-efi/grub.cfg", "/grub/arm64-efi/grub.cfg"]) {
        const res = await fetch(`${OPEN_BASE}${alias}`);
        expect(res.status).toBe(200);
        expect(await res.text()).toBe(canonical);
      }
    },
    TEST_TIMEOUT,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /dist/image/:arch/:file, the live-image artifacts, Range-aware
// ─────────────────────────────────────────────────────────────────────────────

describe("netboot: GET /dist/image/:arch/:file", () => {
  test(
    "streams the full ISO (200) with Accept-Ranges",
    async () => {
      const res = await fetch(`${OPEN_BASE}/dist/image/amd64/polyptic.iso`);
      expect(res.status).toBe(200);
      expect((res.headers.get("accept-ranges") ?? "").toLowerCase()).toBe("bytes");
      expect(await res.text()).toBe(ISO_BYTES);
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
    "serves the (large) vmlinuz with a real Content-Length, NOT chunked",
    async () => {
      // GRUB's shim_lock verifier reads the whole kernel into a buffer to check its signature and bails
      // on an unknown size ("big file signature isn't implemented yet"), so a Secure-Boot box will not
      // load a chunked kernel. Bun forces Transfer-Encoding: chunked for ANY streamed body even with an
      // explicit Content-Length header, so the route must send a Buffer. vmlinuz here is ~5MB (above
      // Bun's small-stream buffering): without the buffered path this comes back chunked (no
      // Content-Length) and this assertion fails, exactly as a real Secure-Boot netboot would.
      const res = await fetch(`${OPEN_BASE}/dist/image/amd64/vmlinuz`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-length")).toBe(String(Buffer.byteLength(VMLINUZ_BYTES)));
      await res.body?.cancel();
    },
    TEST_TIMEOUT,
  );

  test(
    "honours a byte Range with a 206 + exact Content-Range + partial body",
    async () => {
      const res = await fetch(`${OPEN_BASE}/dist/image/amd64/polyptic.iso`, {
        headers: { Range: "bytes=0-9" },
      });
      expect(res.status).toBe(206);
      expect(res.headers.get("content-range")).toBe(`bytes 0-9/${ISO_BYTES.length}`);
      expect(res.headers.get("content-length")).toBe("10");
      expect(await res.text()).toBe(ISO_BYTES.slice(0, 10));
    },
    TEST_TIMEOUT,
  );

  test(
    "a suffix Range (last N bytes) returns the tail",
    async () => {
      const res = await fetch(`${OPEN_BASE}/dist/image/amd64/polyptic.iso`, {
        headers: { Range: "bytes=-8" },
      });
      expect(res.status).toBe(206);
      const len = ISO_BYTES.length;
      expect(res.headers.get("content-range")).toBe(`bytes ${len - 8}-${len - 1}/${len}`);
      expect(await res.text()).toBe(ISO_BYTES.slice(len - 8));
    },
    TEST_TIMEOUT,
  );

  test(
    "a Range past EOF is 416 with a Content-Range of the size",
    async () => {
      const len = ISO_BYTES.length;
      const res = await fetch(`${OPEN_BASE}/dist/image/amd64/polyptic.iso`, {
        headers: { Range: `bytes=${len}-${len + 10}` },
      });
      expect(res.status).toBe(416);
      expect(res.headers.get("content-range")).toBe(`bytes */${len}`);
    },
    TEST_TIMEOUT,
  );

  test(
    "404 for squashfs: dropped from the whitelist (D47), even though a file by that name exists",
    async () => {
      const res = await fetch(`${OPEN_BASE}/dist/image/amd64/squashfs`);
      expect(res.status).toBe(404);
      const body = await res.text();
      expect(body).not.toContain(SQUASHFS_DECOY_BYTES.trim());
    },
    TEST_TIMEOUT,
  );

  test(
    "404 for a file outside the {vmlinuz,initrd,polyptic.iso} whitelist (never leaks a sibling)",
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
      expect((await fetch(`${OPEN_BASE}/dist/image/arm64/polyptic.iso`)).status).toBe(404);
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
// GET /dist/boot/:file, the tokenless boot depot (dongle + signed loaders)
// ─────────────────────────────────────────────────────────────────────────────

describe("netboot: GET /dist/boot/:file", () => {
  test(
    "serves the universal dongle image byte-for-byte (ungated) with a download filename",
    async () => {
      const res = await fetch(`${OPEN_BASE}/dist/boot/${BOOT_MEDIUM_NAME}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition") ?? "").toContain(BOOT_MEDIUM_NAME);
      expect(await res.text()).toBe(BOOT_MEDIUM_BYTES);
    },
    TEST_TIMEOUT,
  );

  test(
    "serves each of the four signed loaders byte-for-byte with a download filename",
    async () => {
      for (const [name, bytes] of Object.entries(EFI_FILES)) {
        const res = await fetch(`${OPEN_BASE}/dist/boot/${name}`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-disposition") ?? "").toContain(name);
        expect(await res.text()).toBe(bytes);
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "tolerates shim's duplicate-slash second-stage fetch: /dist/boot//grubx64.efi",
    async () => {
      // UEFI HTTP Boot: shim appends "/grubx64.efi" to its own URL directory INCLUDING the trailing
      // slash, so the request on the wire is <dir>//grubx64.efi. ignoreDuplicateSlashes must absorb it.
      const res = await fetch(`${OPEN_BASE}/dist/boot//grubx64.efi`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(EFI_FILES["grubx64.efi"] as string);
    },
    TEST_TIMEOUT,
  );

  test(
    "404 for filenames outside the whitelist (incl. the old per-arch medium names)",
    async () => {
      for (const name of ["evil.sh", "polyptic-boot-amd64.efi", "shimia32.efi", "../secret.txt"]) {
        const res = await fetch(`${OPEN_BASE}/dist/boot/${encodeURIComponent(name)}`);
        expect(res.status).toBe(404);
        const body = await res.text();
        expect(body).not.toContain(SECRET_MARKER);
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "path traversal in :file never escapes the boot dist root",
    async () => {
      const attempts = [
        "/dist/boot/..%2f..%2fsecret.txt",
        "/dist/boot/%2e%2e%2fsecret.txt",
        "/dist/boot/../../secret.txt",
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
      expect(info.bootConfigUrl).toBe(`${GATED_BASE}/boot/grub.cfg`);
      expect(info.bootMediumUrl).toBe(`${GATED_BASE}/dist/boot/${BOOT_MEDIUM_NAME}`);
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
      expect(info.bootMediumUrl).toBe(`${OPEN_BASE}/dist/boot/${BOOT_MEDIUM_NAME}`);
    },
    TEST_TIMEOUT,
  );
});
