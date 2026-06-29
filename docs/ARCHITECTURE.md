# Polyptych — architecture & developer reference

Build-facing companion to `README.md`. Polyptych is a **generic, vendor-neutral** display-wall / kiosk-fleet orchestrator. Nothing here depends on a specific stack; integrations (Grafana, Keycloak, …) are pluggable adapters, covered in *Example integration* at the end.

## Desired-state model (sketch)

```
Machine   { id: machine-id, label, lastSeen, agentVersion, outputs: Output[] }
Output    { connector: "DP-1", make, model, serial, resolution, position }
Screen    { id, friendlyName, machineId, outputConnector }      # first-class; what users address
Layout    { id, canvas: {w,h}, regions: Region[] }              # one global virtual canvas
Region    { id, screenId, rect: {x,y,w,h} }                     # arbitrary; not a fixed grid
Scene     { id, name, version, immutable, surfaces: Surface[] } # named snapshot
Surface   { id, regionId, type, source, opts }                  # typed (see below)
Source    { kind, ref, adapter, auth }                          # resolved by a content adapter
FleetState{ desiredRevision, scenes, activeSceneId }
```

**Surface types:** `web-url | dashboard-panel | dashboard-page` (player iframes) · `web-window | native-app` (agent places top-level windows via `swaymsg`) · `image | video | slideshow`.

**Reconcile:** activating a scene bumps one global `desiredRevision`; the controller recomputes each machine's slice (its screens' regions + surfaces) and fans out `apply`; agents report `observedRevision`. Mirrors a Kubernetes controller's `generation`/`observedGeneration`. Optional PREPARE/COMMIT barrier for tear-free flips across all screens at once. Health is exposed as Prometheus metrics on the server and per-agent status over WSS — no external bus required.

## Content adapters (the extensibility seam)

An **adapter** resolves a logical `Source` into a concrete render spec + auth strategy:
```
adapter.resolve(source) -> { url | launchSpec, surfaceType, auth: AuthStrategy, refresh? }
```
- `web` — any URL, rendered as an iframe (`web-url`) or a top-level window (`web-window`) if framing is blocked.
- `grafana` (reference adapter) — builds `/d-solo/<uid>/<slug>?orgId=1&panelId=<id>&kiosk&<vars>` for single-panel tiles or `&kiosk` dashboard pages; picks `anonymous-viewer` or `reverse-proxy-header` auth.
- `media` — `image | video | slideshow` from an asset store; Office docs are pre-converted to images/PDF/MP4 (e.g. `soffice --headless --convert-to`) at upload time.
- `native` — a launch-spec for a non-web app, placed by the agent.

New integrations = new adapters; the core model never changes.

