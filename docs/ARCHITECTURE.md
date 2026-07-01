# Polyptic — architecture & developer reference

Build-facing companion to `README.md`. Polyptic is a **generic, vendor-neutral** display-wall / kiosk-fleet orchestrator. Nothing here depends on a specific stack; integrations (dashboards, identity providers, media stores, …) are pluggable adapters behind stable seams, sketched in *Example integration* at the end.

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
- `dashboard` — builds a single-panel embed URL (or a full `kiosk`-mode dashboard page) from a logical panel reference; picks `anonymous-viewer` or `reverse-proxy-header` auth.
- `media` — `image | video | slideshow` from an asset store; Office docs are pre-converted to images/PDF/MP4 (e.g. `soffice --headless --convert-to`) at upload time.
- `native` — a launch-spec for a non-web app, placed by the agent.

New integrations = new adapters; the core model never changes.

## Auth — two separate concerns (don't conflate)

**Bucket A — content auth ("can the kiosk *see* the website?").** This is **website/browser level**, not Polyptic's. When the player iframes a content URL, the browser handles the session (cookies, OAuth redirects) exactly as on a laptop. Polyptic just points a tile at a URL. The only wrinkle is that a wall is *unattended* — no human to log in — so we provide ways to make the browser arrive **already authenticated**, without re-implementing anyone's login. Per-source strategies:
`public` (do nothing) · `anonymous-viewer` (e.g. a source configured for anonymous read access — nothing to do) · `reverse-proxy-header-injection` (a proxy in front of the source adds `Authorization:` because an iframe can't) · `persisted-session` (seed the kiosk browser profile with a session cookie once, persist via `--user-data-dir`) · `oidc` (pre-seeded/refreshed token). Polyptic's only role here is *config* — which URL/proxy a tile points at. Often: nothing. If a tile needs login and nothing is arranged, it simply shows that site's login page.

**Bucket B — Polyptic's own auth ("can a *person* reconfigure the wall?").** This **is** our application layer. The admin UI/API is OIDC-gated via standard discovery (any IdP) so randoms on the network can't take over the wall. Agent↔server identity is separate again: bootstrap token → mTLS cert keyed to `/etc/machine-id` (or OIDC client credentials).

When we say "build the auth-strategy seam from day one," we mean Bucket A is a per-tile config field. Bucket B (admin OIDC) is its own thing (Phase 6).

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
  → kernel (quiet splash) → Plymouth "polyptic" theme  ← branded splash, live boot status (POL-7)
  → systemd → greetd [initial_session] autologin user=kiosk
  → exec sway   (outputs pinned: `output DP-1 position 0 0 resolution 1920x1080`)
       └─ plymouth quit --retain-splash   ← splash frame held until sway paints (no console flash)
  → systemctl --user start sway-session.target
       ├─ polyptic-agent.service          (Restart=always)
       └─ chromium@<screen>.service × N     (Restart=always; one per output)
  no swayidle · output * dpms on · power is the smart plug's job
```
### Boot splash (POL-7)
Instead of raw kernel/systemd console text, the wall shows a branded **Plymouth** splash from early boot until the player paints. `polyptic-agent setup` installs a `script`-plugin theme under `/usr/share/plymouth/themes/polyptic`, sets it default (`plymouth-set-default-theme -R`), and adds `quiet splash plymouth.ignore-serial-consoles` to the kernel cmdline (`/etc/default/grub` → `update-grub`, or `cmdline.txt` on Pi). It is **live**, not a static image: the script wires `SetUpdateStatusFunction` (systemd's "Starting …" messages), `SetBootProgressFunction` (a progress bar), and `SetMessageFunction` (anything the agent pushes with `plymouth message`). The **logo is a swappable SVG** (`logo.svg`, rasterised to PNG with `rsvg-convert` at install — vector, so it scales to any panel); the **version + hostname** are baked into a vector stamp from the build/host. Clean hand-off: a `plymouth-quit.service` drop-in + the compositor launcher both `quit --retain-splash`, so sway paints straight over the last frame with no flash. Disable with `setup --no-splash`; uninstall restores the prior theme + cmdline.
### Chromium launch (per output)
`chromium --ozone-platform=wayland --app=<player-url?screen=ID> --user-data-dir=/home/kiosk/profiles/<ID> --password-store=basic --force-device-scale-factor=1 --no-first-run --no-default-browser-check --disable-session-crashed-bubble --hide-crash-restore-bubble --disable-infobars --noerrdialogs --disable-component-update --check-for-update-interval=31536000 --disable-features=Translate,InfobarUI`
Before launch: sed-reset `exit_type`/`exited_cleanly` in `<profile>/Default/Preferences` so power cuts never show "Restore pages".

## Gotchas (don't relearn these)
- **Wayland forbids client self-positioning** — `--window-position` is a no-op natively; placement goes through `sway` (config or `swaymsg` IPC). X11 + i3 is the fallback if a GPU/app misbehaves.
- **Multiple Chromium share `app_id="chromium"`** under Wayland → `for_window [app_id]` can't disambiguate. Match on distinct **title**, run an **IPC placer** keyed on launch order, or force **XWayland** (`--ozone-platform=x11` + `--class=screen-a`).
- **Each Chromium needs its own `--user-data-dir`** or a second launch just opens a tab in the first.
- **NVIDIA on wlroots** needs `nvidia-drm.modeset=1` (maybe `WLR_NO_HARDWARE_CURSORS`); verify hardware before committing to Wayland.
- **Plymouth needs an initramfs rebuild + the right cmdline** — a theme dropped in `/usr/share/plymouth/themes` does nothing until `plymouth-set-default-theme -R` (rebuilds the initrd) AND `quiet splash` is on the kernel cmdline. Plymouth renders **PNG**, not SVG, so the vector logo is rasterised at install (needs `rsvg-convert`/`librsvg2-bin`). Without `plymouth quit --retain-splash`, quitting Plymouth blanks the VT before sway paints → a flash of console; retain-splash holds the last frame. Serial consoles can slow/garble the splash → `plymouth.ignore-serial-consoles`.
- **Embedding a dashboard:** the source must permit framing (no `X-Frame-Options: deny`; if CSP is on, list the player origin in `frame-ancestors`). Keep player + content on **one registrable domain** so `SameSite=Lax` cookies survive in the iframe. If the dashboard tool has an embedding / anonymous-access setting, enable it; prefer a single-panel embed URL and bake **every** parameter (including any kiosk / full-screen flag) into the URL, since an in-iframe refresh can drop query state. Pin the source version and re-test embedding on upgrade.
- **Cross-origin iframe load-failure is undetectable** (Same-Origin Policy) → parent-side watchdog: spinner, load timeout, periodic `iframe.src = iframe.src`, error card + backoff. Sources that won't iframe cleanly become top-level `web-window` surfaces.

## Example integration — wiring to an existing stack

A sketch of how a real deployment slots Polyptic in front of infrastructure you already run. It is **illustrative**, not required by the product — every piece below is a swappable adapter.

- **Identity:** point Polyptic's admin OIDC at whatever IdP you already run — any compliant OIDC provider works via standard discovery.
- **Dashboards:** the `dashboard` adapter renders single-panel embeds or full kiosk pages. For public content, back it with a source configured for **anonymous read-only** access (and embedding enabled) so the wall holds no credentials and is orthogonal to human login. For protected content, use the **reverse-proxy header-injection** auth strategy on an IP-allowlisted kiosk ingress.
- **Hosting:** deploy `polyptic-server` via its Helm chart onto any cluster (e.g. behind your existing ingress controller) or any Docker host that can reach the IdP and the content sources.
- **Non-embeddable sources:** any app that sends framing-blocking headers is just a `web-url`/`web-window` source like any other — if it can't be iframed it renders as a top-level window.
