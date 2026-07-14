# Polyptic — Helm chart (control plane / server)

Deploys the **Polyptic server** (the control plane: Fastify REST + three WebSocket
channels on `:8080`) to Kubernetes. This mirrors `deploy/docker-compose.yml`,
`deploy/server.Dockerfile`, and `deploy/.env.example`.

> **Scope.** This chart deploys the server **and its database** (a bundled Postgres,
> on by default — POL-123/D108; point it at your own with `postgresql.enabled=false` +
> `externalDatabase.url`). There is no companion manifest to apply first: `helm install
> polyptic … -f values.yaml` is the whole deployment. The on-device **agent is installed
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
- **One hostname is enough (POL-70/D89).** `ingressRoute.host` derives
  `PUBLIC_BASE_URL`, `CORS_ORIGIN`, `PLAYER_BASE_URL` and `MEDIA_PUBLIC_BASE`
  as `https://<host>` automatically — set `config.publicBaseUrl` (or the
  individual values) only when they genuinely differ.
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
  --set ingress.tls.secretName=polyptic-tls \
  --set postgresql.enabled=false \
  --set externalDatabase.url='postgres://user:pass@pg.example:5432/polyptic' \
  --set secrets.cookieSecret="$(openssl rand -hex 32)" \
  --set secrets.bootstrapToken="$(openssl rand -hex 24)" \
  --set secrets.adminEmail=ops@example.com \
  --set secrets.adminPassword="$(openssl rand -base64 18)"
```

## Production note (D29 / Phase 3f, POL-70 / D88) — HTTPS is the default

The operator auth gate (Phase 3f) signs an **http-only session cookie**, and serving it
over TLS is the chart's default posture (POL-70/D89):

- **Enabling an ingress means TLS.** `ingress.tls.enabled` defaults **true** (the
  Ingress references `ingress.tls.secretName` — pre-provisioned, or filled by
  cert-manager via `ingress.annotations`, e.g.
  `cert-manager.io/cluster-issuer: letsencrypt-prod`). The Traefik `ingressRoute.host`
  router is https (`websecure`) by design.
- **One hostname derives everything.** The enabled ingress host (or an explicit
  `config.publicBaseUrl`) becomes `PUBLIC_BASE_URL` plus the defaults for
  `CORS_ORIGIN`, `PLAYER_BASE_URL` and `MEDIA_PUBLIC_BASE` — all https.
- **Cookie security is automatic.** `config.secureCookies` defaults to `""` (auto):
  the server marks the session cookie `Secure` when `PUBLIC_BASE_URL` is https. A
  `Secure` cookie is only sent back over HTTPS, so an HTTP origin would silently drop
  the session and operators could never stay logged in (POL-43) — which is why a
  *declared* plain-http deployment (`ingress.tls.enabled=false`, or an `http://`
  publicBaseUrl) automatically drops the flag and the server warns loudly at boot
  instead of breaking login. Plain HTTP is a supported degrade for trusted lab LANs,
  never the recommended posture.

Likewise set a strong `secrets.cookieSecret`; if you leave it empty the chart
generates one and preserves it across upgrades, but a managed value is required for
reproducible/GitOps installs.

`config.authEnabled` defaults to `true`. **Never** set it false on a reachable
deployment — that leaves every `/api/v1` route and the `/admin` WS unprotected (it
exists only so the e2e suite can run with `AUTH_ENABLED=false`).

## Let's Encrypt (POL-70/D89) — real certificates from one email

For a public hostname, skip manual secrets entirely:

```sh
helm dependency build deploy/helm/polyptic   # once per checkout (the subchart is vendored; this verifies it)
helm install polyptic deploy/helm/polyptic \
  --set ingress.enabled=true \
  --set ingress.host=polyptic.example.com \
  --set letsEncrypt.enabled=true \
  --set letsEncrypt.email=ops@example.com
```

