# Polyptic — Design Notes

*Last updated 2026-06-29.*

Design record for **Polyptic** — a *generic, vendor-neutral* display-wall / kiosk-fleet orchestration product: one declarative control plane and thin reconciling agents in place of fragile per-machine boot scripts. The repo `README.md` + `docs/ARCHITECTURE.md` are the concise mirrors; this is the working narrative.

---

## TL;DR — the recommendation

Build **Polyptic**: a small **bespoke TypeScript control plane** (`polyptic-server`, runs on any Kubernetes or Docker host), **thin per-client agents** (`polyptic-agent`) that dial *outbound* and reconcile to desired state (Kubernetes-controller-style), and a **web "mosaic player"** (`polyptic-player`) that renders each screen's slice of *one global layout*. Run the player **on a minimal Wayland compositor (`sway`)** for a free VNC/screenshot preview and a **native-window escape hatch**.

**Buy the substrate, build the brain.** Device management (Ubuntu + `sway` + `greetd` + `systemd`) and rendering (Chromium kiosk) are borrowed wholesale. The *only* net-new build is the control plane that owns **one global layout + named scenes + an API** — which no off-the-shelf signage product provides.

**Screens, not machines.** Users drive *named screens* ("Nessie", "Bertha"…); a client is just plumbing. An **ident mode** flashes each screen's name on its physical panel so onboarding/relabelling is point-and-confirm.

**Vendor-neutral.** Any web content/dashboard/image/video; **generic OIDC** (any IdP); content **adapters** (dashboards, media and native apps are first-class *optional* adapters, never dependencies). Ships as a Helm chart **and** a docker-compose.

**Quick win first (days):** point an existing wall at anonymous/`kiosk` dashboard URLs to prove the wall can be decoupled from human auth before building anything. Reversible, no new infra.

---

## Core design principles

1. **Screen is first-class; machine is plumbing.** Registry/layout/scenes/API all address *named screens*. Onboarding maps a machine's outputs to screen identities. → **ident mode** (flash name/number/colour on each output).
2. **One global layout, reconciled** — Kubernetes-controller pattern (spec/status, generation/observedGeneration). The fleet is one consistent system, not N kiosks.
3. **Buy the substrate, build the brain** — only the global-layout + scenes + API + UI is bespoke.
4. **Compositor owns geometry; systemd owns lifecycle** — no click/sleep timing hacks; crash recovery is `Restart=always`.
5. **Typed surfaces** so we're never trapped in an iframe-only model.
6. **Outbound-only agents** — no inbound ports/NAT into the client LAN.
7. **Pluggable adapters + generic OIDC** — integrations are seams, not foundations.

---

## Architecture (layers)

- **Device:** Ubuntu 24.04 minimal → `greetd` passwordless autologin (`kiosk`) → `sway` (outputs pinned by connector) → `systemd --user` services launch the agent + one Chromium `--app` per output (own `--user-data-dir`, popup-suppression flags, `exit_type` reset). No `swayidle`; `output * dpms on`. **Wayland's no-self-positioning is the feature** — all geometry goes through the compositor via `swaymsg` IPC. *GPU caveat:* Intel/AMD trouble-free; NVIDIA needs extra config or an X11+i3 fallback — verify on real hardware.
- **Rendering — hybrid typed surfaces:** default `web-url`/`dashboard-*` tiles render in the CSS-grid **player**; `web-window`/`native-app` are placed by the agent as **top-level windows** (escape hatch for framing-blocked / non-web / future sources). Dashboards use single-panel embeds (all parameters + any kiosk flag baked into the URL).
- **Control plane (`polyptic-server`):** TypeScript/Node (Fastify + `ws` + Postgres + `zod`), standalone, runs on any k8s/Docker. Owns the Machine/Output/Screen registry, the **one global virtual-canvas Layout** (arbitrary regions — not a fixed grid), and named **immutable versioned Scenes**. Reconcile: bump one global `desiredRevision` → recompute each machine's slice → fan out apply; optional PREPARE/COMMIT barrier for tear-free flips. Web UI: layout editor, scenes, live preview, ident trigger, fleet health. Prometheus `/metrics`.
- **Transport:** agents dial **outbound `wss://` only**; ~10s lease, reconnect backoff+jitter; each agent **caches its last-good slice** and keeps rendering through controller outages.
- **Auth (generic):** admin UI/API via **OIDC** standard discovery (any IdP). Per-content-source strategies: `public` · `anonymous-viewer` · `reverse-proxy-header-injection` · `persisted-session` · `oidc`. Agent identity: bootstrap token → mTLS cert keyed to `/etc/machine-id` (or OIDC client creds).
- **Preview:** always-on `grim` JPEG thumbnails up the outbound WSS (show *real* render + auth state); on-demand `wayvnc`→noVNC tunnelled through the control plane; WYSIWYG intended-layout diagram alongside.

