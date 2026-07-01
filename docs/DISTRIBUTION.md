# Polyptic — distribution & packaging

How Polyptic ships, and how you put it on real infrastructure. This is the **packaging** guide — the artifacts, where they come from, and the exact commands to run them. For turning a bare Linux box into a display see `docs/DEPLOY.md`; for the dev/VM loop see `docs/DEV.md`.

> **Nothing here auto-publishes.** The release workflow only runs when *you* push a `vX.Y.Z` tag, and the image/registry steps need secrets that don't exist until you create them. Read this end-to-end before you cut the first release — you choose when (and whether) anything leaves your machine.

Polyptic is two deployable things plus an optional one:

| What | Artifact | How you install it | Lives where |
|---|---|---|---|
| **Server** (control plane + console + player) | one **Docker image** `ghcr.io/<owner>/polyptic-server` | `docker run` / compose / Helm | your cluster or Docker host |
| **Agent** (per display box) | the agent **single binary**, served by the control-plane depot (D35/D41) | `curl -sfL http://SERVER:8080/install \| sh -` | each kiosk machine |
| **Workspace packages** (`@polyptic/*`) | npm tarballs | *optional* — internal to the product; you almost never need these | a private registry, only if you want one |

Throughout, replace `<owner>` with your GitHub org/user (the chart default is `ghcr.io/polyptic/polyptic-server`, i.e. `<owner>` = `polyptic`).

---

## (a) The server — one image that is the whole control plane

The server image is **self-contained**: it bundles the **control plane** (Fastify REST + WebSocket on `:8080`, `/healthz`, `/metrics`, `/media`), the **console** (the Vue operator SPA) and the **player** (the Vue per-screen SPA) in a single artifact. The server serves the console and player as static assets from the *same origin* as the API, which is a real simplification: the session cookie is same-origin, so there is **no cross-origin CORS to configure** for the bundled UIs. You ship one image; you don't wire three.

