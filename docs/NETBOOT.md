# Polyptic boot (bare box → screen, Secure Boot stays ON): netboot to provision, install to a disk the box owns

Boot a bare machine straight into Polyptic **over the network, into RAM**, no operating system installed, and **Secure Boot left ON**. Power on → the box streams a live Polyptic image from the control plane → it comes up as a named, placed screen. Then, if the box has an internal disk, press **INSTALL** in the console: the disk is wiped into Polyptic's own layout (A/B image slots, encrypted swap, a per-boot-reset scratch overlay) and every later boot reads the OS **from the disk** — no RAM copy, no network in the boot loop, and netboot stays right behind as the automatic recovery. Swap a dead panel like a lightbulb: the replacement is generic, because nothing unique lives on any box's disk — an installed disk carries an image the depot can re-serve to anything, never identity or state.

This answers two problems at once:

1. **No hidden install step.** Nothing has to be installed on the box first. It has no OS until it fetches a *live* one over the network — that is how a fresh box gets far enough to show INSTALL at all. Netboot is the **provisioning path** (first boot, replacement boxes) and the **recovery path** (a disk boot that fails falls through to it); it is the *only* path for boxes with no usable disk, which keep netbooting exactly as before.
2. **Who owns a booting box on a shared LAN?** **Ownership is by key, not by who-answered-the-network-first.** A box belongs to the server whose **enrolment token** its boot chain carries. So Polyptic never runs DHCP, and two control planes on one VLAN (staging next to production) coexist for free, because each box carries exactly one server's key.

And it does both **without touching Secure Boot**, because the first boot stage is Ubuntu's already-signed shim + network GRUB, the exact binaries Canonical ships for its own netboot installer. Polyptic signs nothing and manages no keys. See [Secure Boot](#secure-boot) for precisely what is verified and what is not.

> **amd64 image first, universal medium.** The live image is built for amd64 today, and arm64 is a drop-in follow-up. The boot medium is already **universal**: one `polyptic-boot.img` carries the signed loaders for both arches, and the server-generated boot menu picks the right kernel at boot via GRUB's `$grub_cpu`.

---

## Quick start: end to end (zero to pixels)

Follow these in order. Steps 1-3 run **once** (live image on a Linux build host, boot medium on any macOS or Linux machine, then the control plane), and step 5 is per-box (or one config change for the whole fleet). The later sections drill into each piece.

> **You need:** a **Linux build host** for the live image (`mksquashfs`/`chroot` + `curl`, with `sbsigntool` recommended for the signed-kernel guard, *not* macOS, or just run `deploy/full-rebuild-image-docker.sh`, which does it in a privileged container from anywhere); **any macOS or Linux machine** for the boot medium (`curl`, `ar`, `tar`, `zstd`, `mtools`, no root, no compiler); a **running Polyptic control plane** the boxes can reach over **plain HTTP**; and the target boxes in **UEFI mode**. Secure Boot can stay **ON**. The netboot image needs **no base ISO** because it is built from `ubuntu-base`. Only the optional downloadable live ISO borrows a stock ISO's signed ESP.

**1. Build the three artifacts** (from the repo root):

```bash
deploy/build-agent.sh amd64                                           # → deploy/dist/polyptic-agent-amd64
sudo deploy/build-live-image.sh amd64                                 # Linux only → deploy/dist/image/amd64/{vmlinuz,initrd,rootfs.squashfs}
POLYPTIC_BASE=http://10.0.0.5:8080 deploy/build-boot-medium.sh        # macOS or Linux → deploy/dist/boot/{polyptic-boot.img, shim*.efi, grub*.efi}
```

