# Polyptic — distribution & packaging

How Polyptic ships, and how you put it on real infrastructure. This is the **packaging** guide — the artifacts, where they come from, and the exact commands to run them. For turning a bare Linux box into a display see `docs/DEPLOY.md`; for the dev/VM loop see `docs/DEV.md`.

> **Nothing here auto-publishes.** The release workflow only runs when *you* push a `vX.Y.Z` tag, and the image/registry steps need secrets that don't exist until you create them. Read this end-to-end before you cut the first release — you choose when (and whether) anything leaves your machine.

Polyptic is two deployable things plus an optional one:

| What | Artifact | How you install it | Lives where |
|---|---|---|---|
| **Server** (control plane + console + player) | one **Docker image** `ghcr.io/<owner>/polyptic-server` | `docker run` / compose / Helm | your cluster or Docker host |
| **Agent** (per display machine) | the agent **single binary**, baked into the netboot live image at build time | you never install it by hand; it arrives with the image | inside the live image |
| **Netboot** (diskless machine, *no OS install*) | a **live image** + a universal **boot medium** `polyptic-boot.img` (Ubuntu's **signed shim + GRUB**, so **Secure Boot stays ON**), served by the depot (D46/D47) | UEFI HTTP Boot / a USB dongle → the machine streams into RAM | nothing persists on the machine, see [NETBOOT.md](NETBOOT.md) |
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

## (b) The agent — baked into the netboot image, never installed by hand

The per-machine agent is **not** in the server image, and there is **no standalone `.deb`/`.rpm` to
`apt install`**. There is also no `curl … | sh` installer any more: **`GET /install` and the substrate
bundle routes were removed in D58**, superseding D41. A machine becomes a Polyptic display exactly one
way, by **network-booting the live image the control plane serves**:

1. Console → **Settings → Onboard Screens** → **Download bootloader**.
2. Flash `polyptic-boot.img` to a USB stick (2 GB or larger) with Balena Etcher or Rufus.
3. Boot the machine from it, Secure Boot on. It streams the current image into RAM and enrols.

The image already contains the agent binary and the whole kiosk substrate (greetd autologin → sway →
agent → Chromium per output, plus the boot splash), wired at **build** time by `polyptic-agent setup`
running inside the image's chroot. The control-plane address and, in gated mode, the enrolment token
arrive on the kernel command line from the boot menu the server generates per request, so nothing is
typed on the machine and no config file is edited. It dials home and shows **PENDING** in the console
until an operator **Approves** it.

Because a diskless machine re-pulls its whole OS at every boot, "update the agent" and "update the
image" are the same operation, and it is automatic (see **D51** and *Update schedule* in Settings).

The full device story — backends, multi-output placement, crash hardening, troubleshooting, the UTM/VM
walkthrough — is in **`docs/DEPLOY.md`**; the boot chain itself is in **`docs/NETBOOT.md`**.

> **Build the binary yourself** (to seed a depot without building the whole server image, or for an
> arch CI doesn't build): `bash deploy/build-agent.sh amd64` on a host with `bun` produces
> `deploy/dist/polyptic-agent-amd64`. `deploy/build-live-image.sh` picks it up from there when it bakes
> the rootfs, and the server streams it at `GET /dist/agent/<arch>` if you point `AGENT_DIST_DIR` at
> `deploy/dist`.

---

## (b2) The depot internals — what the server serves and how it's baked

For a **machine that can reach ONLY the control plane**, the server itself is the depot: it serves the
boot loaders, the boot menu and the live image, so the machine pulls everything from the one server it
can see and nothing else.

### The artifacts the depot serves (all top-level, ungated, like `/healthz`)

| Route | What | Source on disk |
|---|---|---|
| `GET /boot/grub.cfg` (+ `/grub` aliases) | the generated GRUB menu, with the control-plane base and (gated) the enrolment token baked into the kernel cmdline | generated per request |
| `GET /dist/boot/:file` | the universal `polyptic-boot.img` dongle and the four **signed** loaders (shim + network GRUB, both arches) | `BOOT_DIST_DIR` (default `./deploy/dist/boot`) |
| `GET /dist/image/:arch/{vmlinuz,initrd,rootfs.squashfs}` | the live-image artifacts, Range-streamed into RAM | `IMAGE_DIST_DIR/<arch>/` (default `./deploy/dist/image`) |
| `GET /dist/image/:arch/manifest.json` | the published image id + roll-out urgency, polled every 5 min by every netbooted machine | `IMAGE_DIST_DIR/<arch>/` |
| `GET /dist/agent/:arch` | the prebuilt agent **binary** (`arch` ∈ `arm64`\|`amd64`), streamed; `404` if not bundled. **No boot path fetches this** — the image bakes the binary in. Kept for agent OTA (POL-28) | `AGENT_DIST_DIR/polyptic-agent-<arch>` (default `./deploy/dist`) |

All paths are traversal-safe and 404 cleanly when an artifact is absent.

### How the artifacts get baked in (the server image)

`deploy/server.Dockerfile` is the normal way to fill the depot — no extra steps for the common case:

- **Agent binaries, both arches.** The build stage cross-compiles the agent with `bun build --compile --target=bun-linux-x64` **and** `--target=bun-linux-arm64` into `/app/deploy/dist/polyptic-agent-{amd64,arm64}`. One image build serves every machine, no per-arch build host (Bun bakes the runtime into each binary — see **D7**). `build-live-image.sh` installs the matching one into the live rootfs.
- The runtime stage copies `deploy/dist` and the image-rebuild scripts, and sets `AGENT_DIST_DIR=/app/deploy/dist`.
- **The live image + boot medium** are built by `deploy/build-live-image.sh` and `deploy/build-boot-medium.sh`, on a schedule or from the console's ⋯ menu (**D51/D52/D54**), into `IMAGE_DIST_DIR` / `BOOT_DIST_DIR`.

---

### Dev/lab without Docker

The dev server serves the depot from local files too — build the artifacts and point the server at them:

```bash
bash deploy/build-agent.sh arm64                       # → deploy/dist/polyptic-agent-arm64
bash deploy/build-live-image.sh arm64                  # → deploy/dist/image/arm64/ (Linux build host)
bash deploy/build-boot-medium.sh                       # → deploy/dist/boot/polyptic-boot.img
AGENT_DIST_DIR=deploy/dist bun packages/server/src/index.ts
# then boot a VM from deploy/dist/boot/polyptic-boot.img, or point its UEFI HTTP Boot at
# http://<mac-ip>:8080/dist/boot/shimx64.efi
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
