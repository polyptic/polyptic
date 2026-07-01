# Polyptic

> A **polyptic** is a multi-panel painting whose panels together compose one picture — exactly what a wall of screens is.

**Polyptic is a generic, self-hostable system for centrally orchestrating walls of screens and fleets of display kiosks from a web console.** Named screens, a drag-and-drop spatial canvas, combined video-wall surfaces, a reusable content library (linkable **or** uploaded media), preset **scenes**, live preview, a live activity feed, real local-account auth, a REST/WebSocket API, and zero-click cold boot. It is **vendor-neutral**: any web content, dashboard, image or video; runs on any Kubernetes cluster or plain Docker host; the edge boxes are stock Ubuntu.

It replaces the all-too-common pattern of "a fragile per-machine boot script that clicks here, waits, opens a browser, and types a password in plaintext" with one declarative control plane and thin reconciling agents.

> This repo is the **product**. It has **no dependency on any specific stack** — dashboards, identity providers and content sources are optional adapters behind stable seams, never foundations.

---

## Core ideas

- **Screens, not machines.** You drive *named screens* ("Nessie", "Bertha"). A client machine is just plumbing — "this box owns these outputs." An **ident mode** flashes each screen's name on its physical panel so onboarding is point-and-confirm, never remote-desktop-and-guess.
- **One global layout, reconciled.** The control plane holds a single spatial layout ("murals") + named **scenes**; each agent renders only *its* slice. Same desired-state reconcile loop as a Kubernetes controller — the fleet is **one consistent system, not N isolated kiosks**, by construction.
- **Instant.** Content changes propagate over WebSocket and patch the player's DOM **in place — no reload** (the iframe/img/video source swaps, no white flash). Snappy enough to demo to stakeholders.
- **Buy the substrate, build the brain.** The device stack (Ubuntu + `sway`/`greetd`/`systemd` + Chromium kiosk) is standard and borrowed wholesale. Only the global-layout + scenes + content library + API + console are ours.
- **Outbound-only agents, air-gappable edge.** Clients dial out to the control plane; no inbound ports. The control plane is also the **provisioning depot** — an edge box can install everything from the server with `curl … | sh`, no internet required (see *Provisioning*).

## Quickstart (local dev)

```bash
bun install
bun run db:up                                 # Postgres in Docker (or use STORE=memory to skip it)
POLYPTIC_OUTPUTS="HDMI-1,HDMI-2" bun run dev   # console :5175 · server :8080 · player :5173 · a dev agent
```
Open **http://localhost:5175**, sign in (dev default `operator@polyptic.local` / `polyptic-admin`, prefilled), approve the dev machine under **Machines**, drag its screens onto the canvas, and open a player tab per screen at `http://localhost:5173/?screen=<id>`. Drop a URL or library source on a screen and watch it swap live. `bun run test` runs the suite; `bun run ui-smoke` runs the browser smoke check.

## Architecture

```
                  ┌──────────────────────────────────────────────┐
                  │  @polyptic/server   (control plane · :8080)   │
                  │  Bun · Fastify · Postgres · ws · zod          │
                  │   • registry: machines · screens · outputs    │
                  │   • murals · placements · combined surfaces   │
                  │   • content library · scenes · media on disk  │
                  │   • REST + 3 WS channels · /healthz · /metrics │
                  │   • serves the console + player SPAs           │
                  │  runs on any Kubernetes OR Docker host         │
                  └───────────────▲──────────────▲────────────────┘
                       outbound    │   ws(s)://    │   outbound
              ┌────────────────────┘              └────────────────────┐
     ┌────────┴───────────┐                              ┌─────────────┴──────┐
     │  Display client A  │   (machine = plumbing)        │  Display client C  │
     │  Ubuntu + sway     │            ...                │  Ubuntu + x11/i3   │
     │  polyptic-agent    │  reconciles its slice via     │  polyptic-agent    │
     │  Chromium per out  │  swaymsg / xrandr + player    │  Chromium per out  │
     │ ┌────────┬────────┐│                              │ ┌────────┬────────┐ │
     │ │ Screen │ Screen ││                              │ │  ...   │  ...   │ │
     │ └────────┴────────┘│                              │ └────────┴────────┘ │
     └────────────────────┘                              └─────────────────────┘

   Operator's browser ── REST /api/v1 + WS /admin (session-gated) ──► the console
```