## Auth strategies (generic, per source)
`public` · `anonymous-viewer` · `reverse-proxy-header-injection` (proxy adds `Authorization:` — iframes can't set headers) · `persisted-session` (seed a browser profile once, persist via `--user-data-dir`) · `oidc`. Admin UI/API auth is generic **OIDC** via standard discovery (any IdP). Agent↔server identity: bootstrap token → mTLS cert keyed to `/etc/machine-id`, or OIDC client credentials.

## API sketch (REST + WS)
```
GET    /api/v1/machines | /screens | /layouts | /scenes
POST   /api/v1/screens/:id:ident            # flash name on the physical panel
POST   /api/v1/screens/:id (rename, remap)
POST   /api/v1/scenes                        # create immutable versioned scene
POST   /api/v1/fleet:activate-scene {sceneId}
GET    /api/v1/screens/:id/preview            # latest grim thumbnail
POST   /api/v1/screens/:id:vnc                # open on-demand wayvnc tunnel
GET    /metrics                               # Prometheus
WS     /agent      (agent → server, outbound)  register, lease, status, apply-ack
WS     /ui         (browser → server)          live layout, thumbnails, health
WS     /player?screen=<id>  (Chromium → server) desired surfaces for this screen
```
Transport: agents dial **outbound `wss://` only**. ~10s lease, full status on change / ~60s, ~40s grace, reconnect backoff+jitter. Each agent **caches its last-good slice** and keeps rendering through any controller outage.

## On-device stack
```
power on
  → systemd → greetd [initial_session] autologin user=kiosk
  → exec sway   (outputs pinned: `output DP-1 position 0 0 resolution 1920x1080`)
  → systemctl --user start sway-session.target
       ├─ polyptych-agent.service          (Restart=always)
       └─ chromium@<screen>.service × N     (Restart=always; one per output)
  no swayidle · output * dpms on · power is the smart plug's job
```
### Chromium launch (per output)
`chromium --ozone-platform=wayland --app=<player-url?screen=ID> --user-data-dir=/home/kiosk/profiles/<ID> --password-store=basic --force-device-scale-factor=1 --no-first-run --no-default-browser-check --disable-session-crashed-bubble --hide-crash-restore-bubble --disable-infobars --noerrdialogs --disable-component-update --check-for-update-interval=31536000 --disable-features=Translate,InfobarUI`
Before launch: sed-reset `exit_type`/`exited_cleanly` in `<profile>/Default/Preferences` so power cuts never show "Restore pages".

## Gotchas (don't relearn these)
- **Wayland forbids client self-positioning** — `--window-position` is a no-op natively; placement goes through `sway` (config or `swaymsg` IPC). X11 + i3 is the fallback if a GPU/app misbehaves.
- **Multiple Chromium share `app_id="chromium"`** under Wayland → `for_window [app_id]` can't disambiguate. Match on distinct **title**, run an **IPC placer** keyed on launch order, or force **XWayland** (`--ozone-platform=x11` + `--class=screen-a`).
- **Each Chromium needs its own `--user-data-dir`** or a second launch just opens a tab in the first.
- **NVIDIA on wlroots** needs `nvidia-drm.modeset=1` (maybe `WLR_NO_HARDWARE_CURSORS`); verify hardware before committing to Wayland.
- **Embedding a dashboard:** the source must permit framing (no `X-Frame-Options: deny`; if CSP is on, list the player origin in `frame-ancestors`). Keep player + content on **one registrable domain** so `SameSite=Lax` cookies survive in the iframe. For Grafana: `[security] allow_embedding=true`, single-panel `/d-solo`, put **every** template var + `&kiosk` in the URL (else an in-iframe refresh can drop kiosk mode). Pin the version; re-test kiosk on upgrade.
- **Cross-origin iframe load-failure is undetectable** (Same-Origin Policy) → parent-side watchdog: spinner, load timeout, periodic `iframe.src = iframe.src`, error card + backoff. Sources that won't iframe cleanly become top-level `web-window` surfaces.

## Reuse
`grafana/grafana-kiosk` (Go) handles Chromium-kiosk-pointed-at-Grafana incl. login (`-login-method`, `-kiosk-mode`, `-window-position`) — handy for the Phase 0/1 quick win; the mosaic player + Grafana adapter supersede it for multi-source screens.

---

## Example integration — Grafana + Keycloak (reference deployment)

This shows how a real deployment wires Polyptych to an existing stack. It is **illustrative**, not required by the product.

- **Identity:** point Polyptych's admin OIDC at the existing IdP (e.g. Keycloak realm). Any compliant OIDC provider works.
- **Dashboards:** the Grafana adapter renders `d-solo` panels / `&kiosk` pages. For public demo content, use a dedicated Grafana **anonymous-Viewer org** (`[auth.anonymous] org_role=Viewer`, `[security] allow_embedding=true`) so the wall holds no credentials and is orthogonal to human OAuth login. For protected content, use the **reverse-proxy header-injection** auth strategy on an IP-allowlisted kiosk ingress.
- **Hosting:** deploy `polyptych-server` via its Helm chart onto the same cluster (e.g. behind the existing Traefik ingress) or anywhere else that can reach the IdP and dashboards.
- **Originating use case (AMRC):** Polyptych was conceived to drive the AMRC's ACS/Factory+ demo wall (Grafana 6.52.4 + an MQTT-traffic "visualiser" web app, Keycloak OIDC, Traefik). That validated the OIDC + dashboard-embedding paths — but Polyptych itself depends on none of it. The visualiser is just a `web-url`/`web-window` source like any other; if it sends framing-blocking headers it renders as a top-level window.
