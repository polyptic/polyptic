# Polyptic — on-device deploy & onboarding

How a bare Linux box becomes a Polyptic display. This is the **device** guide (the zero-touch depot install, the cold-boot chain, the kiosk stack). For running the **control plane** (server + console + Postgres) see `docs/DEV.md`; for the why behind these choices see `docs/ARCHITECTURE.md` ("On-device stack" + "Gotchas") and `docs/DECISIONS.md` (**D26**, **D27**, **D35**, **D41**, **D9**).

> **Packaging & distribution** — how Polyptic *ships* (the server Docker image, the depot-served agent binary, the tag-driven release flow, and the optional private npm story) lives in **`docs/DISTRIBUTION.md`**. This page is the operational "install it on a box" guide; that page is "what the artifacts are and where they come from."

> Status: Phase 4. The real `wayland-sway` / `x11-i3` display backends and `polyptic-agent setup` ship in this phase. The backends drive a real compositor + GPU, so they are **VM-/hardware-verified**, not unit-tested — every step below that touches a display is marked where it needs a real virtual output or real hardware. See the [Verification checklist](#verification-checklist--visual-cold-boot-dod) at the end.

---

## The model — "just boot it" (D26 / D27 / D35 / D58)

Polyptic deliberately splits the machine from the brain:

- **Booting the control plane's live image makes the machine a Polyptic display.** That is the entire on-device story. There is no OS to install and no agent to install: the machine network-boots a live image into RAM and runs a zero-click kiosk from there — passwordless autologin → a Wayland compositor → a supervised agent that runs a kiosk browser per output and dials home over `wss://`.
- **The console decides what it shows.** Nothing about *what content appears* is configured on the device. Once the box is enrolled and approved, the operator drags screens onto a mural and assigns content from the console; it arrives live over the player WebSocket. The device never holds a layout, a credential for any dashboard, or a per-machine boot script.

That split is the whole point — it replaces "a fragile per-machine boot script that clicks here, waits, opens a browser, and types a password in plaintext" with **one declarative control plane + thin reconciling agents**.

**Netboot is the ONLY provisioning path (D58, superseding D41).** The agent is a Bun single binary baked into the live image at build time; the machine streams that image from the one server it can reach and nothing else. There is **no** standalone `.deb`/`.rpm` to `apt install`, no first-boot package hook, and no `curl … | sh` installer (the `GET /install` route and the substrate-bundle routes were removed). The provisioning logic still lives in the binary (`polyptic-agent setup`), one source of truth — it just runs when the *image* is built, not when a box is touched.

**The substrate is borrowed, not built (D27, D77).** The image is built up from `ubuntu-base` — the kernel's DRM/KMS already drives the panel. We add only a **compositor** (`sway`) and a **browser** (Google Chrome, native Wayland, from Google's own apt repo — plus `surf`/`xwayland`/`xdotool` as the fallback that also covers arm64), no desktop environment, no GDM/GNOME to fight.

---

## TL;DR

In the console: **Settings → Onboard Screens → Download bootloader**. Flash `polyptic-boot.img` to a USB
stick (2 GB or larger) with Balena Etcher or Rufus. **Wi-Fi machine?** Re-open the flashed stick and put
the network's credentials in `polyptic/wifi.conf` (wired machines ignore the file — one stick serves
everything; POL-63/D67). Boot the target machine from it, Secure Boot on.

It streams the current live image into RAM, comes up as a browser-per-output kiosk (Chrome, native Wayland; surf fallback), and dials home. It
shows **PENDING** in the console until an operator **Approves** it (Phase 2b). After approval its screens
flip to the active scene. Done, and there are no on-device steps, ever.