---

## Content model (typed surfaces) + adapters + media

Surface types: `web-url` · `dashboard-panel` · `dashboard-page` (player iframes) · `web-window` · `native-app` (agent top-level windows) · `image` · `video` · `slideshow`.

**Adapters** resolve a logical source → concrete URL/launch-spec + auth strategy + refresh. `web`, `dashboard`, `media`, `native`. New integrations = new adapters; the core model never changes.

**Office/PowerPoint (nice-to-have, phase 5):** pre-convert PPTX → images/PDF/MP4 server-side (`soffice --headless --convert-to`) and play as `image`/`slideshow`/`video`. Never render Office live. Images/MP4 the player handles natively. Whole media track is a clearly-labelled phase-5 item so v1 stays lean.

---

## Swarm / "screens not machines" / ident mode

- `Machine { id=/etc/machine-id, label, outputs[] }`, `Screen { id, friendlyName, machineId, output, resolution }`. Screen carries the stable id + fun name; Machine is onboarding plumbing.
- **Onboarding:** image a client → agent registers + enumerates outputs (`swaymsg -t get_outputs` → connector + make/model/serial) → trigger **ident mode** → each panel shows its name/number/colour → confirm/rename in UI. Swap a panel → re-ident.
- **One global layout** = the screens are regions of a single canvas; scenes are named snapshots; switching fans out atomically.

---

## Build vs buy

**Borrow wholesale:** device stack (Ubuntu, `sway`/`greetd`/`systemd`, Chromium kiosk, `grim`, `wayvnc`); the *discipline* of OTA / env-as-config provisioning (ship the agent as a single-file **binary**, provision declaratively) — without taking on a hosted-SaaS device manager.

**Build (only net-new):** `polyptic-server` (registry + global layout + versioned scenes + REST/WS API + web UI) and `polyptic-agent`. Tightly scoped, *not* a generic signage CMS.

**Rejected — off-the-shelf signage & AV controllers:** existing products model a fleet as N independent screens with per-screen playlists — no single global layout, no scenes spanning the whole wall. Hosted-SaaS device managers fail the self-host requirement and are content-agnostic; enterprise AV-controller appliances are off-stack. None offer the one-canvas + named-scenes + API model that is the whole point, so the control plane is net-new.

---

## Roadmap (quick win first)

- **Phase 0 (1–3 days, reversible, on current boxes):** anonymous/`kiosk` dashboard URLs → validates auth-decoupling on existing hardware, no new infra.
- **Phase 1 (≈1–2 wk):** one Ubuntu client, autologin→sway→systemd Chromium per screen, static config. *Verify GPU/Wayland.*
- **Phase 2 (≈2–3 wk):** control-plane MVP + agent reconciling one scene; screen registry + ident mode.
- **Phase 3 (≈3–5 wk):** mosaic player across all screens + typed surfaces + scenes + layout editor + atomic fan-out.
- **Phase 4 (≈2–3 wk):** thumbnails + on-demand VNC; Helm + compose packaging; OIDC + mTLS identity; Prometheus; last-good-slice caching.
- **Phase 5 (nice-to-have):** image/video/slideshow + Office→media conversion; native-app surfaces as needs arrive.

**Effort:** ~1.5–3 engineer-months to v1 for 1–2 TS/Linux engineers, front-loaded by the days-scale Phase 0. Biggest estimate risk: GPU/Wayland validation on the real hardware.

---

## Naming — why Polyptic

A **polyptic** is a multi-panel painting whose panels compose one image — the exact metaphor for a wall of screens showing one composition, and for the scenes/mosaic model. Short, distinct, and with a clean namespace across the package registries.

---

## Appendix — key technical gotchas (generic)

