# Polyptic design notes

Design narrative for **Polyptic**, a generic, vendor-neutral display-wall and kiosk-fleet orchestration product. One declarative control plane and thin reconciling agents replace fragile per-machine boot scripts. `README.md` and `docs/ARCHITECTURE.md` are the concise mirrors. This document records why the system is built the way it is.

---

## The shape of the system

Polyptic is a small **bespoke TypeScript control plane** (`polyptic-server`, runs on any Kubernetes or Docker host), **thin per-client agents** (`polyptic-agent`) that dial outbound and reconcile to desired state in the Kubernetes-controller style, and a **web player** (`polyptic-player`) that renders each screen's slice of one global layout. The player runs on a minimal Wayland compositor (`sway`), which gives a free screenshot/VNC preview path and a native-window escape hatch.

**Buy the substrate, build the brain.** Device management (Ubuntu + `sway` + `greetd` + `systemd`) and rendering (Google Chrome as the kiosk browser, `surf` fallback) are borrowed wholesale. The only net-new build is the control plane that owns one global layout, named scenes and an API, which no off-the-shelf signage product provides.

**Screens, not machines.** Users drive named screens ("Nessie", "Bertha"…) and a client machine is just plumbing. An **ident mode** flashes each screen's name on its physical panel, so onboarding and relabelling is point-and-confirm.

**Vendor-neutral.** Any web content, dashboard, image or video. Operator sign-in is built in: local accounts with argon2id-hashed passwords and signed session cookies, no IdP required (console SSO via OIDC is a planned add-on on the same seam). Content **adapters** make dashboards, media and native apps first-class optional integrations, never dependencies. Ships as a Helm chart and a docker-compose.

---

## Core design principles

1. **Screen is first-class and machine is plumbing.** Registry, layout, scenes and API all address named screens. Onboarding maps a machine's outputs to screen identities via ident mode (flash name/number/colour on each output).
2. **One global layout, reconciled.** The Kubernetes-controller pattern (spec/status, generation/observedGeneration). The fleet is one consistent system, not N kiosks.
3. **Buy the substrate, build the brain.** Only the global layout, scenes, API and UI are bespoke.
4. **Compositor owns geometry and systemd owns lifecycle.** No click or sleep timing hacks. Crash recovery is `Restart=always`.
5. **Typed surfaces**, so the system is never trapped in an iframe-only model.
6. **Outbound-only agents.** No inbound ports or NAT into the client LAN.
7. **Pluggable adapters.** Integrations are seams, not foundations.

---

## Architecture (layers)

- **Device:** Ubuntu Server minimal → `greetd` passwordless autologin (`kiosk` user) → `sway` (outputs pinned by connector) → `systemd --user` services launch the agent plus one kiosk browser per output (Chrome native Wayland, `surf` fallback, and isolation is one process per output). No `swayidle`. `output * dpms on`. Wayland's ban on self-positioning is the feature, because all geometry then goes through the compositor via `swaymsg` IPC. GPU caveat: Intel and AMD are trouble-free, but NVIDIA needs extra config or the X11+i3 fallback, so verify on real hardware.
- **Rendering (hybrid typed surfaces):** default `web`/`dashboard` tiles render in the CSS-grid **player**, and a surface carrying `placement: "window"` is placed by the agent as a top-level browser window (the escape hatch for framing-blocked, non-web or future sources). Dashboards use single-panel embeds with all parameters and any kiosk flag baked into the URL.
- **Control plane (`polyptic-server`):** TypeScript (Fastify + `ws` + Postgres + `zod`), standalone, runs on any k8s or Docker host. Owns the Machine/Output/Screen registry, the one global virtual-canvas layout (arbitrary regions, not a fixed grid), and named immutable versioned scenes. Reconcile: bump one global `desiredRevision`, recompute each machine's slice, fan out apply. An optional PREPARE/COMMIT barrier gives tear-free flips. Web UI: layout editor, scenes, live preview, ident trigger, fleet health. Prometheus `/metrics`.
- **Transport:** agents dial outbound `wss://` only, with a ~10s lease and reconnect backoff+jitter. Each agent caches its last-good slice and keeps rendering through controller outages.
- **Auth:** admin UI/API session-gated behind local operator accounts (argon2id password hashing, signed http-only session cookies, per-email and per-IP login lockout); console SSO via OIDC is a planned add-on. Per-content-source strategies: `public` · `anonymous-viewer` · `reverse-proxy-header-injection` · `persisted-session` · `oidc`. Agent identity: bootstrap token, then an mTLS cert keyed to `/etc/machine-id`.
- **Preview:** always-on `grim` JPEG thumbnails up the outbound WSS, showing the real render and auth state · on-demand `wayvnc`→noVNC tunnelled through the control plane · a WYSIWYG intended-layout diagram alongside.

