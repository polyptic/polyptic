# Polyptych control plane — container image.
#
# Minimal Bun image for the server (used by the `full` compose profile and as the
# prod-portable artifact). Build context is the REPO ROOT (see docker-compose.yml:
# build.context = ..), so paths below are relative to the monorepo root.
#
# Build standalone:
#     docker build -f deploy/server.Dockerfile -t polyptych-server .
# Or via compose:
#     docker compose -f deploy/docker-compose.yml --profile full up --build
FROM oven/bun:1

WORKDIR /app

# Copy the whole bun workspace. (deploy/server.Dockerfile.dockerignore keeps
# host node_modules / dist / .git out of the build context.)
COPY . .

# Install all workspace dependencies.
RUN bun install

# Build the shared contract so @polyptych/protocol resolves to its compiled
# dist/ (its package.json "main"/"exports" point at ./dist) before the server
# imports it.
RUN cd packages/protocol && bun run build

# The server reads PORT (default 8080) and binds HOST 0.0.0.0; STORE + DATABASE_URL
# are supplied by compose (or `docker run -e`). Defaults baked in for standalone runs.
ENV PORT=8080
ENV HOST=0.0.0.0
EXPOSE 8080

# Bun runs the TypeScript entrypoint natively — no separate build step for the server.
CMD ["bun", "packages/server/src/index.ts"]
