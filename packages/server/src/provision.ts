/**
 * Zero-touch, AIR-GAPPED edge provisioning — served by the control plane (k3s-style).
 *
 * An edge box that can reach ONLY the server (no internet) bootstraps itself entirely from these
 * TOP-LEVEL, UNGATED routes (registered OUTSIDE the /api/v1 operator gate, like /healthz — the box
 * carries no operator session):
 *
 *   GET /install                                  → the install shell script, with the control-plane
 *                                                   base URL BAKED IN from THIS request (so the box
 *                                                   targets the exact host it curled). text/x-shellscript.
 *   GET /dist/agent/:arch                         → the prebuilt agent BINARY for arm64|amd64, streamed.
 *   GET /dist/deps/:distro/:arch/manifest.json    → the bundled substrate package manifest.
 *   GET /dist/deps/:distro/:arch/:file            → one bundled substrate package (.deb) by name.
 *
 * NETBOOT (POL-33/D47), a bare box boots Ubuntu's SIGNED shim+GRUB chain over the network into a live
 * Polyptic image in RAM, Secure Boot stays ON, no OS install:
 *   GET /boot/grub.cfg                            → the generated GRUB menu with the control-plane base
 *                                                   (and, in GATED mode, the enrolment token) baked in
 *                                                   from THIS request. Ungated, the box has no session.
 *   GET /grub/grub.cfg (+ per-arch aliases)       → the SAME menu where an HTTP-booted grubnet looks:
 *                                                   its baked prefix resolves to (http,host:port)/grub
 *                                                   at the server root, not next to the shim URL.
 *   GET /dist/image/:arch/{vmlinuz,initrd,polyptic.iso} → the live-image artifacts, Range-streamed to RAM.
 *   GET /dist/boot/:file                          → the dd-able universal dongle (polyptic-boot.img) and
 *                                                   the four signed loaders (shim + GRUB .efi), TOKENLESS
 *                                                   so ungated (UEFI HTTP Boot / offload).
 *   GET /api/v1/settings/netboot                  → operator-facing netboot info for the console (GATED,
 *                                                   under /api/v1; secret-free, points at the URLs above).
 *
 * The install flow (the script): detect arch+distro → download the agent binary → write
 * /etc/polyptic/agent.toml + a systemd unit → enrol now (Stage A, fully air-gapped). With --kiosk it
 * additionally pulls the bundled .debs (offline-first; falls back to the distro package manager only if
 * the box has internet) and runs `polyptic-agent setup --skip-deps …` for the greetd/sway/Chromium
 * wiring (Stage B).
 *
 * SAFETY: every path segment is matched against a strict whitelist (no '/', no '..'), and the resolved
 * absolute path is asserted to stay INSIDE its configured root before any file is touched — the same
 * traversal-safety contract as the media serve route. Missing artifacts are a clean 404 (the script's
 * offline-first logic depends on the 404 to fall back), never a traversal or a 500.
 */
import { createReadStream } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { NetbootInfo } from "@polyptic/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { Enrollment } from "./enroll";

/** Built-in fallback install template, shipped beside this module (served when the deploy file is absent). */
const FALLBACK_TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "install.default.sh");

/** Repo root (…/packages/server/src → repo) so the dev defaults find `deploy/dist` regardless of the
 *  server's CWD. In the Docker image the env (AGENT_DIST_DIR=/app/deploy/dist, etc.) overrides these. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// ─────────────────────────────────────────────────────────────────────────────
// Config / wiring
// ─────────────────────────────────────────────────────────────────────────────

export interface ProvisionConfig {
  /** Path to the install-script template (the deploy agent writes deploy/install.sh). */
  installScriptPath: string;
  /** Directory holding the prebuilt agent binaries `polyptic-agent-<arch>`. */
  agentDistDir: string;
  /** Directory holding bundled substrate packages: `<distro>/<arch>/{manifest.json,*.deb}`. */
  depsDistDir: string;
  /** Directory holding the netboot live-image artifacts: `<arch>/{vmlinuz,initrd,polyptic.iso}` (POL-33). */
  imageDistDir: string;
  /** Directory holding the boot depot: `polyptic-boot.img` + the four signed loaders (POL-33/D47). */
  bootDistDir: string;
  /** Last-resort base URL when the request carries no Host/forwarded headers. */
  publicBaseUrl: string;
}