The control-plane address and (in gated mode) the enrolment token are baked into the boot menu the
server generates per request, so nothing is typed on the machine. (A stick that must also boot Wi-Fi-only
machines carries the token in its local menu — build it with `POLYPTIC_TOKEN=`; see
[NETBOOT.md ▸ Wi-Fi](NETBOOT.md#wi-fi-boxes-with-no-wire).)

---

## Zero-touch, air-gapped netboot from the control plane

This is the one and only way to provision a machine (D58): the machine **network-boots a live image into
RAM**, nothing is installed and nothing is written to disk. It suits everything from a normal LAN box to
a machine that reaches **ONLY the server** — a locked-down VLAN, a shop-floor panel, a kiosk behind a
captive firewall — because it pulls every byte from the one server it can see.

### The air-gap model — the server is the depot

The machine never touches the internet. Every byte it needs comes from the one server it can reach:

```
   machine (reaches ONLY the server)                    control plane = depot
   ┌──────────────────────────────┐                     ┌────────────────────────────────┐
   │ shim + GRUB (from USB/HTTP) ─┼───────────────────▶ │ GET /dist/boot/<loader>.efi    │
   │ fetch the boot menu ─────────┼───────────────────▶ │ GET /boot/grub.cfg (base+token) │
   │ stream kernel + initrd ──────┼───────────────────▶ │ GET /dist/image/<arch>/…        │
   │ stream rootfs into RAM ──────┼───────────────────▶ │ GET /dist/image/<arch>/rootfs.squashfs │
   │ enrol over ws(s)://…/agent ──┼───────────────────▶ │ agent WebSocket channel         │
   └──────────────────────────────┘                     └────────────────────────────────┘
```

- **`GET /boot/grub.cfg`** is generated per request with the control-plane base URL **baked in from the request's `Host` header**, plus (in gated mode) the current enrolment token, both on the kernel command line. So the machine enrols against the exact server it booted from, with no base URL and no token to hand-configure. Behind a reverse proxy, `X-Forwarded-Proto`/`X-Forwarded-Host` are honoured.
- All provisioning routes are **top-level and ungated** (like `/healthz`) — the machine has no operator session at boot. They are path-traversal-safe and 404 cleanly when an artifact isn't bundled.
- Secure Boot stays **on**: the chain is Ubuntu's signed shim → Canonical-signed network GRUB → Canonical-signed kernel. Polyptic signs nothing. See `docs/NETBOOT.md`.

### What the image contains

`deploy/build-live-image.sh` builds the rootfs up from `ubuntu-base`, installs the substrate, drops the
agent binary in, and runs **`polyptic-agent setup`** inside the chroot to wire greetd autologin → sway →
browser-per-output → the agent user unit, plus the boot splash (POL-7). The result is a bare
`rootfs.squashfs` that dracut boots with `root=live:<url>` (D55). Nothing is installed on the machine at
boot; the whole OS lives in RAM and is re-pulled next power-on, which is what makes image updates
automatic (D51).

### Booting without a USB stick

Point the machine's UEFI **HTTP Boot** URI at `http://SERVER:8080/dist/boot/shimx64.efi` (arm64:
`shimaa64.efi`), or hand the same URL out as **DHCP option 67**. Both are behind the *Boot without a USB
stick* disclosure in **Settings → Onboard Screens**.

### Serving the depot

The server serves the boot chain from `BOOT_DIST_DIR` (default `./deploy/dist/boot`) and `IMAGE_DIST_DIR`
(default `./deploy/dist/image`); `AGENT_DIST_DIR` (default `./deploy/dist`) holds the agent binaries that
`build-live-image.sh` bakes into the rootfs.

- **The server Docker image bakes the agent binaries in.** `deploy/server.Dockerfile` compiles the agent for **amd64 AND arm64** in the build stage (`bun build --compile --target=bun-linux-{x64,arm64}`) into `/app/deploy/dist`, and sets `AGENT_DIST_DIR`.
- **The live image + boot medium** are built by `deploy/build-live-image.sh` (Linux build host) and `deploy/build-boot-medium.sh` (macOS or Linux), on a schedule or from the console's ⋯ menu (D51/D52/D54).
- **Dev/lab without Docker:**
  ```bash
  bash deploy/build-agent.sh arm64          # → deploy/dist/polyptic-agent-arm64
  bash deploy/build-boot-medium.sh          # → deploy/dist/boot/polyptic-boot.img
  AGENT_DIST_DIR=deploy/dist bun packages/server/src/index.ts
  ```

---

## What the image wires (the cold-boot chain)

```
power on
  → systemd
  → greetd  [initial_session]  passwordless autologin  user=kiosk
  → exec sway                  (outputs pinned by connector; no swayidle; `output * dpms on`)
  → systemd --user             sway-session.target
       └─ polyptic-agent.service        (Restart=always)   ← the ONLY supervised unit
              ├─ enrols / reconnects over outbound wss://
              └─ spawns + supervises  chrome × N              (one fullscreen window per output; surf = fallback)
  zero clicks · zero sleeps · zero typed passwords
```

**Model A — the agent owns its browser children.** systemd supervises *the agent*; the agent spawns one browser per output, places it on the right connector via `swaymsg` IPC, and **respawns** it if it dies. (An earlier sketch showed one systemd unit per screen; Phase 4 folds that supervision into the agent so a single process owns placement + lifecycle. The greetd → sway → systemd-supervised-agent spine is unchanged.)

**Why content changes don't relaunch the browser.** The browser's URL is **fixed per screen** — it points at the player page for that screen (`…/player?screen=<id>`). `showScreen(connector, url)` only (re)launches or repoints the browser **when the URL changes**; everything else (which dashboard, which scene) changes *inside* the player over its own WebSocket, with no reload (< ~150 ms, the "instant" non-negotiable). So a scene switch never touches the device's window stack.

### Kiosk browser launch (per output)

The kiosk browser is **Google Chrome, native Wayland** (POL-67/D77), with **surf** as the fallback. The agent picks at runtime — Chrome when installed, else surf; `POLYPTIC_BROWSER=chrome|surf` forces it — and reports the choice on `agent/hello`, which is what flips the console's per-screen debug affordance between remote DevTools and the on-panel inspector.

**chrome** (default on apt/amd64 — installed by `setup` from Google's own repo, so plain `apt-get upgrade` tracks the latest stable):

```
google-chrome-stable --ozone-platform=wayland --kiosk --app=<player-url?screen=ID> \
  --user-data-dir=<runtime-dir>/polyptic-chrome-<connector> --remote-debugging-port=<9222+n> …
```

- **`--ozone-platform=wayland` is the whole point:** EGL/GBM straight to the GPU like sway — no XWayland, no DRI3, which is the path that software-rendered and CPU-pegged every surf on real amdgpu hardware (the POL-67 finding).
- **One `--user-data-dir` per connector is mandatory:** with a shared dir Chrome dedupes the second launch into the first process (the second output never gets a browser), and since Chrome 136 the default dir refuses the debugging port outright. The dir doubles as the stale-orphan reap token.
- **The remote-debugging port binds loopback only** and is reachable solely through the armed, operator-authenticated DevTools tunnel (below).

**surf** (fallback — arm64, where Google ships no Linux Chrome, or `POLYPTIC_BROWSER=surf`):

```
surf [-N] <player-url?screen=ID>
```

- The URL is a **positional** argument and must come last — surf has no `--app=`; per-output isolation is simply one process per output. `-N` enables the on-panel Web Inspector, passed only when an operator asks.
- surf is an **X11** client, so under the `wayland-sway` backend it renders through **XWayland**. `setup` installs `xwayland` alongside it (sway starts XWayland lazily, but only if the binary exists — without it the fallback wall stays black), and the sway config imports `DISPLAY` into the systemd user environment (without it surf dies with `Can't open default display`).

Either way: **no geometry flags** (Wayland forbids a client positioning itself; sway fullscreens and places each window on its output via `swaymsg` IPC, matched on the child's **pid**), and `POLYPTIC_BROWSER_ARGS` appends extra flags for a lab (`POLYPTIC_CHROME` / `POLYPTIC_SURF` override the binary paths).

### Debugging what a screen is actually rendering (POL-50 / POL-67)

A wall you can only debug by photographing it is a wall you can't debug. What **Console ▸ Machines ▸ (a screen) ▸ Inspect/DevTools** does depends on the box's browser:

**Chrome boxes — remote DevTools, at your desk (POL-67/D77).** The button reads **DevTools**: it arms the tunnel for that screen and opens **Chrome's own DevTools frontend in a new tab**, proxied from the wall box over the agent WS (`/api/v1/screens/:id/devtools`). Elements / Console / Network / Sources against the live page, no physical access, nothing visible on the wall, no reload. Gated like the remote shell: operator session required, armed per screen (re-checked on every frame), audited in the activity feed; the box's debugging port itself never leaves loopback. Click the button again to disarm — it also severs any open DevTools tab.

**surf boxes — the inspector on the panel (POL-50/D63).** WebKitGTK exposes **no** browser-openable remote inspector — `WEBKIT_INSPECTOR_SERVER` opens a port that answers neither HTTP nor a WebSocket upgrade, and its only client is another WebKitGTK app opening `inspector://host:port`, which surf itself cannot load. There is nothing to tunnel, so the agent relaunches that output's surf with `-N`, focuses it, and sends `Ctrl+Shift+O` followed by a reload — the reload matters, because WebKit's inspector does not backfill a load that already finished. Walk over and read the panel. Press **Inspect** again to close it and re-seal the box. Requires `xdotool` (`setup` installs it).

If a screen's machine is offline the button is disabled — the request rides the agent socket, not the player's.

### Crash hardening (don't relearn these)

| Hardening | Where | Why |
|---|---|---|
| `Restart=always` on `polyptic-agent.service` | systemd unit | agent (and via Model A, its browser children) always comes back |
| agent respawns dead browser children | agent / backend | a crashed page never leaves a black output |
| stale-instance reap (chrome: the per-connector data dir; surf: the player URL) | agent / backend | an orphan browser from a crashed agent never fights the new one |
| chromeless by construction | chrome `--kiosk --app` + crash-bubble/first-run flags; `surf` by nature | no infobars, no crash bubbles, no restore prompts on an unattended screen |
| **no** `swayidle` installed | sway session | the wall never blanks itself |
| `output * dpms on` | sway config | outputs forced on at session start |
| autologin via greetd `initial_session` | greetd config | no login prompt, no typed password on cold boot |

### Fleet health — the stats strip and `/metrics` (POL-92 / D91)

Every heartbeat (10s) carries the box's own **vitals**, sampled straight from `/proc` and `/sys`: CPU, memory, root-filesystem usage (on a netbooted box that **is** the RAM image), the hottest thermal zone, load, uptime, the **running image id**, and per-output browser health — resident memory, respawn count, and whether the browser holds an open fd on **`/dev/dri`**.

That last one is the whole point. A kiosk browser with no `/dev/dri` handle has no GPU path and is **painting the wall on the CPU** — the D77 failure that pegged a real box at 300% and took a remote shell plus `top` to find. It now shows up in two places without touching the box:

- **Console ▸ Machines** — each approved card carries a live CPU / Memory / Disk strip, an amber banner when the box is under sustained load (it may drop frames on animated content, including Ident flashes) and a **red "Rendering in software"** banner naming the connector. Offline machines read *"System stats unavailable while offline"* — a reading from a box that has gone dark is not health data.
- **`GET /metrics`** — one labelled series per machine, ungated like `/healthz` (scrapers carry no session):

  ```
  polyptic_machine_up{machine="…",label="Atrium NUC"}                 1
  polyptic_machine_cpu_percent{machine="…"}                          91.5
  polyptic_machine_gpu_accelerated{machine="…",connector="DP-1"}      0     # ← software rendering
  polyptic_machine_browser_respawns_total{machine="…",connector="DP-1"} 4
  polyptic_machine_last_seen_seconds{machine="…"}          1.7684e+09
  polyptic_image_build_age_seconds{arch="amd64",image_id="…"}      86400
  ```

  An approved box that goes dark stays in the exposition at `0` — a series that vanishes cannot fire an alert. An unknown reading emits **no sample at all** (an agent that couldn't tell is not an accusation).

**Sample alert rules ship at [`deploy/prometheus-alerts.example.yaml`](../deploy/prometheus-alerts.example.yaml)** — machine down, agent wedged (socket open, no heartbeat), software rendering, CPU/memory/disk/temperature, browser crash-looping, and a stale live image. Copy it, edit the thresholds (a reception panel and a nine-surface video wall have nothing in common but the metric names), and point Prometheus at the control plane:

```yaml
scrape_configs:
  - job_name: polyptic
    metrics_path: /metrics
    static_configs:
      - targets: ["polyptic.example.com"]
```

---

## Prerequisites & supported targets

- **OS:** none on the machine. The live image is built from `ubuntu-base` (26.04 class); the setup logic is **distro-aware** (apt/dnf/pacman for the substrate it installs) so it is generic across any systemd Linux, but Ubuntu/Debian is the hardware path.
- **GPU:** Intel/AMD → Wayland/sway (default, best path). NVIDIA → likely the **x11-i3 fallback** (D9); see [NVIDIA](#nvidia--wayland).
- **Architecture:** the agent **binary** is arch-specific, but you don't pick it — the image build bakes in the one matching its target arch (`amd64` thin clients; `arm64` Apple-Silicon VM guests), and one universal `polyptic-boot.img` boots both (GRUB's `$grub_cpu` selects the kernel).
- **RAM:** **~3.5 GB** for netboot — the whole OS is streamed into RAM (D55), and POL-67/D77 grew the image with Chrome (estimate; re-measure after the first post-Chrome build). The **live ISO** needs only ~1 GB, because it runs the squashfs off the stick — that is the path for small-RAM boxes.
- **Network:** at boot the machine fetches the loaders, menu and image over **HTTP** from the control plane; thereafter the agent dials **outbound `wss://` only** to the `/agent` path. No inbound ports, no NAT holes.
- **Control plane already running.** Bring up the server + console + Postgres first (`docs/DEV.md`). In gated mode the **bootstrap token** (`POLYPTIC_BOOTSTRAP_TOKEN`) is baked into the boot menu automatically; you never copy it to the device.

---

## The provisioner under the hood (`polyptic-agent setup`)

`deploy/build-live-image.sh` runs this inside the image's chroot — you don't normally call it by hand. `setup` is the idempotent provisioner baked into the agent binary (D7 — the binary embeds no npm runtime and shells out to `swaymsg`/the browser/`grim` via `node:child_process`, so there is nothing to `npm install` on the device). It detects the distro, ensures the substrate deps (`greetd`, `sway`, `google-chrome-stable` [apt+amd64, Google's repo], `surf`, `xwayland`, `xdotool`, `grim`, plus `scrot`/`imagemagick` for the x11 path), creates the **`kiosk`** user, writes the greetd autologin config, the sway config (outputs, `dpms on`, no idle), the systemd unit(s), the **boot splash** (POL-7), and `/etc/polyptic/agent.toml`, then enables them.

You'd call it when building a custom image, or on a running machine to switch backend, pin outputs, or swap the splash logo. It converges without piling up duplicate state:

```bash
sudo polyptic-agent setup \
  --server-url wss://control.example.com/agent \
  --bootstrap-token "$BOOTSTRAP_TOKEN" \
  # optional:
  # --backend wayland-sway|x11-i3     # default: auto-detect (wayland-sway, x11-i3 for NVIDIA)
  # --output DP-1=1920x1080@0,0       # pin a compositor output (repeatable)
  # --no-splash                       # skip the Plymouth boot splash (POL-7)
```

- **Idempotent:** safe to re-run; it converges the box to the desired config without piling up duplicate state.
- **Server URL** must be the **agent channel**: `wss://<host>/agent` in production, `ws://<host>:8080/agent` against a dev control plane.
- **Bootstrap token** is only needed in the server's **gated** mode (the safe default for anything real). If your dev server runs **open** mode it auto-approves and the token is ignored (with a server-side warning) — see `docs/DEV.md` → Phase 2b.

### Or configure by file — `/etc/polyptic/agent.toml`

`setup` writes this; you can also drop/edit it directly (then `sudo systemctl restart polyptic-agent` or re-run `setup`):

```toml
# /etc/polyptic/agent.toml
server_url      = "wss://control.example.com/agent"
bootstrap_token = "change-me-to-a-long-random-secret"
# backend       = "wayland-sway"   # or "x11-i3"; omit to auto-detect
# connector     = "HDMI-1"         # advertised output connector (single-output default)
```

These map onto the agent's environment knobs (the systemd unit exports them): `POLYPTIC_SERVER_URL`, `POLYPTIC_BOOTSTRAP_TOKEN`, `POLYPTIC_BACKEND`, `POLYPTIC_CONNECTOR`. The durable per-machine credential the server issues after first enrolment is stored under the kiosk user's state dir (`~/.polyptic/credential-<machineId>`, `0600`); the server keeps only its `sha256` (D12 / Phase 2b).

## Enrol & approve (Phase 2b)

1. The machine booted the live image straight into the chain above. There is no install step and no reboot to remember.
2. The agent dials out, sends `agent/hello` with the bootstrap token, and the server replies `server/enrolled` + `server/pending`. It now shows up **PENDING** in the console's enrollment view. The connection stays open; a rejected/unknown machine backs off and retries slowly (~60 s) rather than hammering.
3. An operator **Approves** the machine in the console. The server sends `server/apply` and the agent points each output's browser at its player URL. (Approval admits the *machine*; in Phase 3 an approved screen still has to be **dragged onto a mural** before it shows scene content — until then the player shows its idle/unplaced state.)
4. From then on the device reconnects automatically with its durable credential on every cold boot — no token, no clicks.

---

## Display backends

The agent selects a `DisplayBackend` at boot (override with `--backend` / `POLYPTIC_BACKEND`):

- **`wayland-sway` (default, D9).** Placement via **`swaymsg` IPC** (config + runtime `swaymsg` commands), capture via **`grim`**. Best path for Intel/AMD.
- **`x11-i3` (fallback, D9).** For hosts where a GPU/app misbehaves on Wayland (notably NVIDIA). Placement via i3 IPC / `wmctrl`-style control, capture via `scrot` or ImageMagick `import`.
- **`dev-open`** is the **dev-only** backend (opens the player in the host browser; D16 auto-default on a machine with no compositor). It is **not** used on a real device — `setup` configures a real backend.

A few Wayland realities the backend has to handle (from `ARCHITECTURE.md` → "Gotchas"):

- **Wayland forbids client self-positioning.** `--window-position` is a no-op; *all* geometry goes through sway (config or `swaymsg`). This is a feature — one authoritative place for placement.
- **Windows are matched by pid, not class.** Neither browser has a flag to set a per-output WM class/app_id, so `for_window [app_id=…]` can't tell two outputs' windows apart. The backend subscribes to sway's `window` events *before* spawning and matches the new window on the child's **pid** (falling back to `app_id`/launch order). This is exactly why placement is IPC-driven per launch rather than a static config rule.
- **surf (the fallback) reaches sway through XWayland.** It is an X11 client; sway starts XWayland lazily and only if the binary is installed. Chrome runs native Wayland and never touches XWayland.

`ident()` on the agent is **best-effort / secondary** — the *visible* "which panel is this?" flash is server → player (the player overlay), so the agent's `ident` may just log. `capture()` returns a JPEG via `grim` (wayland) / `scrot`|`import` (x11), or `null` where unavailable.

---

## UTM test walkthrough (visual cold-boot)

OrbStack/Docker verifies the boot → systemd → agent → enrolment *plumbing* headlessly and fast, but it has **no display** — it can't prove the visual DoD. For that you need a desktop-virtualization VM with a **real virtual output** where sway + the browser actually render. Below is **UTM** on Apple Silicon (Parallels works too); the load-bearing detail is the GPU.

### Create the VM (the critical settings)

1. **UTM → Create → Virtualize → Linux.**
2. **Backend: QEMU — *not* Apple Virtualization.** Apple's hypervisor exposes a paravirtual GPU that does **not** give sway a DRM/KMS device; sway won't start. QEMU with virtio-gpu does.
3. **Display / GPU: `virtio-gpu` (virtio-ramfb / virtio-gpu-gl).** This is what gives the guest a `/dev/dri/card0` KMS device so **sway gets KMS** and can drive a virtual output. Without it you get no console framebuffer for the compositor.
4. **Boot medium: Polyptic's own.** On Apple Silicon the guest is **arm64**, so build the **arm64** image. There is no Ubuntu ISO to install and no user to create — the guest boots straight into the live image.
5. RAM 2–4 GB (the whole OS lives in RAM), a few CPU cores. No disk needed unless you want to test the offload flow.

### Point it at the dev control plane

On your Mac, make sure the dev control plane is reachable from the guest (`bun run dev` per `docs/DEV.md`) and that the depot has an arm64 image for the guest to stream:

```bash
# on the Mac (once): the agent binary the image bakes in, then the image itself
bash deploy/build-agent.sh arm64                 # → deploy/dist/polyptic-agent-arm64
bash deploy/build-live-image.sh arm64            # Linux build host (or the Docker helper)
```

Then give the VM something to boot. Two options:

- **Self-contained live ISO** (simplest in UTM, whose EDK2 has no HTTP-Boot driver): download it from **Settings → Onboard Screens → Recent builds** and attach it as the VM's CD. It bakes the control-plane URL and the current enrolment token, so treat the file as a credential.
- **PXE / dongle:** attach `deploy/dist/boot/polyptic-boot.img` as a USB drive, or netboot per `docs/NETBOOT.md`.

`virtio-gpu` has no hardware cursor plane. The image already sets `WLR_NO_HARDWARE_CURSORS=1`; if you build a custom one and sway's cursor is invisible, that's the knob.

### Watch the cold boot

On reboot you should see, **with zero interaction**: the **Polyptic boot splash** (branded logo + version + hostname + a live status line, *instead of* kernel/systemd console text — POL-7) → greetd autologin → sway comes up (the splash's last frame is held until sway paints, so there's no flash of console) → the agent service starts and connects → a fullscreen kiosk browser appears on the virtual output. In the console the machine shows **PENDING**; **Approve** it, drag its screen onto a mural, assign content → the VM's screen flips to the **active scene**, instantly.

> **Boot splash check (POL-7):** the splash must be visible from *early* boot (right after the bootloader), show the live status line advancing, and hand off to sway with **no raw console text** at any point. Then check the **way down**: `sudo reboot` (and `sudo poweroff`) must show the same splash reading "Restarting"/"Shutting down" — no kernel/systemd console text on shutdown either. If you see kernel messages on boot, `quiet splash` didn't reach the cmdline — check `cat /proc/cmdline` and `/etc/default/grub` (then `sudo update-grub`), and that `plymouth-set-default-theme` reports `polyptic` (`sudo plymouth-set-default-theme`). If shutdown shows text, confirm the shutdown units are enabled (`systemctl is-enabled plymouth-poweroff.service plymouth-reboot.service`). To swap in the final logo later: replace `/usr/share/plymouth/themes/polyptic/logo.svg` and re-run `sudo polyptic-agent setup`.

Tail the agent while you watch:

```bash
journalctl --user -u polyptic-agent -f      # agent logs (connect, enrol, apply, placement)
# system-level (greetd/sway): journalctl -b -u greetd
swaymsg -t get_outputs                        # confirm sway sees the virtual output
swaymsg -t get_tree                           # confirm the browser window is placed on it
```

### VM caveats (what the VM **cannot** prove)

- **~1 virtual output.** A VM typically presents a single virtual display, so the VM validates **single-output** placement + the whole cold-boot chain. **Multi-output-per-client placement** (two+ browser windows on two+ connectors via the pid-keyed placer) and the **real multi-screen wall** stay a **real-hardware** test.
- **Virtual GPU quirks.** The virtual GPU often needs `WLR_NO_HARDWARE_CURSORS=1` (above). If sway still won't render, that *usefully* exercises the **x11-i3 fallback** (`sudo polyptic-agent setup --backend x11-i3 …`) — the same path you'd use for NVIDIA on real hardware.
- **Arch.** The VM proves the **arm64** build; your thin clients are almost certainly **amd64** — build and smoke-test that binary separately (the server image bakes both).
- **No GPU-accelerated video.** Heavy `video` surfaces may be soft-rendered in the VM; judge media performance on real hardware.

---

## Troubleshooting

### NVIDIA + Wayland
wlroots (sway) on NVIDIA needs `nvidia-drm.modeset=1` on the kernel cmdline and may need `WLR_NO_HARDWARE_CURSORS=1`. If sway is flaky or won't start, **switch to the x11/i3 fallback** (D9) — that's what it's for:
```bash
sudo polyptic-agent setup --backend x11-i3 --server-url … --bootstrap-token …
```
Verify the GPU/compositor on the **real hardware** before committing a fleet to Wayland.

### Black / blank output, or no browser window
```bash
swaymsg -t get_outputs        # is the connector present + active + dpms on?
swaymsg -t get_tree           # is there a browser window, and is it on the right output?
journalctl --user -u polyptic-agent -e   # placement errors, respawn loops
```
Common causes (surf fallback): **`xwayland` not installed** (sway logs `Cannot find Xwayland binary` and surf never opens — the classic black wall), `DISPLAY` not imported into the systemd user environment (surf dies with `Can't open default display`). Either browser: the pid placer not matching, or `swayidle` somehow installed and blanking the screen (it must **not** be present).

### Boot splash — console text still shows, or the logo is blank
- **Splash never shows and `journalctl -b` has `plymouth-start.service: Failed with result 'signal'` (plymouthd SEGFAULT):** the plymouth **label plugin** (text renderer) is missing. Our theme draws text via `Image.Text`; with no `label-*.so`, plymouth disables text rendering, never creates the console viewer, and the `script` plugin then dereferences that NULL viewer (`ply_console_viewer_hide`) and crashes every boot. Fix: install the label plugin and rebuild — `sudo apt install plymouth-label && sudo polyptic-agent setup` (Fedora: `plymouth-plugin-label`; Arch bundles it). Confirm text rendering is up by running plymouth in a debug harness (frees the DRM from the kiosk): `sudo systemctl stop greetd; sudo plymouthd --debug --debug-file=/tmp/ply.log; sudo plymouth show-splash; sleep 2; sudo plymouth --ping && echo ALIVE || echo CRASHED; sudo plymouth quit; sudo systemctl start greetd` — grep `/tmp/ply.log` for `Not using console viewer because text renderering isn't working` (that line = label plugin missing).
- **Console text instead of the splash:** the kernel cmdline is missing `quiet splash`. `cat /proc/cmdline`; if absent, confirm `/etc/default/grub` has them in `GRUB_CMDLINE_LINUX_DEFAULT`, run `sudo update-grub`, reboot. (On a Pi it's `/boot/firmware/cmdline.txt`.)
- **Wrong theme shows (the STOCK distro splash, not `polyptic`):** the theme wasn't embedded in the initramfs. The selector is `/etc/plymouth/plymouthd.conf` — confirm it has an **uncommented** `[Daemon]` section with `Theme=polyptic` (`cat /etc/plymouth/plymouthd.conf`), then rebuild and verify it landed:
  ```bash
  # dracut boxes (Ubuntu 25.10+/26.04): rebuild with dracut, NOT update-initramfs
  sudo dracut -f && lsinitramfs /boot/initrd.img-$(uname -r) | grep polyptic
  # initramfs-tools boxes (Ubuntu 24.04 LTS): sudo update-initramfs -u && lsinitramfs … | grep polyptic
  ```
  Re-running `sudo polyptic-agent setup` does all of this (writes plymouthd.conf, rebuilds dracut-first, verifies). **Note:** `plymouth-set-default-theme` **does not exist on Ubuntu 26.04** (dracut) — plymouthd.conf is the portable selector both builders read; don't rely on that helper.
- **Logo blank but text/bar show:** the SVG wasn't rasterised to PNG (no `rsvg-convert`). `sudo apt install librsvg2-bin && sudo polyptic-agent setup` re-renders `/usr/share/plymouth/themes/polyptic/*.png`.
- **A flash of console between splash and kiosk (compositor/sway text over the splash):** two guards must both be in place. (1) The retain-splash hand-off: the drop-in `/etc/systemd/system/plymouth-quit.service.d/10-polyptic-retain-splash.conf` exists and `systemctl cat plymouth-quit.service` shows `--retain-splash`. (2) The compositor launcher must not print to the VT — it redirects its own + the compositor's output to `/tmp/polyptic-compositor.log` (check the launcher `head /usr/local/bin/polyptic-compositor` has the `exec >>… 2>&1` line; read that log to debug the compositor itself).
- **Wrong version/hostname on the stamp:** it's baked at provision time — re-run `sudo polyptic-agent setup` after a rename/upgrade (or push a live line with `plymouth message --text=…`).

### Greetd isn't autologging in
Check the `initial_session` block points at the `kiosk` user and `exec`s sway:
```bash
sudo cat /etc/greetd/config.toml      # [initial_session] command = "sway", user = "kiosk"
systemctl status greetd
journalctl -b -u greetd
```
Re-run `sudo polyptic-agent setup …` to rewrite the config idempotently.

### Agent connects but stays PENDING forever
Expected until an operator **Approves** it in the console (Phase 2b). If it's `server/rejected` instead (bad/missing token), the agent logs it and retries slowly (~60 s). Fix the token (`/etc/polyptic/agent.toml` or re-run `setup`) and restart:
```bash
journalctl --user -u polyptic-agent -e   # look for "enrollment rejected" / "awaiting operator approval"
sudo systemctl restart polyptic-agent
```

### Useful one-liners
```bash
systemctl --user status polyptic-agent
journalctl --user -u polyptic-agent -f
cat /etc/polyptic/agent.toml
swaymsg -t get_outputs ; swaymsg -t get_tree
```

---

## Uninstall / teardown

`setup` has an inverse. `teardown` disables the kiosk chain (greetd autologin, the units, the sway/browser session) and returns the box toward a normal server, idempotently:

```bash
sudo polyptic-agent teardown            # disable + remove the wiring, keep the binary + config
sudo polyptic-agent teardown --purge    # also remove /etc/polyptic, the kiosk user, profiles & credential
sudo rm -f /usr/local/bin/polyptic-agent   # finally, remove the binary itself
```

---

## Verification checklist — visual cold-boot DoD

Tick these on the VM ([UTM walkthrough](#utm-test-walkthrough-visual-cold-boot)) for the single-output DoD; the ⚠ items need **real multi-output hardware**.

- [ ] The machine boots the medium and streams the live image into RAM: signed shim → GRUB → kernel → dracut `root=live:` → systemd, Secure Boot **on**.
- [ ] `polyptic-agent setup …` is idempotent — running it twice converges, no duplicate/broken state.
- [ ] **Cold boot is zero-click:** power on → greetd autologin → sway → agent → kiosk browser, **no login prompt, no sleep, no typed password**.
- [ ] **Boot splash (POL-7):** branded splash (logo + version + host + live status) from early boot → player with **no console text**; `sudo reboot` / `sudo poweroff` shows it on the way **down** too ("Restarting"/"Shutting down").
- [ ] The agent connects outbound and the machine appears **PENDING** in the console; **Approve** → its screen renders.
- [ ] Assigning content / switching scenes in the console updates the screen **live, with no browser reload** (< ~150 ms).
- [ ] No infobars, no crash bubble, no browser chrome of any kind on the screen.
- [ ] **Power-cut survival:** hard-kill the VM (simulating the EOD smart-plug) → on next boot the wall returns **clean** to the active scene.
- [ ] **Restart=always:** `systemctl --user kill polyptic-agent` → it (and its browser) comes back; manually `kill` a browser child → the agent respawns it.
- [ ] No `swayidle` present; `swaymsg -t get_outputs` shows the output **dpms on**; the screen never blanks itself.
- [ ] ⚠ **Multi-output (hardware):** a client with 2+ outputs places a distinct browser on **each** connector (pid-keyed placement), each pointed at its own player URL.
- [ ] ⚠ **GPU path (hardware):** the chosen backend renders correctly on the real GPU — Wayland/sway on Intel/AMD, or the x11/i3 fallback on NVIDIA (with `nvidia-drm.modeset=1`, `WLR_NO_HARDWARE_CURSORS` as needed).
- [ ] ⚠ **Full wall (hardware):** the real N-screen wall cold-boots to the active scene end-to-end.
```