(The live image bakes in the agent binary, so build the agent first. `POLYPTIC_BASE` is the address your boxes reach the control plane at, baked into the medium. It must be **plain `http://`**, and an IP literal is safest (see [the plain-HTTP contract](#the-boot-depot-server-routes)).)

**2. Point the control plane at the artifacts** and restart it:

```bash
IMAGE_DIST_DIR=/srv/polyptic/image     # copy deploy/dist/image/ here (a mounted volume, the images are large)
BOOT_DIST_DIR=/srv/polyptic/boot       # copy deploy/dist/boot/ here
```

The server's boot banner logs which netboot artifacts it found (live image, boot medium, the four signed loaders) and that Secure Boot is supported, so a mis-pointed dir is obvious at startup.

**3. Verify the depot is serving** (from anywhere that can reach the server):

```bash
curl -s http://10.0.0.5:8080/boot/grub.cfg      # → a GRUB menu with your base + arch selection baked in
curl -sI http://10.0.0.5:8080/dist/image/amd64/rootfs.squashfs | grep -i accept-ranges   # → Accept-Ranges: bytes
```

**4. (Optional but recommended) gate enrolment.** Set an enrolment token (Console ▸ Settings ▸ Enrolment token, or `POLYPTIC_BOOTSTRAP_TOKEN` on the server). Gated mode makes a new box wait for your approval, and open mode auto-approves anything that netboots. Either way, `/boot/grub.cfg` bakes the current token in automatically.

**5. Make a box boot it**, pick **one**:

- **USB dongle (simplest):** Console ▸ Settings ▸ Onboard Screens ▸ **Download bootloader**, then `sudo dd if=polyptic-boot.img of=/dev/sdX bs=4M` to a USB stick. The same stick boots amd64 **and** arm64 boxes, and **Wi-Fi-only boxes too** once you put the network's credentials in `polyptic/wifi.conf` on the flashed stick (wired boxes ignore the file). Plug it in, boot from USB with Secure Boot ON, and take the default (**Polyptic**). See [The boot medium](#the-boot-medium-the-dongle) and [Wi-Fi](#wi-fi-boxes-with-no-wire).
- **No medium, UEFI HTTP Boot:** point the box's firmware Boot URI at `http://10.0.0.5:8080/dist/boot/shimx64.efi` (arm64: `shimaa64.efi`). See [No medium at all](#no-medium-at-all-uefi-http-boot).
- **No medium, site DHCP:** add one option-67 rule to the DHCP you already run. See [Site DHCP option 67](#site-dhcp-option-67-one-change-to-the-dhcp-you-already-run).

**6. First boot → approve → done.** The box streams the image into RAM, boots diskless, and dials in. In **gated** mode it appears **PENDING** under **Console ▸ Machines**. Approve it once and it renders its screen. Place it on a mural like any screen. **Every later cold boot re-attaches automatically** (same stable hardware id + token → no re-approval, placement kept). In **open** mode it's admitted immediately.

**7. Boxes with an internal disk: INSTALL.** The machine's card in the console shows **LIVE** while it runs from RAM, with an **Install to disk** action beside it. Pick the disk (the box reports its own inventory), read the confirmation — it names exactly which disk gets wiped — and watch the progress live. When it finishes, restart the box: from then on it boots from its own disk, faster, with a ~1 GB RAM floor instead of ~3.5 GB, and with netboot as its automatic fallback. See [Installing to the disk](#installing-to-the-disk-the-default-for-boxes-with-one). Keep the USB stick for the next new box — an installed box does not need it.

**Troubleshooting quick hits:**

- Firmware refuses the medium with a **security violation** at power-on → the firmware's `db` lacks the Microsoft **third-party** UEFI CA (some boards ship a "Windows only" policy). Flip the firmware toggle that allows the Microsoft 3rd-party UEFI CA. Do **not** disable Secure Boot, because the chain is signed.
- GRUB stops with **`bad shim signature`** → the depot's `vmlinuz` is not Canonical-signed (modified or corrupted). Rebuild the live image, whose signature guard should have refused this at build time.
- A bare **`grub>` prompt** instead of a menu → GRUB could not find its config. Dongle: check `grub/grub.cfg` exists on the stick. HTTP Boot: check `GET /boot/grub.cfg` **and** `GET /grub/grub.cfg` both return 200.
- Boots GRUB but stalls fetching → GRUB speaks minimal plain HTTP/1.1: **no TLS, no redirects, no chunked responses**, direct 200s with `Content-Length` only. Also expect the GRUB-stage kernel+initrd fetch to run at a few MB/s (tens of seconds). The big root-image fetch happens later, in Linux, at wire speed.
- Downloads the root image then dies in the initramfs → **not enough RAM** (netbooted boxes only — an installed box never copies the image into RAM). dracut pulls the whole squashfs into a RAM tmpfs. Budget roughly **the image size plus the running system's working set** (the initrd raises the tmpfs cap to 90% and warns below the floor). The durable fix for a box with a disk is [INSTALL](#installing-to-the-disk-the-default-for-boxes-with-one).
- Boots the image but never appears in Machines → check the box reaches the control plane, and `journalctl -u polyptic-agent-env` (the identity/cmdline oneshot) on the box.
- **Need a shell on a box?** Power-cycle and pick **Debug console** at the GRUB menu, which is the normal live boot plus a **passwordless root shell on tty9** (`Ctrl+Alt+F9`, and `Ctrl+Alt+F1` returns to the wall). This is the *only* interactive access the image has. The image ships no passwords and no SSH, so a running box is sealed and a debug boot is always a deliberate power-cycle away. It grants nothing an attacker with keyboard + power didn't already have (GRUB configs are unverified in the shim model, so the cmdline was always editable at the menu). The image carries `procps` (`top`, `ps`, `free`) for diagnosing a hot or struggling box.
- A box re-appears as a *new* PENDING machine each boot → its firmware reports no stable DMI UUID and the id fell back to a MAC hash that changed (multi-NIC). See [stable identity](#the-life-of-a-box-power-on-to-pixels).
- A **Wi-Fi box** lands at the "Could not reach the Polyptic control plane" fallback menu → the medium has no local payload for its arch (built LEAN, or without that arch's image), so there is nothing to fall back to. Rebuild the medium after building the arch's live image. If it boots the local payload but never associates → the splash names a rejected `wifi.conf` outright. Otherwise check tty9 (`Ctrl+Alt+F9`, debug boot) with `iw dev`. No wlan device means the adapter's firmware isn't in the curated set (see [Wi-Fi](#wi-fi-boxes-with-no-wire), `FULL_FIRMWARE=1`).

---

## The life of a box, power-on to pixels

This is the **netboot** chain — the provisioning path every box walks at least once, and the only chain for boxes with no usable disk. An [installed box](#installing-to-the-disk-the-default-for-boxes-with-one) replaces the middle of it (kernel, initrd and squashfs come off its own disk, no network) but the enrolment half at the bottom is identical.

```
Boot medium (USB dongle)   or   legacy offloaded ESP entry   or   UEFI HTTP Boot / site DHCP option 67
        │  firmware db (Microsoft UEFI CA 2011) verifies + runs…
        ▼
shim (Microsoft-signed) → verifies + loads → network GRUB "grubnet" (Canonical-signed)
        │  DHCP on each NIC IN TURN, first lease wins, then fetches
        ▼
GET /boot/grub.cfg   (control plane = BOOT DEPOT, ungated)
        │  GRUB menu: control-plane base + (gated) enrolment token baked in from THIS request
        ▼
kernel + initrd over HTTP → GRUB's shim_lock verifier checks the kernel's Canonical
        │  signature ON THE LOADED BUFFER before executing (HTTP or disk, same check)
        ▼
dracut `root=live:…/rootfs.squashfs` curls the WHOLE squashfs into a RAM tmpfs, loop-mounts it
        │  under an overlayfs, NOTHING hits disk
        ▼
Live Polyptic image boots
        │  polyptic-agent-env.service (root, Before=greetd):
        │    • POLYPTIC_MACHINE_ID  ← /sys/class/dmi/id/product_uuid  (MAC-hash fallback)   STABLE per box
        │    • POLYPTIC_SERVER_URL + POLYPTIC_BOOTSTRAP_TOKEN ← /proc/cmdline
        ▼
greetd autologin → sway → the agent dials the control plane (agent/hello, bootstrap token)
        │
        ▼
Enrolment:
   GATED: shows PENDING → operator approves once (Console ▸ Machines) → renders its screen slice.
   Next cold boot: SAME stable id + token → enroll.ts case-4 re-attaches the SAME screen,
     keeps status + placement. No duplicate machine, no re-approval.
```

The **stable machine-id is the whole trick.** A diskless live image regenerates `/etc/machine-id` randomly on every boot, which would make each cold boot look like a brand-new PENDING machine with lost placement. Deriving `POLYPTIC_MACHINE_ID` from hardware (which the agent honours above `/etc/machine-id`) makes the same physical box re-present the same identity forever, so the server's [`enroll.ts` case-4](../packages/server/src/enroll.ts) re-attaches it silently.

---

## Installing to the disk (the default for boxes with one)

A netbooted box pays for its disklessness in RAM and in network dependence: the whole root image sits in a RAM tmpfs all session, and a power cycle cannot end in pixels unless the control plane answers. A box that **has** an internal disk should not pay either price. INSTALL gives the disk to Polyptic — wholly, always wiped — and keeps everything the diskless contract was actually for: **stateless per boot, generic boxes, updates by image id**, now by construction instead of by never writing anything.

### The console flow

All operator intent lives in the console — there are **no install entries in any GRUB menu**, ever. A machine running from RAM wears a **LIVE** chip and an **Install to disk** action. The dialog lists the disks **the box itself reported** (device, size, model, what's currently on it); the confirmation names exactly which disk gets wiped; and once confirmed, the install streams its progress back live (fetching → verifying → writing → boot entry → done), because the operator who clicked is watching.

Mechanically: the agent stays unprivileged — it drops one line (`device=/dev/sdX`) at `/run/polyptic/requests/install`, and a root-owned path unit (`polyptic-install.path`, the same request-file pattern as the reboot flow) runs `install-to-disk.sh`. The installer appends progress lines to `/run/polyptic/install-status`, which the agent relays over the agent WS channel to the console dialog. The outcome also lands in **Console ▸ Activity** (`POST /boot/report`) and in the boot medium's [forensics log](#the-wired-wait-one-card-at-a-time-and-it-talks).

A failure never punishes the room: the box runs from RAM, the wall keeps rendering, the next boot is the same netboot as before. The failure is reported, marked in the progress file, and that is all.

### What lands on the disk

The installer **preflights everything before the first destructive write** — and it fetches + SHA256-verifies a **fresh** build from the depot (per-machine, so roll-out rings are honoured) *before* the wipe. It never copies the image it is running: an install always lands a depot-known build. Then, GPT over the whole disk:

| # | Size | Format | Label / partlabel | Holds |
| --- | --- | --- | --- | --- |
| 1 | 1536 MiB | FAT32 | `POLYPTIC-BT` / `POLYPTIC-ESP` | Signed shim + GRUB at `EFI/polyptic/` **and** the `EFI/BOOT/` fallback (unconditional — this disk is entirely ours); each slot's kernel + LEAN initrd at `/polyptic/boot/<arch>/{a,b}/`; the GRUB config; `wifi.conf`/certs/splash theme copied off the booted medium; the `polyptic/medium-id` marker |
| 2 | 4 GiB | ext4 | `POLYPTIC-A` | Slot A: `rootfs.squashfs` at `/LiveOS/squashfs.img` (the freshly installed build) |
| 3 | 4 GiB | ext4 | `POLYPTIC-B` | Slot B: empty at install — updates stage into whichever slot is inactive |
| 4 | 4 GiB | swap | `POLYPTIC-SWAP` | dm-crypt swap, **re-keyed with a fresh random key every boot** (see below) |
| 5 | rest | ext4 | `POLYPTIC-SCRATCH` | The writable overlay, **wiped by dracut on every boot** |

Disks under ~16 GiB are refused, loudly, before anything is written.

The ESP carries `polyptic/medium-id` (`disk-esp-<timestamp>`) — from that moment **the ESP *is* the box's boot medium**. `find-boot-medium.sh` proves identity by that file's content, so the forensics trail, the splash-theme heal and the A/B kernel staging all work on an installed box unchanged, no special cases.

Finally the installer registers a `Polyptic` UEFI boot entry pointing at the ESP's shim, puts it **first** best-effort, and re-reads NVRAM to check the entry actually exists (the POL-58 verify-don't-assume discipline). Stale entries of ours — a previous `Polyptic`, or the retired offload flow's `Polyptic Netboot` — are pruned first: an install supersedes an offload. But firmware that refuses, drops, or forgets the entry does **not** fail the install: the installer always writes the removable-media fallback loader at `EFI/BOOT/BOOT<arch>.EFI`, post-wipe there is no competing OS on the disk for NVRAM to prefer, and `boot-order.sh` re-asserts any later drift — so a missing entry is reported as the success-with-warning `installed-no-nvram-entry` and the box boots via its default loader path.

### Booting from the disk

```
firmware → `Polyptic` UEFI entry → shim + GRUB on the box's OWN ESP (same signed pair, Secure Boot ON)
        │  menuless: timeout_style=hidden, timeout=1 — a healthy box paints the splash, never a menu
        ▼
kernel + LEAN initrd from the ESP  (set fallback=netboot: if the slot's kernel fails to LOAD,
        │                           GRUB falls through to the stage-1 wired walk → the server's menu,
        │                           and the box streams the OS like an uninstalled box)
        ▼
dracut `root=live:LABEL=POLYPTIC-A` (or -B) loop-mounts the squashfs FROM the slot — no RAM copy,
        │  no network. `rd.live.overlay=LABEL=POLYPTIC-SCRATCH` + `rd.live.overlay.reset=1`:
        │  the writable overlay lives on the scratch partition and dracut wipes it every boot
        ▼
the same live Polyptic image boots — polyptic-agent-env, greetd, sway, agent, enrolment: unchanged
```

The kernel cmdline carries `polyptic.bootpath=disk`, which the box self-reports once per boot (`disk-boot`, state-only — like `wired-boot` it clears a lingering local-fallback flag and never makes a feed line). The hidden menu still honours a keypress during the 1-second window; behind it sit **the other slot** (the previous image, for a keyboard operator after a bad update), **netboot**, and **Debug console**. The automatic fallback deliberately goes to netboot, not to the other slot: GRUB cannot tell a stale slot from a good one, but the control plane always serves a known-good image.

**Swap, privately.** An installed box finally has swap — the pressure-relief valve the diskless box lacked — but swapped pages can carry wall pixels and enrolment tokens, so `POLYPTIC-SWAP` comes up as **dm-crypt with a fresh random key from `/dev/urandom` every boot** (`/etc/crypttab`). The key is never stored; at power-off everything on that partition is permanently unreadable. `nofail` keeps netbooted/live boxes clean — for them the partition simply never appears.

**Statelessness by construction.** The squashfs is read-only; the overlay is reset by dracut itself every boot; the swap is unreadable after power-off. Every boot starts from the pristine image — exactly the diskless contract, without re-downloading a gigabyte to get it.

### Updates: stage always, apply operator-first

The 5-minute update poll (plus a **2-minutes-after-boot** check, so a box powered off overnight catches up immediately) extends the proven A/B medium pattern to the whole OS. The moment the depot serves a newer build for this machine:

1. Kernel + LEAN initrd are fetched into the ESP's **inactive** slot directory; the squashfs is fetched onto the **inactive slot partition** as `.new` and renamed only after its SHA256 check.
2. Everything is verified against the build's `SHA256SUMS`.
3. The GRUB config rewrite is the **last** step — the commit point. Power loss anywhere before it leaves the old config pointing at the old, intact slot. The disk is never half-updated.

The **reboot** — the only disruptive part — is **operator-first**: the poll writes `/run/polyptic/update-state` (`running=` / `staged=`), the agent reports both ids in its heartbeat, and the console wears an **"update ready — reboot to apply"** badge whose reboot rides the existing lifecycle command. The nightly window (03:00–04:59, splayed) remains the backstop so a fleet can never drift indefinitely, and **urgent** still reboots within minutes. A staging that cannot complete skips that round's reboot and retries next poll — the box never reboots onto a half-staged disk.

### Recovery is netboot

There is deliberately **no automatic health-gated rollback between slots**. The recovery story is the one already proven fleet-wide: `set fallback=netboot` in the disk's GRUB config means a slot whose kernel fails to load falls straight through to the same stage-1 wired walk the dongle runs, chains the server's menu, and streams the active image from the control plane — the box comes back as a wall, and the operator fixes the disk at leisure (or just reinstalls). A keyboard operator can also boot the previous image from the hidden menu's other-slot entry.

Firmware fights are watched, not assumed away: `boot-order.sh` runs on every poll and watches whichever entry the box owns — `Polyptic` (installed) or the legacy `Polyptic Netboot` (fielded offloaded boxes, which keep netbooting exactly as before) — reporting drift and, when the operator has opted in, reasserting first place.

### What the installer refuses, and the codes it reports

Nothing is wiped until every check below passes, and every outcome is one code in **Console ▸ Activity** (and the console dialog, and the on-medium forensics log). `installed` is the clean success; `installed-no-nvram-entry` is a success too — with a warning about the firmware's bookkeeping.

| Reported code | What happened | Nothing erased? |
| --- | --- | --- |
| `install-bad-target` | The named device is missing, a partition rather than a whole disk, **removable media**, the very disk the box booted from, or currently mounted — or the request itself was malformed. | yes |
| `install-disk-too-small` | The disk cannot hold the ESP + two 4 GiB slots + swap (< ~16 GiB). | yes |
| `not-uefi` / `no-efibootmgr` / `no-efivars` | Legacy BIOS boot, or the boot-entry tooling/variables are unavailable — probed **before** the wipe, so a doomed install never destroys anything. | yes |
| `depot-unreachable` / `no-loaders` | The depot never answered (after a bounded wait), or answered with an HTTP error for the signed loaders. The image is fetched *before* the wipe, so a network wobble can never leave a wiped, OS-less disk. | yes |
| `install-no-image` | The depot serves no image manifest for this arch — nothing to install. | yes |
| `install-no-tools` | The partitioning toolchain is missing from the image. | yes |
| `install-write-failed` | The wipe, partitioning, formatting, download or verification failed **after** the point of no return. The disk may be part-written; the box itself is untouched (it runs from RAM) and next boot is the same netboot as before. Fix the cause and install again. | no |
| `installed-no-nvram-entry` | **A warning, not a failure.** The install succeeded, but the firmware refused, dropped, or forgot the `Polyptic` boot entry. The box boots via its default loader path (`EFI/BOOT/BOOT<arch>.EFI`, which the installer always writes); if the next boot does not come up, add an entry for `\EFI\polyptic\shim<arch>.efi` in firmware setup, named exactly `Polyptic`. (The installer no longer emits `nvram-*` / `boot-order-not-first` failures — and BootOrder placement was never worth failing on: post-wipe nothing else on the disk competes, and `boot-order.sh` re-asserts later drift.) | disk written, **bootable** |

### What stays true

- **Stateless per boot** — read-only squashfs, dracut-reset overlay, ephemeral-key swap. Nothing a session writes survives a power cycle.
- **Identity and enrolment unchanged** — `POLYPTIC_MACHINE_ID` still derives from hardware, the credential still lives with the agent, nothing identity-shaped is written to the disk. An installed box that dies is replaced by netbooting a blank one.
- **Secure Boot unchanged** — the same pinned, signed shim + GRUB pair, now reading a local config instead of a fetched one; the kernel is verified by `shim_lock` identically (the check was always transport-agnostic).
- **Updates by image id** — the same manifest, the same rings, the same urgency switch; only the mechanics moved from "reboot re-pulls" to "stage, then reboot applies".
- **Netboot unchanged** — the whole chain this document describes still exists and still works; it is simply no longer the *steady state* for boxes that own a disk.

> **Not yet booted on real hardware.** The install flow is pinned off-box (`deploy/live/test/install.test.sh` drives the whole decision tree against stubs), but the first installed boot — in particular the dracut scratch-overlay reset and the encrypted-swap bring-up — calibrates on the existing real-hardware pass.

---

## The boot depot (server routes)

All in [`packages/server/src/provision.ts`](../packages/server/src/provision.ts), alongside `/dist/agent`:

| Route | Gate | What |
|---|---|---|
| `GET /boot/grub.cfg` | **ungated** | The generated GRUB menu: `Polyptic` / `Debug console` / `Watch this screen boot (verbose)`, flat entries (addressed by `--id live|debug|verbose`; the old `offload` entry is retired — [installing](#installing-to-the-disk-the-default-for-boxes-with-one) is a console action now, never a GRUB one). Bakes the control-plane base from the request `Host` and, in gated mode, the current enrolment token into the kernel cmdline. The box has no operator session at boot, so this is ungated. |
| `POST /boot/report` | **token** | How a boot or an install went (boot-path tags, install verdicts, boot-order drift) → one line in the Live Activity feed, or a state-only update on the machine record. The reporter may be mid-boot with no agent session, hence not under `/api/v1`. In gated mode it must present the fleet enrolment token it booted with, and in open mode it is ungated like the rest of the depot. Read-only against the registry, throttled, and the body can only produce one bounded line. |
| `GET /grub/grub.cfg` (+ `/grub/x86_64-efi/grub.cfg`, `/grub/arm64-efi/grub.cfg`) | **ungated** | **Aliases of the same menu**, at the paths an HTTP-booted GRUB actually asks for: grubnet's baked-in prefix is `/grub`, resolved against the **server root** of the host it was fetched from. See [the appendix](#no-medium-at-all-uefi-http-boot). |
| `GET /boot/theme.txt`, `GET /boot/logo.png` | **ungated** | The GRUB theme that makes the menu the [Polyptic boot splash](#the-boot-splash) rather than a text console. Secret-free, and if either fails GRUB shows its plain menu and the box still boots. |
| `GET /dist/image/:arch/{vmlinuz,initrd,rootfs.squashfs}` | **ungated** | The **active** live-image artifacts, streamed with real HTTP **Range** (206/416). The root image is hundreds of MB and streamed into RAM. |
| `GET /dist/image/:arch/builds/:imageId/:file` | **ungated** | The same artifacts for any **retained** build ([Build history](#build-history-and-rollback)). Same Range streaming, same secret-free content. `:imageId` is whitelisted so it cannot walk out of the depot. |
| `GET /dist/boot/:file` | **ungated** | The universal boot medium `polyptic-boot.img`, plus the four signed loaders `shim{x64,aa64}.efi` / `grub{x64,aa64}.efi` (fetched by the disk installer and by UEFI HTTP Boot). All **tokenless**, so ungated like `/dist/agent`. |
| `GET /api/v1/settings/netboot` | **gated** | Operator-facing, secret-free `NetbootInfo{baseUrl, mode, bootConfigUrl, bootMediumUrl}` that drives the Console ▸ Settings ▸ Onboard Screens card. |
| `POST /api/v1/settings/image/activate` | **gated** | Make a retained build the active one, the fleet **rollback** ([Build history](#build-history-and-rollback)). |

**The boot depot is plain HTTP, by contract.** GRUB's HTTP client cannot do TLS, redirects, or chunked encoding, so every asset GRUB fetches must be a direct `200` with a `Content-Length` (the depot also tolerates shim's double-slash request shape, see [the appendix](#no-medium-at-all-uefi-http-boot)). The *root image* is fetched later, by curl inside the initramfs, which is far less fussy, but the depot stays plain-HTTP end to end so one address works for the whole chain. This is deliberate, not an oversight, and it does not weaken the signature chain (the kernel is verified after download, whatever carried it). Treat the depot like any provisioning service: keep it on the LAN / management VLAN the boxes live on. The only secret in the whole flow is the enrolment token, and a leaked token **cannot self-admit** a box, because a new machine lands PENDING until an operator approves it. Regenerating the token re-keys the fleet (see [Ownership](#ownership-keys-and-rotation)). If operators reach the control plane over HTTPS via a proxy, the boxes still need a plain-HTTP path to these routes.

**Serving the artifacts.** Point two env vars at the built directories (they default to `deploy/dist/image` and `deploy/dist/boot` relative to the repo):

```
IMAGE_DIST_DIR=/srv/polyptic/image     # holds <arch>/{vmlinuz,initrd,rootfs.squashfs}
BOOT_DIST_DIR=/srv/polyptic/boot       # holds polyptic-boot.img + shim{x64,aa64}.efi + grub{x64,aa64}.efi
```

The images are large, so mount a volume rather than baking them into the server image, and set the two vars to the mount.

---

## Building the artifacts

### The live image (Linux build host)

> **This build cannot run on macOS.** It needs `chroot` + `mksquashfs`. Install `sbsigntool` too so the signed-kernel guard uses the real signature parser. `deploy/full-rebuild-image-docker.sh <arch>` runs it in a privileged Linux container, so a Mac can drive it. The **pure identity layer** in `deploy/live/` *is* verifiable anywhere: `sh deploy/live/test/identity.test.sh` (also run by `bun test packages/e2e/netboot-identity.test.ts`).

```bash
# 1) the agent binary (seeds the image + the existing depot)
deploy/build-agent.sh amd64

# 2) the live image → deploy/dist/image/amd64/{vmlinuz,initrd,rootfs.squashfs} (+ SHA256SUMS)
#    No base ISO: the rootfs is built up from ubuntu-base, then the SAME `polyptic-agent setup`
#    substrate is installed into it.
sudo deploy/build-live-image.sh amd64
```

The image is built **up from `ubuntu-base`**, not trimmed down from Ubuntu's live-server squashfs. apt installs the kernel, dracut, a curated firmware set and the substrate, and `dracut` then builds the initramfs against that same kernel's modules. What the build guarantees, and why:

- **The kernel ships exactly as Canonical signed it.** `vmlinuz` is the chroot's own `/boot/vmlinuz-<kver>`, the Canonical-signed EFI PE from the `linux-signed` source, the identical binary the live-server ISO carries, delivered by apt instead of by ISO. The build **fails** if the signature is missing, because under Secure Boot GRUB would refuse an unsigned kernel at boot with `bad shim signature`.
- **The kernel cannot drift from its modules.** Kernel, `/lib/modules` and `initrd` all come out of **one apt transaction**, so the old `apt-mark hold` gymnastics (the classic netboot footgun) are structurally gone rather than defended against.
- **The root image is a bare `rootfs.squashfs`.** dracut's netboot mechanism is `root=live:<url>`: `livenet` curls the squashfs into the initramfs tmpfs and `dmsquash-live` loop-mounts it under an overlayfs. No ISO wrapper, no `xorriso`, no casper metadata.
- **Firmware is curated, not complete.** 26.04 splits `linux-firmware` into per-vendor packages, and the image ships `linux-firmware-minimal` plus the two GPU vendors and Realtek NICs. Note that `linux-image-generic` **Depends** on the full `linux-firmware` (~600 MB), which `--no-install-recommends` cannot decline, so the build installs the *concrete* `linux-image-<abi>-generic` instead. A box with unanticipated hardware gets a black screen or a dead NIC, so rebuild with `FULL_FIRMWARE=1` or extend `FIRMWARE_PACKAGES`.
- **RAM sizing:** the squashfs lands in a tmpfs, so a box needs roughly **the image size plus the running system's working set**. The initrd's `polyptic-live` dracut module raises the tmpfs cap from the kernel's default 50% of RAM to 90%, and prints a plain-English message below the floor. Never pass `rd.live.ram=1`, because it `dd`s a *second* full copy of the image into RAM.
- The kiosk browser is **Google Chrome (native Wayland)** where Google ships it: apt + amd64, installed from **Google's own repo**, whose key/list persist into the squashfs so the nightly refresh's plain `apt-get upgrade` tracks the latest stable Chrome (Chrome adds ~300–400 MB, so the previously ~492 MiB amd64 image lands back around ~800 MiB, and the RAM floor must be re-measured). **surf** installs alongside as the fallback, and is all arm64 gets (Google's apt repo serves no arm64 index yet, and `setup` probes for it, so arm64 adopts Chrome automatically once Google publishes), together with `xwayland` (surf is an X11 client) and `xdotool` (surf's on-screen Web Inspector). The agent picks at runtime, and `POLYPTIC_BROWSER` overrides.

### The live ISO (macOS or Linux)

The **no-netboot provisioning option** (and the fastest VM sanity check): wrap the already-built
live rootfs into a stock Ubuntu live ISO that boots from a USB stick / CD / virtual CD, with the
control-plane address + enrolment token baked into the GRUB cmdline. Write it to a stick and boot
the box. It comes up diskless and enrols, the same diskless contract as netboot with no boot
infrastructure.

```bash
POLYPTIC_BASE=http://192.168.1.62:8080 POLYPTIC_TOKEN=lab-token-123 \
  BASE_ISO=~/Downloads/ubuntu-26.04-live-server-arm64.iso \
  deploy/build-live-iso.sh arm64
#   → deploy/dist/image/arm64/polyptic-live.iso  (USB stick, CD, or a UEFI VM's virtual CD)
```

Needs only `xorriso` (`brew install xorriso`), no root, runs on macOS. It lays down the netboot
payload's own `vmlinuz`, `initrd` and `rootfs.squashfs` (build those first on the Linux host). The
squashfs goes to `/LiveOS/squashfs.img`, where dracut's `dmsquash-live` looks, and the cmdline is
`root=live:CDLABEL=POLYPTIC`. It is the **same initrd** the netboot flow uses, two media. `BASE_ISO`
is required *only* for its signed EFI System Partition and GRUB's on-disk prefix. Its kernel, initrd
and squashfs are discarded, so its release does not have to match the payload's.
The token rides the ISO in cleartext, so the FILE is a credential. Share it like one (a leaked
token still only lands new boxes as PENDING).

The default output path (`deploy/dist/image/<arch>/polyptic-live.iso`) is inside the image
depot, so the server serves it at `GET /dist/image/<arch>/polyptic-live.iso` and **Console ▸
Settings ▸ Onboard Screens** lists it under **Recent builds**, one downloadable row per retained build that has one. The baked
cmdline carries `quiet splash plymouth.ignore-serial-consoles`, so the boot shows the Polyptic
Plymouth splash instead of scrolling kernel text. Two load-bearing details behind that: the theme
rides INSIDE the initrd (plymouthd starts long before the squashfs exists), which dracut's own
`plymouth` module handles once `setup` has written `/etc/dracut.conf.d/polyptic-splash.conf` naming
the theme, and `plymouth.ignore-serial-consoles` is required because arm64 VMs get an implicit
devicetree serial console, which otherwise makes plymouth assume a headless server and never paint
the display.

**The remaster pitfall this script exists to avoid:** on post-20.10 Ubuntu ISOs the EFI
System Partition is an **appended partition** that the El Torito catalog points into, not a file
in the ISO tree. A naive xorriso grow/replay repack carries over only the first 2048-byte sector
of the ~5 MiB ESP, so the firmware mounts a FAT whose directory tree is garbage, finds no
`\EFI\BOOT\BOOT*.EFI`, skips the CD, and drops to the UEFI shell (where even the manual
`FS0:\EFI\BOOT\BOOTAA64.EFI` fails with `File Not Found`). The script rebuilds the layout the way
Ubuntu ships it (`-append_partition` + `-e --interval:appended_partition_2:all::`) and
self-verifies that the El Torito image and the appended GPT ESP are the same, byte-identical
region before it will hand you the ISO.

UTM specifics (arm64, Apple Silicon): the display card must be **`virtio-gpu-gl-pci` ("GPU
Supported")**, or sway has no GL renderer and the screen stays black. Leave the drive as a USB CD.
RAM ≥ 2 GiB (the squashfs is mounted off the medium, not copied into RAM). Turn the QEMU
**Hypervisor** (HVF) toggle on, because TCG-emulated boots take many times longer.

### The boot medium (macOS or Linux)

```bash
POLYPTIC_BASE=http://10.0.0.5:8080 deploy/build-boot-medium.sh
#   → deploy/dist/boot/{shimx64.efi, shimaa64.efi, grubx64.efi, grubaa64.efi, polyptic-boot.img}
```

No compiler, no root, no Linux requirement: the prerequisites are `curl`, `shasum`/`sha256sum`, `ar`, `tar`, `zstd`, and `mtools`. The script downloads four **pinned** Ubuntu packages (`shim-signed` + `grub2-signed`, amd64 + arm64), verifies **every download and every extracted binary** against pinned SHA-256 hashes (hard-fail on mismatch), and assembles one FAT32 image:

```
EFI/BOOT/BOOTX64.EFI    shim, amd64 (Microsoft-signed)
EFI/BOOT/grubx64.efi    network GRUB, amd64 (Canonical-signed; shim loads it by this name from its own directory)
EFI/BOOT/BOOTAA64.EFI   shim, arm64
EFI/BOOT/grubaa64.efi   network GRUB, arm64
grub/grub.cfg           stage 1: paint the splash, DHCP all NICs, then chain the server's /boot/grub.cfg (retry menu on failure)
```

Notes that matter:

- `POLYPTIC_BASE` must be plain `http://` (the script rejects `https://` because GRUB has no TLS).
- `grub/grub.cfg` sits at the **volume root**, not next to the EFI binaries, because grubnet's baked-in prefix is `/grub` on whatever device it loaded from, and it never reads a config beside the binaries.
- The stage-1 config on the stick is deliberately dumb and carries only the control-plane address. **The real menu lives server-side** in the generated `/boot/grub.cfg`, so menu changes never require reflashing dongles.
- The pins exist because of SBAT revocation, and are bumped deliberately, never floated. See [Secure Boot](#secure-boot).

---

## The boot splash

A wall screen is public signage. From power-on to content it shows one continuous dark, branded
screen (no console text, no version numbers, no protocol names), because everything in the room can
read it.

The splash has **two painters**, and knowing which is which is the whole trick:

| Who paints | When | What it draws |
|---|---|---|
| **GRUB** | from the moment the loader starts, while it fetches the kernel + initrd | The theme at `GET /boot/theme.txt` + `GET /boot/logo.png`: the Polyptic lockup on `#0b0b0d`, the boot menu, a countdown. |
| **Plymouth** | from early kernel, through the image download, until the player paints | The `polyptic` theme baked into the initrd, with the live status line the dracut module narrates. |

**Plymouth cannot paint the first screen**, however much you want it to. It is a userspace
daemon inside the initramfs, the very thing GRUB is busy fetching while GRUB prints. So the fix runs
the other way. GRUB paints a screen made to look like the splash, and hands its video mode to the
kernel (`gfxpayload=keep`) so Plymouth takes over from the same dark, at the same resolution.

That it costs nothing is a happy accident of what Canonical ships. The pinned **signed** network
GRUB carries a squashfs memdisk holding `fonts/unicode.pf2` plus the `gfxterm`, `gfxmenu` and `png`
modules, on both arches. So `loadfont (memdisk)/fonts/unicode.pf2` needs no network round trip and
no new file on the boot medium. The control plane only has to serve the theme and the logo beside it.
Secure Boot is untouched, because a `grub.cfg` is not signature-verified and the loaders are unchanged.

**Everything graphical is guarded.** The block hangs off `if loadfont …; then`, so a GRUB that cannot
find the font, the modules, or a video mode keeps its text console and boots identically. A theme that
fails to parse, or a `logo.png` that 404s, degrades to GRUB's plain menu. None of it can stop a boot.

Two places to keep in step, because neither can import the other and both end up on a wall:

- `deploy/dongle-grub.cfg.tmpl` carries the stage-1 half (the boot medium has no network yet, so it
  gets the background but not the themed menu), and
  [`render-disk-grub.sh`](../deploy/live/usr/local/lib/polyptic/render-disk-grub.sh) replays the
  template's wired walk verbatim inside an installed box's netboot-fallback entry — kept lockstep by
  `deploy/live/test/render-disk-grub.test.sh`.
- `packages/server/assets/boot-logo.png` is rendered from the **same** `logoSvg()` the Plymouth theme
  uses, because GRUB has no SVG renderer and there is nowhere to rasterise on a box with no OS.
  Rebuild it with `bun deploy/render-boot-logo.ts` whenever the logo or the palette changes.

`packages/e2e/boot-splash.test.ts` diffs all of it: the two shell copies against each other, the theme's
dark against Plymouth's, and the committed PNG against the size the theme asks GRUB to draw.

> **Resolution.** `set gfxmode=auto` makes GRUB **keep the mode the firmware is already in**, consulting
> EDID only if it must change modes and falling back to 800x600 if that fails too. GRUB's mode only has
> to be *something sane*. What the Plymouth splash renders at is settled later, by the real KMS driver
> in the initramfs, which mode-sets the connector's preferred mode. Pinning a resolution here would be
> wrong, because no generic image knows the panel's size.
> Under OVMF/QEMU the whole chain resolves to 800x600 because its GOP starts there and exposes no EDID.
> That is a VM artifact, not what a panel does.

---

## The wired wait: one card at a time, and it talks

Stage 1 used to run `net_dhcp` with no argument. That runs DHCP on **every** card GRUB enumerates,
sharing one retransmit loop, and it does not stop when a card gets an address. It stops when the
**last** card gives up. On a dual-NIC box with one cable in, the empty port therefore held the boot
long after the live port was already online: minutes of `Starting Polyptic ...` on the glass, with the
box looking dead. The initramfs stage had the same failure, fixed the same way.

So stage 1 now walks the cards itself and **takes the first lease**:

```
net_dhcp efinet0 ; set nic_rc="$?"     # 0 = leased; 36 = GRUB_ERR_NET_NO_CARD, i.e. no such port
```

EFI names network cards `efinet0..N` in enumeration order, `net_dhcp` takes a card name, and after a
lease GRUB registers the address in `net_<card>_dhcp_ip`, which is where the screen's
`Got an address (…)` line comes from. **What GRUB cannot do is see carrier**, and it cannot enumerate
its own cards from script (`net_ls_cards` only *prints* them, and GRUB script has no command
substitution). So an unplugged port can no longer outlive a working one, but if the unplugged port is
enumerated **first**, its own DHCP schedule is still paid before the live one is tried. Fixing *that*
means changing the loop inside `grub_cmd_bootp`, a **signed binary Polyptic neither builds nor
touches**. The bare all-cards sweep stays on the failure menu's **Try again**, which is the
escape hatch for a box with more than four ports.

**Watching a boot.** Both menus carry a verbose entry: **Watch this screen boot (verbose)** on the
served menu, **Try again, and show the network conversation** on the medium's fallback menu. It sets
`debug=net,efinet,http` and `pager=1`, so GRUB prints every card, every DHCP packet and every HTTP
request it makes, and (on the served menu) boots the kernel **without** `quiet splash`, so the
transcript carries on into the initramfs instead of disappearing behind the Plymouth splash. It is
never the default. An unattended wall boots the same silent-and-branded path it always did.

---

## The boot medium: the dongle

Download it from **Console ▸ Settings ▸ Onboard Screens ▸ Download bootloader** (`polyptic-boot.img`), then `dd` it to a USB stick. It is **identical for the whole fleet and for both arches** (the per-box identity is derived from each box's own hardware at runtime), so flash one, clone it, and there is nothing unique to prepare per box beyond, optionally, [dropping the site's Wi-Fi credentials](#wi-fi-boxes-with-no-wire) onto the FAT partition. Besides the signed loaders the medium carries a **local boot payload** (kernel + `initrd-wifi` per built arch, in A/B slots the booted box refreshes itself), which is only touched when the wired chain is unreachable. A wired box reads the stick for a few seconds at power-on, exactly as before.

Plug it in and the server-side menu offers flat entries (default after 5 s: the first):

- **`Polyptic`** (`--id live`): boot now, leave the USB in. The box runs fully from RAM and nothing whatsoever is written locally. From here a box with a disk gets [INSTALLED from the console](#installing-to-the-disk-the-default-for-boxes-with-one) and stops needing the stick; a diskless box keeps it in (or keeps netbooting by HTTP Boot/DHCP).
- **`Debug console`** (`--id debug`): the live boot plus a passwordless root shell on tty9 (Ctrl+Alt+F9). The only interactive way into a sealed kiosk image. Never the default.
- **`Watch this screen boot (verbose)`** (`--id verbose`): the live boot with GRUB's own network narration on, for an operator standing at a box (see [the wired wait](#the-wired-wait-one-card-at-a-time-and-it-talks)).

> **The offload entry is retired.** Earlier versions offered **Set up this screen to start without the USB stick**, which copied just the signed loader pair onto the box's *existing* ESP so it could self-boot the netboot chain. [INSTALL](#installing-to-the-disk-the-default-for-boxes-with-one) supersedes it entirely — it ends in a box that needs neither the stick *nor* the network to boot. Boxes offloaded in the field are unaffected: their ESPs still work, they keep netbooting, and `boot-order.sh` still watches their `Polyptic Netboot` entry. Installing on one prunes that entry and takes over.

> **The dongle depends on the firmware bringing the NIC up.** GRUB carries no NIC
> drivers of its own, so `efinet` can only use a card the firmware has already initialised. Most
> real UEFI firmware connects the network stack when the NIC is in the boot order (enable
> network boot / "UEFI network stack" in setup, or one attempted PXE boot). A VM needs the NIC
> given a `bootindex`. If GRUB comes up from the dongle but `net_ls_cards` prints nothing, the
> firmware never touched the NIC. Enable network boot in firmware setup, or prefer
> [UEFI HTTP Boot / DHCP option 67](#no-medium-at-all-uefi-http-boot), where the firmware fetches
> the loader itself and the NIC is up by construction.

---

## Wi-Fi: boxes with no wire

**The short version:** flash the same universal medium, open its FAT partition on any laptop, put the
network's credentials in `polyptic/wifi.conf`, and boot. A wired box ignores the file entirely. A
Wi-Fi-only box boots the medium's local payload, joins the network from the initramfs, and streams
the same live image, so one stick serves the whole fleet.

### Why Wi-Fi needs a local boot stage at all

| Boot stage | Can it do Wi-Fi? |
|---|---|
| Firmware + GRUB (fetch grub.cfg / kernel / initrd) | **No, physically.** GRUB has no WPA supplicant, UEFI network boot is wired-only across the industry, and nothing Polyptic does can change this stage. |
| dracut initramfs (stream `rootfs.squashfs`) | **Yes**: `initrd-wifi` carries wpa_supplicant + every major vendor's wlan drivers and firmware, and associates from the medium's `wifi.conf` before livenet fetches the image. |
| The live rootfs (agent, browser, update poll) | **Yes**: `polyptic-wifi.service` re-reads the same credentials and runs its own supplicant, required even after the initrd associated, because a supplicant must keep running for WPA rekeying. |

So the only stage that needs a wire is the first hop, and that is exactly the stage that already
rides local media. The universal medium's stage 1 is **network-first**. It DHCPs and chains the
server's live menu when a wire works (byte-compatible with the wired flow, fresh token, active
image), and only on failure boots the **local payload**, the medium's own Canonical-signed kernel +
`initrd-wifi`, with `root=live:` **pinned to the build the kernel came from** so kernel and
`/lib/modules` always match. Secure Boot verifies the kernel identically whether GRUB read it from
HTTP or from the FAT.

Everything netboot buys survives on Wi-Fi. The OS still streams from the control plane into RAM at
every boot, the box stays diskless and generic, and updates stay automatic, because the 5-minute poll
**refreshes the medium itself** (new build's kernel + initrd-wifi into the inactive A/B slot,
verified against the depot's `SHA256SUMS`, menu rewritten last so power loss mid-update leaves the
old slot bootable) before rebooting.

A box offline **longer than the depot's retention** comes back to a pin that has been pruned, a 404
it cannot boot past, and it can never boot to earn the refresh that would re-pin it. So the box heals
itself **in the initramfs**, where it still has the network it just joined. When the pinned
image cannot be fetched, it asks `manifest.json` which build is active, boots THAT one (or the
unpinned arch root), and says so, on the splash and off-box as a `pinned-build-missing` boot report,
because the wall is now running a rootfs its on-stick kernel did not ship with. The update poll then
re-pins the medium as it always has, so the fallback fires exactly once. If the kernel and the image
genuinely disagree, the existing recovery path owns it. The running kernel has no `/lib/modules` in
that rootfs, the poll sees the tell, refreshes the medium and reboots into a matched pair. (The
menu's manual **"newest image"** entry survives for an operator standing at a box with a keyboard,
but a wall screen has neither, which is why the fallback is automatic.)

The offline menu also **paints the branded boot splash**, even with no server to fetch the
theme from. `deploy/build-boot-medium.sh` bakes `theme.txt` + `logo.png` onto the medium (fetched
from `GET /boot/theme.txt` at build time, and the theme carries no baked URL, so a local copy renders
identically), and the local menu points `set theme=` at that copy, guarded, so a `LEAN` or
theme-less medium still boots to a plain menu on the correct dark background. An installed box's ESP
(and a legacy offloaded ESP) carries the theme too.

### The credentials file: `polyptic/wifi.conf`

Plain `KEY=value`, one per line. Values run from the first `=` to the end of the line, so SSIDs and
passphrases with spaces/quotes need **no escaping**, and Windows Notepad line endings are fine. The
flashed medium ships an all-comments template of exactly this schema (`deploy/wifi.conf.example`):

```
WIFI_SSID=Your Network Name
WIFI_PSK=your passphrase                  # WPA2/WPA3-Personal (8–63 chars, or the raw 64-hex key)

# WPA-Enterprise (username + password) instead of a PSK:
WIFI_IDENTITY=user@example.org
WIFI_PASSWORD=account password
WIFI_EAP=peap                             # peap (default) | ttls | tls
WIFI_PHASE2=mschapv2                      # mschapv2 (default) | pap (ttls only)
WIFI_ANONYMOUS_IDENTITY=anonymous@example.org
WIFI_CA_CERT=certs/ca.pem                 # optional; the file rides the medium at polyptic/certs/
WIFI_CLIENT_CERT=certs/box.pem            # EAP-TLS: client certificate + key instead of a password
WIFI_CLIENT_KEY=certs/box.key

WIFI_HIDDEN=1                             # SSID not broadcast
WIFI_COUNTRY=GB                           # regulatory domain
```

The file is parsed (never sourced) by the same validated helpers at every stage, and a
present-but-invalid file fails **loudly**. The boot splash names the problem, because a Wi-Fi box
with a typo'd config must say so on the screen the operator is standing at. Bake credentials at
build time instead with `POLYPTIC_WIFI_SSID`/`POLYPTIC_WIFI_PSK` (or `POLYPTIC_WIFI_CONF=<file>` +
`POLYPTIC_WIFI_CERTS=<dir>`) on `deploy/build-boot-medium.sh`, which is also how the read-only
**live ISO** gets Wi-Fi (`deploy/build-live-iso.sh`, same variables, because an ISO can't be edited
after the fact).

**Treat a credentialed medium like a key.** `wifi.conf` holds the network secret in cleartext, and
a payload medium also bakes the enrolment token (the local path can never fetch the server's menu,
so gated fleets must build with `POLYPTIC_TOKEN=`, and without it the local path only enrols on an
open-enrolment control plane). The trust model matches the live ISO's, because a leaked token
still only lands new boxes as PENDING. The EAP identity is fleet-wide per medium, because per-box
enterprise identities would need per-box media, which is out of scope today.

### Installed Wi-Fi boxes

[INSTALL](#installing-to-the-disk-the-default-for-boxes-with-one) copies `polyptic/wifi.conf` (and
`polyptic/certs/`) from the booted medium onto the box's new ESP, so an installed Wi-Fi box carries
its credentials exactly where the stick did and the rootfs `polyptic-wifi.service` reads them
unchanged. Better still, an installed box needs **no network at all to boot** — kernel, initrd and
squashfs all come off the disk (the LEAN initrd, deliberately: the initramfs never has to associate)
— so Wi-Fi only has to come up in the running system, for the agent, the browser and the update
poll. The stick stays the provisioning tool: it is how the box got far enough to be installed, and
how its replacement will.

### What Wi-Fi costs, honestly

- **The medium grows** from ~64 MiB to a few hundred MB per built arch (the wlan firmware is most
  of it, because the fleet's chipsets are unknown, so Intel/Realtek/MediaTek/Qualcomm-Atheros/Broadcom/
  Marvell all ride along). `LEAN=1` still builds the old tiny, tokenless, wired-only dongle, but it
  is an **opt-in escape hatch only**. Nothing selects it for you, because a lean and a
  full medium share a filename and a URL, so a stick that silently cannot boot a Wi-Fi screen is
  worse than no stick at all. A deployment with no live image yet publishes **no medium**, and the
  console says so ("Building the first OS image …") rather than offering a download that lies. Every
  medium ships a sidecar `polyptic-boot.json` saying what it is (`lean`, arches, image ids,
  whether a token is baked), which is what lets the console tell you.
- **Two initrds per build.** The lean `initrd` keeps the wired GRUB-HTTP fetch fast (that fetch runs
  at a few MB/s and is on every wired power-on's critical path), and `initrd-wifi` only ever loads
  from fast local media. Both come from the same dracut run against the same kernel.
- **No zero-media option.** UEFI HTTP Boot / PXE / DHCP option 67 remain wired-only, forever. See
  the table above. A Wi-Fi box needs the stick — kept in until it is
  [installed to its disk](#installing-to-the-disk-the-default-for-boxes-with-one), after which it
  needs neither the stick nor the network to boot.
- **First association is only VM-testable in plumbing** (QEMU emulates no Wi-Fi NIC, and the helpers
  are fully covered by `deploy/live/test/wifi.test.sh` and a `mac80211_hwsim` pass). Real radios,
  real APs and the curated firmware set are only exercised on real hardware.

---

## No medium at all: UEFI HTTP Boot

> **Firmware support varies.** UEFI HTTP Boot needs the firmware's HTTP-Boot driver. Server-class
> and recent desktop firmware ship it. Some builds do NOT. UTM/QEMU's bundled EDK2 for example
> enumerates only "UEFI PXEv4" (no HTTPv4 option), so in those environments use classic PXE
> (DHCP option 67 + TFTP for shim/GRUB, and GRUB still fetches the OS over HTTP) or the dongle with
> the NIC in the boot order. The chain and the server surface are identical either way.

For shops whose hardware or network cooperates, skip the USB entirely, because the **firmware itself** fetches shim over HTTP, and from there the chain is identical (shim → GRUB → `/boot/grub.cfg`). The server side costs nothing extra because it reuses the exact dongle artifacts. But **client support is firmware-dependent**. It is common on 2020+ business desktops (often hidden behind "network stack" / "HTTP boot" toggles) and spotty on older or consumer boards. **Test one unit before planning a rollout.** The dongle remains the guaranteed path.

### Per-box: firmware Boot URI

In firmware setup, enable UEFI HTTP Boot and set the Boot URI to the **signed shim binary**:

```
http://10.0.0.5:8080/dist/boot/shimx64.efi        # arm64 boxes: shimaa64.efi
```

DHCP then only needs to hand out a plain lease, no DHCP changes at all.

### Site DHCP option 67 (one change to the DHCP you already run)

**dnsmasq:**

```ini
# UEFI HTTP Boot, amd64: architecture code 16 (x64 HTTP)
dhcp-match=set:efi-x64-http,option:client-arch,16
dhcp-option-force=tag:efi-x64-http,60,HTTPClient
dhcp-boot=tag:efi-x64-http,"http://10.0.0.5:8080/dist/boot/shimx64.efi"

# UEFI HTTP Boot, arm64: architecture code 19 (arm64 HTTP)
dhcp-match=set:efi-arm64-http,option:client-arch,19
dhcp-option-force=tag:efi-arm64-http,60,HTTPClient
dhcp-boot=tag:efi-arm64-http,"http://10.0.0.5:8080/dist/boot/shimaa64.efi"
```

Three things make this work: the firmware announces vendor class `HTTPClient` with one of the two HTTP-boot architecture codes (**16** = x64, **19** = arm64); option **67 must carry the full URL** to shim (custom port included, it survives the whole chain); and the offer must **echo `HTTPClient` back in option 60** or the firmware ignores it, hence `dhcp-option-force`. Any DHCP server can express the same three rules. Use a real DHCP scope. Proxy-DHCP does not work reliably for HTTP Boot.

> Polyptic still isn't *running* DHCP. You're pointing the one you already have at its boot URL.

### Two protocol quirks the depot absorbs (so you don't have to)

- **shim requests `…//grubx64.efi`, double slash.** shim finds its second stage by taking the URL directory it was fetched from and appending `/grubx64.efi` (`/grubaa64.efi` on arm64), leading slash included. The depot tolerates duplicate slashes, and serves the GRUB binaries in the same `/dist/boot/` directory as shim, which is exactly where shim looks.
- **An HTTP-booted GRUB asks for `/grub/grub.cfg` at the server root.** grubnet's baked-in config prefix is `/grub`. Loaded over HTTP it resolves that against `http://host:port/` (the root of the server it came from), *not* the directory shim was fetched from. That is why the depot serves the same generated menu at `/grub/grub.cfg` (and the per-arch `/grub/x86_64-efi/grub.cfg` + `/grub/arm64-efi/grub.cfg` it probes first) as at the canonical `/boot/grub.cfg`.

---

## Keeping the image updated

A baked image is convenient and immutable, and immediately starts ageing. The update loop closes
that gap with **zero per-box work**. For a netbooted box, a reboot *is* the re-pull, so **an update
is just a rebuilt image plus a reboot**; an [installed box](#updates-stage-always-apply-operator-first)
stages the new build onto its inactive disk slot first, and the reboot then applies it.

**Server side: two scheduled cycles.** Console ▸ Settings ▸ **Image updates** runs rebuild hooks
on two schedules (plus **Refresh now** / **Full rebuild now** buttons). Each hook is a command by
contract. The ready-made Docker ones are:

```bash
IMAGE_REBUILD_CMD="deploy/rebuild-image-docker.sh arm64"            # nightly, default 01:00
IMAGE_FULL_REBUILD_CMD="deploy/full-rebuild-image-docker.sh arm64"  # weekly, default Sun 02:00
```

1. **Nightly refresh** (`deploy/refresh-live-image.sh`): unsquash the CURRENT image,
   `apt-get upgrade` it in a chroot (security + updates pockets), re-squash, and stamp a **new image
   id**. Two deliberate properties: **nothing to upgrade → nothing changes** (no image-id churn, no
   pointless fleet reboots), and **the kernel stays held**, because the refresh does not republish
   `vmlinuz`/`initrd`, so it must not move the ABI out from under the `/lib/modules` it re-squashes.
2. **Weekly full rebuild**: because of that hold, the nightly cycle can never roll a **kernel
   CVE**. The weekly cycle rebuilds the rootfs from `ubuntu-base` (`deploy/full-rebuild-image-docker.sh`
   runs `build-live-image.sh` in a privileged container, and the base tarball is cached under
   `deploy/dist/cache/`), picking up the archive's current Canonical-signed kernel and rebuilding the
   initrd against it. Secure Boot keeps working because any Canonical-signed kernel verifies through
   shim. Everything user-space refreshes nightly and the kernel refreshes weekly.

**Kubernetes.** The Helm chart (`deploy/helm/polyptic`) wires both hooks as
`bun deploy/k8s-run-job.ts refresh|full`. The server creates a privileged rebuild **Job** from a
chart-rendered template on a Linux node, waits, and relays the log tail into the Settings card. The
depot lives on a PVC shared between the server and the Jobs. Day-0 bootstrap is clicking
**Full rebuild now** (the Job pulls `ubuntu-base` straight onto the volume). See the chart README
for the full story, including the dev workflow against a local OrbStack/kind cluster.

**Box side: the poll.** Every netbooted or installed box carries its identity at
`/etc/polyptic/image-id` and compares it against `GET /dist/image/<arch>/manifest.json`
(`{imageId, builtAt, sha256, urgent}`, ungated, secret-free) every 5 minutes — plus a first check
**2 minutes after boot**, so an installed box powered off through the nightly window catches up the
moment it comes back (`polyptic-update-poll.timer`). On a mismatch, a **netbooted** box reboots to
re-pull; an **installed** box [stages first, then waits for the operator](#updates-stage-always-apply-operator-first),
with the same window as its backstop:

- **urgent on** (the Settings switch): reboot **now**, splayed 0–4 min per box (derived from the
  stable machine id) so a wall never hits the depot in unison.
- **urgent off**: netbooted boxes reboot only inside the nightly window (03:00–04:59 local), so a
  01:00 scheduled refresh rolls across the fleet the same night, invisibly. Installed boxes show
  "update ready — reboot to apply" in the console and take the window as the backstop.

Boxes booted from the **live ISO / USB stick never auto-reboot**, because they would re-boot the same
stale medium. The poll guards on `root=live:http…`, which only a netboot cmdline carries (an ISO boot
reads `root=live:CDLABEL=POLYPTIC`). Refresh those by regenerating and re-flashing the ISO
(`deploy/build-live-iso.sh`).

---

## Build history and rollback

The depot keeps the last few builds per architecture, and **one of them is active**. The active build's
artifacts sit at the arch root, exactly where they always have, so `grub.cfg`, the `/dist/image/<arch>/…`
routes, and every USB stick already in a drawer keep working without knowing history exists:

```
<IMAGE_DIST_DIR>/<arch>/
  builds/<imageId>/{rootfs.squashfs,vmlinuz,initrd,SHA256SUMS[,polyptic-live.iso]}   every retained build
  {rootfs.squashfs,vmlinuz,initrd,SHA256SUMS[,polyptic-live.iso]}                    the ACTIVE build
  image-id.txt                                                                       the active build's id
```

A build directory is recognised by its `rootfs.squashfs`. A depot left over from before this layout
(one holding `polyptic.iso`) therefore drops out of the history rather than offering an image the
current boot cmdline cannot use. The next full rebuild re-bootstraps it.

**Rolling back is activating an older build.** In **Console ▸ Settings ▸ Onboard Screens ▸ Recent builds**,
press **Activate** on any retained row (or `POST /api/v1/settings/image/activate {arch, imageId}`). The server
repoints the arch root and republishes `image-id.txt`. Nothing else has to happen: every netbooted box already
compares `manifest.json`'s `imageId` against its own `/etc/polyptic/image-id` every five minutes, so
the fleet re-pulls the older image on the normal policy, within minutes if the roll-out is marked urgent
("Deploy latest to fleet immediately"), otherwise in each box's 03:00–05:00 window.

**Retention** is `IMAGE_RETAIN_BUILDS` (Helm: `imageUpdates.retainBuilds`, default **3**). Pruning drops the
oldest first and never removes the active build, so a fleet parked on an old image cannot have that image
deleted out from under it. Each retained build costs roughly one root image (~500–650 MB) plus its kernel and
initrd on the depot volume. Size `netboot.persistence.size` accordingly. A depot built before this existed is
folded into `builds/` automatically when the server starts.

> **One inode rule worth knowing if you touch the build scripts.** The root and the active build directory
> *share* `rootfs.squashfs` and `polyptic-live.iso` by hardlink, which is why retention is nearly free. They do
> **not** share `vmlinuz`, `initrd`, or `SHA256SUMS`, because `refresh-live-image.sh` writes those with `>` and `cp`,
> which truncate the existing inode in place, and through a hardlink that would silently rewrite a *retained*
> build's artifacts. If you add an artifact that is replaced by `mv`/`rm`+create, it can be shared, and anything
> written in place must be copied. See `SHAREABLE` in `packages/server/src/image-updates.ts`.

---

## Lab: the full netboot chain in a UTM VM

All three flows run end to end in a UTM (QEMU/EDK2, Apple Silicon) VM against a dev control plane
on the host. UTM's firmware has **no HTTP-Boot driver**, so the firmware stage is PXE. Everything
after GRUB is the identical HTTP flow real hardware uses.

**Shared setup:** the VM needs ONE extra virtio NIC whose DHCP can hand out a boot file, and the
NIC must be in the firmware boot order (that is what makes EDK2 initialise it, and GRUB inherits it).
In the VM's QEMU arguments:

```
-netdev user,id=polnet,tftp=/path/to/tftp-root,bootfile=shimaa64.efi
-device virtio-net-pci,netdev=polnet,bootindex=8
```

(Use a bootindex UTM hasn't auto-assigned to a drive. Keep ONE NIC total, because two user-mode NICs
get identical 10.0.2.x subnets and GRUB's routes become ambiguous. RAM ≥ 4 GiB, because dracut
streams the whole root image into a RAM tmpfs.)

- **PXE / "site DHCP option 67" flow:** put `shimaa64.efi`, `grubaa64.efi`, and `grub/grub.cfg`
  (the rendered stage-1 config from `deploy/dongle-grub.cfg.tmpl`) in the TFTP root above. With no
  bootable drives the firmware PXE-boots: shim + GRUB over TFTP, then GRUB fetches
  `/boot/grub.cfg`, kernel, initrd, and the root image from the control plane over HTTP. Power-on
  to wall content takes ~60 s.
- **Dongle flow:** attach `polyptic-boot.img` as a USB **disk** drive. The firmware boots it ahead
  of PXE, and the boot-order NIC is still initialised, so dongle-GRUB is online. ~30 s to content.
- **Install flow:** attach an additional blank VirtIO disk (≥16 GiB), boot the dongle, and press
  **Install to disk** on the machine's card in the console. The installer wipes the disk into the
  [Polyptic layout](#what-lands-on-the-disk), after which the box boots from the disk with the
  dongle removed. A VM exercises none of the firmware states that historically broke boot-entry
  writes on real hardware, which is what `deploy/live/test/install.test.sh` is for: it drives the
  whole decision tree (bad targets, removable media, the booted medium, mounted partitions, small
  disks, an unreachable depot, a firmware that keeps the entry but refuses to reorder, one that
  forgets it) against stubs, on any host.

---

## RAM: netboot needs ~3.5 GB; installed boxes and the live ISO need ~1 GB

The boot paths differ in *where the operating system lives*, and that decides the memory floor:

| Boot path | Where the OS runs from | RAM needed |
| --- | --- | --- |
| Boot medium / netboot (`polyptic-boot.img`) | the whole `rootfs.squashfs` (~1.0–1.1 GiB) is streamed into a **RAM tmpfs** and stays there, alongside the unpacked initrd | **~3.5 GB** |
| **Installed disk** ([INSTALL](#installing-to-the-disk-the-default-for-boxes-with-one)) | the squashfs is loop-mounted **from the slot partition** — it never enters RAM — and the box has 4 GiB of encrypted swap besides | **~1 GB** |
| Live ISO (`polyptic-live.iso`) | the squashfs is read **straight off the USB stick** | **~1 GB** |

The netboot figure is why boxes that own a disk should be installed: the RAM copy is a **permanent
~1 GiB tax for the whole session**, on top of a tmpfs overlay and a multi-process Chrome, with no
swap to relieve any of it — the profile that sat a production box at alarming memory usage
(POL-176/D162). The netboot numbers below still matter, because netboot remains the provisioning and
recovery path every box must be able to walk.

> **The netboot figures above are ESTIMATES pending the first post-Chrome build.** Adding Google
> Chrome (~300–400 MB) to the root image is what took the squashfs from ~700 MiB
> to ~1.0–1.1 GiB and the floor from ~2.5 GB to ~3.5 GB. Re-measure `rootfs.squashfs` on the first
> full rebuild and correct **both** this section and the floor in
> `deploy/live/usr/lib/dracut/modules.d/50polyptic-live/polyptic-ram.sh`, which quotes the same numbers.
> The **boot medium itself is unaffected**, because it carries only `vmlinuz` + `initrd-wifi`. The
> squashfs is streamed, never written to the stick (an installed box's disk, of course, carries it — that is the point). The **live ISO** does carry
> the squashfs, so that file grows by the same ~300–400 MB (still comfortably on a 2 GB stick), but
> its RAM floor does not, because it mounts the image from the medium instead of RAM.

Both floors dropped by roughly a factor of two when the root image stopped being a 1.4 GiB casper
ISO and became a bare squashfs. Shipping every major vendor's Wi-Fi firmware in the root image then
raised the netboot floor ~half a GB, and Chrome raised it again. Measured on the 26.04
arm64 build (with the Wi-Fi firmware and the KMS drivers below): `rootfs.squashfs` **689 MiB**, lean `initrd`
**137 MiB** (wired GRUB fetch, wlan-firmware-free by construction), `initrd-wifi` **210 MiB** (local
media only), `vmlinuz` **23 MiB**. The universal medium with one arch's payload is a **~490 MiB**
image file (amd64 measures close by at 138/194 MiB).

The initrd also carries the real KMS drivers, without
which the boot splash is stuck at the firmware's framebuffer resolution. Expect roughly **+13 MiB on
arm64** and **+47 MiB on amd64** (where the Intel and AMD graphics firmware blobs ride along). The
floors above are unchanged, because an initrd of that size is noise next to the ~500 MiB root image.

The image still lands in the initramfs tmpfs, which the kernel caps at **50 % of RAM** by default,
so the naive ceiling would be twice the image. The initrd's `polyptic-live` dracut module
(`deploy/live/usr/lib/dracut/modules.d/50polyptic-live/`) raises that cap to 90 % before livenet
fetches anything, and below ~3 GB of RAM it prints a plain-English message naming the live ISO as
the fix, rather than failing minutes later with a bare `No space left on device`.

If you see that message, the box is out of RAM. Nothing is wrong with the network or the image. If
the box has an internal disk, netboot it once with enough headroom (or on a temporarily lighter
image) and [INSTALL](#installing-to-the-disk-the-default-for-boxes-with-one) — an installed boot
never pays the RAM copy. Otherwise use the live ISO for that box, or fit more memory.

> **Never pass `rd.live.ram=1`.** It makes dmsquash-live `dd` a *second* full copy of the image into
> RAM on top of the one livenet already downloaded. The generated `/boot/grub.cfg` never emits it, and
> a netboot e2e test asserts its absence.

---

## Troubleshooting: the control-plane address is BAKED into boot media

When the control plane's address changes, **every previously-built medium goes stale at once**.
Know the symptoms:

| Medium | Symptom when the baked address is dead |
| --- | --- |
| Dongle / legacy offloaded disk | GRUB says **`Could not reach the Polyptic control plane at …`** and drops to the fallback menu (`Try again / Restart this screen / Firmware setup`), because `configfile $net/boot/grub.cfg` can't fetch the server menu. |
| Installed disk | The box **boots fine** (nothing network is in the boot loop) but sits at **"Starting up"** — the agent can't reach the `polyptic.server_url` baked into the disk GRUB's cmdline — and updates stop (the poll's manifest URL is baked the same way). The netboot *fallback* entry carries the same stale address. |
| Downloadable live ISO | Boots normally all the way to the splash, then sits at **"Starting up"** forever, because the agent can't reach `polyptic.server_url` on its cmdline. The box never appears in the console. |
| Server env `PLAYER_BASE_URL` | The sneakiest one: the box boots, **enrols, and shows Online in the console**, but the screen shows a white page reading **"Operation was cancelled"** (WebKit's error page). The agent reached the server fine, but the *browser* couldn't load the player from the stale `PLAYER_BASE_URL` the server advertises. The agent's own capture thumbnail (Machines view) shows the same white page, which is how you tell it's the guest's browser, not the display. Restart the server with the corrected `PLAYER_BASE_URL`, and agents re-apply on reconnect. |

What carries a baked address (goes stale when the server moves):

- the **dongle**'s stage-1 `grub/<arch>-efi/grub.cfg` (`set net=(http,HOST:PORT)`),
- a **legacy offloaded disk's ESP** (the same stage-1, copied at offload time),
- an **installed disk's ESP** (`render-disk-grub.sh` bakes `polyptic.base`/`polyptic.server_url` into
  the cmdline and the netboot-fallback entry's `set net=` — regenerated from the *same baked address*
  at every staged update, so it heals on rename only if the old name still resolves),
- the **live ISO**'s kernel cmdline (`polyptic.base` / `polyptic.server_url` / token).

What does **not** (server-derived per request, immune to moves): the netboot payload
(`rootfs.squashfs`), `/boot/grub.cfg` menu URLs, the update-poll manifest. All derive from the HTTP
`Host` header of the request that fetched them.

Fixes, fastest first:

1. **Re-bake the media** for the new address: `POLYPTIC_BASE=http://<new-host>:8080
   deploy/build-boot-medium.sh` and re-download/rebuild the live ISO (`deploy/build-live-iso.sh`).
   Reflash sticks, re-attach ISOs.
2. **Patch an offloaded ESP in place** (no reflash, handy for VMs): find the ESP partition offset
   in the disk image (GPT LBA×512), then
   `mcopy -i "<disk.img>@@<offset>" ::/grub/arm64-efi/grub.cfg /tmp/g && sed -i '' 's/OLD:8080/NEW:8080/' /tmp/g && mcopy -o -i "<disk.img>@@<offset>" /tmp/g ::/grub/arm64-efi/grub.cfg`.
3. **The real fix: bake a NAME, not an IP.** Give the control plane a stable DNS name (in
   Kubernetes: the chart's `ingressRoute.bootHost`, a plain-HTTP Traefik router for the boot
   paths) and build all media against `http://boot.your-domain`. Media then survive any move of
   the control plane. (dracut's initramfs fetches the image with **curl**, which resolves names,
   follows redirects and retries.)

Related black-screen gotcha (not address-related): a UTM VM whose display is `virtio-gpu-pci`
(no GL) boots to the splash and then goes **black**, because sway has no GL renderer. Use
`virtio-gpu-gl-pci` ("GPU Supported").

---

## Secure Boot

**It stays on.** That is the point of the signed chain, and the reason the loader is Ubuntu's shim + GRUB rather than anything Polyptic compiles.

**What it is.** Secure Boot is a UEFI feature that will only run a boot binary whose cryptographic signature chains to a key the firmware trusts (its `db` keystore, which normally holds Microsoft's keys). It exists to stop a machine booting tampered or unauthorised early code, a bootkit.

**How the chain verifies.** The first stage is Ubuntu's **shim**, signed by Microsoft's third-party UEFI CA, which virtually every UEFI machine already trusts. shim embeds Canonical's certificate and uses it to verify the second stage, Ubuntu's **network GRUB** ("grubnet"). GRUB, running under Secure Boot, registers a `shim_lock` verifier. When a menu entry's `linux` command loads the kernel, the **whole kernel is read into memory first and its Canonical signature is checked on that buffer** before any of it executes. The check is transport-agnostic, so a kernel fetched over plain HTTP is verified exactly like one read from disk, and booting over the LAN subtracts nothing from the chain. An unsigned or tampered kernel stops the boot with `bad shim signature`.

```
firmware db (Microsoft UEFI CA 2011)
  → shim 15.8 (Microsoft-signed)
     → grubnet (Canonical-signed; verified against shim's embedded certificate)
        → vmlinuz (Canonical-signed; verified by GRUB's shim_lock on the loaded buffer)
           → initrd, rootfs.squashfs (NOT signature-verified, by design; see below)
```

Polyptic signs **nothing** and manages **no keys**. Every verified stage is a byte-identical redistribution of binaries Canonical ships for its own netboot installer, and the kernel in the live image is the Canonical-signed one apt installs from `linux-signed` (the image build refuses to package anything else). Building the rootfs from `ubuntu-base` rather than from a live ISO changes **who carries the kernel**, not what it is. `linux-image-<abi>-generic` is the same signed PE the ISO ships, and the build's `sbverify` guard checks the signer either way.

**What is verified, and what is not.**

| Stage | Signature-verified? | By |
|---|---|---|
| shim | **yes** | the firmware `db` (Microsoft UEFI CA 2011) |
| GRUB (grubnet) | **yes** | shim's embedded Canonical certificate |
| kernel (`vmlinuz`) | **yes** | GRUB's `shim_lock` verifier, on the loaded buffer, any transport |
| GRUB config (`/boot/grub.cfg`) | no | config files are exempt in this model |
| `initrd` | no | explicitly exempt (`GRUB_VERIFY_FLAGS_SKIP_VERIFICATION`) |
| `rootfs.squashfs` | no | fetched by the initramfs (dracut's curl) after the verified kernel is running |

The unverified rows are **not a Polyptic shortcut but the standard shim model**, the same boundary every stock Ubuntu machine boots with (Ubuntu's own security documentation states that initrd images aren't validated). Building the initrd with dracut changes nothing here, because an unsigned dracut initramfs is exactly as legitimate to shim as the unsigned casper initrd it replaced. Secure Boot's job is to guarantee the machine only executes signed early-boot code: firmware, loaders, kernel. The initrd and root image are trusted the way the rest of Polyptic is. They come from **your** control plane over **your** LAN, addressed by the boot config, and a box that boots them still cannot self-admit, because it lands PENDING until an operator approves it. Extending signature coverage to the initrd and cmdline is possible via a **UKI** (a unified kernel image: kernel + initrd + cmdline sealed in one signed PE), at the cost of signing every image build, exactly the key management this design avoids.

**SBAT: why the loader versions are pinned.** Beyond signatures, shim enforces **SBAT**, a generation-based revocation scheme: firmware carries a minimum-generation list (advanced over time by Ubuntu updates, and even by Windows on dual-boot hardware), and a loader below the minimum is refused *even though its signature is valid*. This is why `deploy/build-boot-medium.sh` pins **exact package versions with SHA-256 hashes** instead of fetching "latest". The GA noble GRUB build carries an SBAT generation that is **already revoked** on up-to-date firmware, and the shim packages also contain a `.signed.previous` binary (shim 15.4) that is revoked everywhere. Both are one careless download away. The pinned pair (shim 15.8, GRUB 2.12 from noble-updates) survives every SbatLevel published as of 2026-07. When Ubuntu ships new signed loaders (a security notice against `shim-signed` / `grub2-signed`), **bump the pins deliberately**: update the deb URLs + hashes in the script, rebuild the medium, then reflash sticks and reinstall installed boxes (the disk installer fetches the loaders from the depot, so a reinstall picks up the new pair). Never ship the `.previous` binaries, and never relax the pin to "whatever is newest".

**Firmware caveats.** A minority of x86 boards ship a "Windows only" Secure Boot policy whose `db` lacks the Microsoft **third-party** CA that signs shim, so they refuse the medium at power-on with a security violation. The fix is a firmware toggle (usually named like "Allow Microsoft 3rd Party UEFI CA"), not disabling Secure Boot. Very new machines that enrol only Microsoft's 2023 UEFI CA may likewise refuse the 2011-signed shim. If you hit one, check for a newer `shim-signed` to pin.

**Secure Boot off also works.** The same medium boots with Secure Boot disabled (shim prints "Booting in insecure mode" and carries on), with no rebuild and no config change. Useful for lab VMs with no certificates enrolled, but it does not exercise the verified chain, so test at least one unit with Secure Boot ON.

---

## Ownership, keys, and rotation

- **Ownership = the boot key.** Whoever can make a box chain `<base>/boot/grub.cfg` (via dongle, UEFI HTTP Boot, or site DHCP) — or whoever installed the box's disk — enrols it against that server. Multiple Polyptic instances on one network = different keys, zero collision.
- **The enrolment key is a standing fleet secret, by design.** It lives in the boot chain (USB / a legacy offloaded ESP / DHCP), and on an installed box it is baked into the disk GRUB's cmdline (the token authenticated the fleet the box was installed into; the ESP is protected by the box being a sealed kiosk, and a leaked token still only lands new boxes as PENDING). **Regenerate** the enrolment token (Console ▸ Settings ▸ Enrolment token) to re-key the fleet. The change is live on the next `agent/hello` *and* the next `GET /boot/grub.cfg`, so boxes re-pend until re-keyed. The **wired** netboot path stays tokenless on the media (the token arrives with the server's menu), so wired sticks never need reflashing on rotation. A medium built with a **local Wi-Fi payload** bakes the token into its local menu. After a rotation, rebuild those media (`deploy/build-boot-medium.sh`, and on Kubernetes a `helm upgrade` re-runs the boot-medium Job, which lifts the current token from `/boot/grub.cfg` automatically) or edit the `polyptic.token=` value in `/grub/local-<arch>.cfg` on the FAT. Legacy offloaded Wi-Fi ESPs likewise carry the token and want the same edit. An installed box's ESP config carries the token too (the update poll regenerates the config, but from the *booted* cmdline's token, so a rotation does not propagate by itself) — the enforcement point for installed boxes is the server: they re-pend on the next hello until re-keyed, and a reinstall or an ESP edit refreshes the baked copy.
- **Token exposure is bounded and matches the trust model.** `GET /boot/grub.cfg` serves the token ungated, and it appears in `/proc/cmdline` on the booted kiosk. It is only a *coarse* filter, because a valid token on a **new** box lands it **PENDING**, and an operator still approves it under Machines before it renders anything. Keep the provisioning network operator-only. A LEAN (wired-only) medium is tokenless, so possession of one grants nothing beyond "reach `/boot/grub.cfg`". A medium carrying the Wi-Fi local payload bakes the token and is a credential, so treat the downloaded `.img` like one on gated fleets.
