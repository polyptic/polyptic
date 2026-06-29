# Polyptych — on-device deploy & onboarding

How a bare Linux box becomes a Polyptych display. This is the **device** guide (the `polyptych-agent` package, the cold-boot chain, the kiosk stack). For running the **control plane** (server + console + Postgres) see `docs/DEV.md`; for the why behind these choices see `docs/ARCHITECTURE.md` ("On-device stack" + "Gotchas") and `docs/DECISIONS.md` (**D26**, **D27**, **D9**, **D16**).

> Status: Phase 4. The real `wayland-sway` / `x11-i3` display backends and `polyptych-agent setup` ship in this phase. The backends drive a real compositor + GPU, so they are **VM-/hardware-verified**, not unit-tested — every step below that touches a display is marked where it needs a real virtual output or real hardware. See the [Verification checklist](#verification-checklist--visual-cold-boot-dod) at the end.

---

## The model — "just install it" (D26 / D27)

Polyptych deliberately splits the box from the brain:

- **`apt install polyptych-agent` makes the box a Polyptych display.** That is the entire on-device story. The package turns a stock **Ubuntu Server-minimal** install into a zero-click kiosk: passwordless autologin → a Wayland compositor → a supervised agent that runs a kiosk Chromium per output and dials home over `wss://`.
- **The console decides what it shows.** Nothing about *what content appears* is configured on the device. Once the box is enrolled and approved, the operator drags screens onto a mural and assigns content from the console; it arrives live over the player WebSocket. The device never holds a layout, a credential for any dashboard, or a per-machine boot script.

That split is the whole point — it replaces "a fragile per-machine boot script that clicks here, waits, opens a browser, and types a password in plaintext" with **one declarative control plane + thin reconciling agents**.

**apt is the primary path.** A prebuilt **image** and **cloud-init / Ansible** are optional thin wrappers around the *same* `.deb` + the *same* `polyptych-agent setup` logic (the provisioning lives in the binary, not in an image, so there is one source of truth). Use the image only when flashing a large fleet; a handful of boxes is just `apt install`.

**The substrate is borrowed, not built (D27).** Start from Ubuntu Server-minimal — a "server" is CLI-*by-default*, not CLI-*only*; the kernel's DRM/KMS already drives the panel. We add only a **compositor** (`sway`) and a **browser** (a **`.deb` Chromium**, *not* the snap — see [Troubleshooting](#snap-chromium-avoid-it)), no desktop environment, no GDM/GNOME to fight. `cog` / WPE WebKit is the documented fallback for low-power clients.

---

## TL;DR

On a machine with the repo checked out (build host — can be your Mac or a Linux box with `bun`):

```bash
# 1. Build the .deb for the target's architecture (amd64 thin clients, arm64 Apple-Silicon VMs)
bash deploy/build-agent.sh --arch amd64          # → dist/polyptych-agent_<ver>_amd64.deb
```

On the **target box** (Ubuntu Server-minimal), as a user with sudo:

```bash
# 2. Install (the leading ./ makes apt treat it as a local file, pulling deps from the repos)
sudo apt install ./polyptych-agent_<ver>_amd64.deb

# 3. Point it at the control plane and wire the kiosk stack (idempotent)
sudo polyptych-agent setup \
  --server-url wss://control.example.com/agent \
  --bootstrap-token "$BOOTSTRAP_TOKEN"

# 4. Reboot into the kiosk
sudo reboot
```

The box cold-boots into a Chromium-per-output kiosk and dials home. It shows **PENDING** in the console until an operator **Approves** it (Phase 2b). After approval its screens flip to the active scene. Done — no further on-device steps, ever.

---

## What the package wires (the cold-boot chain)

```
power on
  → systemd
  → greetd  [initial_session]  passwordless autologin  user=kiosk
  → exec sway                  (outputs pinned by connector; no swayidle; `output * dpms on`)
  → systemd --user             sway-session.target
       └─ polyptych-agent.service        (Restart=always)   ← the ONLY supervised unit
              ├─ enrols / reconnects over outbound wss://
              └─ spawns + supervises  kiosk Chromium × N     (one --app window per output)
  zero clicks · zero sleeps · zero typed passwords
```

**Model A — the agent owns its Chromium children.** systemd supervises *the agent*; the agent spawns one kiosk Chromium per output, places it on the right connector via `swaymsg` IPC, and **respawns** it if it dies. (An earlier sketch in `ARCHITECTURE.md`/`README.md` showed `chromium@<screen>.service × N` as separate systemd units; Phase 4 folds that supervision into the agent so a single process owns placement + lifecycle. The greetd → sway → systemd-supervised-agent spine is unchanged.)

**Why content changes don't relaunch the browser.** The Chromium URL is **fixed per screen** — it points at the player page for that screen (`…/player?screen=<id>`). `showScreen(connector, url)` only (re)launches or repoints Chromium **when the URL changes**; everything else (which dashboard, which scene) changes *inside* the player over its own WebSocket, with no reload (< ~150 ms, the "instant" non-negotiable). So a scene switch never touches the device's window stack.

### Kiosk Chromium launch (per output)

The backend launches Chromium with the **exact** flags from `ARCHITECTURE.md` → "Chromium launch (per output)":

```
chromium \
  --ozone-platform=wayland \
  --app=<player-url?screen=ID> \
  --user-data-dir=/home/kiosk/profiles/<ID> \
  --password-store=basic \
  --force-device-scale-factor=1 \
  --no-first-run \
  --no-default-browser-check \
  --disable-session-crashed-bubble \
  --hide-crash-restore-bubble \
  --disable-infobars \
  --noerrdialogs \
  --disable-component-update \
  --check-for-update-interval=31536000 \
  --disable-features=Translate,InfobarUI
```

- `--ozone-platform=wayland` runs Chromium natively on sway (the x11/i3 fallback uses `--ozone-platform=x11`).
- `--app=<url>` gives a frameless, chrome-less window; **sway** makes it fullscreen on its assigned output (Wayland forbids the client positioning itself — see below). The `x11-i3` backend can use `--kiosk` plus a `--class=screen-<id>` so i3 can match and fullscreen it.
- `--user-data-dir=/home/kiosk/profiles/<ID>` is **mandatory and distinct per output** — a second Chromium sharing a profile just opens a *tab* in the first, not a new window.
- `--password-store=basic` stops Chromium blocking on a GNOME-keyring/secret-service prompt that doesn't exist on a headless server.
- The popup-suppression set (`--disable-session-crashed-bubble --hide-crash-restore-bubble --disable-infobars --noerrdialogs`) plus the Preferences reset below is what keeps an unattended panel clean after a power cut.

**Before each launch, reset the crash flags.** Power cuts (the EOD smart-plug) leave Chromium thinking it crashed, which pops a "Restore pages" bar over the content. The backend `sed`-resets `exit_type` → `"Normal"` and `exited_cleanly` → `true` in `/home/kiosk/profiles/<ID>/Default/Preferences` *before* relaunch, so the wall comes up clean every time.

### Crash hardening (don't relearn these)

| Hardening | Where | Why |
|---|---|---|
| `Restart=always` on `polyptych-agent.service` | systemd unit | agent (and via Model A, its Chromium children) always comes back |
| agent respawns dead Chromium children | agent / backend | a crashed tab never leaves a black output |
| `exit_type` / `exited_cleanly` reset before launch | backend, in `Preferences` | no "Restore pages" bar after a power cut |
| popup-suppression flags | Chromium launch | no infobars / crash bubbles / error dialogs on an unattended screen |
| **no** `swayidle` installed | sway session | the wall never blanks itself |
| `output * dpms on` | sway config | outputs forced on at session start |
| autologin via greetd `initial_session` | greetd config | no login prompt, no typed password on cold boot |

---

## Prerequisites & supported targets

- **OS:** Ubuntu Server-minimal (24.04 LTS class) is the validated target; the setup logic is **distro-aware** (apt/dnf/pacman) so it is generic across any systemd Linux, but native `.deb` (Ubuntu/Debian) is the hardware path. `.rpm`/others are later.
- **GPU:** Intel/AMD → Wayland/sway (default, best path). NVIDIA → likely the **x11-i3 fallback** (D9); see [NVIDIA](#nvidia--wayland).
- **Architecture:** the `.deb` is **arch-specific**. Thin clients are typically **amd64**; an Apple-Silicon UTM/Parallels VM guest is **arm64**. Build the `.deb` for the arch you are installing on (`--arch amd64` / `--arch arm64`) — installing the wrong arch fails with a dpkg architecture error.
- **Network:** the agent dials **outbound `wss://` only** to the control plane's `/agent` path. No inbound ports, no NAT holes. The box must be able to reach the server URL.
- **Control plane already running.** Bring up the server + console + Postgres first (`docs/DEV.md`). Note the **bootstrap token** (`POLYPTYCH_BOOTSTRAP_TOKEN`) — the device needs the same value to enrol in gated mode.

---

## Step 1 — Build the `.deb`

The agent is a **Bun single binary** (D7): `deploy/build-agent.sh` compiles `packages/agent` with `bun build --compile` for the chosen Linux target and packages it with a postinst that drops the `polyptych-agent` binary on `PATH`, declares the runtime deps (`greetd`, `sway`, `chromium-browser`/`chromium` as a **`.deb`** not the snap, `grim`, plus `scrot`/`imagemagick` for the x11 path), and prepares `/etc/polyptych/`.

```bash
# from the repo root, on a host with bun
bash deploy/build-agent.sh --arch amd64      # x86-64 thin clients
bash deploy/build-agent.sh --arch arm64      # Apple-Silicon VM guests, ARM clients
# → dist/polyptych-agent_<version>_<arch>.deb
```

> The binary embeds no npm runtime and shells out to the system tools (`swaymsg`, `chromium`, `grim`, …) via `node:child_process` — there is nothing to `npm install` on the device.

## Step 2 — Install on the box

Copy the `.deb` to the target (scp/USB/your fleet tool) and:

```bash
sudo apt install ./polyptych-agent_<version>_amd64.deb
```

The leading `./` is important — it tells apt this is a **local file** and to resolve `Depends:` (sway, the `.deb` Chromium, greetd, grim, …) from the configured repositories. `dpkg -i` alone would *not* pull dependencies.

The package install only **places files + declares deps**. It does **not** flip the box into kiosk mode on its own — that is `setup`, so an accidental `apt install` never hijacks a machine.

## Step 3 — Configure & wire the stack (`polyptych-agent setup`)

`setup` is the idempotent provisioner baked into the binary. It detects the distro, ensures deps, creates the **`kiosk`** user, writes the greetd autologin config, the sway config (outputs, `dpms on`, no idle), the systemd unit(s), and `/etc/polyptych/agent.toml` from your flags, then enables them.

```bash
sudo polyptych-agent setup \
  --server-url wss://control.example.com/agent \
  --bootstrap-token "$BOOTSTRAP_TOKEN" \
  # optional:
  # --backend wayland-sway|x11-i3     # default: auto-detect (wayland-sway, x11-i3 for NVIDIA)
  # --kiosk-user kiosk                # the autologin user it creates/uses
```

- **Idempotent:** safe to re-run; it converges the box to the desired config (re-point at a new server, switch backend, rotate the token) without piling up duplicate state.
- **Server URL** must be the **agent channel**: `wss://<host>/agent` in production, `ws://<host>:8080/agent` against a dev control plane.
- **Bootstrap token** is only needed in the server's **gated** mode (the safe default for anything real). If your dev server runs **open** mode it auto-approves and the token is ignored (with a server-side warning) — see `docs/DEV.md` → Phase 2b.

### Or configure by file — `/etc/polyptych/agent.toml`

`setup` writes this; you can also drop/edit it directly (then `sudo systemctl restart polyptych-agent` or re-run `setup`):

```toml
# /etc/polyptych/agent.toml
server_url      = "wss://control.example.com/agent"
bootstrap_token = "change-me-to-a-long-random-secret"
# backend       = "wayland-sway"   # or "x11-i3"; omit to auto-detect
# connector     = "HDMI-1"         # advertised output connector (single-output default)
```

These map onto the agent's environment knobs (the systemd unit exports them): `POLYPTYCH_SERVER_URL`, `POLYPTYCH_BOOTSTRAP_TOKEN`, `POLYPTYCH_BACKEND`, `POLYPTYCH_CONNECTOR`. The durable per-machine credential the server issues after first enrolment is stored under the kiosk user's state dir (`~/.polyptych/credential-<machineId>`, `0600`); the server keeps only its `sha256` (D12 / Phase 2b).

## Step 4 — Enrol & approve (Phase 2b)

1. `sudo reboot` (or `sudo systemctl start greetd`) — the box cold-boots the chain above.
2. The agent dials out, sends `agent/hello` with the bootstrap token, and the server replies `server/enrolled` + `server/pending`. It now shows up **PENDING** in the console's enrollment view. The connection stays open; a rejected/unknown machine backs off and retries slowly (~60 s) rather than hammering.
3. An operator **Approves** the machine in the console. The server sends `server/apply` and the agent points each output's Chromium at its player URL. (Approval admits the *machine*; in Phase 3 an approved screen still has to be **dragged onto a mural** before it shows scene content — until then the player shows its idle/unplaced state.)
4. From then on the device reconnects automatically with its durable credential on every cold boot — no token, no clicks.

---

## Display backends

The agent selects a `DisplayBackend` at boot (override with `--backend` / `POLYPTYCH_BACKEND`):

- **`wayland-sway` (default, D9).** Placement via **`swaymsg` IPC** (config + runtime `swaymsg` commands), capture via **`grim`**. Best path for Intel/AMD.
- **`x11-i3` (fallback, D9).** For hosts where a GPU/app misbehaves on Wayland (notably NVIDIA). Placement via i3 IPC / `wmctrl`-style control, capture via `scrot` or ImageMagick `import`.
- **`dev-open`** is the **dev-only** backend (opens the player in the host browser; D16 auto-default on a machine with no compositor). It is **not** used on a real device — `setup` configures a real backend.

A few Wayland realities the backend has to handle (from `ARCHITECTURE.md` → "Gotchas"):

- **Wayland forbids client self-positioning.** `--window-position` is a no-op; *all* geometry goes through sway (config or `swaymsg`). This is a feature — one authoritative place for placement.
- **The app_id / title gotcha.** Every Chromium shares `app_id="chromium"` under Wayland, so a `for_window [app_id="chromium"]` rule can't tell two outputs' windows apart. The backend disambiguates by matching a **distinct window title** (or runs an **IPC placer keyed on launch order**, or forces XWayland with `--ozone-platform=x11 --class=screen-<id>`). This is exactly why placement is IPC-driven per launch rather than a static config rule.
- **Per-output `--user-data-dir`** is non-negotiable (see the launch flags) or the second window is just a tab in the first.

`ident()` on the agent is **best-effort / secondary** — the *visible* "which panel is this?" flash is server → player (the player overlay), so the agent's `ident` may just log. `capture()` returns a JPEG via `grim` (wayland) / `scrot`|`import` (x11), or `null` where unavailable.

---

## UTM test walkthrough (visual cold-boot)

OrbStack/Docker verifies the install → systemd → agent → enrolment *plumbing* headlessly and fast, but it has **no display** — it can't prove the visual DoD. For that you need a desktop-virtualization VM with a **real virtual output** where sway + Chromium actually render. Below is **UTM** on Apple Silicon (Parallels works too); the load-bearing detail is the GPU.

### Create the VM (the critical settings)

1. **UTM → Create → Virtualize → Linux.**
2. **Backend: QEMU — *not* Apple Virtualization.** Apple's hypervisor exposes a paravirtual GPU that does **not** give sway a DRM/KMS device; sway won't start. QEMU with virtio-gpu does.
3. **Display / GPU: `virtio-gpu` (virtio-ramfb / virtio-gpu-gl).** This is what gives the guest a `/dev/dri/card0` KMS device so **sway gets KMS** and can drive a virtual output. Without it you get no console framebuffer for the compositor.
4. **ISO: Ubuntu Server-minimal.** On Apple Silicon the guest is **arm64**, so download the **arm64** Ubuntu Server ISO. (Build the **arm64** `.deb` for this VM — and separately the **amd64** `.deb` for your real thin clients.)
5. RAM 2–4 GB, a few CPU cores, 16 GB+ disk. Finish the Ubuntu Server install (create a normal sudo user; you do **not** pre-create `kiosk` — `setup` does that).

### Install & point it at the dev control plane

On your Mac, make sure the dev control plane is reachable from the guest (run `bun run dev` per `docs/DEV.md`; use the host's LAN IP, not `localhost`, from inside the VM). Then in the guest:

```bash
# copy the arm64 .deb in (scp from the Mac, or a UTM shared dir)
sudo apt install ./polyptych-agent_<version>_arm64.deb

sudo polyptych-agent setup \
  --server-url ws://<your-mac-ip>:8080/agent \
  --bootstrap-token "$BOOTSTRAP_TOKEN"      # omit if your dev server runs OPEN mode

# virtio-gpu has no hardware cursor plane — set this so sway's cursor renders
echo 'WLR_NO_HARDWARE_CURSORS=1' | sudo tee -a /etc/environment

sudo reboot
```

### Watch the cold boot

On reboot you should see, **with zero interaction**: greetd autologin → sway comes up → the agent service starts and connects → a fullscreen kiosk Chromium appears on the virtual output. In the console the machine shows **PENDING**; **Approve** it, drag its screen onto a mural, assign content → the VM's screen flips to the **active scene**, instantly.

Tail the agent while you watch:

```bash
journalctl --user -u polyptych-agent -f      # agent logs (connect, enrol, apply, placement)
# system-level (greetd/sway): journalctl -b -u greetd
swaymsg -t get_outputs                        # confirm sway sees the virtual output
swaymsg -t get_tree                           # confirm the Chromium window is placed on it
```

### VM caveats (what the VM **cannot** prove)

- **~1 virtual output.** A VM typically presents a single virtual display, so the VM validates **single-output** placement + the whole cold-boot chain. **Multi-output-per-client placement** (two+ Chromium windows on two+ connectors via the app_id/title disambiguation) and the **real multi-screen wall** stay a **real-hardware** test.
- **Virtual GPU quirks.** The virtual GPU often needs `WLR_NO_HARDWARE_CURSORS=1` (above). If sway still won't render, that *usefully* exercises the **x11-i3 fallback** (`sudo polyptych-agent setup --backend x11-i3 …`) — the same path you'd use for NVIDIA on real hardware.
- **Arch.** The VM proves the **arm64** build; your thin clients are almost certainly **amd64** — build and smoke-test that `.deb` separately.
- **No GPU-accelerated video.** Heavy `video` surfaces may be soft-rendered in the VM; judge media performance on real hardware.

---

## Troubleshooting

### snap Chromium — avoid it
Ubuntu's default `chromium` is a **snap**: confined, slow to cold-start, and awkward about external `--user-data-dir` profile paths (exactly what per-output kiosks need). Use a **`.deb` Chromium** (D27). The package depends on a `.deb` Chromium; if a snap got in first, remove it and install the deb:
```bash
snap list | grep chromium && sudo snap remove chromium
# install a .deb Chromium (e.g. the Ubuntu chromium .deb / a PPA / vendor .deb), then re-run setup
sudo polyptych-agent setup --server-url … --bootstrap-token …
```
If a `.deb` Chromium isn't available for the platform, **`cog` / WPE WebKit** is the documented low-power fallback.

### NVIDIA + Wayland
wlroots (sway) on NVIDIA needs `nvidia-drm.modeset=1` on the kernel cmdline and may need `WLR_NO_HARDWARE_CURSORS=1`. If sway is flaky or won't start, **switch to the x11/i3 fallback** (D9) — that's what it's for:
```bash
sudo polyptych-agent setup --backend x11-i3 --server-url … --bootstrap-token …
```
Verify the GPU/compositor on the **real hardware** before committing a fleet to Wayland.

### "Restore pages" bar appears after a power cut
The `exit_type`/`exited_cleanly` reset isn't taking. Confirm the agent owns the profile path and resets it *before* launch:
```bash
ls /home/kiosk/profiles/                                  # one dir per output ID
grep -o '"exit_type":"[^"]*"' /home/kiosk/profiles/<ID>/Default/Preferences
```
After a clean agent restart it should read `"Normal"`. If a stray snap Chromium is running, its profile is elsewhere — see above.

### Black / blank output, or no Chromium window
```bash
swaymsg -t get_outputs        # is the connector present + active + dpms on?
swaymsg -t get_tree           # is there a Chromium window, and is it on the right output?
journalctl --user -u polyptych-agent -e   # placement errors, respawn loops
```
Common causes: a wrong/absent `--user-data-dir` (second window opened as a tab — should not happen with the per-output dirs), the app_id/title placer not matching (Wayland app_id gotcha), or `swayidle` somehow installed and blanking the screen (it must **not** be present).

### Greetd isn't autologging in
Check the `initial_session` block points at the `kiosk` user and `exec`s sway:
```bash
sudo cat /etc/greetd/config.toml      # [initial_session] command = "sway", user = "kiosk"
systemctl status greetd
journalctl -b -u greetd
```
Re-run `sudo polyptych-agent setup …` to rewrite the config idempotently.

### Agent connects but stays PENDING forever
Expected until an operator **Approves** it in the console (Phase 2b). If it's `server/rejected` instead (bad/missing token), the agent logs it and retries slowly (~60 s). Fix the token (`/etc/polyptych/agent.toml` or re-run `setup`) and restart:
```bash
journalctl --user -u polyptych-agent -e   # look for "enrollment rejected" / "awaiting operator approval"
sudo systemctl restart polyptych-agent
```

### Useful one-liners
```bash
systemctl --user status polyptych-agent
journalctl --user -u polyptych-agent -f
cat /etc/polyptych/agent.toml
swaymsg -t get_outputs ; swaymsg -t get_tree
```

---

## Uninstall / teardown

`setup` has an inverse. `teardown` disables the kiosk chain (greetd autologin, the units, the sway/Chromium session) and returns the box toward a normal server, idempotently:

```bash
sudo polyptych-agent teardown            # disable + remove the wiring, keep the package
sudo polyptych-agent teardown --purge    # also remove /etc/polyptych, the kiosk user, profiles & credential
sudo apt remove polyptych-agent          # or: apt purge, to drop config too
```

---

## Verification checklist — visual cold-boot DoD

Tick these on the VM ([UTM walkthrough](#utm-test-walkthrough-visual-cold-boot)) for the single-output DoD; the ⚠ items need **real multi-output hardware**.

- [ ] `apt install ./polyptych-agent_*.deb` succeeds and pulls deps (sway, `.deb` Chromium, greetd, grim).
- [ ] `polyptych-agent setup …` is idempotent — running it twice converges, no duplicate/broken state.
- [ ] **Cold boot is zero-click:** power on → greetd autologin → sway → agent → kiosk Chromium, **no login prompt, no sleep, no typed password**.
- [ ] The agent connects outbound and the machine appears **PENDING** in the console; **Approve** → its screen renders.
- [ ] Assigning content / switching scenes in the console updates the screen **live, with no browser reload** (< ~150 ms).
- [ ] No "Restore pages" bar, no infobars, no crash bubble on the screen.
- [ ] **Power-cut survival:** hard-kill the VM (simulating the EOD smart-plug) → on next boot the wall returns **clean** to the active scene (no restore bar).
- [ ] **Restart=always:** `systemctl --user kill polyptych-agent` → it (and its Chromium) comes back; manually `kill` a Chromium child → the agent respawns it.
- [ ] No `swayidle` present; `swaymsg -t get_outputs` shows the output **dpms on**; the screen never blanks itself.
- [ ] ⚠ **Multi-output (hardware):** a client with 2+ outputs places a distinct kiosk Chromium on **each** connector (app_id/title disambiguation), each pointed at its own player URL.
- [ ] ⚠ **GPU path (hardware):** the chosen backend renders correctly on the real GPU — Wayland/sway on Intel/AMD, or the x11/i3 fallback on NVIDIA (with `nvidia-drm.modeset=1`, `WLR_NO_HARDWARE_CURSORS` as needed).
- [ ] ⚠ **Full wall (hardware):** the real N-screen wall cold-boots to the active scene end-to-end.
```
