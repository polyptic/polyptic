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

**Playlists (POL-34/D84):** a `ContentSource` of `kind: "playlist"` — an ordered carousel over other library sources with per-step timing (statics must be timed; a video left untimed plays to its end). Assignment resolves the whole rotation into ONE `playlist` surface (entries + a `startedAt` anchor) and the **player** advances it locally, so a control-plane outage never stops the carousel. Fully-timed rotations derive their on-air entry from the clock against the shared anchor — video-wall members stay in phase without coordinating and a rebooted box rejoins mid-cycle. Library edits/deletes ripple through playlists onto the glass; send-time auth (POL-24) stamps each entry with its own source's token.

**Page zoom (POL-57/D62):** framed surfaces carry a `zoom` scale factor (0.25–4, default 1). The player lays the iframe out at `1/zoom` of the box it must fill and scales it back up, so the page sees a smaller CSS viewport and re-lays-out — a browser's zoom, not a magnifying glass. The control plane remembers the value per `(screen-or-wall, page)` pair and re-applies it whenever that page lands on that target again.

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

**Bucket B — Polyptic's own auth ("can a *person* reconfigure the wall?").** This **is** our application layer. The admin UI/API is OIDC-gated via standard discovery (any IdP) so randoms on the network can't take over the wall. Agent↔server identity is separate again, and LAYERED (POL-25 / D69): the bootstrap token enrols a machine into a durable app-level credential (server keeps sha256 only), and — with `AGENT_MTLS_PORT` set — enrolment also signs the agent's CSR into a durable **mTLS client certificate** (CN = the machine id from `/etc/machine-id`; the private key never leaves the box) issued by the deployment's own persisted CA. Every reconnect then rides a dedicated TLS listener where a wrong/absent cert fails the handshake, before any app code; `AGENT_MTLS_REQUIRE=1` makes that the only admitted path. The cert is the fleet transport gate, the credential is the per-machine identity (per-connection CN binding waits on the runtime exposing peer certs on http upgrades).

When we say "build the auth-strategy seam from day one," we mean Bucket A is a per-tile config field. Bucket B (admin OIDC) is its own thing (Phase 6).

## Deployment — HTTPS by default (POL-70 / D88)

The **operator surface** (console, REST, `/admin` + `/player` WS, media) is HTTPS by default; **the netboot depot is plain HTTP by contract** (GRUB/shim have no TLS stack, D47) and never becomes https. Don't conflate either with the mTLS *agent* listener (D82) — that is its own raw-TLS port, never behind an HTTP ingress.

