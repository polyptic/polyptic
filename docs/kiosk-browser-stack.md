# Generic kiosk browser + display stack — design

> Status: **proposed** (2026-06-30). A design for making Polyptic's per-screen browser render on
> **all** hardware/OS, not a one-off for the UTM/QEMU arm64 test box. Supersedes the surf/cog choice
> (D27). **Implement only after the de-risking experiment in §6 passes on real hardware.**

## TL;DR

- **One engine fleet-wide: Chromium / Blink** — the engine the agent already drives. Only the
  *delivery channel* varies per box; the launch flags are identical everywhere.
- **Delivery: native-first, Flatpak as an online-only escape hatch.** Native real packages on
  Debian (`apt`), Fedora (`dnf`), Arch/ALARM (`pacman`) — all genuine upstream Wayland/Ozone builds
  on amd64 **and** arm64. **Ubuntu is the only distro with no real Chromium in its archive** — fill
  the hole with the **xtradeb PPA** real `.deb` (or a vendored Debian `chromium` deb). **Never the snap.**
- **Drop surf and cog as the answer.** surf is X11-only (no Wayland); cog isn't packaged on Ubuntu
  and hard-fails on the no-3D virtio-gpu. Keep both in-tree as documented niche/emergency only.
- **Compositor stays sway** (cage can't place different URLs per output — DRM master is exclusive).
- **Render = detect-and-branch** (no single flag does both): a fact-based GPU probe decides
  software vs hardware. **The missing piece that's been biting us:** the *browser* needs an explicit
  `--disable-gpu` on the software branch — Chromium defaults to ANGLE and does **not** honour the
  inherited `LIBGL_ALWAYS_SOFTWARE` for its GPU process. (Keep that env for the compositor only.)
- **No pre-baked image needed** for the stated matrix (Ubuntu/Debian/Fedora/Arch × amd64/arm64 ×
  real/no-3D GPU × Wayland/X11, online or air-gapped). An image is the honest fallback only for
  exotic cells (musl/Alpine; immutable + air-gapped + arm64 + NVIDIA-on-Wayland compounded).

## Evidence (grounded; each with a source)

- Native Chromium is real on Debian/Fedora/Arch, both arches (distro archives;
  `packages.debian.org/chromium`, Fedora `dnf`, `archlinuxarm.org`).
- Ubuntu `chromium-browser` is a **transitional snap shim** (deb→snap since 19.10) — auto-refresh
  breaks kiosk determinism, confinement breaks arbitrary `--user-data-dir`, air-gap-hostile.
  <https://discourse.ubuntu.com/t/call-for-testing-chromium-browser-deb-to-snap-transition/11179>.
  **Verified in-repo:** the chromium we vendored for ubuntu-26.04/arm64 IS that snap shim — replace it.
- xtradeb PPA ships a **real arm64 Chromium `.deb`** for noble (149.x, 2026-06-25), covering
  22.04/24.04/25.10/26.04. Verified via Launchpad API
  `~xtradeb/+archive/ubuntu/apps?ws.op=getPublishedBinaries`. *Caveat:* single-maintainer supply
  chain; verify on the target before locking in.
- Flatpak `org.chromium.Chromium` is one app-id for x86_64 **and** aarch64 on all four distros
  (<https://flathub.org/apps/org.chromium.Chromium>) — **but Flatpak offline is broken** (no
  collection-id on Flathub, air-gapped installs fail to resolve dl.flathub.com; flatpak issues
  #676/#5484 open) → Flatpak is the escape hatch, **not** the air-gap backbone.
- Chromium auto-uses real GL where present and falls back to software (Skia/`wl_shm`) for 2D on a
  no-3D GPU — does **not** handicap real GPUs.
  <https://github.com/chromium/chromium/blob/main/docs/gpu/swiftshader.md>.
- **No single flag keeps HW accel on a real GPU and forces software on a no-3D GPU — mutually
  exclusive** → detect-and-branch. WebGL on a no-3D box now needs explicit `--enable-unsafe-swiftshader`
  (<https://chromestatus.com/feature/5166674414927872>). `--use-angle=vulkan` is rejected under
  `--ozone-platform=wayland` (<https://issues.chromium.org/issues/334275637>), so the software branch
  is `--disable-gpu` (2D/video) or `--use-gl=angle --use-angle=swiftshader` (WebGL).
- wlroots' own software-detect criterion is EGL `EGL_MESA_device_software` / `GL_RENDERER` matching
  `llvmpipe|softpipe|swrast` — reuse it as the agent's probe so it never disagrees with whether sway
  will run (<https://github.com/swaywm/wlroots/commit/6becc69ec90c2300d974e653ca50d2d33cf94c00>).
- **NVIDIA proprietary on wlroots-Wayland is genuinely unreliable** (GBM/modifier crash, blank
  window); X11 is NVIDIA's best path (<https://github.com/swaywm/sway/issues/6650>). → route NVIDIA
  to the in-tree X11/i3 backend.
- **Unverified / flagged:** arm64 Flatpak Chromium as a fullscreen kiosk on a real panel is not
  empirically confirmed — treat arm64 = native-only until launched-and-seen.

## How each hard case is handled

| Case | Mechanism |
|---|---|
| **NVIDIA (Wayland)** | detect `nvidia` DRM driver → route to **X11/i3** backend + native Chromium (`--ozone-platform=x11`); never wlroots-NVIDIA, never Flatpak (driver-matched GL extension = air-gap trap) |
| **arm64** | **native packages only** (Debian/Fedora/ALARM real arm64; Ubuntu via xtradeb/Debian deb). Flatpak arm64 unselected until verified |
| **headless server-minimal** | unchanged: greetd → launcher → sway/i3 → agent → Chromium-per-output; installs a compositor, never a DE |
| **air-gapped** | native `.deb`/`.rpm`/pkg baked into the live image (make `build-live-image.sh` install a **real** Chromium, not surf/snap). Flatpak explicitly **out** unless operator runs a signed OSTree repo |
| **no-3D / software-GL** | GPU probe → `render=software` → Chromium `--disable-gpu` (2D/video) or SwANGLE (WebGL), **explicitly** |
| **X11-only / legacy** | existing X11Backend (`--ozone-platform=x11 --window-position/-size`) — Chromium-on-X11 is the uniform X11 answer (drop surf/cog) |

## What changes in Polyptic

1. **`backends/chromium.ts` — keep; add a render-aware software branch to `buildChromiumArgs`.**
   Add `render?: "hardware"|"software"` + `webgl?: boolean` to `ChromiumLaunchSpec`; on `software`
   append `--disable-gpu` (default) or `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`
   (webgl). **This is the single most important fix** — the inherited env is not deterministic for
   Chromium. Keep `LIBGL_ALWAYS_SOFTWARE` for the *compositor* only.
2. **`backends/browser.ts` — add `flatpakChromium`** (`resolveBin→'flatpak'`, `buildArgs→['run','org.chromium.Chromium',...buildChromiumArgs(spec)]`), selected by `POLYPTIC_BROWSER=flatpak-chromium`.
   **Demote surf/cog** to documented emergency; fix the stale "cog is the Ubuntu answer" comment.
3. **Compositor stays sway.** Do **not** switch to cage (single-app; can't do per-output URLs).
4. **`backends/select.ts` — real auto-detect:** Wayland-vs-X + `nvidia` DRM driver → choose
   `x11-i3` for NVIDIA, `wayland-sway` otherwise (today it always returns `dev-open`).
5. **GPU probe baked into the agent** (zero runtime dep): no `renderD*` → software; read `DRIVER=`
   from `/sys/class/drm/*/device/uevent` to route; authoritative EGL+GBM probe (`EGL_MESA_device_software`
   / `GL_RENDERER` substring) for the verdict; keep the `FAST_EXIT_SECS=8` crash-timer as safety net.
6. **Fix the auto-flip env-propagation gap** (`templates.ts`): when `auto` flips to software *after*
   a fast crash, the already-running agent doesn't see it. Persist the verdict to a file the agent
   reads per launch (the probe largely pre-empts this by deciding before first launch).
7. **`setup/browser.ts`** — Ubuntu path prefers a vendored real `.deb` (xtradeb/Debian), **never**
   the snap; add an online-only `flatpak` branch. **`setup/distro.ts`** — flatpak optional only.
8. **`deploy/build-live-image.sh`** — replace `surf` with a real Chromium deb in the image's apt set.
9. **`docs/DECISIONS.md`** — supersede D27: "native Chromium deb (xtradeb/Debian) + Flatpak escape
   hatch; sway + X11/i3-for-NVIDIA; detect-and-branch render", drop "cog/surf is the Ubuntu answer".

## Phased plan

1. Render branch (no delivery change): `buildChromiumArgs` software flags. **Highest value.**
2. GPU probe + cache the verdict; feed compositor env *and* Chromium flag; fix the auto-flip gap.
3. Ubuntu native deb in the image: vendor a real arm64 Chromium; drop surf and the snap.
4. Backend auto-detect + NVIDIA→X11 routing in `select.ts`.
5. Demote surf/cog; add `flatpakChromium`; update D27.
6. Later: dnf/pacman offline bundling; optional self-hosted OSTree repo for air-gapped Flatpak sites.

## First experiment (run on the test VM BEFORE any of the above)

De-risk the three load-bearing claims in one run. On wall1:
```
sudo add-apt-repository -y ppa:xtradeb/apps && sudo apt update && sudo apt install -y chromium
readlink -f "$(command -v chromium)"        # must NOT be under /snap
# under the already-working software-mode sway session:
chromium --ozone-platform=wayland --app=http://192.168.64.1:5173/?screen=<id> --kiosk \
         --user-data-dir=/tmp/p1 --disable-gpu --no-first-run
```
**Success = a fullscreen page paints with no black-flash and no GPU crash-loop** on the no-3D
virtio-gpu. That validates: (a) a real `.deb` Chromium exists for Ubuntu arm64, (b) `--disable-gpu`
deterministically paints on a no-3D GPU under a pixman compositor, (c) the agent's existing flags
pass straight through. If it paints, the whole native-first design is de-risked. If the deb is wrong
or won't paint, vendor the **Debian `chromium` deb** before touching any other phase.
