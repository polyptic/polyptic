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
 * NETBOOT (POL-33), a bare box HTTP-boots a live Polyptic image straight into RAM, no OS install:
 *   GET /boot.ipxe                                → an iPXE chain script with the control-plane base
 *                                                   (and, in GATED mode, the enrolment token) baked in
 *                                                   from THIS request. Ungated, the box has no session.
 *   GET /dist/image/:arch/{vmlinuz,initrd,squashfs} → the live-image artifacts, Range-streamed to RAM.
 *   GET /dist/ipxe/:file                          → a prebuilt boot medium (polyptic-boot-<arch>.{efi,img}),
 *                                                   TOKENLESS so ungated (UEFI HTTP Boot / DHCP / offload).
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
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { NetbootInfo } from "@polyptic/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";

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
  /** Directory holding the netboot root images: `<arch>/{vmlinuz,initrd,squashfs}` (POL-33). */
  imageDistDir: string;
  /** Directory holding prebuilt boot media `polyptic-boot-<arch>.{efi,img}` (POL-33). */
  ipxeDistDir: string;
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
    ipxeDistDir: env.IPXE_DIST_DIR?.trim() || resolve(REPO_ROOT, "deploy/dist/ipxe"),
    publicBaseUrl: (env.PUBLIC_BASE_URL?.trim() || "http://localhost:8080").replace(/\/+$/, ""),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Whitelists + traversal-safe path resolution
// ─────────────────────────────────────────────────────────────────────────────

/** Build target architectures we serve binaries + bundles for. */
const ARCH_RE = /^(arm64|amd64)$/;
/** The three netboot root-image artifacts a diskless box streams (POL-33). Nothing else is servable. */
const IMAGE_FILE_RE = /^(vmlinuz|initrd|squashfs)$/;
/** A boot-medium filename: `polyptic-boot-<arch>[-snponly].{efi,img}`. The `.img` is a `dd`-able FAT32
 *  USB dongle image; the `.efi` is the raw loader for UEFI HTTP Boot / DHCP option-67 / offload. Both
 *  are TOKENLESS (they only chain `/boot.ipxe`), so this route is ungated like `/dist/agent`. */
const IPXE_FILE_RE = /^polyptic-boot-(amd64|arm64)(-snponly)?\.(efi|img)$/;
/** Extensions tried when resolving the "best" downloadable medium for an arch: the dongle image first
 *  (what an operator writes to USB), then the raw loader. `polyptic-boot-<arch>.<ext>` (POL-33). */
const BOOT_MEDIUM_EXTS = ["img", "efi"] as const;
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
 * append the `/agent` channel path. Baked into `/boot.ipxe` so a diskless box's agent dials the exact
 * same host it netbooted from (the outbound-WSS channel, D12). `http://h:8080` → `ws://h:8080/agent`.
 */
export function toWsAgentUrl(httpBase: string): string {
  return `${httpBase.replace(/\/+$/, "").replace(/^http/, "ws")}/agent`;
}

/**
 * The kernel command line a diskless box boots with (POL-33). CENTRALISED here so the casper/live-boot
 * contract is a one-line change once validated on real hardware (the one piece not testable in-repo):
 *   - `boot=casper netboot=http fetch=<squashfs>` streams the root image straight into RAM over HTTP
 *     and builds a tmpfs overlay, nothing touches disk ("live image, no install").
 *   - `ip=dhcp` brings the NIC up before the fetch.
 *   - `polyptic.server_url=` / `polyptic.token=` are picked out of /proc/cmdline by the image's
 *     parse-cmdline helper and become the agent's POLYPTIC_SERVER_URL / POLYPTIC_BOOTSTRAP_TOKEN.
 * `arch` + `polyptic_base` are iPXE variables the script resolves at boot; the token (when gated) is
 * a baked literal. Kernel + initrd are served alongside the squashfs from `/dist/image/<arch>/`.
 * When `offload` is set (the boot medium's "Offload to this box" menu item chains `/boot.ipxe?offload=1`),
 * `polyptic.offload=1` is added so the live image runs its one-shot ESP-loader install before reconciling.
 */
