# Polyptic — Helm chart (control plane / server)

Deploys the **Polyptic server** (the control plane: Fastify REST + three WebSocket
channels on `:8080`) to Kubernetes. This mirrors `deploy/docker-compose.yml`,
`deploy/server.Dockerfile`, and `deploy/.env.example`.

> **Scope.** This chart deploys ONLY the server. The on-device **agent is installed
> per box** from the control-plane depot (`curl -sfL http://SERVER/install | sh -`; D41) —
> it is never run in Kubernetes. Agents connect *out* to the server over a WebSocket; expose
> the server (Ingress / LoadBalancer) so the fleet can reach it.

## TL;DR — install a release (GHCR-hosted)

Every `v*` tag publishes **both halves to GHCR** (`.github/workflows/release.yml`):
the multi-arch server image (`ghcr.io/polyptic/polyptic-server`) and this chart as
an **OCI chart** (also attached to the GitHub Release as a `.tgz`):

```sh
helm install polyptic oci://ghcr.io/polyptic/charts/polyptic --version <x.y.z> \
  --namespace polyptic --create-namespace
```

The chart's `appVersion` is pinned to the same tag, so the default image tag
always matches the release you installed. From a working tree instead (no
release), `helm install polyptic deploy/helm/polyptic …` works the same way.

## K3s quick start

K3s fits this chart unusually well: it **ships Traefik** (so `ingressRoute.*`
works out of the box — the `web`/`websecure` entryPoints below are K3s's
defaults) and its `local-path` StorageClass satisfies both PVCs.

```sh
helm install polyptic oci://ghcr.io/polyptic/charts/polyptic --version <x.y.z> \
  --namespace polyptic --create-namespace \
  --set ingressRoute.enabled=true \
  --set ingressRoute.host=polyptic.your-domain \
  --set ingressRoute.tls.certResolver=letsencrypt \
  --set ingressRoute.bootHost=boot.polyptic.your-domain \
  --set config.corsOrigin=https://polyptic.your-domain \
  --set config.playerBaseUrl=https://polyptic.your-domain \
  --set media.publicBase=https://polyptic.your-domain \
  --set imageUpdates.arch=<amd64|arm64 — your BOXES' arch> \
  --set secrets.bootstrapToken="$(openssl rand -hex 24)" \
  --set secrets.adminEmail=you@example.com \
  --set secrets.adminPassword="$(openssl rand -base64 18)"
```

Two K3s-specific notes:

- **`imageUpdates.arch` must have a matching Linux node** — the rebuild Jobs
  carry a `kubernetes.io/arch` selector *and* a pod-affinity to the server's
  node (the depot PVC is RWO). On a single-node K3s VM that means: the VM's
  arch is the arch you can build images for.
- **The boot path stays plain HTTP.** K3s Traefik listens on :80 (`web`) by
  default, so `bootHost` works immediately; point DNS for both hosts at the VM
  and bake `http://<bootHost>` into your boot media.

## Production install (HTTPS + Ingress + external Postgres)

```sh
helm install polyptic deploy/helm/polyptic \
  --namespace polyptic --create-namespace \
  --set image.repository=ghcr.io/polyptic/polyptic-server \
  --set image.tag=0.1.0 \
  --set ingress.enabled=true \
  --set ingress.className=nginx \
  --set ingress.host=polyptic.example.com \
  --set ingress.tls.enabled=true \
  --set ingress.tls.secretName=polyptic-tls \
  --set config.corsOrigin=https://polyptic.example.com \
  --set config.playerBaseUrl=https://polyptic.example.com \
  --set config.secureCookies=true \
  --set postgresql.enabled=false \
  --set externalDatabase.url='postgres://user:pass@pg.example:5432/polyptic' \
  --set secrets.cookieSecret="$(openssl rand -hex 32)" \
  --set secrets.bootstrapToken="$(openssl rand -hex 24)" \
  --set secrets.adminEmail=ops@example.com \
  --set secrets.adminPassword="$(openssl rand -base64 18)"
```

## Production note (D29 / Phase 3f) — HTTPS + `SECURE_COOKIES=true`