- **Primary path: a TLS-terminating ingress** in front of the plain `:8080` listener. Everything already survives termination: browsers follow the page protocol for WS (`wss:` on an https page — console and player both derive, never hardcode), the session cookie turns `Secure` automatically (below), and `computeBaseUrl` honours `X-Forwarded-Proto/Host`. The Helm chart makes this the well-lit path: name a host (`ingress.host` + `ingress.enabled`, or `ingressRoute.host`) and `PUBLIC_BASE_URL`, `CORS_ORIGIN`, `PLAYER_BASE_URL` and `MEDIA_PUBLIC_BASE` all derive **https** from that one hostname; `ingress.tls.enabled` **defaults true** (cert-manager wires in via `ingress.annotations`). On Traefik, `ingressRoute.bootHost` keeps the boot depot on a separate plain-HTTP router — that split is the supported way to run HTTPS *and* netboot from one cluster.
- **Native TLS** for bare/docker hosts: `TLS_CERT_FILE` + `TLS_KEY_FILE` (PEM paths, both or the boot refuses) switch the whole listener to https — REST, all three WS channels, media. It also makes the netboot depot https-only, which GRUB cannot fetch: a netbooting fleet needs the boot paths on plain http (the banner says so).
- **Let's Encrypt** (chart): `letsEncrypt.enabled=true` + `letsEncrypt.email` installs the vendored cert-manager subchart (condition-gated) and renders an ACME `Issuer` + a `Certificate` writing the ingress host's TLS secret — real, auto-renewed certificates from one hostname and one email, no manual secret. `staging: true` tests the http01 solver path without burning rate limits; `additionalDnsNames` extends the cert; the solver's ingress class defaults to `traefik` (K3s).
- **Self-signed** for no-cert-infrastructure installs: `TLS_MODE=self-signed` (chart: `tls.mode: self-signed`) makes the server mint its own CA + server certificate with the POL-25 x509 machinery, **persist them in the store, and reuse them on every boot** — a re-mint would re-warn every browser, so persistence is the point. The leaf re-mints automatically from the same CA (trust survives) when SANs grow (`TLS_SANS`, the `PUBLIC_BASE_URL` host, and in the chart the Service DNS names are covered) or expiry nears. **Console ▸ Settings ▸ HTTPS** shows the posture (`GET /api/v1/settings/https`), offers the CA download (`…/https/ca.crt`, gated like every settings route — the CA cert is public material, but its only consumer is a session-holding operator) with the SHA-256 fingerprint for out-of-band verification, and carries per-OS trust instructions (macOS Keychain, Windows Trusted Root, Linux `update-ca-certificates` + the Firefox-own-store caveat, iOS profile + full-trust toggle, Android CA install).
- **Secure cookies follow the declared scheme.** Precedence: explicit `SECURE_COOKIES` → `PUBLIC_BASE_URL` scheme (`https://` → Secure on; `http://` → Secure OFF, because a Secure cookie over plain http is silently dropped and login "succeeds" without persisting — POL-43) → `NODE_ENV=production`.
- **Plain HTTP degrades, never refuses.** Zero-click boot on a trusted plain-HTTP homelab keeps working (non-negotiable #4); the server prints a loud `auth.cookie.insecure` banner — operator credentials in cleartext, and the POL-59/POL-67 shell/DevTools tunnels are only as trustworthy as the network. HTTPS is the prerequisite for hostile networks.

## API sketch (REST + WS)
```
GET    /api/v1/machines | /screens | /layouts | /scenes
POST   /api/v1/screens/:id:ident            # flash name on the physical panel
POST   /api/v1/screens/:id (rename, remap)
POST   /api/v1/machines/:id/reboot {reason?} # power-cycle one box (409 offline / not approved)
POST   /api/v1/scenes                        # create immutable versioned scene
POST   /api/v1/fleet:activate-scene {sceneId}
GET    /api/v1/screens/:id/preview            # latest grim thumbnail
POST   /api/v1/screens/:id/inspect {on}       # chrome: arm the remote-DevTools tunnel · surf: pop the on-panel inspector
GET    /api/v1/screens/:id/devtools[/**]      # remote DevTools entry + proxied frontend/CDP (POL-67; armed screens only)
GET    /metrics                               # Prometheus
WS     /agent      (agent → server, outbound)  register, lease, status, apply-ack, reboot
WS     /ui         (browser → server)          live layout, thumbnails, health
WS     /player?screen=<id>  (browser → server)  desired surfaces for this screen
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
       └─ polyptic-agent.service          (Restart=always)
             └─ chrome × N                  (one per output; the agent owns + respawns them; surf = fallback, D77)
  no swayidle · output * dpms on · input * events disabled (POL-60) · power is the smart plug's job
```
### Boot splash (POL-7)
Instead of raw kernel/systemd console text, the wall shows a branded **Plymouth** splash from early boot until the player paints — **and again through shutdown/reboot** (setup enables the shipped `plymouth-{poweroff,reboot,halt,kexec}` units; the script keys off `Plymouth.GetMode()` to show "Shutting down"/"Restarting"), so no console text shows at either end. `polyptic-agent setup` installs a `script`-plugin theme under `/usr/share/plymouth/themes/polyptic`, sets it default (`plymouth-set-default-theme -R`), and adds `quiet splash plymouth.ignore-serial-consoles` to the kernel cmdline (`/etc/default/grub` → `update-grub`, or `cmdline.txt` on Pi). It is **live**, not a static image: the script wires `SetUpdateStatusFunction` (systemd's unit status), `SetBootProgressFunction` (a progress bar), and `SetMessageFunction`/`SetHideMessageFunction` (anything pushed with `plymouth display-message`). Those last two share **one** status line with systemd, and our narration outranks it while it is up — systemd's text is raw unit names, ours is written for someone looking at a wall. The **logo is a swappable SVG** (`logo.svg`, rasterised to PNG with `rsvg-convert` at install — vector, so it scales to any panel); the **version + hostname** are baked into a vector stamp from the build/host. Clean hand-off: a `plymouth-quit.service` drop-in + the compositor launcher both `quit --retain-splash`, so sway paints straight over the last frame with no flash. Disable with `setup --no-splash`; uninstall restores the prior theme + cmdline.
### Reboot from the control plane (POL-55)
An operator can power-cycle one box from Console ▸ Machines (`POST /api/v1/machines/:id/reboot` → `server/reboot` on that machine's live agent socket). The agent is **unprivileged** and the live image ships neither `sudo` nor polkit, so it does not reboot the box itself: `polyptic-agent setup` writes a root-owned pair whose only capability is rebooting — `polyptic-reboot.path` watches `/run/polyptic/requests/reboot`, and `polyptic-reboot.service` consumes that file and runs `systemctl --no-block reboot`. The agent's whole escalation is creating an empty file in the one directory (`0770 root:kiosk`, made each boot by a `tmpfiles.d` drop-in) it may write into — no command string, no argument to smuggle. `/run` is tmpfs, so a request can never survive the reboot it caused. The agent answers `agent/reboot-ack` **before** going down; a box that declines (dev backend, non-Linux, no helper) stays up and its reason lands in the console's activity feed. Distinct from the fleet-wide image roll-out (D51), where each box polls the manifest and reboots *itself*.

### Kiosk input lockdown (POL-60)
A deployed wall ignores physical input devices: the sway config carries `input * events disabled`, so a walk-up keyboard cannot Tab focus around the dashboard or Ctrl+Alt+F-anything to a VT — and a device hot-plugged later is disabled the moment sway sees it. A **debug boot** (the GRUB "Debug console" entry, `systemd.debug-shell=1` on the kernel cmdline) gets keyboard/pointer/touch back at sway startup, or the tty9 root shell it exists for would be unreachable from the box. Everything the control plane drives is unaffected — agent IPC, the inspector's XTEST keystrokes (synthesised inside Xwayland, not a libinput device), the remote shell — though `input *` also matches virtual seat devices, so a hand-started wayvnc is view-only until an operator runs `swaymsg input '*' events enabled` over the remote shell. The x11-i3 fallback does the best X11 allows: `xinput disable` on physical slave devices at i3 start (sparing XTEST, or the on-screen inspector would stop typing), no hot-plug coverage.

### Browser launch (per output)
The kiosk browser is **Google Chrome, native Wayland** where installed, with **surf as the fallback** (D77 reversing D63's surf-only clause; `selectKioskBrowser`: `POLYPTIC_BROWSER` override, else chrome-if-present — the same call the agent's hello reports as `browser`).

- **chrome** (default on apt/amd64): `google-chrome-stable --ozone-platform=wayland --kiosk --app=<player-url?screen=ID> --user-data-dir=<per-connector> --remote-debugging-port=<9222+n> …` — native Wayland is the point: EGL/GBM straight to the GPU like sway, no Xwayland, no DRI3 (the path that software-rendered and CPU-pegged every surf on real amdgpu hardware, POL-67). One instance per output **requires** the per-connector `--user-data-dir` (a shared dir makes Chrome dedupe into one process; it is also what makes the debug port honoured since Chrome 136), and that dir doubles as the stale-orphan reap token. The debug port binds **loopback only** and is reachable solely through the armed DevTools tunnel below.
- **surf** (fallback — arm64, or `POLYPTIC_BROWSER=surf`): `surf [-N] <player-url?screen=ID>` — chromeless and fullscreen by nature, URL **positional**, no profile/geometry flags: isolation is separate pids, placement is the compositor's job. `-N` enables the on-panel Web Inspector and is passed **only** when an operator asks for it, so developer extras are never a keypress from a public panel.

### Inspect / remote DevTools (POL-50 / POL-67)
`POST /api/v1/screens/:id/inspect {on}` → `server/inspect` on that machine's agent socket, with browser-dependent meaning; either way the agent answers `agent/inspect-ack`, and that ack alone sets `ScreenView.inspecting`, so the console never badges an inspector that isn't real. A refusal leaves `inspecting` unchanged, so its reason rides back on `ScreenView.inspectError` — otherwise the console cannot tell "the wall said no" from "the wall hasn't answered".

- **chrome — remote DevTools tunnelled through the console (D77).** `inspect on` ARMS the tunnel for that output (no relaunch, nothing on the glass). The console's per-screen **DevTools** button then opens `GET /api/v1/screens/:id/devtools` in a new tab: the server discovers the page target over the agent WS, redirects into **Chrome's own bundled DevTools frontend** proxied at `…/devtools/<rest>` → box `/<rest>` (127.0.0.1 only), and the frontend's CDP WebSocket bridges back through a cookie-gated upgrade. POL-59 shell posture throughout: session-gated routes, armed-per-screen re-checked on every frame, audited, agent-side `devtoolsEndpoint` (null unless chrome+running+armed) as defense in depth. Two measured traps handled: the agent fetches loopback so Chrome's Host-header 500 never fires, and Chrome's frontend CSP (`connect-src 'self' ws://127.0.0.1:*`) is simply not forwarded by the proxy.
- **surf — the on-panel inspector (POL-50/D63).** WebKitGTK exposes **no** browser-openable remote inspector — `WEBKIT_INSPECTOR_SERVER` answers neither HTTP nor a WebSocket upgrade, and its only client is another WebKitGTK app opening `inspector://`, which surf cannot load — so there is nothing to tunnel and the dev tools are shown *where the page is*. The agent relaunches that output's surf with `-N`, focuses the window, then sends **Ctrl+Shift+O** and a reload. Opening it is part of the launch, so a browser that crashes and respawns while being inspected comes back inspected. Turning it off relaunches without `-N`.

### Cast to a screen (POL-119 / D111)
Ad-hoc mirroring from a presenter's iPhone/Mac onto one physical panel — generic **cast** framing, `airplay` first kind (**UxPlay**, GPLv3/GStreamer, Ubuntu universe). The player content path is untouched: the cast is an OS window the agent fullscreens over the browser; on disconnect the scene underneath is simply revealed.

- **Desired state:** `Screen.castEnabled` — persistent, **no TTL** (the always-on on-screen **PIN**, not the toggle, gates each session). Rides `server/apply` assignments together with a send-time `friendlyName` (the mDNS advertisement); `POST /api/v1/screens/:id/cast {enabled}` re-pushes a **same-revision** apply + render (the rename trick), and a rename of a cast-enabled screen re-applies too (receiver restarts under the new name — brief advertisement blip, accepted).
- **Agent:** one `SupervisedProcess`-managed UxPlay per cast-enabled connector — `-pin` always, `-reg <state-file>` (PIN-verified devices persist; resets harmlessly on a RAM-boot), `-as 0` (video only), `-vs waylandsink -fs` (never an Xwayland sink — POL-67), fixed per-connector base ports and a deterministic locally-administered `-m` MAC so two instances on one box never collide and a respawn keeps its identity. **x11-i3 and dev-open refuse `setCast`** with a reason (rides `agent/status.screens[].note` — the panel is never painted red for a missing receiver).
- **Session signal:** receiver windows appear at **sender-connect** time (the PIN prompt is a window too), so sway keeps a **persistent** pid-matched window watch per receiver (vs. the launch-time `waitForWindow`): every appearance is moved+fullscreened onto the connector; window presence is level-reported as `agent/status.screens[].casting` (heartbeat + immediately on change) → `Presence` → `ScreenView.castActive` → console "Casting now" (tile badge, Inspector state, Machines chip). Player badge shows a static cast glyph (`castEnabled` stamped on `server/render` like the name).
- **Image:** apt set `cast: uxplay avahi-daemon gstreamer1.0-plugins-bad` (wayland backend only) + `systemctl enable avahi-daemon` in setup. Discovery needs mDNS on the sender's L2 — cross-VLAN plumbing is the operator's problem. FairPlay-DRM apps will not mirror to any third-party receiver.

## Gotchas (don't relearn these)
- **Wayland forbids client self-positioning** — `--window-position` is a no-op natively; placement goes through `sway` (config or `swaymsg` IPC). X11 + i3 is the fallback if a GPU/app misbehaves.
- **surf is an X11 client**, so under sway it renders through **XWayland** — which sway starts lazily and only if the `xwayland` binary exists. Without the package the fallback browser never opens and the wall sits black. The sway config must also import `DISPLAY` into the systemd user environment, or surf dies with `Can't open default display`. Worse (POL-67/D77): XWayland's GPU path is **DRI3**, and where DRI3 is broken (real amdgpu wall hardware) every surf silently **software-renders** and pegs the CPU — the reason Chrome-native-Wayland is the default browser. Check `/proc/<pid>/fd` for a `/dev/dri` handle to tell which path a browser is on.
- **Two Chrome launches sharing a `--user-data-dir` dedupe into ONE process** — the second "launch" just opens a window in the first, which breaks per-output supervision AND (Chrome 136+) the default data dir refuses `--remote-debugging-port` outright. Hence the per-connector data dir.
- **Placement is keyed on the child's PID**, matched off the `swaymsg -t subscribe` window-event stream: neither browser has a flag to set a per-output WM class/app_id, so matching on class alone would pick an arbitrary sibling.
- **`xdotool key --window <id>` does nothing to a GTK app** — it delivers via `XSendEvent`, which GTK ignores. Synthetic input must go through **XTEST** (`xdotool key`, no `--window`) against the *focused* window. This is why the on-screen inspector focuses the surf window first.
- **WebKit's Web Inspector does not backfill.** Opened after a page has loaded, its Console and Network tabs are empty — so the agent reloads the page right after opening it, which is the only way a failing *load* is observable.
- **NVIDIA on wlroots** needs `nvidia-drm.modeset=1` (maybe `WLR_NO_HARDWARE_CURSORS`); verify hardware before committing to Wayland.
- **Plymouth needs an initramfs rebuild + the right cmdline** — a theme dropped in `/usr/share/plymouth/themes` does nothing until `plymouth-set-default-theme -R` (rebuilds the initrd) AND `quiet splash` is on the kernel cmdline. Plymouth renders **PNG**, not SVG, so the vector logo is rasterised at install (needs `rsvg-convert`/`librsvg2-bin`). Without `plymouth quit --retain-splash`, quitting Plymouth blanks the VT before sway paints → a flash of console; retain-splash holds the last frame. Serial consoles can slow/garble the splash → `plymouth.ignore-serial-consoles`.
- **The splash renders at the firmware's resolution unless the initramfs has a real KMS driver** (POL-53/[D64](DECISIONS.md)) — Ubuntu's `plymouthd.defaults` sets `UseSimpledrm=1`, which makes dracut's `plymouth` module depend on `simpledrm` instead of `drm`, and `drm` is never auto-detected. `simpledrm` is a fixed-mode shim over the firmware's framebuffer (often 1024×768 or 1280×800) and cannot mode-set, so the panel just upscales the whole splash. The splash drop-in therefore says `add_dracutmodules+=" drm "`; once a real driver probes, plymouth swaps renderers and mode-sets the connector's preferred (native) mode. Symptom if it regresses: a soft, blocky logo on a big panel.
- **`plymouthd.conf` sets `ThemeDir=` alongside `Theme=`** (POL-53/[D64](DECISIONS.md)) — `plymouth-populate-initrd` only honours the config when both keys are present. With `Theme=` alone it falls back to the `default.plymouth` alternative, which `setup` registers best-effort; where neither resolves, it exits 1 *before* installing plymouth's systemd units and dracut throws the error away. Symptom if it regresses: no `plymouth-start.service` in the initramfs (`lsinitrd | grep plymouth-start`), so plymouthd never starts there, the screen shows console text until switch-root, and every `plymouth display-message` from a dracut hook is a silent no-op.
- **A Plymouth theme's top-level code runs once** — read `Window.GetWidth()` there and the layout is frozen at whatever the first framebuffer was. plymouthd starts from `sysinit.target` while udev is still probing, so the KMS driver can mode-set *after* the splash is painted. The theme keeps its layout in a `layout()` function and re-runs it from the refresh callback whenever the window size changes. Symptom if it regresses: the splash is correctly proportioned but small and off-centre, sitting in the top-left of a big panel.
- **In Plymouth's DSL, `x = 1` inside a `fun` creates a function-local** unless `x` already exists in an enclosing scope — so any name a helper shares with `layout()` must be initialised at the top level first. Get it wrong and the reader silently draws nothing (this is what made the status line vanish, with no error anywhere).
- **`Image.Text` draws at Pango's default `Sans 12` (~16 px)** and the theme scales that bitmap up by `sh / 620`, so the status line is ~2.3× upscaled on a 1440p panel and softer than everything around it. `Image.Text` takes a font argument; using it is a known follow-up, not yet verified on a real plymouth.
- **Embedding a dashboard:** the source must permit framing (no `X-Frame-Options: deny`; if CSP is on, list the player origin in `frame-ancestors`). Keep player + content on **one registrable domain** so `SameSite=Lax` cookies survive in the iframe. If the dashboard tool has an embedding / anonymous-access setting, enable it; prefer a single-panel embed URL and bake **every** parameter (including any kiosk / full-screen flag) into the URL, since an in-iframe refresh can drop query state. Pin the source version and re-test embedding on upgrade.
- **Cross-origin iframe load-failure is undetectable** (Same-Origin Policy) → parent-side watchdog: spinner, load timeout, periodic `iframe.src = iframe.src`, error card + backoff. Sources that won't iframe cleanly become top-level `web-window` surfaces.

## Example integration — wiring to an existing stack

A sketch of how a real deployment slots Polyptic in front of infrastructure you already run. It is **illustrative**, not required by the product — every piece below is a swappable adapter.

- **Identity:** point Polyptic's admin OIDC at whatever IdP you already run — any compliant OIDC provider works via standard discovery.
- **Dashboards:** the `dashboard` adapter renders single-panel embeds or full kiosk pages. For public content, back it with a source configured for **anonymous read-only** access (and embedding enabled) so the wall holds no credentials and is orthogonal to human login. For protected content, use the **reverse-proxy header-injection** auth strategy on an IP-allowlisted kiosk ingress.
- **Hosting:** deploy `polyptic-server` via its Helm chart onto any cluster (e.g. behind your existing ingress controller) or any Docker host that can reach the IdP and the content sources.
- **Non-embeddable sources:** any app that sends framing-blocking headers is just a `web-url`/`web-window` source like any other — if it can't be iframed it renders as a top-level window.