/** Resolve provisioning config from the environment, with sensible repo-relative defaults. */
export function provisionConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ProvisionConfig {
  return {
    installScriptPath: env.INSTALL_SCRIPT_PATH?.trim() || resolve(REPO_ROOT, "deploy/install.sh"),
    agentDistDir: env.AGENT_DIST_DIR?.trim() || resolve(REPO_ROOT, "deploy/dist"),
    depsDistDir: env.DEPS_DIST_DIR?.trim() || resolve(REPO_ROOT, "deploy/dist/deps"),
    imageDistDir: env.IMAGE_DIST_DIR?.trim() || resolve(REPO_ROOT, "deploy/dist/image"),
    bootDistDir: env.BOOT_DIST_DIR?.trim() || resolve(REPO_ROOT, "deploy/dist/boot"),
    publicBaseUrl: (env.PUBLIC_BASE_URL?.trim() || "http://localhost:8080").replace(/\/+$/, ""),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Whitelists + traversal-safe path resolution
// ─────────────────────────────────────────────────────────────────────────────

/** Build target architectures we serve binaries + bundles for. */
const ARCH_RE = /^(arm64|amd64)$/;
/** The netboot live-image artifacts a diskless box streams (POL-33): the Canonical-signed kernel,
 *  the initrd, and the ISO wrapper casper `iso-url=` pulls whole into RAM — plus the self-contained
 *  bootable live ISO (POL-38/D49, `build-live-iso.sh`; it bakes the token like `/boot/grub.cfg`
 *  does, and a leaked token still cannot self-admit a NEW box past the operator). Nothing else is
 *  servable. */
const IMAGE_FILE_RE = /^(vmlinuz|initrd|polyptic\.iso|polyptic-live\.iso)$/;
/** The boot-depot files (POL-33/D47): `polyptic-boot.img` is the universal `dd`-able FAT32 dongle (both
 *  arches on one stick); the four `.efi` files are the SIGNED loaders (shim + network GRUB per arch) for
 *  UEFI HTTP Boot and the offload flow. All TOKENLESS (they only chain `/boot/grub.cfg`), so this route
 *  is ungated like `/dist/agent`. */
const BOOT_FILE_RE = /^(polyptic-boot\.img|shimx64\.efi|shimaa64\.efi|grubx64\.efi|grubaa64\.efi)$/;
/** The four signed loaders the depot serves and the offload flow installs (for the boot summary). */
const SIGNED_LOADER_FILES = ["shimx64.efi", "shimaa64.efi", "grubx64.efi", "grubaa64.efi"] as const;
/** A distro slug: `<id>` or `<id>-<version>` (e.g. `ubuntu`, `ubuntu-24.04`, `debian-12`). */
const DISTRO_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** A bundle file name (.deb etc.): no path separators, no leading dot, bounded charset. `:` is allowed
 * because Debian version epochs put a colon in the filename (e.g. `chromium_2:1snap1_arm64.deb`), which
 * the installer URL-encodes as `%3a`; the traversal guard (resolved path inside the root) is the real
 * safety check, so the charset just has to exclude separators. */
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._+~:-]{0,255}$/;

/** The placeholder substituted with the computed control-plane base in the install template. */
const BASE_PLACEHOLDER = "{{POLYPTIC_BASE}}";

/**
 * Resolve `segments` under `root`, asserting the result stays INSIDE `root` (no traversal). Returns
 * null if the join escapes the root — callers turn that into a 404, never a leak. Mirrors the media
 * store's `safeJoin`.
 */
function safeResolve(root: string, ...segments: string[]): string | null {
  const base = resolve(root);
  const abs = resolve(base, ...segments);
  if (abs !== base && !abs.startsWith(base + sep)) return null;
  return abs;
}

/** First value of a (possibly comma-joined / array) header, trimmed; "" if absent. */
function headerFirst(value: string | string[] | undefined): string {
  if (value === undefined) return "";
  const raw = Array.isArray(value) ? value[0] ?? "" : value;
  const first = raw.split(",")[0] ?? "";
  return first.trim();
}

/**
 * Compute the control-plane base URL the box should target — the exact host it curled. Prefer the
 * reverse-proxy's X-Forwarded-Proto/Host, else the Host header, else the configured PUBLIC_BASE_URL.
 * Always scheme://authority with no trailing slash.
 */
export function computeBaseUrl(request: FastifyRequest, fallback: string): string {
  const fwdHost = headerFirst(request.headers["x-forwarded-host"]);
  const fwdProto = headerFirst(request.headers["x-forwarded-proto"]).toLowerCase();
  const host = headerFirst(request.headers.host);

  if (fwdHost) {
    const proto = fwdProto || "http";
    return `${proto}://${fwdHost}`.replace(/\/+$/, "");
  }
  if (host) {
    const proto = fwdProto || "http";
    return `${proto}://${host}`.replace(/\/+$/, "");
  }
  return fallback.replace(/\/+$/, "");
}

/**
 * Derive the agent WebSocket URL from an HTTP(S) control-plane base: `http`→`ws`, `https`→`wss`, and
 * append the `/agent` channel path. Baked into `/boot/grub.cfg` so a diskless box's agent dials the
 * exact same host it netbooted from (the outbound-WSS channel, D12). `http://h:8080` → `ws://h:8080/agent`.
 */
export function toWsAgentUrl(httpBase: string): string {
  return `${httpBase.replace(/\/+$/, "").replace(/^http/, "ws")}/agent`;
}

/**
 * The kernel command line a diskless box boots with (POL-33/D47). CENTRALISED here so the casper
 * contract is a one-line change once validated on real hardware (the one piece not testable in-repo):
 *   - `boot=casper iso-url=<url ending .iso>` makes casper wget the WHOLE ISO into RAM (initramfs
 *     tmpfs) and loop-mount the squashfs inside it, nothing touches disk ("live image, no install").
 *     `netboot=http fetch=` does not exist in casper; `iso-url` is the real mechanism.
 *   - `layerfs-path=filesystem.squashfs` OVERRIDES the layered image name the reused initrd bakes in
 *     (`/conf/conf.d/default-layer.conf`, e.g. `ubuntu-server-minimal.ubuntu-server.installer...`), so
 *     casper mounts our single `deploy/build-live-image.sh` squashfs instead of panicking with
 *     "File system layers are missing". Must match the squashfs filename the image build writes.
 *   - `ip=dhcp` brings the NIC up before the fetch.
 *   - `polyptic.server_url=` / `polyptic.token=` are picked out of /proc/cmdline by the image's
 *     parse-cmdline helper and become the agent's POLYPTIC_SERVER_URL / POLYPTIC_BOOTSTRAP_TOKEN.
 * `$arch` is a GRUB runtime variable expanded at boot; the http URLs are literals (GRUB/casper have no
 * TLS, the boot depot is plain http by contract) and the token (when gated) is a baked literal. The
 * caller appends `polyptic.offload=1` (offload entry only) and the Ubuntu `---` arg-list terminator,
 * so every polyptic.* arg here stays BEFORE the `---`.
 */
function bootKernelCmdline(httpBase: string, token: string | undefined): string {
  const parts = [
    "boot=casper",
    "layerfs-path=filesystem.squashfs",
    `iso-url=${httpBase}/dist/image/$arch/polyptic.iso`,
    "ip=dhcp",
    // The HTTP base (for the offload flow to fetch the loaders) + the WS agent URL (for the agent).
    `polyptic.base=${httpBase}`,
    `polyptic.server_url=${toWsAgentUrl(httpBase)}`,
  ];
  if (token !== undefined) parts.push(`polyptic.token=${token}`);
  // POL-7/POL-38: boot splash instead of scrolling kernel/systemd text. The live image carries the
  // Polyptic Plymouth theme (squashfs + an initrd cpio segment); `quiet splash` is what makes
  // plymouthd display it, and `plymouth.ignore-serial-consoles` is LOAD-BEARING: any serial console
  // (arm64 VMs get one implicitly from the devicetree) makes plymouth assume a headless server and
  // never paint the local display (verified live with plymouthd --debug in the POL-38 UTM boot).
  // A wall renders on its panel by definition, so ignoring serial consoles is always right here.
  // Must sit BEFORE the caller-appended `---` terminator.
  // `multipath=off` is honoured by DRACUT-based initrds only — the initramfs-tools multipath boot
  // script has no cmdline gate at all, which is why build-live-image.sh overrides it with a no-op
  // inside the shipped initrd (the real fix for the pre-splash "fatal configuration error" spray).
  // The flag stays as documentation-of-intent + coverage for future dracut-based images.
  parts.push("multipath=off", "quiet", "splash", "plymouth.ignore-serial-consoles");
  return parts.join(" ");
}

/**
 * Build the GRUB menu served at `GET /boot/grub.cfg` (+ the /grub aliases) for a control plane at
 * `base`, baking in the WS agent URL and, in GATED mode, the current enrolment token (POL-33/D47). The
 * box has no operator session at boot, so the route is ungated; a leaked token cannot self-admit (a NEW
 * machine still lands PENDING for an operator to approve, see enroll.ts case 1). `$grub_cpu` selects
 * amd64/arm64 at boot so one menu serves both arches. The `--id offload` entry tags the cmdline so the
 * live image writes the signed loaders to the box's ESP once, then boots the same flow forever. Every
 * `$var` in the emitted config is GRUB runtime syntax, written literally (never JS interpolation); the
 * commands are plain `linux`/`initrd` (noble's signed GRUB has no linuxefi). When the computed base is
 * https, http is emitted anyway: GRUB/casper have no TLS, the boot depot is plain-HTTP by contract.
 */
export function buildBootGrubCfg(base: string, token: string | undefined): string {
  const hostPort = base.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const httpBase = `http://${hostPort}`;
  const cmdline = bootKernelCmdline(httpBase, token);
  const lines = [
    "# Polyptic netboot (POL-33/D47), generated for THIS control plane from the request Host.",
    "# Ownership is by KEY: the box belongs to the server whose enrolment token it carries.",
    "# Chain: firmware db -> shim (Microsoft-signed) -> GRUB (Canonical-signed) -> Canonical-signed",
    "# kernel, verified by shim_lock even when fetched over HTTP. Secure Boot stays ON.",
  ];
  if (base.startsWith("https://")) {
    lines.push(
      "# The operator base is https, but GRUB/casper have no TLS: the boot depot speaks plain http.",
    );
  }
  lines.push(
    'if [ "$grub_cpu" = "x86_64" ]; then set arch=amd64; else set arch=arm64; fi',
    `set net=(http,${hostPort})`,
    "set timeout=5",
    "set default=live",
    'menuentry "Polyptic: boot now (diskless, nothing written to this box)" --id live {',
    '  echo "Polyptic: streaming the $arch live image into RAM ..."',
    `  linux  $net/dist/image/$arch/vmlinuz ${cmdline} ---`,
    "  initrd $net/dist/image/$arch/initrd",
    "}",
    'menuentry "Polyptic: offload to this box, then boot (one-time; adds a loader to the ESP)" --id offload {',
    '  echo "Polyptic: offload mode, the live image will install the loader, then keep booting ..."',
    `  linux  $net/dist/image/$arch/vmlinuz ${cmdline} polyptic.offload=1 ---`,
    "  initrd $net/dist/image/$arch/initrd",
    "}",
  );
  return lines.join("\n") + "\n";
}

/**
 * Parse a single `Range: bytes=start-end` header against a known `size`. The live ISO is hundreds of
 * MB and casper's fetch can issue byte-range GETs while streaming it, so `/dist/image` serves real
 * 206 partial content. Returns `null` for an absent / multi-range / malformed header (caller streams the
 * full 200), `{ unsatisfiable: true }` for a start past EOF (→ 416), else the inclusive `{ start, end }`.
 * Supports the suffix form `bytes=-N` (last N bytes). Mirrors the media store's range handling.
 */
export function parseRange(
  header: string | string[] | undefined,
  size: number,
): null | { unsatisfiable: true } | { start: number; end: number } {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(raw.trim());
  if (!m) return null;
  const rangeStart = m[1] ?? "";
  const rangeEnd = m[2] ?? "";
  if (rangeStart === "" && rangeEnd === "") return null;

  let start: number;
  let end: number;
  if (rangeStart === "") {
    // Suffix form: last N bytes.
    const n = Number(rangeEnd);
    if (!Number.isFinite(n) || n <= 0) return { unsatisfiable: true };
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(rangeStart);
    end = rangeEnd === "" ? size - 1 : Number(rangeEnd);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size) return { unsatisfiable: true };
  if (end >= size) end = size - 1;
  return { start, end };
}

/**
 * Cap under which a boot asset is served as a fully-buffered body (so it carries a Content-Length)
 * rather than a stream. GRUB's shim_lock verifier and UEFI reject an unknown-size / chunked body
 * (`verifiers.c`: an unknown size trips the "big file signature isn't implemented yet" guard, so a
 * Secure-Boot box will NOT load a chunked kernel), and Bun's HTTP server forces
 * `Transfer-Encoding: chunked` for ANY streamed body EVEN with an explicit Content-Length header, so
 * a complete Buffer is the only way to emit Content-Length. Every boot-critical artifact (vmlinuz,
 * initrd, the signed `.efi` loaders, the dongle `.img`) is comfortably under this; only the ~1.5GB
 * casper ISO exceeds it, and that is fetched by busybox `wget` inside the initramfs (chunked-capable),
 * never by GRUB, so streaming it is fine and avoids holding it in RAM. 512 MiB.
 */
const BOOT_ASSET_BUFFER_MAX = 512 * 1024 * 1024;

/**
 * Serve `abs` (a known-`size` regular file) as a boot asset: honour a byte Range, and for a non-range
 * response emit a Content-Length so GRUB/UEFI can verify + size it. Buffers the body up to
 * {@link BOOT_ASSET_BUFFER_MAX} (Bun only emits Content-Length for a complete Buffer, not a stream);
 * larger files (the casper ISO) stream. Callers set any extra headers (e.g. Content-Disposition) first.
 */
async function sendBootAsset(
  reply: FastifyReply,
  abs: string,
  size: number,
  rangeHeader: string | string[] | undefined,
): Promise<unknown> {
  reply.header("Cache-Control", "no-store");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Accept-Ranges", "bytes");
  reply.type("application/octet-stream");

  const range = parseRange(rangeHeader, size);
  if (range && "unsatisfiable" in range) {
    reply.header("Content-Range", `bytes */${size}`);
    reply.type("text/plain; charset=utf-8");
    return reply.code(416).send("range not satisfiable");
  }
  if (range) {
    const { start, end } = range;
    const len = end - start + 1;
    // Read the (bounded) slice into a Buffer so the 206 carries a real Content-Length, not chunked.
    const buf = Buffer.allocUnsafe(len);
    const fh = await open(abs, "r");
    try {
      await fh.read(buf, 0, len, start);
    } finally {
      await fh.close();
    }
    reply.code(206);
    reply.header("Content-Range", `bytes ${start}-${end}/${size}`);
    reply.header("Content-Length", String(len));
    return reply.send(buf);
  }
  if (size <= BOOT_ASSET_BUFFER_MAX) {
    // A Buffer body (not a stream) is what makes Bun emit Content-Length; GRUB requires it.
    reply.header("Content-Length", String(size));
    return reply.send(await readFile(abs));
  }
  // Only the casper ISO lands here: streamed (chunked), fetched by busybox wget, never by GRUB.
  return reply.send(createReadStream(abs));
}

/**
 * Resolve the downloadable boot medium under `bootDistDir`, traversal-safe: the universal `dd`-able
 * `polyptic-boot.img` dongle (one stick boots amd64 AND arm64, no per-arch media). Returns its absolute
 * path when it is a regular file, else `null` (the medium is optional, the UI falls back to pointing
 * DHCP option-67 / UEFI HTTP Boot at the shim URL when it's absent).
 */
export async function resolveBootMedium(bootDistDir: string): Promise<string | null> {
  const abs = safeResolve(bootDistDir, "polyptic-boot.img");
  if (!abs) return null;
  try {
    if ((await stat(abs)).isFile()) return abs;
  } catch {
    // medium not bundled
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Register the provisioning routes. ALL are TOP-LEVEL and UNGATED — register OUTSIDE the /api/v1 gate
 * (alongside /healthz). Pass the resolved {@link ProvisionConfig}.
 */
export function registerProvisionRoutes(
  fastify: FastifyInstance,
  config: ProvisionConfig,
  enrollment: Enrollment,
): void {
  const { installScriptPath, agentDistDir, depsDistDir, imageDistDir, bootDistDir, publicBaseUrl } =
    config;

  // ── GET /install — the install script, with the control-plane base baked in from THIS request. ──
  fastify.get("/install", async (request, reply) => {
    const base = computeBaseUrl(request, publicBaseUrl);

    let template: string;
    try {
      template = await readFile(installScriptPath, "utf8");
    } catch {
      // The deploy agent hasn't written deploy/install.sh yet — serve the built-in fallback that ships
      // beside this module so the route is never broken (identical contract: one {{POLYPTIC_BASE}}).
      template = await readFile(FALLBACK_TEMPLATE_PATH, "utf8");
    }

    const script = template.split(BASE_PLACEHOLDER).join(base);
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.type("text/x-shellscript; charset=utf-8");
    return script;
  });

  // ── GET /dist/agent/:arch — the prebuilt agent binary. 404 when not bundled. ──
  fastify.get("/dist/agent/:arch", async (request, reply) => {
    const arch = (request.params as { arch?: string }).arch ?? "";
    if (!ARCH_RE.test(arch)) {
      return reply.code(404).send({ error: "unknown architecture" });
    }
    const filename = `polyptic-agent-${arch}`;
    const abs = safeResolve(agentDistDir, filename);
    if (!abs) return reply.code(404).send({ error: "not found" });

    let st;
    try {
      st = await stat(abs);
    } catch {
      return reply.code(404).send({ error: "agent binary not bundled" });
    }
    if (!st.isFile()) return reply.code(404).send({ error: "agent binary not bundled" });

    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Accept-Ranges", "bytes");
    reply.header("Content-Disposition", `attachment; filename="${filename}"`);
    reply.header("Content-Length", String(st.size));
    reply.type("application/octet-stream");
    return reply.send(createReadStream(abs));
  });

  // ── GET /dist/deps/:distro/:arch/manifest.json — the bundled substrate manifest. 404 → script falls back. ──
  fastify.get("/dist/deps/:distro/:arch/manifest.json", async (request, reply) => {
    const { distro, arch } = request.params as { distro?: string; arch?: string };
    const abs = await resolveDepsPath(depsDistDir, distro, arch, "manifest.json");
    if (!abs) return reply.code(404).send({ error: "no bundle for this distro/arch" });

    let body: Buffer;
    try {
      body = await readFile(abs);
    } catch {
      return reply.code(404).send({ error: "no bundle for this distro/arch" });
    }

    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.type("application/json; charset=utf-8");
    return reply.send(body);
  });

  // ── GET /dist/deps/:distro/:arch/:file — one bundled substrate package. 404 when absent. ──
  fastify.get("/dist/deps/:distro/:arch/:file", async (request, reply) => {
    const { distro, arch, file } = request.params as {
      distro?: string;
      arch?: string;
      file?: string;
    };
    const abs = await resolveDepsPath(depsDistDir, distro, arch, file);
    if (!abs) return reply.code(404).send({ error: "package not bundled" });

    const st = await stat(abs);

    // manifest.json is JSON; everything else in the bundle is a Debian package.
    const isManifest = file === "manifest.json";
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Accept-Ranges", "bytes");
    reply.header("Content-Length", String(st.size));
    if (isManifest) {
      reply.type("application/json; charset=utf-8");
    } else {
      reply.header("Content-Disposition", `attachment; filename="${file}"`);
      reply.type("application/vnd.debian.binary-package");
    }
    return reply.send(createReadStream(abs));
  });

  // ─── Netboot depot (POL-33) ────────────────────────────────────────────────────────────────────

  // ── GET /boot/grub.cfg (+ /grub aliases), UNGATED per-request GRUB menu; base baked from THIS
  //    request, enrolment token baked in GATED mode. The dongle's stage-1 config chains /boot/grub.cfg;
  //    an HTTP-booted grubnet instead resolves its baked $prefix to (http,host:port)/grub at the SERVER
  //    ROOT and probes the per-arch paths first, hence the three aliases (same handler, same body). ──
  const serveBootConfig = async (request: FastifyRequest, reply: FastifyReply): Promise<string> => {
    const base = computeBaseUrl(request, publicBaseUrl);
    const config = buildBootGrubCfg(base, enrollment.currentToken);
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    // A string reply makes Fastify set Content-Length; REQUIRED, firmware/GRUB reject chunked encoding.
    reply.type("text/plain; charset=utf-8");
    return config;
  };
  fastify.get("/boot/grub.cfg", serveBootConfig);
  fastify.get("/grub/grub.cfg", serveBootConfig);
  fastify.get("/grub/x86_64-efi/grub.cfg", serveBootConfig);
  fastify.get("/grub/arm64-efi/grub.cfg", serveBootConfig);

  // ── GET /dist/image/:arch/:file, the live-image artifacts (vmlinuz|initrd|polyptic.iso), Range-aware
  //    (the ISO is large and streamed into RAM). 404 → the box's boot cleanly stalls. ──
  fastify.get("/dist/image/:arch/:file", async (request, reply) => {
    const { arch, file } = request.params as { arch?: string; file?: string };
    if (!arch || !ARCH_RE.test(arch)) return reply.code(404).send({ error: "unknown architecture" });
    if (!file || !IMAGE_FILE_RE.test(file)) return reply.code(404).send({ error: "unknown image file" });
    const abs = safeResolve(imageDistDir, arch, file);
    if (!abs) return reply.code(404).send({ error: "not found" });

    let st;
    try {
      st = await stat(abs);
    } catch {
      return reply.code(404).send({ error: "image not bundled" });
    }
    if (!st.isFile()) return reply.code(404).send({ error: "image not bundled" });

    // vmlinuz + initrd are fetched (and vmlinuz shim_lock-verified) by GRUB, which needs Content-Length;
    // sendBootAsset buffers them for that. The ~1.5GB ISO streams (wget fetches it). Range-aware (206/416).
    return sendBootAsset(reply, abs, st.size, request.headers.range);
  });

  // ── GET /dist/boot/:file, UNGATED download of the boot depot: the universal dd-able dongle
  //    (polyptic-boot.img) + the four signed loaders (shim*/grub*.efi). Tokenless (they only chain
  //    /boot/grub.cfg), so, like /dist/agent, it's ungated: UEFI HTTP Boot, DHCP option-67 and the
  //    offload flow all fetch with no session. 404 when not bundled. ──
  fastify.get("/dist/boot/:file", async (request, reply) => {
    const file = (request.params as { file?: string }).file ?? "";
    if (!BOOT_FILE_RE.test(file)) return reply.code(404).send({ error: "unknown boot file" });
    const abs = safeResolve(bootDistDir, file);
    if (!abs) return reply.code(404).send({ error: "not found" });

    let st;
    try {
      st = await stat(abs);
    } catch {
      return reply.code(404).send({ error: "boot file not bundled" });
    }
    if (!st.isFile()) return reply.code(404).send({ error: "boot file not bundled" });

    // The signed .efi loaders (offload + UEFI HTTP Boot fetch these via shim/firmware) and the dongle
    // .img all need Content-Length; sendBootAsset buffers them (all well under the cap). Range-aware.
    reply.header("Content-Disposition", `attachment; filename="${file}"`);
    return sendBootAsset(reply, abs, st.size, request.headers.range);
  });

  // ── GET /api/v1/settings/netboot, GATED (auto: /api/v1 prefix → the global preHandler). Secret-free
  //    netboot info for the console (the token stays in EnrollmentInfo). ──
  fastify.get("/api/v1/settings/netboot", async (request) => {
    const base = computeBaseUrl(request, publicBaseUrl);
    // The universal dd-able dongle image, when bundled (one medium for both arches).
    const medium = await resolveBootMedium(bootDistDir);
    // The self-contained bootable live ISOs (POL-38/D49), listed per arch when built into the depot.
    const liveIsos: Array<{ arch: "arm64" | "amd64"; url: string }> = [];
    for (const arch of ["arm64", "amd64"] as const) {
      try {
        const st = await stat(join(imageDistDir, arch, "polyptic-live.iso"));
        if (st.isFile()) liveIsos.push({ arch, url: `${base}/dist/image/${arch}/polyptic-live.iso` });
      } catch {
        // not bundled for this arch — omit the entry
      }
    }
    return NetbootInfo.parse({
      baseUrl: base,
      mode: enrollment.open ? "open" : "gated",
      bootConfigUrl: `${base}/boot/grub.cfg`,
      bootMediumUrl: medium ? `${base}/dist/boot/polyptic-boot.img` : null,
      liveIsos,
    });
  });
}

/**
 * Validate distro+arch+file against the whitelists and resolve to an EXISTING traversal-safe file under
 * the deps root, trying both supported on-disk layouts:
 *   - `${DEPS_DIST_DIR}/<distro>/<arch>/<file>`         (DEPS_DIST_DIR points AT the deps root — the
 *                                                        bundle-deps.sh / default `./deploy/dist/deps` layout)
 *   - `${DEPS_DIST_DIR}/deps/<distro>/<arch>/<file>`    (DEPS_DIST_DIR is the dist root with a `deps/` subdir)
 * Both candidates are independently traversal-checked. Returns the first that is a regular file, or null
 * on validation failure / escape / absence (caller → 404 so the install script falls back cleanly).
 */
async function resolveDepsPath(
  depsDistDir: string,
  distro: string | undefined,
  arch: string | undefined,
  file: string | undefined,
): Promise<string | null> {
  if (!distro || !DISTRO_RE.test(distro)) return null;
  if (!arch || !ARCH_RE.test(arch)) return null;
  if (!file || !FILE_RE.test(file) || file.includes("..")) return null;

  const candidates = [
    safeResolve(depsDistDir, distro, arch, file),
    safeResolve(depsDistDir, "deps", distro, arch, file),
  ];
  for (const abs of candidates) {
    if (!abs) continue;
    try {
      if ((await stat(abs)).isFile()) return abs;
    } catch {
      // try the next candidate layout
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Boot diagnostics
// ─────────────────────────────────────────────────────────────────────────────

/** Whether a path exists and is a directory (for boot logging). */
async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Whether a path exists and is a regular file (for boot logging). */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** A boot-time summary of which provisioning artifacts are present, for the boot banner. */
export async function provisionBootSummary(config: ProvisionConfig): Promise<{
  installTemplate: boolean;
  agentDistDir: boolean;
  depsDistDir: boolean;
  agentArm64: boolean;
  agentAmd64: boolean;
  imageDistDir: boolean;
  imageAmd64: boolean;
  bootMedium: boolean;
  signedLoaders: boolean;
}> {
  const [installTemplate, agentDir, depsDir, arm64, amd64, imageDir, imageAmd64, medium, loaders] =
    await Promise.all([
      isFile(config.installScriptPath),
      isDir(config.agentDistDir),
      isDir(config.depsDistDir),
      isFile(resolve(config.agentDistDir, "polyptic-agent-arm64")),
      isFile(resolve(config.agentDistDir, "polyptic-agent-amd64")),
      isDir(config.imageDistDir),
      isFile(resolve(config.imageDistDir, "amd64", "polyptic.iso")),
      resolveBootMedium(config.bootDistDir).then((p) => p !== null),
      // Serving UEFI HTTP Boot / offload needs ALL FOUR loaders (shim + network GRUB, both arches).
      Promise.all(
        SIGNED_LOADER_FILES.map((f) => isFile(resolve(config.bootDistDir, f))),
      ).then((present) => present.every(Boolean)),
    ]);
  return {
    installTemplate,
    agentDistDir: agentDir,
    depsDistDir: depsDir,
    agentArm64: arm64,
    agentAmd64: amd64,
    imageDistDir: imageDir,
    imageAmd64,
    bootMedium: medium,
    signedLoaders: loaders,
  };
}