`letsEncrypt.enabled` condition-installs the **vendored cert-manager subchart** and renders
an ACME `Issuer` plus a `Certificate` that writes the exact TLS secret the Ingress already
references (`ingress.tls.secretName`) — HTTPS then Just Works and auto-renews. Requirements:
the host resolves publicly and :80 reaches this cluster's ingress (http01 solver;
`letsEncrypt.solverIngressClass` defaults to `traefik` for K3s, set `nginx` where relevant).
Use `letsEncrypt.staging=true` to test the challenge path against the staging endpoint
(untrusted certs, generous rate limits) before flipping to production. Extra hostnames go on
`letsEncrypt.additionalDnsNames`. On a Traefik IngressRoute deployment set
`ingressRoute.tls.secretName` (NOT `certResolver` — that is Traefik's own ACME) and the
Certificate targets it. If the cluster already runs cert-manager, keep `letsEncrypt.enabled`
off and copy `templates/lets-encrypt.yaml`'s two resources instead of double-installing.

## Self-signed TLS (POL-70/D89) — HTTPS with no certificate infrastructure

For a homelab with no public DNS and no cert-manager:

```sh
helm install polyptic deploy/helm/polyptic \
  --set tls.mode=self-signed \
  --set service.type=NodePort \
  --set config.publicBaseUrl=https://walls.home:30080
```

The server mints its own CA + certificate (SANs: the derived public host, the in-cluster
Service DNS names, `tls.sans`, plus localhost + the pod hostname), **persists them in the
store, and reuses them across restarts** — operators download the CA once from
**Console ▸ Settings ▸ HTTPS** (fingerprint shown for verification, per-OS trust
instructions in the card) and every device stays green from then on. The chart flips the
health probes to HTTPS (kubelet skips certificate verification). **Exposure:** reach the pod
directly (`service.type=NodePort`/`LoadBalancer`) — an ingress in front of an HTTPS pod
needs re-encryption config this chart deliberately doesn't ship; if you have an ingress,
`letsEncrypt` or a provided secret is the better answer. Not combinable with
`letsEncrypt.enabled` (one terminates in the pod, the other at the ingress).

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
  derived from the public origin (`config.publicBaseUrl` / the ingress host,
  POL-70/D89); set `media.publicBase` only when it genuinely differs.
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
  (`/boot`, `/grub`, `/dist`, `/install`), because shim and GRUB have no TLS
  stack. **This is the address you bake into boot media**:

```sh
POLYPTIC_BASE=http://boot.polyptic.example.com deploy/build-boot-medium.sh
POLYPTIC_BASE=http://boot.polyptic.example.com POLYPTIC_TOKEN=… BASE_ISO=… deploy/build-live-iso.sh arm64
```

Media bake their control-plane address at build time — dongles, offloaded disks,
and live ISOs all go stale the moment a bare-IP server moves (see NETBOOT.md's
troubleshooting section for the symptoms). A stable `bootHost` name ends that
class of failure: the control plane can move freely behind the name. (D47's caveat
about the casper initrd's busybox `wget` preferring IPs to names retired with
casper itself in D55: dracut's initramfs fetches the root image with `curl`.)

```sh
helm upgrade --install polyptic deploy/helm/polyptic \
  --set ingressRoute.enabled=true \
  --set ingressRoute.host=polyptic.example.com \
  --set ingressRoute.tls.certResolver=letsencrypt \
  --set ingressRoute.bootHost=boot.polyptic.example.com
```

(`ingressRoute.host` also derives `PUBLIC_BASE_URL`, `CORS_ORIGIN`,
`PLAYER_BASE_URL` and `MEDIA_PUBLIC_BASE` as `https://<host>` — POL-70/D89.)

## Netboot depot + automated image updates (POL-33…43)

The server serves the netboot artifacts — the live image (`GET /dist/image/<arch>/…`)
and the signed boot loaders (`GET /dist/boot/<file>`) — from a **depot volume**
(`netboot.persistence`, PVC by default, `helm.sh/resource-policy: keep`). shim and
GRUB speak **plain HTTP**: netbooting boxes must reach the server over `http://`
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

**Day-0 bootstrap:** the **boot medium** (signed loaders + `polyptic-boot.img`)
is built automatically by a per-revision Job whenever the chart knows the
address to bake (`imageUpdates.bakeBase`, defaulting to
`http://<ingressRoute.bootHost>`) and the depot is persistent — the Console's
bootloader download is live from minute one, and a `bootHost` change re-bakes
it on the next `helm upgrade` (opt out: `netboot.autoBuildMedium=false`). The
image depot itself starts empty: click **Full rebuild now** in Console ▸
Settings (or wait for Sunday) — the Job builds the rootfs from `ubuntu-base`
and publishes the netboot image plus the **downloadable live ISO** (enrolment
token baked in) straight onto the depot volume. Without a bake address the
Jobs publish only the netboot image. The nightly refresh keeps the live ISO in
step with the payload.

**The medium and Wi-Fi fleets (POL-63/POL-69):** the Job reads the local
Wi-Fi payload (kernel + `initrd-wifi`) straight off the depot volume and
lifts the **current enrolment token** from the server's own `/boot/grub.cfg`
(via the in-cluster service), baking both into the image — so the downloaded
stick boots Wi-Fi-only screens on a gated fleet, and a token rotated in the
Console is picked up by the next re-bake with no chart value to keep in sync.
Two consequences: on a gated fleet the downloadable `.img` is a **credential**
(same trust model as the live ISO), and after rotating the token you re-run
the Job (`helm upgrade` suffices) and re-flash Wi-Fi sticks — wired sticks
don't carry it and don't care. Before the first full rebuild the depot has no
payload, so the Job builds the LEAN wired-only medium and says so; the next
`helm upgrade` after an image build re-bakes it in full.

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

## Database — the chart brings its own (POL-123 / D108)

**`helm install` is the whole deployment.** `postgresql.enabled` defaults to **true** and the chart
deploys Postgres itself — a first-party StatefulSet + Service (`templates/postgres.yaml`,
`postgres:16-alpine`), *not* a subchart, with `DATABASE_URL` wired to it automatically. There is no
companion manifest to apply first.

> Until POL-123 the `postgresql.*` values were a **lie**: they advertised a bundled database the
> chart had never implemented (no dependency, no template). The shipped default — `store: postgres`,
> `postgresql.enabled: false`, an empty `externalDatabase.url` — installed cleanly and then
> crash-looped the server on `getaddrinfo ENOTFOUND`. That combination is now **refused at template
> time**, with a message telling you what to set.

| Goal | Settings |
| --- | --- |
| **Bundled Postgres (default)** | nothing — `postgresql.enabled=true`; the password is generated and preserved, `DATABASE_URL` is derived. |
| External / managed Postgres | `postgresql.enabled=false` + `externalDatabase.url=postgres://…` |
| Pre-made Secret (GitOps) | `postgresql.enabled=false` + `secrets.existingSecret=my-secret` with keys `COOKIE_SECRET`, `POLYPTIC_BOOTSTRAP_TOKEN`, `POLYPTIC_ADMIN_EMAIL`, `POLYPTIC_ADMIN_PASSWORD`, `DATABASE_URL`. |
| Bundled DB, your own password Secret | `postgresql.auth.existingSecret=my-db-secret` (+ `.existingSecretPasswordKey`, default `POSTGRES_PASSWORD`). |
| Ephemeral (dev only) | `config.store=memory` — no database is deployed at all. |

**Credentials.** Leave `postgresql.auth.password` empty (the default): the chart generates a random
32-char password on first install, stores it in its own Secret as `POSTGRES_PASSWORD`, and preserves
it across `helm upgrade` (the same lookup pattern as `secrets.cookieSecret`). The password is never
baked into a rendered connection string — it is injected into the server pod as an env var and
expanded into `DATABASE_URL` by the kubelet.

**Data.** `postgresql.persistence` is on by default (8Gi, cluster-default StorageClass). The claim
comes from the StatefulSet's `volumeClaimTemplate` — `data-<release>-db-0` — which Kubernetes and
Helm both leave alone: **`helm uninstall` does not delete your registry**; `kubectl delete pvc` does.

**Pre-flight refusals.** The chart `fail`s at template time rather than render a database config that
cannot work: both a bundled and an external database configured; `store=postgres` with neither; an
unknown `config.store`.

### Upgrading from the hand-rolled `polyptic-db` manifest

If you have been applying your own PVC + StatefulSet + Service (named `polyptic-db`) alongside the
chart, adopt the data instead of re-creating it:

```sh
kubectl -n polyptic delete statefulset polyptic-db --cascade=orphan   # keep the PVC + the data
helm upgrade polyptic … \
  --set postgresql.enabled=true \
  --set postgresql.persistence.existingClaim=<your-pvc-name> \
  --set postgresql.auth.password='<the password your DATABASE_URL used>'
# and REMOVE externalDatabase.url from your values (the chart refuses both at once).
```

The bundled Service is also named `polyptic-db` for a release called `polyptic`, so any
`DATABASE_URL` you had pointing at it keeps resolving. Alternatively keep your manifest and set
`postgresql.enabled=false` + `externalDatabase.url` — that posture is still fully supported.

## Key values

| Key | Default | Notes |
| --- | --- | --- |
| `image.repository` / `image.tag` | `ghcr.io/polyptic/polyptic-server` / `""` (→ appVersion) | Server image. |
| `replicaCount` | `1` | Single-writer control plane; keep at 1. |
| `service.type` / `service.port` | `ClusterIP` / `8080` | Container always listens on `containerPort` (8080). |
| `ingress.enabled` / `.host` / `.tls.enabled` / `.tls.secretName` | `false` / `polyptic.example.com` / **`true`** / `polyptic-tls` | Enabling the ingress means TLS unless you opt out (POL-70/D89); cert-manager via `ingress.annotations`. |
| `config.store` | `postgres` | `postgres` or `memory`. |
| `config.publicBaseUrl` | `""` (derived from the enabled ingress host) | The ONE public origin → `PUBLIC_BASE_URL` + the defaults below (POL-70/D89). |
| `config.corsOrigin` | `""` (derived) | Comma-separated browser origins (cookies are cross-origin). |
| `config.playerBaseUrl` | `""` (derived) | Origin the wall boxes open; the chart appends `/player`. |
| `config.authEnabled` | `true` | The Phase 3f gate. Keep true. |
| `config.secureCookies` | `""` (auto) | Secure follows `PUBLIC_BASE_URL`'s scheme, else `NODE_ENV` — see production note. |
| `config.captureIntervalMs` | `""` | Live-preview capture cadence (server default when empty). |
| `tls.mode` / `tls.sans` | `""` / `[]` | `self-signed` → server-native TLS with a persisted, downloadable CA (see the self-signed section). |
| `letsEncrypt.enabled` / `.email` / `.staging` / `.additionalDnsNames` / `.solverIngressClass` | `false` / `""` / `false` / `[]` / `traefik` | Real ACME certificates via the vendored cert-manager subchart (see the Let's Encrypt section). |
| `secrets.cookieSecret` | `""` (generated) | Session signing key. |
| `secrets.bootstrapToken` | `""` (OPEN) | Set for gated agent enrollment. |
| `secrets.adminEmail` / `secrets.adminPassword` | `""` | Seed operator on first boot. |
| `metrics.enabled` | `true` | Prometheus scrape annotations for `/metrics`. |
| `media.dir` | `/var/lib/polyptic/media` | `MEDIA_DIR` — upload dir + media volumeMount path. |
| `media.publicBase` | `""` (derived) | `MEDIA_PUBLIC_BASE` — must be player-reachable. |
| `media.maxBytes` | `209715200` | `MEDIA_MAX_BYTES` — max upload size (~200MB). |
| `media.persistence.enabled` | `true` | Back `MEDIA_DIR` with a PVC (else ephemeral emptyDir). |
| `media.persistence.size` / `.storageClass` / `.existingClaim` | `20Gi` / `""` / `""` | Media PVC sizing/class, or bring your own claim. |
| `postgresql.enabled` | **`true`** | Deploy the bundled Postgres StatefulSet (POL-123/D108). |
| `postgresql.image.repository` / `.tag` | `postgres` / `16-alpine` | Bundled database image. |
| `postgresql.auth.username` / `.database` / `.password` | `polyptic` / `polyptic` / `""` (generated + preserved) | Bundled DB credentials. |
| `postgresql.auth.existingSecret` / `.existingSecretPasswordKey` | `""` / `POSTGRES_PASSWORD` | Bring your own password Secret. |
| `postgresql.persistence.enabled` / `.size` / `.storageClass` / `.existingClaim` | `true` / `8Gi` / `""` / `""` | Data volume; `existingClaim` adopts a PVC you already have. |
| `postgresql.resources` | 100m/256Mi → 1/1Gi | Bundled DB resources. |
| `externalDatabase.url` | `""` | Your own Postgres. Requires `postgresql.enabled=false` (both at once is refused). |

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
`COOKIE_SECRET` (and the bundled database's password) survives a reinstall — delete it
manually if you want a clean slate. The database's own PVC (`data-<release>-db-0`) also
survives: uninstalling a release must not destroy a wall's registry. To wipe it:

```sh
kubectl -n polyptic delete pvc data-polyptic-db-0
```