### Components
| component | tech | role |
|---|---|---|
| `@polyptic/server` | Bun · Fastify · `ws` · Postgres (porsager) · `zod` | source of truth: registry, murals/placement, combined surfaces, content library, scenes, media; REST + WS (`/agent`, `/player`, `/admin`); local auth; `/healthz` + Prometheus `/metrics`; serves both SPAs |
| `@polyptic/console` | **Vue 3 · Vite · Vue Router · Pinia · Vue Flow** | the operator UI: spatial **Wall** canvas, content library, scenes, machines + cold-start wizard, settings, live activity feed |
| `@polyptic/player` | **Vue 3 · Vite** | per-screen renderer; draws its slice of typed surfaces, including a video-wall **span** of one piece of content across panels; in-place updates |
| `@polyptic/agent` | **Bun single binary** (served by the control-plane depot) | outbound WS, reconciles its slice, drives `sway` (`swaymsg`) or `x11/i3`, launches Chromium-per-output, captures `grim`/`scrot` preview thumbnails |
| `@polyptic/protocol` | `zod` | the shared contract — every cross-process message is defined and validated here |

### Device stack (each display client)
Ubuntu Server-minimal → `greetd` passwordless autologin (`kiosk`) → **`sway`** (Wayland; `x11`/`i3` fallback for NVIDIA) with outputs pinned by connector → `systemd`-supervised agent + one Chromium `--app` per output (own `--user-data-dir`, popup-suppression flags, `exit_type` reset so a power cut never shows "Restore pages"). No idle/blank; `output * dpms on`. **Zero clicks, zero sleeps, zero typed passwords.**