The operator auth gate (Phase 3f) signs an **http-only session cookie**. In any real
deployment you **MUST**:

1. Serve the console over **HTTPS** (Ingress TLS or an upstream terminator), and
2. Set **`config.secureCookies=true`** (renders `SECURE_COOKIES=true`).

A `secure` cookie is only sent back over HTTPS, so an HTTP origin would silently drop
the session and operators could never stay logged in. The chart defaults
`config.secureCookies: true` and `config.nodeEnv: production` for this reason — only
flip them off for a throwaway HTTP/dev cluster. Likewise set a strong
`secrets.cookieSecret`; if you leave it empty the chart generates one and preserves it
across upgrades, but a managed value is required for reproducible/GitOps installs.

`config.authEnabled` defaults to `true`. **Never** set it false on a reachable
deployment — that leaves every `/api/v1` route and the `/admin` WS unprotected (it
exists only so the e2e suite can run with `AUTH_ENABLED=false`).

## Health, metrics, and the auth gate

`/healthz` and `/metrics` are **top-level (NOT `/api/v1`)** so they are UNgated for
liveness probes and Prometheus scrapers, even with the auth gate on:

- **Readiness + liveness** probes both hit `/healthz` (see `values.yaml` →
  `readinessProbe` / `livenessProbe`).
- **Prometheus** scrape annotations for `/metrics` are added to the pod template when
  `metrics.enabled=true` (`prometheus.io/scrape|path|port`).

## Media uploads (Phase 7)

Operators can **upload** images/videos (`POST /api/v1/media`, gated) as well as
**link** external media URLs (Phase 3c). Uploads are streamed to a **disk volume**
(Polyptic does **not** use object storage) and served back, **ungated**, from the
top-level `GET /media/:id` with **HTTP Range** support (so video can seek) — exactly
like any external content URL, so a player on another host can fetch them without a
session.

The server reads three env vars (rendered into the ConfigMap):

- `MEDIA_DIR` — where uploads are written. Backed by the media volume below.
- `MEDIA_PUBLIC_BASE` — absolute base URL prepended to `/media/<id>` when an upload
  becomes a `ContentSource.url`. **Must be reachable by the players/public wall** —
  set it to your public origin (normally the same HTTPS host as `playerBaseUrl`).
- `MEDIA_MAX_BYTES` — max accepted upload size, in bytes (default ~200MB).

`media.persistence.enabled=true` (default) backs `MEDIA_DIR` with a
**PersistentVolumeClaim** (`templates/pvc.yaml`, annotated `resource-policy: keep` so
uploads survive `helm uninstall`); set it `false` to use an ephemeral `emptyDir`
(uploads lost on restart — dev only), or point `media.persistence.existingClaim` at a
PVC you manage yourself.

```sh
# Example: 50Gi media PVC on a named StorageClass, public origin set.
helm install polyptic deploy/helm/polyptic \
  --set media.publicBase=https://polyptic.example.com \
  --set media.persistence.size=50Gi \
  --set media.persistence.storageClass=fast-rwo
```

## Traefik IngressRoutes: stable names, no more baked IPs

On a Traefik cluster, prefer `ingressRoute.enabled=true` over the generic Ingress
(enable one, not both). It creates **two routers**:

- **`ingressRoute.host`** (HTTPS, `websecure`, `certResolver` or `secretName`) —
  console + player + REST + all three WebSocket channels. Deliberately **one
  same-origin host**: the operator session is an http-only cookie, so splitting
  console/api across subdomains would break sign-in. Traefik proxies the
  WebSockets natively.
- **`ingressRoute.bootHost`** (plain HTTP, `web`) — the boot depot only
  (`/boot`, `/grub`, `/dist`, `/install`), because shim/GRUB/casper have no TLS
  stack. **This is the address you bake into boot media**:

```sh
POLYPTIC_BASE=http://boot.polyptic.example.com deploy/build-boot-medium.sh
POLYPTIC_BASE=http://boot.polyptic.example.com POLYPTIC_TOKEN=… BASE_ISO=… deploy/build-live-iso.sh arm64
```