function bootKernelCmdline(gated: boolean, offload: boolean): string {
  const parts = [
    "initrd=initrd",
    "boot=casper",
    "netboot=http",
    "ip=dhcp",
    "fetch=${polyptic_base}/dist/image/${arch}/squashfs",
    // The HTTP base (for the offload flow to fetch the loader) + the WS agent URL (for the agent).
    "polyptic.base=${polyptic_base}",
    "polyptic.server_url=${polyptic_ws}",
  ];
  if (gated) parts.push("polyptic.token=${polyptic_token}");
  if (offload) parts.push("polyptic.offload=1");
  return parts.join(" ");
}

/**
 * Build the `GET /boot.ipxe` chain script for a control plane at `base`, baking in the WS agent URL and
 *, in GATED mode, the current enrolment token (POL-33). The box has no operator session at boot, so
 * this route is ungated; a leaked token cannot self-admit (a NEW machine still lands PENDING for an
 * operator to approve, see enroll.ts case 1). `${buildarch}` selects amd64/arm64 at boot so one script
 * serves both arches (amd64 images are bundled first). `offload` (from `/boot.ipxe?offload=1`) tags the
 * cmdline so the live image writes the loader to the box's ESP once, then boots the same flow forever.
 */
export function buildBootIpxeScript(
  base: string,
  token: string | undefined,
  offload = false,
): string {
  const gated = token !== undefined;
  const lines = [
    "#!ipxe",
    "# Polyptic netboot (POL-33), generated for THIS control plane from the request Host.",
    "# Ownership is by KEY: the box belongs to the server whose enrolment token it carries.",
    `set polyptic_base ${base}`,
    `set polyptic_ws ${toWsAgentUrl(base)}`,
    "iseq ${buildarch} arm64 && set arch arm64 || set arch amd64",
  ];
  if (gated) lines.push(`set polyptic_token ${token}`);
  const mode = offload ? "offload (writing the boot loader to this box) then " : "";
  lines.push(
    `echo Polyptic: ${mode}streaming the \${arch} live image from \${polyptic_base} (diskless, no install) …`,
    `kernel \${polyptic_base}/dist/image/\${arch}/vmlinuz ${bootKernelCmdline(gated, offload)}`,
    "initrd ${polyptic_base}/dist/image/${arch}/initrd",
    "boot",
  );
  return lines.join("\n") + "\n";
}

/**
 * Parse a single `Range: bytes=start-end` header against a known `size`. The squashfs root image is
 * hundreds of MB and casper/iPXE issue byte-range GETs while streaming it, so `/dist/image` serves real
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
 * Resolve the preferred downloadable boot medium for `arch` under `ipxeDistDir`, traversal-safe: the
 * `dd`-able `.img` dongle first (what an operator writes to USB), else the raw `.efi` loader. Returns the
 * absolute path of the first that is a regular file, else `null` (the medium is optional, the UI falls
 * back to the raw `/boot.ipxe` URL when it's absent).
 */