### Content model
Reusable **`ContentSource`** library entries — `web` · `dashboard` · `image` · `video` — that are **linkable (a URL) or uploaded** (stored on a disk volume, served with HTTP Range so video seeks). Assign a source to a screen or a combined surface by **drag-and-drop** or the inspector; a source assigned to a video wall **spans** across its member panels. Editing a library source re-pushes live to every screen showing it. (Office docs → pre-convert to image/video; framing-hostile sites are a known web limitation — use embed-friendly URLs or the kiosk's trusted-content flags.)

### Auth
- **Operator console / API:** **local accounts**, done properly — argon2id password hashing (Bun's built-in), signed **HTTP-only** session cookies (secure over HTTPS), per-email + per-IP login **rate-limiting/lockout**, anti-CSWSH origin checks. Every `/api/v1/**` route and the `/admin` WebSocket are session-gated by default (`AUTH_ENABLED`); the device channels (`/agent`, `/player`) and `/healthz`,`/metrics`,`/media` are not. **OIDC/SSO** is a planned add-on on the same seam.
- **Agent ↔ server:** a one-time **bootstrap token** (gated mode) → the machine appears *pending* → an operator **approves** it → a durable per-machine credential (the server stores only its `sha256`). Open mode auto-approves for dev, loudly. No inbound ports.

### Live preview, health & activity
Per-output **JPEG thumbnails** (`grim`/`scrot`) flow up the agent channel and paint the actual render onto each tile in the console. `GET /healthz` + a hand-rolled Prometheus `GET /metrics` (build info, revision, agents/players/machines/screens). A **Live Activity feed** streams notable events (machine connected/unreachable, screen approved, content assigned, scene applied, combine/split/rename).

## Provisioning the edge (air-gappable)

The control plane *is* the depot — an edge box needs to reach **only your server**:

```bash
# agent only — fully air-gapped (the box never touches the internet):
curl -sfL http://CONTROL_PLANE:8080/install | POLYPTIC_TOKEN=<token> sh -

# full kiosk — substrate (sway/greetd/Chromium) from the server's bundle,
# falling back to the distro's package manager only on an un-bundled distro with internet:
curl -sfL http://CONTROL_PLANE:8080/install | POLYPTIC_TOKEN=<token> sh -s -- --kiosk
```

The script bakes in the control-plane URL from the host you curled and downloads the agent binary from the server (`GET /dist/agent/<arch>`). The server bundles the substrate `.deb`s for a supported distro (Ubuntu latest); `--kiosk` prefers that bundle and only reaches the internet when the box is on a distro you haven't bundled. This depot one-liner is the **only** way to install an agent — there is no standalone `.deb`/`.rpm` to `apt install` (D41). See `docs/DEPLOY.md`.

Once provisioned, a box **dials in and waits to be approved**. The operator journey from there —
**enrol → approve → ident the panels to name them → place on a mural → assign content** — is point-and-confirm (a guided **Cold-start wizard** in the console walks you through it). Full step-by-step:
**[`docs/ONBOARDING.md`](docs/ONBOARDING.md)**.

## Deploy / Distribution
See **[`docs/DISTRIBUTION.md`](docs/DISTRIBUTION.md)** for the full packaging story.

- **Server** — one **Docker image** (`ghcr.io/<owner>/polyptic-server`) bundling the control plane **plus** the console and player SPAs, served same-origin (so the session cookie just works). `docker run`, the **docker-compose** `full` profile (server + Postgres + media volume), or the **Helm chart** in `deploy/helm/polyptic` (bring-your-own Postgres; renders standalone). You don't `npm install` Polyptic — you run the image.
- **Agent** — installed on each box via the `curl | sh` depot one-liner above (the server serves the binary; no standalone package — D41).
- **Releases** are **tag-driven** (GitHub Actions): pushing `vX.Y.Z` builds the server image + the agent binaries and attaches the binaries to the Release. CI (typecheck + tests) runs on every push; nothing publishes on a normal push.

## Status

**Feature-complete through Phase 8** and verified headlessly + in a real browser; the remaining work is environmental (real hardware), not features.

- **Built & tested:** Phases 1–3 (instant slice → registry → enrollment → the full Vue console: murals, combined surfaces, content library, scenes, machines + cold-start wizard, local auth + settings), Phase 5 (live preview, metrics, Helm), Phase 7 (media upload to disk), Phase 8 (single-image packaging + CI/release/Pages). **101 end-to-end tests** (real server, REST + WS) + full TypeScript typecheck are green; the console's interactions (content names, drag-to-assign, combine/rename, the activity feed) are **verified in-browser** via the `tools/ui-check` Playwright harness. *(Phase 6 / OIDC is deliberately deferred — the seam is in place.)*
- **Code-complete, not yet proven on hardware:** the **device stack** (Phase 4 — real `sway`/`x11` backends, zero-touch depot install, greetd cold-boot, boot splash, Chromium-per-output) and the **production image build** / actual multi-machine deploy. These can only be validated on real boxes/VMs — that's the active next step.

See **`docs/ONBOARDING.md`** to add a display, `docs/DEPLOY.md` for the device side, `docs/DISTRIBUTION.md` for packaging, `docs/ROADMAP.md` for the detailed state, `docs/DECISIONS.md` for the decision log (D1–D34+), `docs/DESIGN.md` for the narrative, `docs/ARCHITECTURE.md` for the build reference, and `CLAUDE.md` for working conventions.

## Naming
A **polyptic** is a multi-panel painting whose panels together compose one picture — the same relationship a video wall has to the single image it shows. Many panels, one composition: screens, scenes, and the mosaic all fall out of that metaphor.