Media bake their control-plane address at build time — dongles, offloaded disks,
and live ISOs all go stale the moment a bare-IP server moves (see NETBOOT.md's
troubleshooting section for the symptoms). A stable `bootHost` name ends that
class of failure: the control plane can move freely behind the name. One caveat
carried over from D47: GRUB resolves DNS fine, but casper's busybox `wget` is
more reliable with IPs on some releases — verify a name-based boot on your
target release before a fleet-wide rollout.

```sh
helm upgrade --install polyptic deploy/helm/polyptic \
  --set ingressRoute.enabled=true \
  --set ingressRoute.host=polyptic.example.com \
  --set ingressRoute.tls.certResolver=letsencrypt \
  --set ingressRoute.bootHost=boot.polyptic.example.com \
  --set config.corsOrigin=https://polyptic.example.com \
  --set config.playerBaseUrl=https://polyptic.example.com \
  --set media.publicBase=https://polyptic.example.com
```

## Netboot depot + automated image updates (POL-33…43)

The server serves the netboot artifacts — the live image (`GET /dist/image/<arch>/…`)
and the signed boot loaders (`GET /dist/boot/<file>`) — from a **depot volume**
(`netboot.persistence`, PVC by default, `helm.sh/resource-policy: keep`). GRUB and
casper speak **plain HTTP**: netbooting boxes must reach the server over `http://`
(a LoadBalancer/NodePort on the management LAN), not the HTTPS Ingress. Console and
players keep using HTTPS; only the boot path is http-by-contract.

With `imageUpdates.enabled=true` (default) the chart wires the two POL-41/POL-43
update cycles **Kubernetes-natively** — the server keeps its scheduler and the
console keeps its buttons, but the hook commands create privileged **Jobs** instead
of running docker:

| Cycle | Default | What it does |
| --- | --- | --- |
| Nightly refresh (`IMAGE_REBUILD_CMD` → `bun deploy/k8s-run-job.ts refresh`) | 01:00 | In-place `apt upgrade` of the existing image (kernel held, D47). Exits untouched when there is nothing to upgrade — no image-id churn, no pointless fleet reboots. |
| Weekly full rebuild (`IMAGE_FULL_REBUILD_CMD` → `bun deploy/k8s-run-job.ts full`) | Sundays 02:00 | Rebuild from the base ISO (`imageUpdates.baseIsoUrl`, default the official Ubuntu `imageUpdates.ubuntuRelease` live-server ISO, downloaded once and cached on the depot volume). **This is the cycle that rolls kernel CVEs.** |

How a rebuild runs: the server POSTs a Job rendered from the
`<fullname>-rebuild-jobs` ConfigMap, waits, and relays the log tail to
Console ▸ Settings ▸ Image updates. The Job's initContainer copies the rebuild
scripts **out of the server image** (version-locked; nothing is duplicated into the
chart), and the build itself runs privileged (chroot + loop mounts) in a plain
`imageUpdates.jobImage` container on a Linux node of `imageUpdates.arch`. Because
the depot PVC is ReadWriteOnce, the Jobs carry a required pod-affinity to the
server's node; RWX storage lifts that constraint. Finished Jobs are GC'd after
`imageUpdates.ttlSecondsAfterFinished`.

RBAC (namespace-scoped, created by the chart): `jobs` create/get, `pods` list,
`pods/log` get — no delete, no exec, no secrets.

**Day-0 bootstrap:** the depot starts empty. Click **Full rebuild now** in
Console ▸ Settings ▸ Image updates (or wait for Sunday) — the Job downloads the
base ISO and publishes the first image straight onto the depot volume. For the
signed loaders, build the boot medium once on any machine
(`POLYPTIC_BASE=http://<server-lan> deploy/build-boot-medium.sh`) and copy it in:
`kubectl cp deploy/dist/boot <pod>:/var/lib/polyptic/depot/`.

## Dev workflow (local cluster)

Keep the fast inner loop **on the host** (`bun run dev` — sub-second, no images).
Use the chart for the integration ring on OrbStack / Docker Desktop Kubernetes /
kind:

```sh
# once per code change you want in-cluster (chart-only changes skip this):
docker build -f deploy/server.Dockerfile -t polyptic-server:dev .
# kind only: kind load docker-image polyptic-server:dev

# every chart/values iteration (seconds, no image build):
helm upgrade --install polyptic deploy/helm/polyptic \
  -f deploy/helm/polyptic/values-dev.yaml \
  --namespace polyptic --create-namespace

kubectl -n polyptic port-forward svc/polyptic 8080:8080   # http://localhost:8080
```

`values-dev.yaml` uses the local `polyptic-server:dev` image (`pullPolicy: Never`),
an in-memory store, plain-HTTP cookies, a seeded `dev@example.com` operator, and
keeps the depot PVC (a full rebuild caches the ~3GB base ISO — don't redo it per
pod roll). Note the bonus: your cluster's nodes are **Linux**, so the image
rebuild Jobs work here even though the host is macOS.

## Database options

| Goal | Settings |
| --- | --- |
| In-cluster Postgres (default) | `postgresql.enabled=true` — `DATABASE_URL` is derived from the subchart automatically. |
| External / managed Postgres | `postgresql.enabled=false` + `externalDatabase.url=postgres://…` |
| Pre-made Secret (GitOps) | `secrets.existingSecret=my-secret` with keys `COOKIE_SECRET`, `POLYPTIC_BOOTSTRAP_TOKEN`, `POLYPTIC_ADMIN_EMAIL`, `POLYPTIC_ADMIN_PASSWORD`, `DATABASE_URL`. |
| Ephemeral (dev only) | `config.store=memory`, `postgresql.enabled=false` — registry lost on restart. |

## Key values

| Key | Default | Notes |
| --- | --- | --- |
| `image.repository` / `image.tag` | `ghcr.io/polyptic/polyptic-server` / `""` (→ appVersion) | Server image. |
| `replicaCount` | `1` | Single-writer control plane; keep at 1. |
| `service.type` / `service.port` | `ClusterIP` / `8080` | Container always listens on `containerPort` (8080). |
| `ingress.enabled` / `.host` / `.tls.enabled` / `.tls.secretName` | `false` / `polyptic.example.com` / `false` / `polyptic-tls` | HTTPS in prod. |
| `config.store` | `postgres` | `postgres` or `memory`. |
| `config.corsOrigin` | `https://polyptic.example.com` | Comma-separated browser origins (cookies are cross-origin). |
| `config.authEnabled` | `true` | The Phase 3f gate. Keep true. |
| `config.secureCookies` | `true` | HTTPS-only cookies — see production note. |
| `config.captureIntervalMs` | `""` | Live-preview capture cadence (server default when empty). |
| `secrets.cookieSecret` | `""` (generated) | Session signing key. |
| `secrets.bootstrapToken` | `""` (OPEN) | Set for gated agent enrollment. |
| `secrets.adminEmail` / `secrets.adminPassword` | `""` | Seed operator on first boot. |
| `metrics.enabled` | `true` | Prometheus scrape annotations for `/metrics`. |
| `media.dir` | `/var/lib/polyptic/media` | `MEDIA_DIR` — upload dir + media volumeMount path. |
| `media.publicBase` | `https://polyptic.example.com` | `MEDIA_PUBLIC_BASE` — must be player-reachable. |
| `media.maxBytes` | `209715200` | `MEDIA_MAX_BYTES` — max upload size (~200MB). |
| `media.persistence.enabled` | `true` | Back `MEDIA_DIR` with a PVC (else ephemeral emptyDir). |
| `media.persistence.size` / `.storageClass` / `.existingClaim` | `20Gi` / `""` / `""` | Media PVC sizing/class, or bring your own claim. |
| `postgresql.enabled` | `true` | Bitnami Postgres subchart toggle. |
| `externalDatabase.url` | `""` | Used when `postgresql.enabled=false`. |

## Render / lint locally

```sh
helm dependency update deploy/helm/polyptic
helm lint deploy/helm/polyptic
helm template polyptic deploy/helm/polyptic --namespace polyptic
```

## Uninstall

```sh
helm uninstall polyptic --namespace polyptic
```

The chart-managed Secret carries `helm.sh/resource-policy: keep` so a generated
`COOKIE_SECRET` survives a reinstall — delete it manually if you want a clean slate.
