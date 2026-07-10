# Polyptic netboot (bare box → screen, no OS install, Secure Boot stays ON)

Boot a bare machine straight into Polyptic **over the network, into RAM**, no operating system installed, nothing written to the disk, and **Secure Boot left ON**. Power on → the box streams a live Polyptic image from the control plane → it comes up as a named, placed screen. Swap a dead panel like a lightbulb: the replacement is generic, because nothing unique ever lived on its disk.

This is the answer to two problems at once (POL-33 / [D46](DECISIONS.md), loader pivoted to the signed chain in [D47](DECISIONS.md)):

1. **No hidden install step.** The old `curl … | sh` one-liner needed an OS on the box first, and it is gone (D58). Netboot removes the step entirely: the box has no OS until it fetches one, and it fetches a *live* one that never touches disk.
2. **Who owns a booting box on a shared LAN?** **Ownership is by key, not by who-answered-the-network-first.** A box belongs to the server whose **enrolment token** its boot chain carries. So Polyptic never runs DHCP, and two control planes on one VLAN (staging next to production) coexist for free, each box carries exactly one server's key.

And it does both **without touching Secure Boot**: the first boot stage is Ubuntu's already-signed shim + network GRUB, the exact binaries Canonical ships for its own netboot installer. Polyptic signs nothing and manages no keys. See [Secure Boot](#secure-boot) for precisely what is verified and what is not.

> **amd64 image first, universal medium.** The live image is built for amd64 today; arm64 is a drop-in follow-up. The boot medium is already **universal**: one `polyptic-boot.img` carries the signed loaders for both arches, and the server-generated boot menu picks the right kernel at boot via GRUB's `$grub_cpu`.

---

## Quick start: end to end (zero to pixels)

Follow these in order. Steps 1-3 run **once** (live image on a Linux build host, boot medium on any macOS or Linux machine, then the control plane); step 5 is per-box (or one config change for the whole fleet). The later sections drill into each piece.

> **You need:** a **Linux build host** for the live image (`mksquashfs`/`chroot` + `curl`, with `sbsigntool` recommended for the signed-kernel guard, *not* macOS — or just run `deploy/full-rebuild-image-docker.sh`, which does it in a privileged container from anywhere); **any macOS or Linux machine** for the boot medium (`curl`, `ar`, `tar`, `zstd`, `mtools`; no root, no compiler); a **running Polyptic control plane** the boxes can reach over **plain HTTP**; and the target boxes in **UEFI mode**. Secure Boot can stay **ON**. The netboot image needs **no base ISO** — it is built from `ubuntu-base`; only the optional downloadable live ISO borrows a stock ISO's signed ESP.

**1. Build the three artifacts** (from the repo root):

```bash
deploy/build-agent.sh amd64                                           # → deploy/dist/polyptic-agent-amd64
sudo deploy/build-live-image.sh amd64                                 # Linux only → deploy/dist/image/amd64/{vmlinuz,initrd,rootfs.squashfs}
POLYPTIC_BASE=http://10.0.0.5:8080 deploy/build-boot-medium.sh        # macOS or Linux → deploy/dist/boot/{polyptic-boot.img, shim*.efi, grub*.efi}
```