export async function resolveBootMedium(ipxeDistDir: string, arch: string): Promise<string | null> {
  if (!ARCH_RE.test(arch)) return null;
  for (const ext of BOOT_MEDIUM_EXTS) {
    const abs = safeResolve(ipxeDistDir, `polyptic-boot-${arch}.${ext}`);
    if (!abs) continue;
    try {
      if ((await stat(abs)).isFile()) return abs;
    } catch {
      // try the next extension
    }
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
  const { installScriptPath, agentDistDir, depsDistDir, imageDistDir, ipxeDistDir, publicBaseUrl } =
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

  // ── GET /boot.ipxe, UNGATED iPXE chain script; base baked from THIS request, enrolment token
  //    baked in GATED mode. A diskless box (or the site's DHCP/UEFI-HTTP boot) chains this. ──
  fastify.get("/boot.ipxe", async (request, reply) => {
    const base = computeBaseUrl(request, publicBaseUrl);
    // The boot medium's "Offload to this box" menu item chains `/boot.ipxe?offload=1`.
    const offload = (request.query as { offload?: string }).offload === "1";
    const script = buildBootIpxeScript(base, enrollment.currentToken, offload);
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    // iPXE fetches its scripts as text/plain; the shebang (#!ipxe) is what iPXE keys off, not the type.
    reply.type("text/plain; charset=utf-8");
    return script;
  });

  // ── GET /dist/image/:arch/:file, the netboot root image (vmlinuz|initrd|squashfs), Range-aware
  //    (the squashfs is large and streamed byte-range into RAM). 404 → the box's boot cleanly stalls. ──
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

    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Accept-Ranges", "bytes");
    reply.type("application/octet-stream");

    const range = parseRange(request.headers.range, st.size);
    if (range && "unsatisfiable" in range) {
      // The octet-stream content-type is already set above, so send a plain string (not an object,
      // which the octet-stream serializer would reject) with a text type for the error body.
      reply.header("Content-Range", `bytes */${st.size}`);
      reply.type("text/plain; charset=utf-8");
      return reply.code(416).send("range not satisfiable");
    }
    if (range) {
      const { start, end } = range;
      reply.code(206);
      reply.header("Content-Range", `bytes ${start}-${end}/${st.size}`);
      reply.header("Content-Length", String(end - start + 1));
      return reply.send(createReadStream(abs, { start, end }));
    }
    reply.header("Content-Length", String(st.size));
    return reply.send(createReadStream(abs));
  });

  // ── GET /dist/ipxe/:file, UNGATED download of a prebuilt boot medium (polyptic-boot-<arch>.{efi,img}).
  //    Tokenless (it only chains /boot.ipxe), so, like /dist/agent, it's ungated: UEFI HTTP Boot, DHCP
  //    option-67 and the offload flow all fetch it with no session. 404 when not bundled. ──
  fastify.get("/dist/ipxe/:file", async (request, reply) => {
    const file = (request.params as { file?: string }).file ?? "";
    if (!IPXE_FILE_RE.test(file)) return reply.code(404).send({ error: "unknown boot medium" });
    const abs = safeResolve(ipxeDistDir, file);
    if (!abs) return reply.code(404).send({ error: "not found" });

    let st;
    try {
      st = await stat(abs);
    } catch {
      return reply.code(404).send({ error: "boot medium not bundled" });
    }
    if (!st.isFile()) return reply.code(404).send({ error: "boot medium not bundled" });

    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Accept-Ranges", "bytes");
    reply.header("Content-Disposition", `attachment; filename="${file}"`);
    reply.header("Content-Length", String(st.size));
    reply.type("application/octet-stream");
    return reply.send(createReadStream(abs));
  });

  // ── GET /api/v1/settings/netboot, GATED (auto: /api/v1 prefix → the global preHandler). Secret-free
  //    netboot info for the console (the token stays in EnrollmentInfo). ──
  fastify.get("/api/v1/settings/netboot", async (request) => {
    const base = computeBaseUrl(request, publicBaseUrl);
    // amd64-first; resolveBootMedium prefers the dd-able .img (dongle) over the raw .efi for download.
    const medium = await resolveBootMedium(ipxeDistDir, "amd64");
    const mediumFile = medium ? (medium.split(sep).pop() ?? null) : null;
    return NetbootInfo.parse({
      baseUrl: base,
      mode: enrollment.open ? "open" : "gated",
      bootIpxeUrl: `${base}/boot.ipxe`,
      bootMediumUrl: mediumFile ? `${base}/dist/ipxe/${mediumFile}` : null,
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
  bootMediumAmd64: boolean;
}> {
  const [installTemplate, agentDir, depsDir, arm64, amd64, imageDir, imageAmd64, mediumAmd64] =
    await Promise.all([
      isFile(config.installScriptPath),
      isDir(config.agentDistDir),
      isDir(config.depsDistDir),
      isFile(resolve(config.agentDistDir, "polyptic-agent-arm64")),
      isFile(resolve(config.agentDistDir, "polyptic-agent-amd64")),
      isDir(config.imageDistDir),
      isFile(resolve(config.imageDistDir, "amd64", "squashfs")),
      resolveBootMedium(config.ipxeDistDir, "amd64").then((p) => p !== null),
    ]);
  return {
    installTemplate,
    agentDistDir: agentDir,
    depsDistDir: depsDir,
    agentArm64: arm64,
    agentAmd64: amd64,
    imageDistDir: imageDir,
    imageAmd64,
    bootMediumAmd64: mediumAmd64,
  };
}