- **Wayland positioning:** Chromium `--window-position` is a no-op natively — placement MUST go through `sway` (config or IPC). X11 works (fallback).
- **Multiple Chromium share `app_id="chromium"`** on Wayland → match on **title**, an **IPC placer** keyed on launch order, or force **XWayland** (`--ozone-platform=x11` + `--class=`).
- **Each Chromium needs its own `--user-data-dir`** or a second launch opens a tab in the first.
- **Hard power cut → "Restore pages":** suppress with `--disable-session-crashed-bubble --hide-crash-restore-bubble` *and* sed-reset `exit_type`/`exited_cleanly` in profile `Preferences`.
- **Headless autologin:** `--password-store=basic` (avoid gnome-keyring prompt); `--force-device-scale-factor=1`; `--autoplay-policy=no-user-gesture-required` if media plays.
- **Dashboard embedding:** source must permit framing (no `X-Frame-Options: deny`; if CSP on, list player origin in `frame-ancestors`). Keep player + content on **one registrable domain** for `SameSite=Lax` cookies. If the dashboard tool has an embedding / anonymous-access flag, enable it; prefer a single-panel embed URL and bake every parameter + any kiosk flag into the URL (an in-iframe refresh can otherwise drop query state); pin the version, re-test on upgrade.
- **Cross-origin iframe load-failure is undetectable** (SOP) → parent-side watchdog: spinner, load timeout, periodic `iframe.src = iframe.src`, error card + backoff.

---

## Update 2026-06-29 — Console v2 model

The **Polyptic Console v2** model settles the operator console. We adopt it wholesale (decisions D21–D25). This reshapes **Phase 3**; the contract/code don't change until that build.

**Entities (the Phase 3 data model):**
- **Mural** — a named, switchable canvas (e.g. "Reception", "Atrium"). A deployment has several. Top-bar switcher selects the active one.
- **Screen placement** — a Screen is **unplaced** (lives in a tray) or **placed** on exactly one mural at `{x, y, w, h}`. Enrolment (2b) ≠ placement: an approved screen still has to be dragged onto a mural. (Screens stay independent of their host machine — the machine is only shown as secondary "driven by" metadata, which the v2 design confirmed.)
- **Surface (combined / video wall)** — adjacent placed screens combined into one logical screen. Content **spans** the surface with bezel seams shown; it has a combined resolution, one content assignment, and "ident all". **Combine** (multi-select adjacent → combine) / **Split** (back to individual screens).
- **ContentSource** — a reusable library item: `{ name, kind: web|dashboard|image|video, address/config, authStrategy }`. Dragged from the **Content Library** onto a screen or surface. (Promotes the old "content adapters" idea into managed entities; `authStrategy` is the Bucket-A strategy from the auth model.)
- **Scene** — snapshots a mural's whole composition: each screen/surface's content **and** every screen's position/size **and** which screens are combined. Switching a scene restores it atomically (instant fan-out). Save = "save current wall as scene".
- **Activity event** — server-emitted event (`machine unreachable`, `content changed`, `scene activated`, `screen approved`…) surfaced as the console's **live activity feed**.

**The console (v2) shape:** top bar (mural switcher · scene switcher + save · live/alerts · theme); left = Content Library + Unplaced-screens tray; centre = zoomable canvas of screens + combined surfaces with a floating selection toolbar; right = context inspector (single screen / combined surface / multi-select pre-combine / empty); a live activity feed. Machines appear only as secondary metadata.