---

## Content model (typed surfaces), adapters and media

Surface types: `web` · `dashboard` · `image` · `video` · `stream` · `playlist` · `page`. All render in the player; a framing-blocked `web`/`dashboard` surface carries `placement: "window"` and is placed by the agent as a top-level browser window instead. A `deck` content source (an uploaded PDF/slide document) converts to page images server-side and renders as a playlist of images, so it needs no surface of its own.

**Adapters** resolve a logical source into a concrete URL or launch-spec plus an auth strategy and refresh policy. `web`, `dashboard`, `media`, `native`. New integrations are new adapters, and the core model never changes.

**Office/PowerPoint:** upload the PPTX/PDF as a `deck` source. The server converts it once, at upload, into page images (behind the `DocumentConverter` seam) and it plays as a playlist of images with a per-page dwell. Never render Office live.

---

## Swarm, "screens not machines", ident mode

- `Machine { id=/etc/machine-id, label, outputs[] }`, `Screen { id, friendlyName, machineId, output, resolution }`. The Screen carries the stable id and the friendly name, and the Machine is onboarding plumbing.
- **Onboarding:** image a client → the agent registers and enumerates outputs (`swaymsg -t get_outputs` gives connector plus make/model/serial) → trigger ident mode → each panel shows its name/number/colour → confirm or rename in the UI. Swap a panel, re-ident.
- **One global layout** means the screens are regions of a single canvas. Scenes are named snapshots, and switching fans out atomically.

---

## Build vs buy

**Borrow wholesale:** the device stack (Ubuntu, `sway`/`greetd`/`systemd`, the Chrome kiosk browser with the `surf` fallback, `grim`) and the discipline of OTA, env-as-config provisioning (ship the agent as a single-file binary, provision declaratively), without taking on a hosted-SaaS device manager.

**Build (only net-new):** `polyptic-server` (registry, global layout, versioned scenes, REST/WS API, web UI) and `polyptic-agent`. Tightly scoped, not a generic signage CMS.

**Rejected: off-the-shelf signage and AV controllers.** Existing products model a fleet as N independent screens with per-screen playlists. No single global layout, no scenes spanning the whole wall. Hosted-SaaS device managers fail the self-host requirement and are content-agnostic. Enterprise AV-controller appliances are off-stack. None offer the one-canvas + named-scenes + API model that is the whole point, so the control plane is net-new.

---

## Naming: why Polyptic

A **polyptych** is a multi-panel painting whose panels compose one image, the exact metaphor for a wall of screens showing one composition and for the scenes/mosaic model. The name is short, distinct, and has a clean namespace across the package registries.

---

## The console model

The operator console is built around these entities:

- **Mural**: a named, switchable canvas (e.g. "Reception", "Atrium"). A deployment has several, and a top-bar switcher selects the active one.
- **Screen placement**: a Screen is **unplaced** (lives in a tray) or **placed** on exactly one mural at `{x, y, w, h}`. Enrolment is not placement, so an approved screen still has to be dragged onto a mural. Screens stay independent of their host machine, which is only shown as secondary "driven by" metadata.
- **Surface (combined / video wall)**: adjacent placed screens combined into one logical screen. Content spans the surface with bezel seams shown. The surface has a combined resolution, one content assignment, and "ident all". **Combine** (multi-select adjacent screens) and **Split** (back to individual screens).
- **ContentSource**: a reusable library item: `{ name, kind: web|dashboard|image|video|stream|playlist|page|deck, address/config, authStrategy }`. Dragged from the **Content Library** onto a screen or surface.
- **Scene**: a snapshot of a mural's whole composition: each screen or surface's content, every screen's position and size, and which screens are combined. Switching a scene restores it atomically with an instant fan-out. Save means "save the current wall as a scene".
- **Activity event**: a server-emitted event (`machine unreachable`, `content changed`, `scene activated`, `screen approved`…) surfaced as the console's live activity feed.

