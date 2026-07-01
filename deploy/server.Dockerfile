# Polyptic — single control-plane image (console + player + server).
#
# ONE artifact = the operator console (Vue SPA) + the player (Vue SPA) + the
# Fastify control plane. The server serves both SPAs SAME-ORIGIN on :8080, so the
# auth cookie "just works" with no cross-origin CORS dance.
#
# Multi-stage:
#   stage 1 (build)   — oven/bun:1: `bun install`, build @polyptic/protocol, then
#                       `vite build` the console AND the player into their dist/.
#   stage 2 (runtime) — oven/bun:1-slim: server source + protocol + the two dist
#                       dirs only. CONSOLE_DIR / PLAYER_DIR point the server at the
#                       built SPAs. Runs the TS entrypoint with bun (no JS build).
#
# Build context is the REPO ROOT (docker-compose sets build.context = ..), so all
# paths below are relative to the monorepo root.
#
# Build standalone:
#     docker build -f deploy/server.Dockerfile -t polyptic-server .
# Or via compose:
#     docker compose -f deploy/docker-compose.yml --profile full up --build
#
# NOTE: `vite build` runs HERE, inside the image — never in the sandbox workflow.

# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 — build: install deps, compile the protocol, build both SPAs.
# ─────────────────────────────────────────────────────────────────────────────
FROM oven/bun:1 AS build
WORKDIR /app

# Copy the whole bun workspace. (.dockerignore + deploy/server.Dockerfile.dockerignore
# keep host node_modules / dist / .git / media out of the build context, so
# `bun install` regenerates linux-native deps inside the image.)
COPY . .

# Install all workspace dependencies (incl. vite + vue-tsc needed to build the SPAs).
RUN bun install --frozen-lockfile

# Build the shared contract first so @polyptic/protocol resolves to its compiled
# dist/ (its package.json exports point at ./dist) before anything imports it.
RUN cd packages/protocol && bun run build

# Production builds of both SPAs. Vite emits to packages/<app>/dist by default.
RUN cd packages/console && bun run build
RUN cd packages/player && bun run build

# ── Zero-touch depot: compile the agent single binary for BOTH arches ─────────
# The agent is delivered ONLY via this depot (D35/D41): the control plane serves these at
# GET /dist/agent/<arch> and deploy/install.sh downloads the one matching the box's uname -m. Bun
# cross-compiles the runtime INTO each binary, so this one image build produces amd64 AND arm64 — no
# per-arch build host. (Same `bun build --compile` as deploy/build-agent.sh, inlined here.)
# The version is baked in at compile time (POLYPTIC_VERSION build-arg → `--define`): the standalone
# binary can't read package.json off disk, and it's what the boot splash + agent/hello report (POL-7).
ARG POLYPTIC_VERSION=0.0.0
RUN mkdir -p /app/deploy/dist \
 && AGENT_VER="${POLYPTIC_VERSION#v}" \
 && bun build --compile --minify --define "process.env.POLYPTIC_BUILD_VERSION=\"$AGENT_VER\"" --target=bun-linux-x64 \
      --outfile /app/deploy/dist/polyptic-agent-amd64 packages/agent/src/index.ts \
 && bun build --compile --minify --define "process.env.POLYPTIC_BUILD_VERSION=\"$AGENT_VER\"" --target=bun-linux-arm64 \
      --outfile /app/deploy/dist/polyptic-agent-arm64 packages/agent/src/index.ts \
 && chmod 0755 /app/deploy/dist/polyptic-agent-amd64 /app/deploy/dist/polyptic-agent-arm64

# ── Optional: bundle the visual substrate (.deb closure) for THIS image's arch ─
# Gated by --build-arg BUNDLE_DEPS=1. Best-effort: a failed bundle (e.g. no Chromium .deb in the
# base image's apt index) must NOT sink the server build — the substrate is only needed for the
# --kiosk path, and a bundle can always be added later with deploy/bundle-deps.sh. When it succeeds
# the depot serves GET /dist/deps/<distro>/<arch>/{manifest.json,*.deb} offline to edge boxes.
ARG BUNDLE_DEPS=0
RUN if [ "$BUNDLE_DEPS" = "1" ]; then \
      echo "==> BUNDLE_DEPS=1: bundling substrate for this image arch"; \
      apt-get update \
        && apt-get install -y --no-install-recommends ca-certificates \
        && bash deploy/bundle-deps.sh \
        || echo "WARN: bundle-deps failed; continuing without a baked substrate bundle"; \
    else \
      echo "==> BUNDLE_DEPS not set; skipping substrate bundle (add later with deploy/bundle-deps.sh)"; \
    fi

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2 — runtime: slim image with just what the server needs at run time.
# ─────────────────────────────────────────────────────────────────────────────
FROM oven/bun:1-slim AS runtime
WORKDIR /app

# Optional provenance, surfaced by the server at /api/v1 + /metrics.
ARG POLYPTIC_VERSION=0.0.0
ARG POLYPTIC_REVISION=dev

# node_modules is built linux-native in stage 1 — copy it rather than reinstalling
# (bun hoists the workspace deps to the root node_modules).
COPY --from=build /app/node_modules ./node_modules

# Workspace + server manifests and the TS config the server tsconfig extends.
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/bun.lock ./bun.lock
COPY --from=build /app/tsconfig.base.json ./tsconfig.base.json

# The shared contract (compiled dist + its manifest) and the server source.
COPY --from=build /app/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /app/packages/server ./packages/server

# The two built SPAs — the only thing the runtime needs from console/player.
COPY --from=build /app/packages/console/dist ./packages/console/dist
COPY --from=build /app/packages/player/dist ./packages/player/dist

# The air-gap depot: the served install script + the compiled agent binaries (both arches) and any
# baked substrate bundle. The server reads ./deploy/install.sh (INSTALL_SCRIPT_PATH) and bakes the
# control-plane base into its {{POLYPTIC_BASE}} placeholder per request; it streams the binaries +
# bundle from AGENT_DIST_DIR / DEPS_DIST_DIR at GET /dist/agent/<arch> and /dist/deps/….
COPY --from=build /app/deploy/install.sh ./deploy/install.sh
COPY --from=build /app/deploy/dist ./deploy/dist

# ── Runtime env ──────────────────────────────────────────────────────────────
# The server binds HOST:PORT and serves the console + player from these dirs,
# same-origin on :8080. STORE / DATABASE_URL / MEDIA_* come from compose or
# `docker run -e` (defaults below keep a bare `docker run` bootable).
ENV PORT=8080 \
    HOST=0.0.0.0 \
    CONSOLE_DIR=/app/packages/console/dist \
    PLAYER_DIR=/app/packages/player/dist \
    MEDIA_DIR=/var/lib/polyptic/media \
    AGENT_DIST_DIR=/app/deploy/dist \
    DEPS_DIST_DIR=/app/deploy/dist/deps \
    POLYPTIC_VERSION=${POLYPTIC_VERSION} \
    POLYPTIC_REVISION=${POLYPTIC_REVISION}

EXPOSE 8080

# Healthcheck hits the public /healthz. bun is always present, so we avoid relying
# on curl/wget being installed in the slim base.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Bun runs the TypeScript entrypoint natively — no separate build step for the server.
CMD ["bun", "packages/server/src/index.ts"]