> **Why the image, and not `npm install`?** Polyptic is a *product you run*, not a library you depend on. The unit of deployment is this image (server) and the depot-served binary (agent). You never `npm install polyptic` to stand it up — see [(d) Self-hosted npm](#d-self-hosted-npm--optional-and-only-if-you-want-it) for why the workspace packages are internal.

### The image is built in CI, not here

The console and player are **Vite SPAs**; their production build (`vite build`) runs in CI or on your machine — see `deploy/server.Dockerfile`. The image's build stage runs `bun install`, builds `@polyptic/protocol`, builds the console + player static bundles, and the runtime stage runs `bun packages/server/src/index.ts` with the built SPAs on disk. The server is pointed at those bundles with `CONSOLE_DIR` / `PLAYER_DIR` (the image bakes sane defaults; you only override them if you relocate the assets).

### Run it three ways

**1. `docker run` — the smallest possible thing**

```bash
docker run -d --name polyptic-server -p 8080:8080 \
  -e DATABASE_URL=postgres://polyptic:polyptic@your-db:5432/polyptic \
  -e COOKIE_SECRET="$(openssl rand -hex 32)" \
  -e SECURE_COOKIES=true \
  -e CORS_ORIGIN=https://polyptic.example.com \
  -e POLYPTIC_ADMIN_EMAIL=alex@example.com \
  -e POLYPTIC_ADMIN_PASSWORD='change-me-now' \
  -e MEDIA_DIR=/var/lib/polyptic/media \
  -e MEDIA_PUBLIC_BASE=https://polyptic.example.com \
  -v polyptic-media:/var/lib/polyptic/media \
  ghcr.io/<owner>/polyptic-server:0.1.0
```

You bring your own Postgres (any reachable Postgres 16; `DATABASE_URL` points at it). Put a TLS-terminating reverse proxy in front so the cookie can be `SECURE_COOKIES=true`.

**2. docker-compose — server + Postgres together**

`deploy/docker-compose.yml` ships a `full` profile that builds the server from `deploy/server.Dockerfile` and brings up Postgres alongside it:

```bash
docker compose -f deploy/docker-compose.yml --profile full up -d
```

For a *released* image instead of a local build, set the `server.image` to `ghcr.io/<owner>/polyptic-server:0.1.0` and drop the `build:` block (or override with a small `docker-compose.override.yml`). The compose file already wires the media volume and the `db`-network `DATABASE_URL`; copy `deploy/.env.example` → `deploy/.env` and fill in the auth secrets.

**3. Helm — on Kubernetes**

The standalone chart in `deploy/helm/polyptic` deploys **only the server** (agents are not in the cluster — they live on the boxes). Bring your own Postgres via `externalDatabase.url`, or flip on the in-cluster Bitnami subchart:

```bash
helm install polyptic deploy/helm/polyptic \
  --set image.repository=ghcr.io/<owner>/polyptic-server \
  --set image.tag=0.1.0 \
  --set externalDatabase.url=postgres://polyptic:polyptic@my-pg:5432/polyptic \
  --set secrets.cookieSecret="$(openssl rand -hex 32)" \
  --set config.corsOrigin=https://polyptic.example.com \
  --set ingress.enabled=true --set ingress.host=polyptic.example.com \
  --set ingress.tls.enabled=true
```

If you leave `secrets.cookieSecret` empty the chart generates one on first install and preserves it across upgrades. Liveness/readiness hit the **ungated** `/healthz`; Prometheus scrape annotations target the ungated `/metrics`. See `deploy/helm/polyptic/README.md` for the full values reference.

### Server environment reference

Set on `docker run -e …`, the compose `environment:` / `.env`, or Helm `config.*` / `secrets.*`. Everything has a working default except where noted as **required for a real deployment**.

| Env var | Purpose | Notes |
|---|---|---|
| `DATABASE_URL` | Postgres connection string | **Required** in prod (`STORE=postgres`, the default). `postgres://user:pass@host:5432/polyptic`. |
| `STORE` | Registry backend: `postgres` or `memory` | `memory` is a test-only double; never run real with it. |
| `PORT` | HTTP + WS listen port | Default `8080`. The image `EXPOSE`s 8080. |
| `COOKIE_SECRET` | Signs the http-only session cookies | **Required** in prod; long random value (`openssl rand -hex 32`). |
| `SECURE_COOKIES` | Mark session cookies `Secure` (HTTPS-only) | **Set `true` in production over HTTPS.** `NODE_ENV=production` implies it unless overridden. |
| `CORS_ORIGIN` | Comma-separated allowed browser origins | Only needed when a browser hits the API from a *different* origin than the bundled console (e.g. a separately hosted console). Same-origin bundled UI needs nothing here. |
| `POLYPTIC_ADMIN_EMAIL` / `POLYPTIC_ADMIN_PASSWORD` | Seed the first operator on first boot | Created only if no users exist yet. Set both, or manage operators out-of-band. |
| `POLYPTIC_BOOTSTRAP_TOKEN` | Shared agent-enrollment secret | Unset → **open mode** (auto-approve, dev only). Set → **gated**: agents show PENDING until approved. Same value on each agent. |
| `MEDIA_DIR` | Directory uploads are written to | Mount a **persistent** volume here in prod (e.g. `/var/lib/polyptic/media`). |
| `MEDIA_PUBLIC_BASE` | Absolute base URL prepended to `/media/<id>` | Must be reachable by players/public wall — your public HTTPS origin. |
| `MEDIA_MAX_BYTES` | Max upload size in bytes | Default ~200 MB (`209715200`). |
| `CAPTURE_INTERVAL_MS` | Live-preview thumbnail capture cadence | Empty → server default. Server polls agents for `server/capture`. |
| `CONSOLE_DIR` / `PLAYER_DIR` | Where the server reads the built console/player SPA assets | Baked into the image; override only if you relocate the bundles. |

---

## (b) The agent — zero-touch install from the control-plane depot

The per-box agent is **not** in the server image, and there is **no standalone `.deb`/`.rpm` to `apt install`** (removed in **D41**). The agent is a Bun single binary that the control plane itself serves; a box installs it with a k3s-style one-liner and nothing else — the box needs to reach **only the server** (D35). This is the **one** supported way to put an agent on a box.

On a target box (Ubuntu Server-minimal), as a sudo user:

```bash
# agent only (headless enrol; fully air-gapped) — downloads the binary, writes config, enrols:
curl -sfL http://control.example.com:8080/install | POLYPTIC_TOKEN="$POLYPTIC_BOOTSTRAP_TOKEN" sh -

# agent + the greetd/sway/Chromium kiosk substrate (the visual wall) — auto-reboots into it when done:
curl -sfL http://control.example.com:8080/install | POLYPTIC_TOKEN="$POLYPTIC_BOOTSTRAP_TOKEN" sh -s -- --kiosk
#   add --no-reboot to wire the kiosk but reboot yourself later
```

The installer downloads the arch-matched binary from `GET /dist/agent/<arch>`, installs it, and (with `--kiosk`) runs `polyptic-agent setup` to wire the zero-click chain (greetd autologin → sway → agent → Chromium-per-output, plus the boot splash), then **auto-reboots** so the box cold-boots straight into the kiosk (`--no-reboot`/`POLYPTIC_NO_REBOOT=1` opts out; the agent-only install never reboots). The box cold-boots and dials home; it shows **PENDING** in the console until an operator **Approves** it. Per-box config lives in `/etc/polyptic/agent.toml` (`systemctl restart polyptic-agent` or re-run the installer / `sudo polyptic-agent setup` to apply). Drop `POLYPTIC_TOKEN=` only if the server runs OPEN mode. The full device story — backends, multi-output placement, crash hardening, troubleshooting, the UTM/VM walkthrough — is in **`docs/DEPLOY.md`**; the depot internals (what the server serves, how the binary is baked, air-gap bundles) are in **(b2)** below.

> **Build the binary yourself** (to seed a depot without building the whole server image, or for an arch CI doesn't build): `bash deploy/build-agent.sh amd64` on a host with `bun` produces `deploy/dist/polyptic-agent-amd64`; point the server's `AGENT_DIST_DIR` at `deploy/dist`.

---

## (b2) The depot internals — what the server serves and how it's baked

For an **edge box that can reach ONLY the control plane**, the server itself is the depot: it serves the agent binary and (with `--kiosk`) the visual substrate, so the box pulls everything from the one server it can see, and nothing else. Section (b) is the operator command; this section is the *packaging* side — what the depot serves and how the artifacts get there.

The operator command is in (b) above; the operator-facing flow, Stage A (agent, offline) vs Stage B (`--kiosk`, substrate offline-first), and the flags live in **`docs/DEPLOY.md` → "Zero-touch, air-gapped install"**.

### The artifacts the depot serves (all top-level, ungated, like `/healthz`)

| Route | What | Source on disk |
|---|---|---|
| `GET /install` | `deploy/install.sh` with `{{POLYPTIC_BASE}}` replaced by the URL the box curled (from `Host` / `X-Forwarded-*`) | `INSTALL_SCRIPT_PATH` (default `./deploy/install.sh`) |
| `GET /dist/agent/:arch` | the prebuilt agent **binary** (`arch` ∈ `arm64`\|`amd64`), streamed; `404` if not bundled | `AGENT_DIST_DIR/polyptic-agent-<arch>` (default `./deploy/dist`) |
| `GET /dist/deps/:distro/:arch/manifest.json` | the substrate **bundle manifest** (file list); `404` → the script tries its online fallback | `DEPS_DIST_DIR/<distro>/<arch>/manifest.json` (default `./deploy/dist/deps`) |
| `GET /dist/deps/:distro/:arch/:file` | one bundled `.deb` from the closure | `DEPS_DIST_DIR/<distro>/<arch>/<file>` |

`:arch` is `arm64`/`amd64`; `:distro` is a slug like `ubuntu-24.04` (`/etc/os-release` `ID-VERSION_ID`). All paths are traversal-safe and 404 cleanly when an artifact is absent.

### How the artifacts get baked in (the server image)

`deploy/server.Dockerfile` is the normal way to fill the depot — no extra steps for the common case:

- **Agent binaries, both arches.** The build stage cross-compiles the agent with `bun build --compile --target=bun-linux-x64` **and** `--target=bun-linux-arm64` into `/app/deploy/dist/polyptic-agent-{amd64,arm64}`. One image build serves every box, no per-arch build host (Bun bakes the runtime into each binary — see **D7**).
- **Substrate bundle (optional, gated).** `--build-arg BUNDLE_DEPS=1` runs `deploy/bundle-deps.sh` for the **image's** arch into `/app/deploy/dist/deps`. It's best-effort — a failed bundle never sinks the server build (the substrate is only needed for `--kiosk`, and bundles can be added later).
- The runtime stage copies `deploy/install.sh` + `deploy/dist`, and sets `AGENT_DIST_DIR=/app/deploy/dist` + `DEPS_DIST_DIR=/app/deploy/dist/deps`.

```bash
# build the server image WITH a baked substrate bundle for the image's arch:
docker build -f deploy/server.Dockerfile --build-arg BUNDLE_DEPS=1 -t polyptic-server .
```

### Adding a distro/arch bundle with `bundle-deps.sh`

A bundle is the **full `.deb` dependency closure** for the substrate (`sway`, `greetd`, a `.deb` Chromium — never the snap — `grim`, `wayvnc`, `dbus-user-session`, fonts) for one Ubuntu point-release + arch. Run it **on an Ubuntu host of the target arch**:

```bash
# on an amd64 Ubuntu host (or container):
bash deploy/bundle-deps.sh
#   → deploy/dist/deps/ubuntu-24.04/amd64/{manifest.json, *.deb}
```

**Cross-arch caveat:** `apt-get` resolves the closure for the **host's** arch — there is no reliable foreign-arch `apt-get download`. To bundle a different arch, run it in a target-arch container (binfmt/qemu makes this work from any host):

```bash
docker run --rm --platform linux/arm64 -v "$PWD":/repo -w /repo ubuntu:24.04 \
  bash -c 'apt-get update && apt-get install -y --no-install-recommends ca-certificates && deploy/bundle-deps.sh'
#   → deploy/dist/deps/ubuntu-24.04/arm64/{manifest.json, *.deb}
```

Drop the resulting `deploy/dist/deps/<distro>/<arch>/` directory into the server's `DEPS_DIST_DIR` (it's baked into the image, or mount it as a volume) and the offline `--kiosk` path lights up for that distro+arch. `bundle-deps.sh` is idempotent (clean rebuild each run) and writes a `manifest.json` whose `files` array the install script reads; install order is left to `apt-get install ./*.deb`, which resolves the closure itself.

### Dev/lab without Docker

The dev server serves the depot from local files too — build the binary and point the server at it:

```bash
bash deploy/build-agent.sh arm64                       # → deploy/dist/polyptic-agent-arm64
AGENT_DIST_DIR=deploy/dist bun packages/server/src/index.ts
# on a VM that can reach your Mac:
curl -sfL http://<mac-ip>:8080/install | POLYPTIC_TOKEN=$TOKEN sh -
```

---

## (c) Releases — one tag builds everything

Releases are driven entirely by **git tags**. Pushing a tag of the form `vX.Y.Z` is what triggers the release workflow; nothing builds or publishes on an ordinary push to `main`.

```bash
# when you are ready to ship a version (and ONLY then):
git tag v0.1.0
git push origin v0.1.0
```

On that tag the release workflow:

1. **Builds the server image** and pushes it to GHCR as `ghcr.io/<owner>/polyptic-server:0.1.0` (and `:latest`). This includes the `vite build` of the console + player that this sandbox can't run — it runs in CI, and the image's build stage also bakes the agent binaries (both arches) into the depot with the version baked in via `--build-arg POLYPTIC_VERSION`.
2. **Builds the agent binaries** — `polyptic-agent-amd64` and `polyptic-agent-arm64` — via `deploy/build-agent.sh` (Bun single binary, version baked in via `--define`).
3. **Creates the GitHub Release** for the tag and **attaches the agent binaries** so you can seed a depot's `AGENT_DIST_DIR` from the Release (the running server image already serves them; there is no `.deb`/`.rpm` to `apt install` — D41).

What it needs before it can succeed (you set these up when you're ready, not before):

- **GHCR push:** the built-in `GITHUB_TOKEN` with `packages: write` (granted in the workflow's `permissions:`), or a PAT if you push to a different org. No external secret needed for the default org.
- **Release assets:** `contents: write` (again the built-in token).
- That's it — no third-party registries, no cloud credentials. The chart's `appVersion` / image `tag` should match the tag you push (e.g. bump `Chart.yaml` `version`/`appVersion` to `0.1.0` in the commit you tag); the release workflow strips the leading `v` from the tag for the agent binary version.

> Pre-tag dry run: build locally with `docker build -f deploy/server.Dockerfile -t polyptic-server:test .` and `bash deploy/build-agent.sh amd64` to confirm both artifacts build before you ever push a tag.

---

## (d) Self-hosted npm — OPTIONAL, and only if you want it

**You do not need this to deploy Polyptic.** The `@polyptic/*` workspace packages (`@polyptic/protocol`, `@polyptic/server`, `@polyptic/console`, `@polyptic/player`, `@polyptic/agent`) are **internal to the product**: they are wired together inside the monorepo and shipped *as* the Docker image and the depot-served agent binary. You deploy the image and the binary — you never `npm install @polyptic/server` to run Polyptic. So **publishing to any npm registry is entirely optional**, and **nothing is published until you deliberately choose to.**

You'd only want a registry if your org wants to **consume these packages elsewhere** — e.g. a separate internal tool that imports `@polyptic/protocol`'s zod contracts, or you split a package out of the monorepo later. If that day comes, here are the two sane paths.

### Recommended: GitHub Packages (lowest friction)

GitHub Packages gives you an org-scoped private npm registry with **zero new infrastructure** — it's the same GitHub account, same `GITHUB_TOKEN`, same access model as your code and your GHCR images. Recommended unless you specifically need to be off GitHub.

**1.** Add `publishConfig` to each package's `package.json` you want to publish:

```jsonc
// packages/protocol/package.json (and any other @polyptic/* you publish)
{
  "name": "@polyptic/protocol",
  "version": "0.1.0",
  "publishConfig": {
    "registry": "https://npm.pkg.github.com"
  }
}
```

**2.** Add an `.npmrc` that scopes `@polyptic` to GitHub Packages and authenticates. For **publishing in CI**, use the workflow's token via an env var (never hard-code a token in a committed file):

```ini
# .npmrc  (repo root — safe to commit; the token comes from the environment)
@polyptic:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

In the release/publish workflow, set `NODE_AUTH_TOKEN` to a token with `packages: write` (the built-in `GITHUB_TOKEN` works for the package's own org; use a PAT for a different org).

**3.** Publish (per package, once you've bumped the version):

```bash
cd packages/protocol
npm publish        # uses publishConfig.registry + the scoped .npmrc above
# (with bun: bunx npm publish — npm is the registry client either way)
```

**4.** To *consume* a published package from another repo, that repo needs the same `@polyptic:registry=…` line plus a read token (`//npm.pkg.github.com/:_authToken=<PAT-with-read:packages>`), then `npm install @polyptic/protocol` resolves from GitHub Packages.

### Alternative: Verdaccio (full control, off GitHub)

If you want the registry **entirely under your control** — air-gapped, on your own host, no GitHub dependency — run **[Verdaccio](https://verdaccio.org/)**, a lightweight self-hosted npm registry and caching proxy. In one paragraph: `docker run -d -p 4873:4873 -v verdaccio-storage:/verdaccio/storage verdaccio/verdaccio` stands it up; create a user with `npm adduser --registry http://your-host:4873`; point the scope at it with `.npmrc` line `@polyptic:registry=http://your-host:4873`; then `npm publish --registry http://your-host:4873`. Verdaccio transparently proxies the public npm registry for everything *not* under `@polyptic`, so a single registry URL serves both your private scope and public deps. Put TLS + auth in front of it for anything beyond a trusted LAN. This is the right choice when policy forbids storing packages on GitHub; otherwise GitHub Packages is less to operate.

**Either way: this is opt-in.** Until you add `publishConfig` and run `npm publish` (or set up a publish workflow), the `@polyptic/*` packages stay inside the monorepo and ship only as the image and the depot-served agent binary.

---

## See also

- `docs/DEPLOY.md` — the on-device guide (making a box a display; backends; troubleshooting; VM walkthrough).
- `deploy/helm/polyptic/README.md` — full Helm values reference.
- `deploy/.env.example` — annotated server environment.
- `docs/DEV.md` — local dev + bringing up the control plane for testing.
