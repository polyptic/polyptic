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
 *   - GET /dist/image/:arch/{vmlinuz,initrd,rootfs.squashfs} → the live-image artifacts, Range-streamed (206).
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
// Also LARGE (~5MB): Bun silently buffers SMALL streamed bodies and emits a Content-Length for
// them, so only an above-threshold body makes the "root image is streamed, never buffered"
// regression guard actually observe streaming.
const ROOTFS_BYTES =
  "FAKE_POLYPTIC_ROOTFS_SQUASHFS_" + "R".repeat(5_000_000) + "\x00rootfs-marker\n";
// A decoy by the OLD casper artifact name: proves the /dist/image 404 is the whitelist, not mere absence.
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
//   imageDir/amd64/{vmlinuz,initrd,rootfs.squashfs,filesystem.squashfs}   (the casper-era name is a
//                                          whitelist decoy; NO arm64 dir, asserts a clean 404)
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
  writeFileSync(join(amd64, "rootfs.squashfs"), ROOTFS_BYTES, "binary");
  writeFileSync(join(amd64, "filesystem.squashfs"), SQUASHFS_DECOY_BYTES, "binary");

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
      // Both menu entries by --id; dracut fetches the BARE squashfs; WS agent URL baked.
      expect(body).toContain("--id live");
      expect(body).toContain("--id offload");
      expect(body).toContain("--id debug");
      expect(body).toContain(`root=live:http://${OPEN_HOST}/dist/image/$arch/rootfs.squashfs`);
      // The writable layer is an overlayfs in RAM. `rd.live.ram=1` must NEVER appear: it dd's a
      // SECOND full copy of the image into RAM on top of the one livenet already downloaded.
      expect(body).toContain("rd.overlay=1");
      expect(body).not.toContain("rd.live.ram");
      // dracut waits for the NIC before livenet's fetch.
      expect(body).toContain("rd.neednet=1");
      // casper is gone (POL-35/D55): no ISO wrapper, no layered-image override.
      expect(body).not.toContain("boot=casper");
      expect(body).not.toContain("iso-url=");
      expect(body).not.toContain("layerfs-path=");
      expect(body).toContain(`polyptic.server_url=ws://${OPEN_HOST}/agent`);
      // OPEN mode carries NO enrolment token.
      expect(body).not.toContain("polyptic.token=");
    },
    TEST_TIMEOUT,
  );

  test(
    "the menu speaks noble GRUB: plain linux/initrd, no `---` terminator, no iPXE remnants",
    async () => {
      const body = await (await fetch(`${OPEN_BASE}/boot/grub.cfg`)).text();
      // Noble's signed GRUB dropped linuxefi/initrdefi; only plain `linux` + `initrd` exist.
      expect(body).not.toContain("linuxefi");
      expect(body).not.toContain("initrdefi");
      expect(body).toMatch(/^ {2}linux {2}\$net\/dist\/image\/\$arch\/vmlinuz .+$/m);
      expect(body).toMatch(/^ {2}initrd \$net\/dist\/image\/\$arch\/initrd$/m);
      // `---` is a casper/live-installer convention (the kernel hands everything after it to init);
      // dracut has no use for it, so the cmdline must not end with one.
      expect(body).not.toContain(" ---");
      // The iPXE first stage is gone (D47): no shebang, no chain URL.
      expect(body).not.toContain("#!ipxe");
      expect(body).not.toContain("boot.ipxe");
    },
    TEST_TIMEOUT,
  );

  test(
    "a PORTLESS Host header (GRUB's http client) still bakes the socket's real port into the menu",
    async () => {
      // GRUB 2.12 sends `Host: <ip>` with no port; trusting it verbatim once baked port-80 URLs
      // into the menu and the kernel fetch died with ECONNREFUSED (POL-39, found live in the VM).
      // Bun's fetch forbids overriding Host, so speak raw HTTP.
      const net = await import("node:net");
      const body = await new Promise<string>((resolvePromise, reject) => {
        const sock = net.connect(OPEN_PORT, "127.0.0.1", () => {
          sock.write("GET /boot/grub.cfg HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
        });
        let buf = "";
        sock.on("data", (d) => (buf += d.toString()));
        sock.on("end", () => resolvePromise(buf));
        sock.on("error", reject);
      });
      expect(body).toContain(`set net=(http,127.0.0.1:${OPEN_PORT})`);
      expect(body).not.toContain("set net=(http,127.0.0.1)\n");
    },
    TEST_TIMEOUT,
  );

  test(
    "the menu is three flat entries with the names operators know, and no submenu",
    async () => {
      const body = await (await fetch(`${OPEN_BASE}/boot/grub.cfg`)).text();
      expect(body).toContain('menuentry "Polyptic (Live)" --id live');
      expect(body).toContain('menuentry "Polyptic (Offload Bootloader)" --id offload');
      expect(body).toContain('menuentry "Polyptic (Debug Console)" --id debug');
      // A submenu opens a fresh GRUB environment context, which is what broke `$net`/`$arch` below.
      expect(body).not.toContain("submenu ");
    },
    TEST_TIMEOUT,
  );

  test(
    "`arch` and `net` are EXPORTED, so a nested entry can never resolve them to empty (POL-58)",
    async () => {
      const body = await (await fetch(`${OPEN_BASE}/boot/grub.cfg`)).text();
      // GRUB opens a new env context for a `submenu` and copies only EXPORTED variables into it. A
      // confirmation submenu once wrapped the offload entry, so `$net` and `$arch` came out empty and
      // GRUB asked for `/dist/image//vmlinuz` — file not found, on a box whose live entry booted fine.
      // Both are set before any entry, and both are exported.
      const archSet = body.indexOf("set arch=amd64");
      const exportArch = body.indexOf("export arch");
      const exportNet = body.indexOf("export net");
      const firstEntry = body.indexOf("menuentry ");
      expect(archSet).toBeGreaterThan(-1);
      expect(exportArch).toBeGreaterThan(archSet);
      expect(exportNet).toBeGreaterThan(-1);
      expect(exportArch).toBeLessThan(firstEntry);
      expect(exportNet).toBeLessThan(firstEntry);
      // And no entry may hardcode an arch into the artifact path — `$arch` is the only selector.
      expect(body).not.toContain("/dist/image/amd64/vmlinuz");
      expect(body).not.toContain("/dist/image//vmlinuz");
    },
    TEST_TIMEOUT,
  );

  test(
    "only the offload entry tags the cmdline with polyptic.offload=1",
    async () => {
      const body = await (await fetch(`${OPEN_BASE}/boot/grub.cfg`)).text();
      const liveStart = body.indexOf("--id live");
      const offloadStart = body.indexOf("--id offload");
      expect(liveStart).toBeGreaterThan(-1);
      expect(offloadStart).toBeGreaterThan(liveStart);
      const liveEntry = body.slice(liveStart, offloadStart);
      const offloadEntry = body.slice(offloadStart);
      expect(liveEntry).not.toContain("polyptic.offload=1");
      expect(offloadEntry).toContain("polyptic.offload=1");
    },
    TEST_TIMEOUT,
  );

  test(
    "the debug entry (and ONLY it) carries systemd.debug-shell=1, and never auto-boots",
    async () => {
      const body = await (await fetch(`${OPEN_BASE}/boot/grub.cfg`)).text();
      const debugStart = body.indexOf("--id debug");
      expect(debugStart).toBeGreaterThan(-1);
      const beforeDebug = body.slice(0, debugStart);
      const debugEntry = body.slice(debugStart);
      // The root-shell arg must not leak into the live/offload entries a wall boots unattended.
      expect(beforeDebug).not.toContain("systemd.debug-shell=1");
      expect(debugEntry).toContain("systemd.debug-shell=1");
      // A debug boot is an operator CHOICE at the menu: the default entry stays the live boot.
      expect(body).toContain("set default=live");
    },
    TEST_TIMEOUT,
  );

  test(
    "GATED mode: bakes in the current enrolment token, ahead of the splash args",
    async () => {
      const res = await fetch(`${GATED_BASE}/boot/grub.cfg`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain(`set net=(http,${GATED_HOST})`);
      // The splash args (POL-7/POL-38) trail the token; the offload tag trails those.
      const SPLASH = "multipath=off quiet splash plymouth\\.ignore-serial-consoles";
      expect(body).toMatch(new RegExp(`polyptic\\.token=${FLEET_TOKEN} ${SPLASH}$`, "m"));
      expect(body).toMatch(new RegExp(`polyptic\\.token=${FLEET_TOKEN} ${SPLASH} polyptic\\.offload=1$`, "m"));
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
// POST /boot/report — how the bootloader install went (POL-58)
//
// The box that reports is diskless and mid-boot: no agent session exists yet, and on failure it will
// never get one. Before this route, an install that could not make the firmware boot Polyptic failed
// into a journal on a RAM disk — the operator learned about it by rebooting and landing back in the
// machine's old OS. Each report becomes exactly one Live Activity line in the console.
// ─────────────────────────────────────────────────────────────────────────────

/** Open `/admin`, read the first `admin/state`, close. A fresh client's snapshot is current state. */
async function readAdminActivity(base: string): Promise<{ severity: string; text: string }[]> {
  const ws = new WebSocket(`${base.replace("http://", "ws://")}/admin`);
  try {
    const message = await new Promise<string>((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error("no admin/state within 5s")), 5_000);
      ws.onmessage = (ev) => {
        clearTimeout(timer);
        resolvePromise(String(ev.data));
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("admin socket error"));
      };
    });
    return JSON.parse(message).activity ?? [];
  } finally {
    ws.close();
  }
}

const goodReport = {
  ok: true,
  code: "installed",
  detail: "installed the signed loaders on /dev/nvme0n1 (partition 1)",
  machineId: "dmi-4c4c4544-0031",
};

describe("netboot: POST /boot/report", () => {
  test(
    "OPEN mode: a successful install lands one `good` line in the Live Activity feed",
    async () => {
      const res = await fetch(`${OPEN_BASE}/boot/report`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(goodReport),
      });
      expect(res.status).toBe(204);

      const activity = await readAdminActivity(OPEN_BASE);
      const line = activity.find((e) => e.text.includes("installed the Polyptic bootloader"));
      expect(line).toBeDefined();
      expect(line?.severity).toBe("good");
      expect(line?.text).toContain("dmi-4c4c4544-0031");
      expect(line?.text).toContain("/dev/nvme0n1");
    },
    TEST_TIMEOUT,
  );

  test(
    "a FAILED install is reported as `bad` and names the reason — the whole point of POL-58",
    async () => {
      const res = await fetch(`${OPEN_BASE}/boot/report`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ok: false,
          code: "boot-order-not-first",
          detail: "the firmware would not make 'Polyptic Netboot' the first boot option",
          machineId: "dmi-deadbeef",
        }),
      });
      expect(res.status).toBe(204);

      const activity = await readAdminActivity(OPEN_BASE);
      const line = activity.find((e) => e.text.includes("boot-order-not-first"));
      expect(line).toBeDefined();
      expect(line?.severity).toBe("bad");
      expect(line?.text).toContain("could not install the Polyptic bootloader");
    },
    TEST_TIMEOUT,
  );

  test(
    "an unknown code or an oversized detail is a 400, never an activity line",
    async () => {
      const bad = await fetch(`${OPEN_BASE}/boot/report`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ok: false, code: "definitely-not-a-code", detail: "x" }),
      });
      expect(bad.status).toBe(400);

      const huge = await fetch(`${OPEN_BASE}/boot/report`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ok: false, code: "no-esp", detail: "z".repeat(201) }),
      });
      expect(huge.status).toBe(400);

      const activity = await readAdminActivity(OPEN_BASE);
      expect(activity.some((e) => e.text.includes("definitely-not-a-code"))).toBe(false);
      expect(activity.some((e) => e.text.includes("zzzzzzzzzz"))).toBe(false);
    },
    TEST_TIMEOUT,
  );

  test(
    "GATED mode: the box must present the fleet enrolment token it netbooted with",
    async () => {
      const anon = await fetch(`${GATED_BASE}/boot/report`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(goodReport),
      });
      expect(anon.status).toBe(401);

      const wrong = await fetch(`${GATED_BASE}/boot/report`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer not-the-token" },
        body: JSON.stringify(goodReport),
      });
      expect(wrong.status).toBe(401);

      const right = await fetch(`${GATED_BASE}/boot/report`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${FLEET_TOKEN}` },
        body: JSON.stringify(goodReport),
      });
      expect(right.status).toBe(204);
    },
    TEST_TIMEOUT,
  );

  test(
    "a flood of reports is throttled, so a hostile boot network cannot drown the feed",
    async () => {
      const post = (): Promise<Response> =>
        fetch(`${GATED_BASE}/boot/report`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${FLEET_TOKEN}` },
          body: JSON.stringify({ ...goodReport, ok: false, code: "no-esp" }),
        });
      const codes: number[] = [];
      for (let i = 0; i < 20; i++) codes.push((await post()).status);
      expect(codes).toContain(429);
      // …and the throttle is not an outage: the first few still got through.
      expect(codes.filter((c) => c === 204).length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /dist/image/:arch/:file, the live-image artifacts, Range-aware
// ─────────────────────────────────────────────────────────────────────────────

describe("netboot: GET /dist/image/:arch/:file", () => {
  test(
    "streams the full root image (200) with Accept-Ranges — and NEVER buffers it",
    async () => {
      const res = await fetch(`${OPEN_BASE}/dist/image/amd64/rootfs.squashfs`);
      expect(res.status).toBe(200);
      expect((res.headers.get("accept-ranges") ?? "").toLowerCase()).toBe("bytes");
      // Streamed = chunked under Bun = no Content-Length. This is a REGRESSION GUARD, not an
      // implementation detail: a Content-Length here means the route readFile()'d the whole image
      // into a Buffer, which OOM-killed a 512Mi control-plane pod on every dracut fetch the day
      // the image (486 MiB) dipped under the old 512 MiB buffer cap (fpd-ago, 2026-07-10). The
      // fetchers of this artifact (dracut's curl, browsers) are chunked-capable by contract.
      expect(res.headers.get("content-length")).toBeNull();
      expect(await res.text()).toBe(ROOTFS_BYTES);
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
      const res = await fetch(`${OPEN_BASE}/dist/image/amd64/rootfs.squashfs`, {
        headers: { Range: "bytes=0-9" },
      });
      expect(res.status).toBe(206);
      expect(res.headers.get("content-range")).toBe(`bytes 0-9/${ROOTFS_BYTES.length}`);
      expect(res.headers.get("content-length")).toBe("10");
      expect(await res.text()).toBe(ROOTFS_BYTES.slice(0, 10));
    },
    TEST_TIMEOUT,
  );

  test(
    "a suffix Range (last N bytes) returns the tail",
    async () => {
      const res = await fetch(`${OPEN_BASE}/dist/image/amd64/rootfs.squashfs`, {
        headers: { Range: "bytes=-8" },
      });
      expect(res.status).toBe(206);
      const len = ROOTFS_BYTES.length;
      expect(res.headers.get("content-range")).toBe(`bytes ${len - 8}-${len - 1}/${len}`);
      expect(await res.text()).toBe(ROOTFS_BYTES.slice(len - 8));
    },
    TEST_TIMEOUT,
  );

  test(
    "a Range past EOF is 416 with a Content-Range of the size",
    async () => {
      const len = ROOTFS_BYTES.length;
      const res = await fetch(`${OPEN_BASE}/dist/image/amd64/rootfs.squashfs`, {
        headers: { Range: `bytes=${len}-${len + 10}` },
      });
      expect(res.status).toBe(416);
      expect(res.headers.get("content-range")).toBe(`bytes */${len}`);
    },
    TEST_TIMEOUT,
  );

  test(
    "404 for the casper-era filesystem.squashfs: not on the whitelist, even though the file exists",
    async () => {
      const res = await fetch(`${OPEN_BASE}/dist/image/amd64/filesystem.squashfs`);
      expect(res.status).toBe(404);
      const body = await res.text();
      expect(body).not.toContain(SQUASHFS_DECOY_BYTES.trim());
    },
    TEST_TIMEOUT,
  );

  test(
    "404 for a file outside the {vmlinuz,initrd,rootfs.squashfs} whitelist (never leaks a sibling)",
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
      expect((await fetch(`${OPEN_BASE}/dist/image/arm64/rootfs.squashfs`)).status).toBe(404);
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