**What v2 did NOT cover — missing operator flows** (queued for design, then build): cold-start (nothing connected yet); the **enrolment/approval** UI (Phase 2b's pending → approve/reject "bouncer"); the first-time **ident → name → place** mapping flow; a **fleet/machines** management view (health, enrolment status, reject/revoke, bootstrap-token setting); **content-source** add/edit (incl. auth strategy); **scene management** (list/rename/delete/duplicate/schedule); and console **settings/sign-in** (admin OIDC — Bucket B/Phase 6). Optionally: real **live preview** thumbnails on the canvas (Phase 5) rather than content *names*.

---

## Update 2026-06-29 — Phase 4 device stack: zero-touch depot install, not a (mandatory) image (D26/D27; agent delivery revised by D41)

Settled while the design was in flight; build deferred until after Phase 3.

**Delivery.** The only on-device path is the **netboot live image** served by the control plane: a bare machine boots it into RAM over the network, nothing is installed and nothing is written to disk (D46/D47/D58, superseding D41's `curl … | sh` one-liner). The image is built by `polyptic-agent setup` at build time, which wires the whole chain on a **stock** Ubuntu rootfs: greetd autologin (`kiosk` user) → **sway** → `systemd`-supervised agent + **Chromium-per-output**, plus crash hardening (`Restart=always`, popup/`exit_type` suppression, no `swayidle`, `dpms on`). Per-machine config (control-plane URL + bootstrap token) arrives on the kernel command line, baked into the boot menu the server generates per request. Clean split: **the boot medium = the machine is a Polyptic display; the console = what it shows** (it enrols via 2b → you Approve it).

**Generic Linux.** The runtime stack (systemd, greetd, sway/cage, Chromium, Wayland) is distro-agnostic; only the package format and the DM-to-displace differ. So the **setup logic lives in the agent binary** (`polyptic-agent setup`), distro-aware (apt/dnf/pacman) for the substrate it installs (Ubuntu/Debian = the actual hardware, `.rpm`/AUR later) — one source of truth, run inside the chroot when the live image is built.

**"How does a browser show on a *server*?"** A "server" install isn't CLI-*only* — it's the same OS with no desktop. The hardware still has a GPU + real outputs (that's how you see boot text). The Linux graphics stack is: kernel **DRM/KMS** (drives the panel) → a **compositor / display server** (sway on Wayland; Xorg on X11) → a **GUI app** (Chromium). A "server" is missing only the middle layer. We add **just a compositor** (sway, a few MB) + the browser — *no* desktop environment (GNOME/KDE bundle a compositor *plus* tons of apps we don't want). So we deliberately start from **Server-minimal**: nothing to fight, lean, fast-booting. `apt install greetd sway chromium grim` is essentially the whole graphical layer.

**Browser.** `.deb` Chromium, **not Ubuntu's snap** (confined, slow cold-start, awkward profile paths) — the #1 kiosk pitfall. `cog`/WPE WebKit is the documented fallback for low-power clients (lighter; WebKit not Blink, so occasional dashboard rendering quirks).

**Backends.** Phase 4 makes the agent's `wayland-sway`/`x11-i3` `DisplayBackend`s **real** (swaymsg-IPC window placement + Chromium launching + `grim`/`wayvnc` capture), replacing today's Phase-1 stubs; `dev-open` stays for non-Linux dev.

**Test target (noted).** Two complementary VMs: **OrbStack** (headless, no display) for fast iteration on the **install → systemd → agent → enrolment** plumbing + a *headless* sway (`WLR_BACKENDS=headless`); and **UTM** (QEMU + virtio-gpu) — a desktop-virtualization VM with a real virtual display — for the **visual** "cold-boot → active scene, zero clicks" DoD, where sway + Chromium actually render. Caveats for the visual VM: it presents ~one virtual output (so *multi-output-per-client* + the real multi-screen wall stay a real-hardware test), the virtual GPU may need `WLR_NO_HARDWARE_CURSORS` or the x11/i3 fallback, and on Apple Silicon the guest is arm64 (build the agent binary for the VM arch *and* the likely-amd64 thin clients).

---

## Update 2026-06-29 (later) — renamed to "Polyptic" + logo + console design refresh

- **Renamed Polyptych → Polyptic** across the whole codebase: npm scope `@polyptic/*`, env vars `POLYPTIC_*`, `/etc/polyptic`, `~/.polyptic`, the `polyptic-agent` binary, brand text, and the repo folder `~/code/polyptic`. 115 files; verified typecheck + e2e 28/28. (Easier to spell.)
- **Logo** (`packages/console/src/components/Logo.vue`): the hinged-panel mark — two angled side panels + a squared-off centre on a rounded holder, **theme-inverting** (holder `--primary`, panels `--primary-fg`). Wired into the nav rail + sign-in. Horizontal lockup = mark + the "Polyptic" wordmark.
- **Console design refreshed** (`docs/design/console.dc.html` v4): brand is **Polyptic**, the logo mark replaces the old "P", and the **scene controls moved to the top-left of the Wall top bar** (active scene + Save scene lead it). The full scene rail/management lands in **3d** against this reference.