**The console's shape:** a top bar (mural switcher · scene switcher and save · live/alerts · theme); left, the Content Library and the unplaced-screens tray; centre, a zoomable canvas of screens and combined surfaces with a floating selection toolbar; right, a context inspector (single screen, combined surface, multi-select pre-combine, or empty); plus the live activity feed. Machines appear only as secondary metadata.

---

## Device stack: zero-touch netboot, not an install

**Delivery.** The only on-device path is the **netboot live image** served by the control plane: a bare machine boots it into RAM over the network, nothing is installed and nothing is written to disk. The image is built by `polyptic-agent setup` at build time, which wires the whole chain on a stock Ubuntu rootfs: greetd autologin (`kiosk` user) → **sway** → a `systemd`-supervised agent plus a kiosk browser per output (Chrome native Wayland, surf fallback), plus crash hardening (`Restart=always`, no `swayidle`, `dpms on`). Per-machine config (control-plane URL and bootstrap token) arrives on the kernel command line, baked into the boot menu the server generates per request. The split is clean. The boot medium makes the machine a Polyptic display, and the console decides what it shows (the machine enrols and an operator approves it).

**Generic Linux.** The runtime stack (systemd, greetd, sway, the browser, Wayland) is distro-agnostic. Only the package format and the display manager to displace differ. So the setup logic lives in the agent binary (`polyptic-agent setup`), distro-aware for the substrate it installs, one source of truth, run inside the chroot when the live image is built.

**"How does a browser show on a *server*?"** A "server" install is not CLI-only. It is the same OS with no desktop. The hardware still has a GPU and real outputs, which is how you see boot text. The Linux graphics stack is: kernel **DRM/KMS** (drives the panel) → a **compositor / display server** (sway on Wayland, Xorg on X11) → a **GUI app** (the browser). A "server" is missing only the middle layer. Polyptic adds just a compositor (sway, a few MB) and the browser, with no desktop environment (GNOME and KDE bundle a compositor plus a pile of unwanted apps). Starting from Server-minimal means nothing to fight, lean, fast-booting. `apt install greetd sway google-chrome-stable grim` (plus the `surf xwayland` fallback) is essentially the whole graphical layer.

**Browser.** **Google Chrome stable, native Wayland**: vendor-signed and security-updated from Google's own apt repo, EGL/GBM straight to the GPU. surf under Xwayland software-rendered and pegged the CPU on real hardware, which is why Chrome is the default. Chrome's loopback remote-debugging port also gives operators Chrome DevTools from their own desk, tunnelled through the console. `surf` (WebKitGTK) remains the fallback. It covers arm64 and Chrome-hostile hardware, at the cost that its dev tools can only be popped on the panel itself.

**Backends.** The agent's `wayland-sway` and `x11-i3` `DisplayBackend`s are real (swaymsg-IPC window placement, browser launching, `grim` capture, the on-screen inspector), and `dev-open` exists for non-Linux dev.

---

## Appendix: key technical gotchas (generic)

- **Wayland positioning:** a client cannot position itself. Placement MUST go through `sway` (config or IPC). X11 works and is the fallback.
- **Windows are matched by pid**, off sway's `window` event stream, because the browser exposes no per-output WM class to match on.
- **surf (the fallback browser) is an X11 client**, so under sway it needs `xwayland` installed and `DISPLAY` imported into the user session, or it never opens. Its XWayland GPU path needs DRI3, which real wall hardware broke, and that is why Chrome native Wayland is the default.
- **Hard power cut → "Restore pages":** suppress with `--disable-session-crashed-bubble --hide-crash-restore-bubble` *and* sed-reset `exit_type`/`exited_cleanly` in the profile's `Preferences`.
- **Headless autologin:** `--password-store=basic` (avoids the gnome-keyring prompt) · `--force-device-scale-factor=1` · `--autoplay-policy=no-user-gesture-required` if media plays.
- **Dashboard embedding:** the source must permit framing (no `X-Frame-Options: deny`, and if CSP is on, list the player origin in `frame-ancestors`). Keep player and content on one registrable domain for `SameSite=Lax` cookies. If the dashboard tool has an embedding or anonymous-access flag, enable it. Prefer a single-panel embed URL and bake every parameter plus any kiosk flag into the URL, because an in-iframe refresh can otherwise drop query state. Pin the version and re-test on upgrade.
- **Cross-origin iframe load-failure is undetectable** (Same-Origin Policy), so the parent needs a watchdog: spinner, load timeout, periodic `iframe.src = iframe.src`, error card and backoff.