(Order matters for the first two: the live image bakes in the agent binary, so build the agent first. `POLYPTIC_BASE` is the address your boxes reach the control plane at, baked into the medium; it must be **plain `http://`**, and an IP literal is safest, see [the plain-HTTP contract](#the-boot-depot-server-routes).)

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

**4. (Optional but recommended) gate enrolment.** Set an enrolment token (Console ▸ Settings ▸ Enrolment token, or `POLYPTIC_BOOTSTRAP_TOKEN` on the server). Gated mode makes a new box wait for your approval; open mode auto-approves anything that netboots. Either way, `/boot/grub.cfg` bakes the current token in automatically.

**5. Make a box boot it**, pick **one**:

- **USB dongle (simplest):** Console ▸ Settings ▸ Onboard Screens ▸ **Download bootloader**, then `sudo dd if=polyptic-boot.img of=/dev/sdX bs=4M` to a USB stick. The same stick boots amd64 **and** arm64 boxes — and **Wi-Fi-only boxes too**, once you put the network's credentials in `polyptic/wifi.conf` on the flashed stick (wired boxes ignore the file). Plug it in, boot from USB with Secure Boot ON, and choose **Polyptic (Live)** or **Polyptic (Offload Bootloader)** at the menu. See [The boot medium](#the-boot-medium-dongle-or-offload) and [Wi-Fi](#wi-fi-boxes-with-no-wire).
- **No medium, UEFI HTTP Boot:** point the box's firmware Boot URI at `http://10.0.0.5:8080/dist/boot/shimx64.efi` (arm64: `shimaa64.efi`). See [No medium at all](#no-medium-at-all-uefi-http-boot).
- **No medium, site DHCP:** add one option-67 rule to the DHCP you already run. See [Site DHCP option 67](#site-dhcp-option-67-one-change-to-the-dhcp-you-already-run).

**6. First boot → approve → done.** The box streams the image into RAM, boots diskless, and dials in. In **gated** mode it appears **PENDING** under **Console ▸ Machines**, approve it once; it renders its screen. Place it on a mural like any screen. **Every later cold boot re-attaches automatically** (same stable hardware id + token → no re-approval, placement kept). In **open** mode it's admitted immediately.

**Troubleshooting quick hits:**

- Firmware refuses the medium with a **security violation** at power-on → the firmware's `db` lacks the Microsoft **third-party** UEFI CA (some boards ship a "Windows only" policy). Flip the firmware toggle that allows the Microsoft 3rd-party UEFI CA; do **not** disable Secure Boot, the chain is signed.
- GRUB stops with **`bad shim signature`** → the depot's `vmlinuz` is not Canonical-signed (modified or corrupted); rebuild the live image, its signature guard should have refused this at build time.
- A bare **`grub>` prompt** instead of a menu → GRUB could not find its config. Dongle: check `grub/grub.cfg` exists on the stick. HTTP Boot: check `GET /boot/grub.cfg` **and** `GET /grub/grub.cfg` both return 200.
- Boots GRUB but stalls fetching → GRUB speaks minimal plain HTTP/1.1: **no TLS, no redirects, no chunked responses**, direct 200s with `Content-Length` only. Also expect the GRUB-stage kernel+initrd fetch to run at a few MB/s (tens of seconds); the big ISO fetch happens later, in Linux, at wire speed.
- Downloads the root image then dies in the initramfs → **not enough RAM**. dracut pulls the whole squashfs into a RAM tmpfs; budget roughly **the image size plus the running system's working set** (the initrd raises the tmpfs cap to 90% and warns below the floor).
- Boots the image but never appears in Machines → check the box reaches the control plane, and `journalctl -u polyptic-agent-env` (the identity/cmdline oneshot) on the box.
- **Need a shell on a box?** Power-cycle and pick **Polyptic (Debug Console)** at the GRUB menu — the normal live boot plus a **passwordless root shell on tty9** (`Ctrl+Alt+F9`; `Ctrl+Alt+F1` returns to the wall). This is the *only* interactive access the image has: it ships no passwords and no SSH, so a running box is sealed and a debug boot is always a deliberate power-cycle away. It grants nothing an attacker with keyboard + power didn't already have (GRUB configs are unverified in the shim model, so the cmdline was always editable at the menu). The image carries `procps` (`top`, `ps`, `free`) for exactly this: diagnosing a hot or struggling box.
- A box re-appears as a *new* PENDING machine each boot → its firmware reports no stable DMI UUID and the id fell back to a MAC hash that changed (multi-NIC); see [stable identity](#the-life-of-a-box-power-on-to-pixels).
- A **Wi-Fi box** lands at the `Retry (DHCP + chain again)` menu → the medium has no local payload for its arch (built LEAN, or without that arch's image), so there is nothing to fall back to. Rebuild the medium after building the arch's live image. If it boots the local payload but never associates → the splash names a rejected `wifi.conf` outright; otherwise check tty9 (`Ctrl+Alt+F9`, debug boot) with `iw dev` — no wlan device means the adapter's firmware isn't in the curated set (see [Wi-Fi](#wi-fi-boxes-with-no-wire), `FULL_FIRMWARE=1`).

---

## The life of a box, power-on to pixels

```
Boot medium (USB dongle)   or   offloaded ESP entry   or   UEFI HTTP Boot / site DHCP option 67
        │  firmware db (Microsoft UEFI CA 2011) verifies + runs…
        ▼
shim (Microsoft-signed) → verifies + loads → network GRUB "grubnet" (Canonical-signed)
        │  DHCP on all NICs, then fetches
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
Enrolment, the EXISTING flow, unchanged:
   GATED: shows PENDING → operator approves once (Console ▸ Machines) → renders its screen slice.
   Next cold boot: SAME stable id + token → enroll.ts case-4 re-attaches the SAME screen,
     keeps status + placement. No duplicate machine, no re-approval.
```

The **stable machine-id is the whole trick.** A diskless live image regenerates `/etc/machine-id` randomly on every boot, which would make each cold boot look like a brand-new PENDING machine with lost placement. Deriving `POLYPTIC_MACHINE_ID` from hardware (which the agent already honours above `/etc/machine-id`) makes the same physical box re-present the same identity forever, so the server's existing [`enroll.ts` case-4](../packages/server/src/enroll.ts) re-attaches it silently, with **zero server or protocol change**.

---

## The boot depot (server routes)

All in [`packages/server/src/provision.ts`](../packages/server/src/provision.ts), alongside `/dist/agent`:

| Route | Gate | What |
|---|---|---|
| `GET /boot/grub.cfg` | **ungated** | The generated GRUB menu: `Polyptic (Live)` / `Polyptic (Offload Bootloader)` / `Polyptic (Debug Console)`, three flat entries. Bakes the control-plane base from the request `Host` and, in gated mode, the current enrolment token into the kernel cmdline. The box has no operator session at boot, so this is ungated. |
| `POST /boot/report` | **token** | How a box's bootloader install went (POL-58) → one line in the Live Activity feed. The reporter is mid-boot with no agent session, hence not under `/api/v1`; in gated mode it must present the fleet enrolment token it netbooted with, in open mode it is ungated like the rest of the depot. Read-only against the registry, throttled, and the body can only produce one bounded line. |
| `GET /grub/grub.cfg` (+ `/grub/x86_64-efi/grub.cfg`, `/grub/arm64-efi/grub.cfg`) | **ungated** | **Aliases of the same menu**, at the paths an HTTP-booted GRUB actually asks for: grubnet's baked-in prefix is `/grub`, resolved against the **server root** of the host it was fetched from. See [the appendix](#no-medium-at-all-uefi-http-boot). |
| `GET /dist/image/:arch/{vmlinuz,initrd,rootfs.squashfs}` | **ungated** | The **active** live-image artifacts, streamed with real HTTP **Range** (206/416); the root image is hundreds of MB and streamed into RAM. |
| `GET /dist/image/:arch/builds/:imageId/:file` | **ungated** | The same artifacts for any **retained** build ([Build history](#build-history-and-rollback)). Same Range streaming, same secret-free content; `:imageId` is whitelisted so it cannot walk out of the depot. |
| `GET /dist/boot/:file` | **ungated** | The universal boot medium `polyptic-boot.img`, plus the four signed loaders `shim{x64,aa64}.efi` / `grub{x64,aa64}.efi` (fetched by the offload flow and UEFI HTTP Boot). All **tokenless**, so ungated like `/dist/agent`. |
| `GET /api/v1/settings/netboot` | **gated** | Operator-facing, secret-free `NetbootInfo{baseUrl, mode, bootConfigUrl, bootMediumUrl}` that drives the Console ▸ Settings ▸ Onboard Screens card. |
| `POST /api/v1/settings/image/activate` | **gated** | Make a retained build the active one — the fleet **rollback** ([Build history](#build-history-and-rollback)). |

**The boot depot is plain HTTP, by contract.** GRUB's HTTP client cannot do TLS, redirects, or chunked encoding; every asset GRUB fetches must be a direct `200` with a `Content-Length` (the depot also tolerates shim's double-slash request shape, see [the appendix](#no-medium-at-all-uefi-http-boot)). The *root image* is fetched later, by curl inside the initramfs, which is far less fussy — but the depot stays plain-HTTP end to end so one address works for the whole chain. This is deliberate, not an oversight, and it does not weaken the signature chain (the kernel is verified after download, whatever carried it). Treat the depot like any provisioning service: keep it on the LAN / management VLAN the boxes live on. The only secret in the whole flow is the enrolment token, and a leaked token **cannot self-admit** a box, a new machine lands PENDING until an operator approves it; regenerating the token re-keys the fleet (see [Ownership](#ownership-keys-and-rotation)). If operators reach the control plane over HTTPS via a proxy, the boxes still need a plain-HTTP path to these routes.

**Serving the artifacts.** Point two env vars at the built directories (they default to `deploy/dist/image` and `deploy/dist/boot` relative to the repo):

```
IMAGE_DIST_DIR=/srv/polyptic/image     # holds <arch>/{vmlinuz,initrd,rootfs.squashfs}
BOOT_DIST_DIR=/srv/polyptic/boot       # holds polyptic-boot.img + shim{x64,aa64}.efi + grub{x64,aa64}.efi
```

The images are large, mount a volume rather than baking them into the server image, and set the two vars to the mount.

---

## Building the artifacts

### The live image (Linux build host)

> **This build cannot run on macOS.** It needs `chroot` + `mksquashfs`; install `sbsigntool` too so the signed-kernel guard uses the real signature parser. `deploy/full-rebuild-image-docker.sh <arch>` runs it in a privileged Linux container, so a Mac can drive it. The **pure identity layer** in `deploy/live/` *is* verifiable anywhere: `sh deploy/live/test/identity.test.sh` (also run by `bun test packages/e2e/netboot-identity.test.ts`).

```bash
# 1) the agent binary (seeds the image + the existing depot)
deploy/build-agent.sh amd64

# 2) the live image → deploy/dist/image/amd64/{vmlinuz,initrd,rootfs.squashfs} (+ SHA256SUMS)
#    No base ISO: the rootfs is built up from ubuntu-base, then the SAME `polyptic-agent setup`
#    substrate is installed into it.
sudo deploy/build-live-image.sh amd64
```

The image is built **up from `ubuntu-base`**, not trimmed down from Ubuntu's live-server squashfs (POL-35/[D55](DECISIONS.md)). apt installs the kernel, dracut, a curated firmware set and the substrate; `dracut` then builds the initramfs against that same kernel's modules. What the build guarantees, and why:

- **The kernel ships exactly as Canonical signed it.** `vmlinuz` is the chroot's own `/boot/vmlinuz-<kver>`, the Canonical-signed EFI PE from the `linux-signed` source — the identical binary the live-server ISO carries, delivered by apt instead of by ISO. The build **fails** if the signature is missing, because under Secure Boot GRUB would refuse an unsigned kernel at boot with `bad shim signature`.
- **The kernel cannot drift from its modules.** Kernel, `/lib/modules` and `initrd` all come out of **one apt transaction**, so the old `apt-mark hold` gymnastics — the classic netboot footgun — are structurally gone rather than defended against.
- **The root image is a bare `rootfs.squashfs`.** dracut's netboot mechanism is `root=live:<url>`: `livenet` curls the squashfs into the initramfs tmpfs and `dmsquash-live` loop-mounts it under an overlayfs. No ISO wrapper, no `xorriso`, no casper metadata.
- **Firmware is curated, not complete.** 26.04 splits `linux-firmware` into per-vendor packages; the image ships `linux-firmware-minimal` plus the two GPU vendors and Realtek NICs. Note that `linux-image-generic` **Depends** on the full `linux-firmware` (~600 MB) — which `--no-install-recommends` cannot decline — so the build installs the *concrete* `linux-image-<abi>-generic` instead. A box with unanticipated hardware gets a black screen or a dead NIC: rebuild with `FULL_FIRMWARE=1`, or extend `FIRMWARE_PACKAGES`.
- **RAM sizing:** the squashfs lands in a tmpfs, so a box needs roughly **the image size plus the running system's working set**. The initrd's `polyptic-live` dracut module raises the tmpfs cap from the kernel's default 50% of RAM to 90%, and prints a plain-English message below the floor. Never pass `rd.live.ram=1` — it `dd`s a *second* full copy of the image into RAM.
- The kiosk browser is **surf** (`BROWSER=` overrides). Ubuntu's Chromium is snap-only; `cog` was dropped from the archive after 25.04.

### The live ISO (macOS or Linux)

The **no-netboot provisioning option** (and the fastest VM sanity check): wrap the already-built
live rootfs into a stock Ubuntu live ISO that boots from a USB stick / CD / virtual CD, with the
control-plane address + enrolment token baked into the GRUB cmdline. Write it to a stick, boot the
box, it comes up diskless and enrols — same diskless contract as netboot, no boot infrastructure.

```bash
POLYPTIC_BASE=http://192.168.1.62:8080 POLYPTIC_TOKEN=lab-token-123 \
  BASE_ISO=~/Downloads/ubuntu-26.04-live-server-arm64.iso \
  deploy/build-live-iso.sh arm64
#   → deploy/dist/image/arm64/polyptic-live.iso  (USB stick, CD, or a UEFI VM's virtual CD)
```

Needs only `xorriso` (`brew install xorriso`), no root, runs on macOS. It lays down the netboot
payload's own `vmlinuz`, `initrd` and `rootfs.squashfs` (build those first on the Linux host); the
squashfs goes to `/LiveOS/squashfs.img`, where dracut's `dmsquash-live` looks, and the cmdline is
`root=live:CDLABEL=POLYPTIC` — the **same initrd** the netboot flow uses, two media. `BASE_ISO` is
still required, but now *only* for its signed EFI System Partition and GRUB's on-disk prefix; its
kernel, initrd and squashfs are discarded, so its release no longer has to match the payload's.
The token rides the ISO in cleartext, so the FILE is a credential — share it like one (a leaked
token still only lands new boxes as PENDING).

The default output path (`deploy/dist/image/<arch>/polyptic-live.iso`) is inside the image
depot, so the server serves it at `GET /dist/image/<arch>/polyptic-live.iso` and **Console ▸
Settings ▸ Onboard Screens** lists it under **Recent builds**, one downloadable row per retained build that has one. The baked
cmdline carries `quiet splash plymouth.ignore-serial-consoles`, so the boot shows the Polyptic
Plymouth splash instead of scrolling kernel text. Two load-bearing details behind that: the theme
rides INSIDE the initrd (plymouthd starts long before the squashfs exists), which dracut's own
`plymouth` module handles once `setup` has written `/etc/dracut.conf.d/polyptic-splash.conf` naming
the theme (D45) — this replaced the initramfs-tools hook harvest + cpio-append of D49; and
`plymouth.ignore-serial-consoles` is required because arm64 VMs get an implicit devicetree serial
console, which otherwise makes plymouth assume a headless server and never paint the display.

**The remaster pitfall this script exists to avoid (POL-38):** on post-20.10 Ubuntu ISOs the EFI
System Partition is an **appended partition** that the El Torito catalog points into, not a file
in the ISO tree. A naive xorriso grow/replay repack carries over only the first 2048-byte sector
of the ~5 MiB ESP, so the firmware mounts a FAT whose directory tree is garbage, finds no
`\EFI\BOOT\BOOT*.EFI`, skips the CD, and drops to the UEFI shell (where even the manual
`FS0:\EFI\BOOT\BOOTAA64.EFI` fails with `File Not Found`). The script rebuilds the layout the way
Ubuntu ships it (`-append_partition` + `-e --interval:appended_partition_2:all::`) and
self-verifies that the El Torito image and the appended GPT ESP are the same, byte-identical
region before it will hand you the ISO.

UTM specifics (arm64, Apple Silicon): display card **`virtio-gpu-gl-pci` ("GPU Supported")**, or
sway has no GL renderer and the screen stays black; leave the drive as a USB CD; RAM ≥ 2 GiB
(the squashfs is mounted off the medium, not copied into RAM); turn the QEMU **Hypervisor** (HVF)
toggle on, TCG-emulated boots take many times longer.

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
grub/grub.cfg           stage 1: DHCP all NICs, then chain the server's /boot/grub.cfg (retry menu on failure)
```

Notes that matter:

- `POLYPTIC_BASE` must be plain `http://` (the script rejects `https://`; GRUB has no TLS).
- `grub/grub.cfg` sits at the **volume root**, not next to the EFI binaries: grubnet's baked-in prefix is `/grub` on whatever device it loaded from, and it never reads a config beside the binaries.
- The stage-1 config on the stick is deliberately dumb, it carries only the control-plane address. **The real menu lives server-side** in the generated `/boot/grub.cfg`, so menu changes never require reflashing dongles.
- The pins exist because of SBAT revocation, and are bumped deliberately, never floated; see [Secure Boot](#secure-boot).

---

## The boot medium: dongle or offload

Download it from **Console ▸ Settings ▸ Onboard Screens ▸ Download bootloader** (`polyptic-boot.img`), then `dd` it to a USB stick. It is **identical for the whole fleet and for both arches** (the per-box identity is derived from each box's own hardware at runtime), so flash one, clone it, and there is nothing unique to prepare per box beyond, optionally, [dropping the site's Wi-Fi credentials](#wi-fi-boxes-with-no-wire) onto the FAT partition. Besides the signed loaders the medium carries a **local boot payload** — kernel + `initrd-wifi` per built arch, in A/B slots the booted box refreshes itself — which is only touched when the wired chain is unreachable; a wired box reads the stick for a few seconds at power-on, exactly as before.

Plug it in and the server-side menu offers:

- **Boot Polyptic now**, leave the USB in. The box is fully **diskless**; nothing whatsoever is written locally. Best for disposable / hot-swap panels.
- **Polyptic (Offload Bootloader)** writes *just the signed shim + GRUB pair* (the pointer, not the OS) into the box's **existing EFI System Partition** under `EFI/polyptic/`, drops the same stage-1 config at the ESP's `/grub/<arch>-efi/grub.cfg` (and `/grub/grub.cfg` when that path is free), and makes a UEFI boot entry (`efibootmgr`, "Polyptic Netboot") the firmware's **first** boot option. Pull the USB and the box self-boots the identical HTTP flow forever, **Secure Boot still ON** (the installed loaders are the same signed binaries). One USB can walk a rack, installing on each box.

> **The dongle depends on the firmware bringing the NIC up (POL-39).** GRUB carries no NIC
> drivers of its own — `efinet` can only use a card the firmware has already initialised. Most
> real UEFI firmware connects the network stack when the NIC is in the boot order (enable
> network boot / "UEFI network stack" in setup, or one attempted PXE boot); a VM needs the NIC
> given a `bootindex`. If GRUB comes up from the dongle but `net_ls_cards` prints nothing, the
> firmware never touched the NIC — enable network boot in firmware setup, or prefer
> [UEFI HTTP Boot / DHCP option 67](#no-medium-at-all-uefi-http-boot), where the firmware fetches
> the loader itself and the NIC is up by construction.

**Installing the bootloader never repartitions, formats, or wipes.** It only adds files to the ESP that's already there plus one boot entry. The box's previous OS stays on its disk and stays bootable — pick it from the firmware's boot menu, or delete the "Polyptic Netboot" entry in firmware setup to hand the machine back. The install **refuses to overwrite any GRUB config it didn't write itself** (its own file carries a `# polyptic-offload` marker; a foreign file aborts it loudly), and it claims the removable-media fallback path `EFI/BOOT/BOOT<arch>.EFI` **only when that path is empty** — another vendor's default loader is never displaced. The full live OS still streams from the control plane into RAM on every boot; what lands on disk is the few-MB signed loader pair, never an OS, identity, or state. (Mechanically: the confirmation entry adds `polyptic.offload=1` to the kernel cmdline; the live image's `polyptic-offload.service` does the ESP install once, from Linux userland where `efibootmgr` exists, fetching the loaders tokenlessly from `/dist/boot/`.)

### When the install doesn't take (POL-58)

Nothing is called installed until it has been **verified**: the script re-reads the UEFI boot variables after writing them and asserts that "Polyptic Netboot" exists *and leads* `BootOrder`. If the firmware disagrees, the install fails, says why on the screen you are standing in front of, and posts the reason to **Console ▸ Activity** (`POST /boot/report`). No success stamp, no silent half-install. The `polyptic-offload.service` unit fails too, so `systemctl status polyptic-offload` tells the truth.

| Reported code | What happened | What to do |
| --- | --- | --- |
| `boot-order-not-first` | The firmware stored the entry but keeps booting something else first. | Move **Polyptic Netboot** to the top of the boot order in firmware setup. |
| `nvram-write-failed` / `nvram-entry-missing` | The firmware refused the boot variable, or accepted and dropped it (often full variable storage). | Clear unused boot entries in firmware setup, then install again. The loaders are already on the ESP — a manual entry for `\EFI\polyptic\shim<arch>.efi` also works. |
| `not-uefi` | The box booted in legacy BIOS/CSM mode, which has no UEFI boot entries. | Enable UEFI boot in firmware setup (this is also why a legacy-installed Ubuntu has no ESP to chain from). |
| `no-esp` | No EFI System Partition on any **internal** disk. An ESP on removable media is deliberately ignored: pointing the boot entry at the stick you are about to pull is exactly how a box "installs" and then boots its old OS. | Boot the box's existing OS in UEFI mode once, or create an ESP, then install again. |
| `ambiguous-esp` | Several internal ESPs and none is clearly the one the firmware boots. | Re-run with `polyptic.offload_disk=/dev/<disk>` appended to the kernel command line (press `e` at the GRUB menu). |
| `foreign-grub-cfg` | A GRUB config Polyptic didn't write already sits at its path. | Nothing was changed. Move or remove that file if the ESP is genuinely yours to use. |

On a multi-ESP box the install picks the ESP the **firmware already boots from** (matched by `PARTUUID` against the existing UEFI boot entries) and says which one it chose; it aborts rather than guess when that is still a tie.

---

## Wi-Fi: boxes with no wire

**The short version:** flash the same universal medium, open its FAT partition on any laptop, put the
network's credentials in `polyptic/wifi.conf`, and boot. A wired box ignores the file entirely; a
Wi-Fi-only box boots the medium's local payload, joins the network from the initramfs, and streams
the same live image — one stick serves the whole fleet.

### Why Wi-Fi needs a local boot stage at all

| Boot stage | Can it do Wi-Fi? |
|---|---|
| Firmware + GRUB (fetch grub.cfg / kernel / initrd) | **No — physically.** GRUB has no WPA supplicant and UEFI network boot is wired-only across the industry; nothing Polyptic does can change this stage. |
| dracut initramfs (stream `rootfs.squashfs`) | **Yes**: `initrd-wifi` carries wpa_supplicant + every major vendor's wlan drivers and firmware, and associates from the medium's `wifi.conf` before livenet fetches the image. |
| The live rootfs (agent, browser, update poll) | **Yes**: `polyptic-wifi.service` re-reads the same credentials and runs its own supplicant — required even after the initrd associated, because a supplicant must keep running for WPA rekeying. |

So the only stage that needs a wire is the first hop — and that is exactly the stage that already
rides local media. The universal medium's stage 1 is **network-first**: it DHCPs and chains the
server's live menu when a wire works (byte-compatible with the wired flow, fresh token, active
image), and only on failure boots the **local payload**: the medium's own Canonical-signed kernel +
`initrd-wifi`, with `root=live:` **pinned to the build the kernel came from** so kernel and
`/lib/modules` always match. Secure Boot verifies the kernel identically whether GRUB read it from
HTTP or from the FAT.

Everything netboot buys survives on Wi-Fi: the OS still streams from the control plane into RAM at
every boot, the box stays diskless and generic, and updates stay automatic — the 5-minute poll
**refreshes the medium itself** (new build's kernel + initrd-wifi into the inactive A/B slot,
verified against the depot's `SHA256SUMS`, menu rewritten last so power loss mid-update leaves the
old slot bootable) before rebooting. A box offline longer than the depot's retention boots the
menu's recovery entry (newest image, possibly mismatched kernel) and heals itself on the next poll.

### The credentials file: `polyptic/wifi.conf`

Plain `KEY=value`, one per line; values run from the first `=` to the end of the line, so SSIDs and
passphrases with spaces/quotes need **no escaping**; Windows Notepad line endings are fine. The
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
present-but-invalid file fails **loudly** — the boot splash names the problem, because a Wi-Fi box
with a typo'd config must say so on the screen the operator is standing at. Bake credentials at
build time instead with `POLYPTIC_WIFI_SSID`/`POLYPTIC_WIFI_PSK` (or `POLYPTIC_WIFI_CONF=<file>` +
`POLYPTIC_WIFI_CERTS=<dir>`) on `deploy/build-boot-medium.sh` — also how the read-only **live ISO**
gets Wi-Fi (`deploy/build-live-iso.sh`, same variables; an ISO can't be edited after the fact).

**Treat a credentialed medium like a key.** `wifi.conf` holds the network secret in cleartext, and
a payload medium also bakes the enrolment token (the local path can never fetch the server's menu,
so gated fleets must build with `POLYPTIC_TOKEN=`; without it the local path only enrols on an
open-enrolment control plane). Same trust model as the live ISO has always had: a leaked token
still only lands new boxes as PENDING. The EAP identity is fleet-wide per medium — per-box
enterprise identities would need per-box media, which is out of scope today.

### Offload for Wi-Fi boxes

**Polyptic (Offload Bootloader)** on a box that came up over Wi-Fi copies the loaders **and** the
local payload + credentials onto the internal ESP, so the box self-boots the whole Wi-Fi chain with
no stick in. The ESP must fit **two** payload slots (live + update spare) — roughly 2× the kernel +
initrd-wifi, checked **before anything is written**; a too-small ESP fails with `esp-too-small` in
**Console ▸ Activity** and the box keeps booting from the stick. A wired boot keeps today's
pointer-only install; `polyptic.offload_wifi=1/0` on the cmdline (press `e` at the menu) forces
either behaviour.

### What Wi-Fi costs, honestly

- **The medium grows** from ~64 MiB to a few hundred MB per built arch (the wlan firmware is most
  of it — the fleet's chipsets are unknown, so Intel/Realtek/MediaTek/Qualcomm-Atheros/Broadcom/
  Marvell all ride along). `LEAN=1` still builds the old tiny, tokenless, wired-only dongle.
- **Two initrds per build.** The lean `initrd` keeps the wired GRUB-HTTP fetch fast (that fetch runs
  at a few MB/s and is on every wired power-on's critical path); `initrd-wifi` only ever loads from
  fast local media. Both come from the same dracut run against the same kernel.
- **No zero-media option.** UEFI HTTP Boot / PXE / DHCP option 67 remain wired-only, forever — see
  the table above. A Wi-Fi box needs the stick (kept in, or offloaded once to its ESP).
- **First association is only VM-testable in plumbing** (QEMU emulates no Wi-Fi NIC; the helpers are
  fully covered by `deploy/live/test/wifi.test.sh` and a `mac80211_hwsim` pass); real radios, real
  APs and the curated firmware set get their first exercise on the pending real-hardware pass.

---

## No medium at all: UEFI HTTP Boot

> **Firmware support varies.** UEFI HTTP Boot needs the firmware's HTTP-Boot driver. Server-class
> and recent desktop firmware ship it; some builds do NOT — UTM/QEMU's bundled EDK2 for example
> enumerates only "UEFI PXEv4" (no HTTPv4 option), so in those environments use classic PXE
> (DHCP option 67 + TFTP for shim/GRUB; GRUB still fetches the OS over HTTP) or the dongle with
> the NIC in the boot order. The chain and the server surface are identical either way.

For shops whose hardware or network cooperates, skip the USB entirely: the **firmware itself** fetches shim over HTTP, and from there the chain is identical (shim → GRUB → `/boot/grub.cfg`). The server side costs nothing extra, it reuses the exact dongle artifacts. But **client support is firmware-dependent**: common on 2020+ business desktops (often hidden behind "network stack" / "HTTP boot" toggles), spotty on older or consumer boards. **Test one unit before planning a rollout.** The dongle remains the guaranteed path.

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

Three things make this work: the firmware announces vendor class `HTTPClient` with one of the two HTTP-boot architecture codes (**16** = x64, **19** = arm64); option **67 must carry the full URL** to shim (custom port included, it survives the whole chain); and the offer must **echo `HTTPClient` back in option 60** or the firmware ignores it, hence `dhcp-option-force`. Any DHCP server can express the same three rules. Use a real DHCP scope; proxy-DHCP does not work reliably for HTTP Boot.

> Polyptic still isn't *running* DHCP, you're pointing the one you already have at its boot URL.

### Two protocol quirks the depot absorbs (so you don't have to)

- **shim requests `…//grubx64.efi`, double slash.** shim finds its second stage by taking the URL directory it was fetched from and appending `/grubx64.efi` (`/grubaa64.efi` on arm64), leading slash included. The depot tolerates duplicate slashes, and serves the GRUB binaries in the same `/dist/boot/` directory as shim, which is exactly where shim looks.
- **An HTTP-booted GRUB asks for `/grub/grub.cfg` at the server root.** grubnet's baked-in config prefix is `/grub`; loaded over HTTP it resolves that against `http://host:port/` (the root of the server it came from), *not* the directory shim was fetched from. That is why the depot serves the same generated menu at `/grub/grub.cfg` (and the per-arch `/grub/x86_64-efi/grub.cfg` + `/grub/arm64-efi/grub.cfg` it probes first) as at the canonical `/boot/grub.cfg`.

---

## Keeping the image updated (POL-41 + POL-43)

A baked image is convenient and immutable — and immediately starts ageing. The update loop closes
that gap with **zero per-box work**, because a diskless box re-pulls its whole OS at every boot:
**an update is just a rebuilt image plus a reboot.**

**Server side — two scheduled cycles.** Console ▸ Settings ▸ **Image updates** runs rebuild hooks
on two schedules (plus **Refresh now** / **Full rebuild now** buttons). Each hook is a command by
contract; the ready-made Docker ones are:

```bash
IMAGE_REBUILD_CMD="deploy/rebuild-image-docker.sh arm64"            # nightly, default 01:00
IMAGE_FULL_REBUILD_CMD="deploy/full-rebuild-image-docker.sh arm64"  # weekly, default Sun 02:00
```

1. **Nightly refresh** — `deploy/refresh-live-image.sh`: unsquash the CURRENT image,
   `apt-get upgrade` it in a chroot (security + updates pockets), re-squash, and stamp a **new image
   id**. Two deliberate properties: **nothing to upgrade → nothing changes** (no image-id churn, no
   pointless fleet reboots), and **the kernel stays held** — the refresh does not republish
   `vmlinuz`/`initrd`, so it must not move the ABI out from under the `/lib/modules` it re-squashes.
2. **Weekly full rebuild** — because of that hold, the nightly cycle can never roll a **kernel
   CVE**. The weekly cycle rebuilds the rootfs from `ubuntu-base` (`deploy/full-rebuild-image-docker.sh`
   runs `build-live-image.sh` in a privileged container; the base tarball is cached under
   `deploy/dist/cache/`), picking up the archive's current Canonical-signed kernel and rebuilding the
   initrd against it — Secure Boot keeps working because any Canonical-signed kernel verifies through
   shim. Everything user-space refreshes nightly; the kernel refreshes weekly.

**Kubernetes.** The Helm chart (`deploy/helm/polyptic`) wires both hooks as
`bun deploy/k8s-run-job.ts refresh|full`: the server creates a privileged rebuild **Job** from a
chart-rendered template on a Linux node, waits, and relays the log tail into the Settings card. The
depot lives on a PVC shared between the server and the Jobs; day-0 bootstrap is just clicking
**Full rebuild now** (the Job pulls `ubuntu-base` straight onto the volume). See the chart README
for the full story, including the dev workflow against a local OrbStack/kind cluster.

**Box side — the 5-minute poll.** Every netbooted box carries its identity at
`/etc/polyptic/image-id` and compares it against `GET /dist/image/<arch>/manifest.json`
(`{imageId, builtAt, sha256, urgent}`, ungated, secret-free) every 5 minutes
(`polyptic-update-poll.timer`). On a mismatch:

- **urgent on** (the Settings switch): reboot **now**, splayed 0–4 min per box (derived from the
  stable machine id) so a wall never hits the depot in unison;
- **urgent off**: reboot only inside the nightly window (03:00–04:59 local) — a 01:00 scheduled
  refresh therefore rolls across the fleet the same night, invisibly.

Boxes booted from the **live ISO / USB stick never auto-reboot** — they would re-boot the same
stale medium. The poll guards on `root=live:http…`, which only a netboot cmdline carries (an ISO boot
reads `root=live:CDLABEL=POLYPTIC`). Refresh those by regenerating and re-flashing the ISO
(`deploy/build-live-iso.sh`).

---

## Build history and rollback

The depot keeps the last few builds per architecture, and **one of them is active**. The active build's
artifacts sit at the arch root — exactly where they always have — so `grub.cfg`, the `/dist/image/<arch>/…`
routes, and every USB stick already in a drawer keep working without knowing history exists:

```
<IMAGE_DIST_DIR>/<arch>/
  builds/<imageId>/{rootfs.squashfs,vmlinuz,initrd,SHA256SUMS[,polyptic-live.iso]}   every retained build
  {rootfs.squashfs,vmlinuz,initrd,SHA256SUMS[,polyptic-live.iso]}                    the ACTIVE build
  image-id.txt                                                                       the active build's id
```

A build directory is recognised by its `rootfs.squashfs`. A depot left over from before this layout
(one holding `polyptic.iso`) therefore drops out of the history rather than offering an image the
current boot cmdline cannot use; the next full rebuild re-bootstraps it.

**Rolling back is activating an older build.** In **Console ▸ Settings ▸ Onboard Screens ▸ Recent builds**,
press **Activate** on any retained row (or `POST /api/v1/settings/image/activate {arch, imageId}`). The server
repoints the arch root and republishes `image-id.txt`. Nothing else has to happen: every netbooted box already
compares `manifest.json`'s `imageId` against its own `/etc/polyptic/image-id` every five minutes (POL-41), so
the fleet re-pulls the older image on the normal policy — within minutes if the roll-out is marked urgent
("Deploy latest to fleet immediately"), otherwise in each box's 03:00–05:00 window.

**Retention** is `IMAGE_RETAIN_BUILDS` (Helm: `imageUpdates.retainBuilds`, default **3**). Pruning drops the
oldest first and never removes the active build, so a fleet parked on an old image cannot have that image
deleted out from under it. Each retained build costs roughly one root image (~500–650 MB) plus its kernel and
initrd on the depot volume; size `netboot.persistence.size` accordingly. A depot built before this existed is
folded into `builds/` automatically when the server starts.

> **One inode rule worth knowing if you touch the build scripts.** The root and the active build directory
> *share* `rootfs.squashfs` and `polyptic-live.iso` by hardlink — that is why retention is nearly free. They do
> **not** share `vmlinuz`, `initrd`, or `SHA256SUMS`: `refresh-live-image.sh` writes those with `>` and `cp`,
> which truncate the existing inode in place, and through a hardlink that would silently rewrite a *retained*
> build's artifacts. If you add an artifact that is replaced by `mv`/`rm`+create, it can be shared; anything
> written in place must be copied. See `SHAREABLE` in `packages/server/src/image-updates.ts`.

---

## Lab: the full netboot chain in a UTM VM (POL-39, verified)

All three flows run end to end in a UTM (QEMU/EDK2, Apple Silicon) VM against a dev control plane
on the host. UTM's firmware has **no HTTP-Boot driver**, so the firmware stage is PXE; everything
after GRUB is the identical HTTP flow real hardware uses.

**Shared setup** — the VM needs ONE extra virtio NIC whose DHCP can hand out a boot file, and the
NIC must be in the firmware boot order (that is what makes EDK2 initialise it; GRUB inherits it).
In the VM's QEMU arguments:

```
-netdev user,id=polnet,tftp=/path/to/tftp-root,bootfile=shimaa64.efi
-device virtio-net-pci,netdev=polnet,bootindex=8
```

(Use a bootindex UTM hasn't auto-assigned to a drive; keep ONE NIC total — two user-mode NICs get
identical 10.0.2.x subnets and GRUB's routes become ambiguous. RAM ≥ 4 GiB: dracut streams the
whole root image into a RAM tmpfs.)

- **PXE / "site DHCP option 67" flow:** put `shimaa64.efi`, `grubaa64.efi`, and `grub/grub.cfg`
  (the rendered stage-1 config from `deploy/dongle-grub.cfg.tmpl`) in the TFTP root above; with no
  bootable drives the firmware PXE-boots: shim + GRUB over TFTP, then GRUB fetches
  `/boot/grub.cfg`, kernel, initrd, and the root image from the control plane over HTTP. Verified:
  power-on → wall content in ~60 s.
- **Dongle flow:** attach `polyptic-boot.img` as a USB **disk** drive; the firmware boots it ahead
  of PXE, and the boot-order NIC is still initialised, so dongle-GRUB is online. Verified: ~30 s
  to content.
- **Offload flow:** attach an additional VirtIO disk that has a GPT + FAT32 ESP, boot the dongle and
  pick **Polyptic (Offload Bootloader)**; the live boot writes the signed loaders + boot entry on the
  disk, after which the box boots the same chain with the dongle removed.
  A VM's blank ESP exercises none of the firmware states that broke this on real hardware, which is
  what `deploy/live/test/offload.test.sh` is for: it drives the whole decision tree (removable media,
  several ESPs, a firmware that keeps the entry but refuses to reorder, one that forgets it, a
  foreign default loader) against stubs, on any host.

---

## RAM: netboot needs ~2.5 GB, the live ISO needs ~1 GB

The two media differ in *where the operating system lives*, and that decides the memory floor:

| Medium | Where the OS runs from | RAM needed |
| --- | --- | --- |
| Boot medium / netboot (`polyptic-boot.img`) | the whole `rootfs.squashfs` (~700 MiB) is streamed into a **RAM tmpfs** and stays there, alongside the unpacked initrd | **~2.5 GB** |
| Live ISO (`polyptic-live.iso`) | the squashfs is read **straight off the USB stick** | **~1 GB** |

Both floors dropped by roughly a factor of two in POL-35/[D55](DECISIONS.md), when the root image
stopped being a 1.4 GiB casper ISO and became a bare squashfs; POL-63 then raised the netboot floor
~half a GB by shipping every major vendor's Wi-Fi firmware in the root image. Measured on the 26.04
arm64 build (POL-63): `rootfs.squashfs` **689 MiB**, lean `initrd` **113 MiB** (wired GRUB fetch,
wlan-firmware-free by construction), `initrd-wifi` **177 MiB** (local media only), `vmlinuz`
**24 MiB**; the universal medium with one arch's payload is a **~424 MiB** image file.

The image still lands in the initramfs tmpfs, which the kernel caps at **50 % of RAM** by default —
so the naive ceiling would be twice the image. The initrd's `polyptic-live` dracut module
(`deploy/live/usr/lib/dracut/modules.d/50polyptic-live/`) raises that cap to 90 % before livenet
fetches anything, and below ~2 GB of RAM it prints a plain-English message naming the live ISO as
the fix, rather than failing minutes later with a bare `No space left on device`.

If you see that message, the box is out of RAM — nothing is wrong with the network or the image. Use
the live ISO for that box, or fit more memory.

> **Never pass `rd.live.ram=1`.** It makes dmsquash-live `dd` a *second* full copy of the image into
> RAM on top of the one livenet already downloaded. The generated `/boot/grub.cfg` never emits it, and
> a netboot e2e test asserts its absence.

---

## Troubleshooting: the control-plane address is BAKED into boot media

Seen live (2026-07-09): the dev host moved to a different network, its IP changed, and **every
previously-built medium went stale at once**. Know the symptoms:

| Medium | Symptom when the baked address is dead |
| --- | --- |
| Dongle / offloaded disk | GRUB drops to the fallback menu — `Retry (DHCP + chain again) / Reboot / Firmware setup` — because `configfile $net/boot/grub.cfg` can't fetch the server menu. |
| Downloadable live ISO | Boots normally all the way to the splash, then sits at **"Starting up"** forever: the agent can't reach `polyptic.server_url` on its cmdline. The box never appears in the console. |
| Server env `PLAYER_BASE_URL` | The sneakiest one: the box boots, **enrols, and shows Online in the console** — but the screen shows a white page reading **"Operation was cancelled"** (WebKit's error page). The agent reached the server fine; the *browser* couldn't load the player from the stale `PLAYER_BASE_URL` the server advertises. The agent's own capture thumbnail (Machines view) shows the same white page — that's how you tell it's the guest's browser, not the display. Restart the server with the corrected `PLAYER_BASE_URL`; agents re-apply on reconnect. |

What carries a baked address (goes stale when the server moves):

- the **dongle**'s stage-1 `grub/<arch>-efi/grub.cfg` (`set net=(http,HOST:PORT)`),
- an **offloaded disk's ESP** (the same stage-1, copied at offload time),
- the **live ISO**'s kernel cmdline (`polyptic.base` / `polyptic.server_url` / token).

What does **not** (server-derived per request, immune to moves): the netboot payload
(`rootfs.squashfs`), `/boot/grub.cfg` menu URLs, the update-poll manifest — all derive from the HTTP
`Host` header of the request that fetched them.

Fixes, fastest first:

1. **Re-bake the media** for the new address: `POLYPTIC_BASE=http://<new-host>:8080
   deploy/build-boot-medium.sh` and re-download/rebuild the live ISO (`deploy/build-live-iso.sh`);
   reflash sticks, re-attach ISOs.
2. **Patch an offloaded ESP in place** (no reflash — handy for VMs): find the ESP partition offset
   in the disk image (GPT LBA×512), then
   `mcopy -i "<disk.img>@@<offset>" ::/grub/arm64-efi/grub.cfg /tmp/g && sed -i '' 's/OLD:8080/NEW:8080/' /tmp/g && mcopy -o -i "<disk.img>@@<offset>" /tmp/g ::/grub/arm64-efi/grub.cfg`.
3. **The real fix: bake a NAME, not an IP.** Give the control plane a stable DNS name (in
   Kubernetes: the chart's `ingressRoute.bootHost`, a plain-HTTP Traefik router for the boot
   paths) and build all media against `http://boot.your-domain`. Media then survive any move of
   the control plane. (The old caveat about the casper initrd's busybox `wget` being unreliable with
   DNS names is gone: dracut's initramfs fetches the image with **curl**, which resolves names,
   follows redirects and retries.)

Related black-screen gotcha (not address-related): a UTM VM whose display is `virtio-gpu-pci`
(no GL) boots to the splash and then goes **black** — sway has no GL renderer. Use
`virtio-gpu-gl-pci` ("GPU Supported"), the same D48 lesson.

---

## Secure Boot

**It stays on.** That is the point of the signed chain, and the reason the loader is Ubuntu's shim + GRUB rather than anything Polyptic compiles.

**What it is.** Secure Boot is a UEFI feature that will only run a boot binary whose cryptographic signature chains to a key the firmware trusts (its `db` keystore, which normally holds Microsoft's keys). It exists to stop a machine booting tampered or unauthorised early code, a bootkit.

**How the chain verifies.** The first stage is Ubuntu's **shim**, signed by Microsoft's third-party UEFI CA, which virtually every UEFI machine already trusts. shim embeds Canonical's certificate and uses it to verify the second stage, Ubuntu's **network GRUB** ("grubnet"). GRUB, running under Secure Boot, registers a `shim_lock` verifier: when a menu entry's `linux` command loads the kernel, the **whole kernel is read into memory first and its Canonical signature is checked on that buffer** before any of it executes. The check is transport-agnostic, a kernel fetched over plain HTTP is verified exactly like one read from disk, so booting over the LAN subtracts nothing from the chain. An unsigned or tampered kernel stops the boot with `bad shim signature`.

```
firmware db (Microsoft UEFI CA 2011)
  → shim 15.8 (Microsoft-signed)
     → grubnet (Canonical-signed; verified against shim's embedded certificate)
        → vmlinuz (Canonical-signed; verified by GRUB's shim_lock on the loaded buffer)
           → initrd, rootfs.squashfs (NOT signature-verified, by design; see below)
```

Polyptic signs **nothing** and manages **no keys**: every verified stage is a byte-identical redistribution of binaries Canonical ships for its own netboot installer, and the kernel in the live image is the Canonical-signed one apt installs from `linux-signed` (the image build refuses to package anything else). Building the rootfs from `ubuntu-base` rather than from a live ISO changed **who carries the kernel to us**, not what it is: `linux-image-<abi>-generic` is the same signed PE the ISO ships, and the build's `sbverify` guard checks the signer either way.

**What is verified, and what is not.**

| Stage | Signature-verified? | By |
|---|---|---|
| shim | **yes** | the firmware `db` (Microsoft UEFI CA 2011) |
| GRUB (grubnet) | **yes** | shim's embedded Canonical certificate |
| kernel (`vmlinuz`) | **yes** | GRUB's `shim_lock` verifier, on the loaded buffer, any transport |
| GRUB config (`/boot/grub.cfg`) | no | config files are exempt in this model |
| `initrd` | no | explicitly exempt (`GRUB_VERIFY_FLAGS_SKIP_VERIFICATION`) |
| `rootfs.squashfs` | no | fetched by the initramfs (dracut's curl) after the verified kernel is running |

The unverified rows are **not a Polyptic shortcut; they are the standard shim model**, the same boundary every stock Ubuntu machine boots with (Ubuntu's own security documentation states that initrd images aren't validated). Building the initrd ourselves with dracut changes nothing here: an unsigned dracut initramfs is exactly as legitimate to shim as the unsigned casper initrd it replaced. Secure Boot's job is to guarantee the machine only executes signed early-boot code: firmware, loaders, kernel. The initrd and root image are trusted the way the rest of Polyptic is: they come from **your** control plane over **your** LAN, addressed by the boot config, and a box that boots them still cannot self-admit, it lands PENDING until an operator approves it. Extending signature coverage to the initrd and cmdline is possible via a **UKI** (a unified kernel image: kernel + initrd + cmdline sealed in one signed PE) and is the tracked future-work path, at the cost of signing every image build, exactly the key management this design avoids today.

**SBAT: why the loader versions are pinned.** Beyond signatures, shim enforces **SBAT**, a generation-based revocation scheme: firmware carries a minimum-generation list (advanced over time by Ubuntu updates, and even by Windows on dual-boot hardware), and a loader below the minimum is refused *even though its signature is valid*. This is why `deploy/build-boot-medium.sh` pins **exact package versions with SHA-256 hashes** instead of fetching "latest": the GA noble GRUB build carries an SBAT generation that is **already revoked** on up-to-date firmware, and the shim packages also contain a `.signed.previous` binary (shim 15.4) that is revoked everywhere, both are one careless download away. The pinned pair (shim 15.8, GRUB 2.12 from noble-updates) survives every SbatLevel published as of 2026-07. When Ubuntu ships new signed loaders (a security notice against `shim-signed` / `grub2-signed`), **bump the pins deliberately**: update the deb URLs + hashes in the script, rebuild the medium, reflash / re-offload. Never ship the `.previous` binaries, and never relax the pin to "whatever is newest".

**Firmware caveats.** A minority of x86 boards ship a "Windows only" Secure Boot policy whose `db` lacks the Microsoft **third-party** CA that signs shim; they refuse the medium at power-on with a security violation. The fix is a firmware toggle (usually named like "Allow Microsoft 3rd Party UEFI CA"), not disabling Secure Boot. Very new machines that enrol only Microsoft's 2023 UEFI CA may likewise refuse the 2011-signed shim; if you hit one, check for a newer `shim-signed` to pin.

**Secure Boot off also works.** The same medium boots with Secure Boot disabled (shim prints "Booting in insecure mode" and carries on); no rebuild, no config change. Useful for lab VMs with no certificates enrolled, but it does not exercise the verified chain, so test at least one unit with Secure Boot ON.

---

## Ownership, keys, and rotation

- **Ownership = the boot key.** Whoever can make a box chain `<base>/boot/grub.cfg`, via dongle, offloaded entry, UEFI HTTP Boot, or site DHCP, enrols it against that server. Multiple Polyptic instances on one network = different keys, zero collision.
- **The netboot key is a standing fleet secret, by design.** It lives in the boot chain (USB / offloaded ESP / DHCP), not on a wiped disk. **Regenerate** the enrolment token (Console ▸ Settings ▸ Enrolment token) to re-key the fleet, the change is live on the next `agent/hello` *and* the next `GET /boot/grub.cfg`, so boxes re-pend until re-keyed. The **wired** path stays tokenless on the media (the token arrives with the server's menu), so wired sticks never need reflashing on rotation. A medium built with a **local Wi-Fi payload** bakes the token into its local menu (POL-63): after a rotation, rebuild those media (`deploy/build-boot-medium.sh`) or edit the `polyptic.token=` value in `/grub/local-<arch>.cfg` on the FAT — offloaded Wi-Fi ESPs likewise carry it and want the same edit.
- **Token exposure is bounded and matches today's trust model.** `GET /boot/grub.cfg` serves the token ungated, and it appears in `/proc/cmdline` on the booted kiosk, the same exposure as the `curl … | sh` one-liner passing it via env. It is only a *coarse* filter: a valid token on a **new** box lands it **PENDING**, and an operator still approves it under Machines before it renders anything. Keep the provisioning network operator-only. The downloadable medium is tokenless, so possession of a stick grants nothing beyond "reach `/boot/grub.cfg`".
