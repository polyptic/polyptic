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

import type { FastifyInstance, FastifyRequest } from "fastify";

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
  /** Last-resort base URL when the request carries no Host/forwarded headers. */
  publicBaseUrl: string;
}

/** Resolve provisioning config from the environment, with sensible repo-relative defaults. */
export function provisionConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ProvisionConfig {
  return {
    installScriptPath: env.INSTALL_SCRIPT_PATH?.trim() || resolve(REPO_ROOT, "deploy/install.sh"),
    agentDistDir: env.AGENT_DIST_DIR?.trim() || resolve(REPO_ROOT, "deploy/dist"),
    depsDistDir: env.DEPS_DIST_DIR?.trim() || resolve(REPO_ROOT, "deploy/dist/deps"),
    publicBaseUrl: (env.PUBLIC_BASE_URL?.trim() || "http://localhost:8080").replace(/\/+$/, ""),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Whitelists + traversal-safe path resolution
// ─────────────────────────────────────────────────────────────────────────────

/** Build target architectures we serve binaries + bundles for. */
const ARCH_RE = /^(arm64|amd64)$/;
/** A distro slug: `<id>` or `<id>-<version>` (e.g. `ubuntu`, `ubuntu-24.04`, `debian-12`). */
const DISTRO_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** A bundle file name (.deb etc.): no path separators, no leading dot, bounded charset. */
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._+~-]{0,255}$/;

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

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Register the provisioning routes. ALL are TOP-LEVEL and UNGATED — register OUTSIDE the /api/v1 gate
 * (alongside /healthz). Pass the resolved {@link ProvisionConfig}.
 */
export function registerProvisionRoutes(fastify: FastifyInstance, config: ProvisionConfig): void {
  const { installScriptPath, agentDistDir, depsDistDir, publicBaseUrl } = config;

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
}> {
  const [installTemplate, agentDir, depsDir, arm64, amd64] = await Promise.all([
    isFile(config.installScriptPath),
    isDir(config.agentDistDir),
    isDir(config.depsDistDir),
    isFile(resolve(config.agentDistDir, "polyptic-agent-arm64")),
    isFile(resolve(config.agentDistDir, "polyptic-agent-amd64")),
  ]);
  return {
    installTemplate,
    agentDistDir: agentDir,
    depsDistDir: depsDir,
    agentArm64: arm64,
    agentAmd64: amd64,
  };
}
