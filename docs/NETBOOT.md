# Polyptic netboot (bare box → screen, no OS install, Secure Boot stays ON)

Boot a bare machine straight into Polyptic **over the network, into RAM**, no operating system installed, nothing written to the disk, and **Secure Boot left ON**. Power on → the box streams a live Polyptic image from the control plane → it comes up as a named, placed screen. Swap a dead panel like a lightbulb: the replacement is generic, because nothing unique ever lived on its disk.

This is the answer to two problems at once (POL-33 / [D46](DECISIONS.md), loader pivoted to the signed chain in [D47](DECISIONS.md)):

1. **No hidden install step.** The `curl … /install | sh` one-liner ([DISTRIBUTION.md](DISTRIBUTION.md)) still needs an OS on the box first. Netboot removes that: the box has no OS until it fetches one, and it fetches a *live* one that never touches disk.
2. **Who owns a booting box on a shared LAN?** **Ownership is by key, not by who-answered-the-network-first.** A box belongs to the server whose **enrolment token** its boot chain carries. So Polyptic never runs DHCP, and two control planes on one VLAN (staging next to production) coexist for free, each box carries exactly one server's key.

And it does both **without touching Secure Boot**: the first boot stage is Ubuntu's already-signed shim + network GRUB, the exact binaries Canonical ships for its own netboot installer. Polyptic signs nothing and manages no keys. See [Secure Boot](#secure-boot) for precisely what is verified and what is not.

> **amd64 image first, universal medium.** The live image is built for amd64 today; arm64 is a drop-in follow-up. The boot medium is already **universal**: one `polyptic-boot.img` carries the signed loaders for both arches, and the server-generated boot menu picks the right kernel at boot via GRUB's `$grub_cpu`.

---

## Quick start: end to end (zero to pixels)

Follow these in order. Steps 1-3 run **once** (live image on a Linux build host, boot medium on any macOS or Linux machine, then the control plane); step 5 is per-box (or one config change for the whole fleet). The later sections drill into each piece.

> **You need:** a **Linux amd64 build host** for the live image (`unsquashfs`/`mksquashfs`/`chroot`/loop-mounts + `xorriso`, with `sbsigntool` recommended for the signed-kernel guard, *not* macOS); **any macOS or Linux machine** for the boot medium (`curl`, `ar`, `tar`, `zstd`, `mtools`; no root, no compiler); a **casper live ISO** to base the image on (e.g. `ubuntu-24.04.x-live-server-amd64.iso`); a **running Polyptic control plane** the boxes can reach over **plain HTTP**; and the target boxes in **UEFI mode**. Secure Boot can stay **ON**.

**1. Build the three artifacts** (from the repo root):

```bash
deploy/build-agent.sh amd64                                           # → deploy/dist/polyptic-agent-amd64
sudo BASE_ISO=/path/ubuntu-24.04.x-live-server-amd64.iso \
     deploy/build-live-image.sh amd64                                 # Linux only → deploy/dist/image/amd64/{vmlinuz,initrd,polyptic.iso}
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
curl -sI http://10.0.0.5:8080/dist/image/amd64/polyptic.iso | grep -i accept-ranges   # → Accept-Ranges: bytes
```

**4. (Optional but recommended) gate enrolment.** Set an enrolment token (Console ▸ Settings ▸ Enrolment token, or `POLYPTIC_BOOTSTRAP_TOKEN` on the server). Gated mode makes a new box wait for your approval; open mode auto-approves anything that netboots. Either way, `/boot/grub.cfg` bakes the current token in automatically.

**5. Make a box boot it**, pick **one**:

- **USB dongle (simplest):** Console ▸ Settings ▸ Netboot ▸ **Download boot medium**, then `sudo dd if=polyptic-boot.img of=/dev/sdX bs=4M` to a USB stick. The same stick boots amd64 **and** arm64 boxes. Plug it in, boot from USB with Secure Boot ON, and choose **boot now** or **offload** at the menu. See [The boot medium](#the-boot-medium-dongle-or-offload).
- **No medium, UEFI HTTP Boot:** point the box's firmware Boot URI at `http://10.0.0.5:8080/dist/boot/shimx64.efi` (arm64: `shimaa64.efi`). See [No medium at all](#no-medium-at-all-uefi-http-boot).
- **No medium, site DHCP:** add one option-67 rule to the DHCP you already run. See [Site DHCP option 67](#site-dhcp-option-67-one-change-to-the-dhcp-you-already-run).

**6. First boot → approve → done.** The box streams the image into RAM, boots diskless, and dials in. In **gated** mode it appears **PENDING** under **Console ▸ Machines**, approve it once; it renders its screen. Place it on a mural like any screen. **Every later cold boot re-attaches automatically** (same stable hardware id + token → no re-approval, placement kept). In **open** mode it's admitted immediately.

**Troubleshooting quick hits:**

- Firmware refuses the medium with a **security violation** at power-on → the firmware's `db` lacks the Microsoft **third-party** UEFI CA (some boards ship a "Windows only" policy). Flip the firmware toggle that allows the Microsoft 3rd-party UEFI CA; do **not** disable Secure Boot, the chain is signed.
- GRUB stops with **`bad shim signature`** → the depot's `vmlinuz` is not Canonical-signed (modified or corrupted); rebuild the live image, its signature guard should have refused this at build time.
- A bare **`grub>` prompt** instead of a menu → GRUB could not find its config. Dongle: check `grub/grub.cfg` exists on the stick. HTTP Boot: check `GET /boot/grub.cfg` **and** `GET /grub/grub.cfg` both return 200.
- Boots GRUB but stalls fetching → GRUB speaks minimal plain HTTP/1.1: **no TLS, no redirects, no chunked responses**, direct 200s with `Content-Length` only. Also expect the GRUB-stage kernel+initrd fetch to run at a few MB/s (tens of seconds); the big ISO fetch happens later, in Linux, at wire speed.
- Downloads the ISO then dies in the initramfs → **not enough RAM**. casper pulls the whole ISO into a RAM tmpfs; budget roughly **2x the ISO size plus the running system's working set**.
- Stalls at the casper download → the initrd's busybox wget speaks plain http (custom ports fine, no redirects) and the box may have no DNS; use the server's **IP** in `POLYPTIC_BASE`.
- Boots the image but never appears in Machines → check the box reaches the control plane, and `journalctl -u polyptic-agent-env` (the identity/cmdline oneshot) on the box.
- A box re-appears as a *new* PENDING machine each boot → its firmware reports no stable DMI UUID and the id fell back to a MAC hash that changed (multi-NIC); see [stable identity](#the-life-of-a-box-power-on-to-pixels).

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
casper `iso-url=…/polyptic.iso` wgets the WHOLE ISO into a RAM tmpfs, loop-mounts the squashfs
        │  tmpfs overlay, NOTHING hits disk
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

All in [`packages/server/src/provision.ts`](../packages/server/src/provision.ts), alongside `/install` + `/dist/agent`:

| Route | Gate | What |
|---|---|---|
| `GET /boot/grub.cfg` | **ungated** | The generated GRUB menu (boot now / offload). Bakes the control-plane base from the request `Host` (like `/install`) and, in gated mode, the current enrolment token into the kernel cmdline. The box has no operator session at boot, so this is ungated. |
| `GET /grub/grub.cfg` (+ `/grub/x86_64-efi/grub.cfg`, `/grub/arm64-efi/grub.cfg`) | **ungated** | **Aliases of the same menu**, at the paths an HTTP-booted GRUB actually asks for: grubnet's baked-in prefix is `/grub`, resolved against the **server root** of the host it was fetched from. See [the appendix](#no-medium-at-all-uefi-http-boot). |
| `GET /dist/image/:arch/{vmlinuz,initrd,polyptic.iso}` | **ungated** | The live-image artifacts, streamed with real HTTP **Range** (206/416); the ISO is hundreds of MB and streamed into RAM. |
| `GET /dist/boot/:file` | **ungated** | The universal boot medium `polyptic-boot.img`, plus the four signed loaders `shim{x64,aa64}.efi` / `grub{x64,aa64}.efi` (fetched by the offload flow and UEFI HTTP Boot). All **tokenless**, so ungated like `/dist/agent`. |
| `GET /api/v1/settings/netboot` | **gated** | Operator-facing, secret-free `NetbootInfo{baseUrl, mode, bootConfigUrl, bootMediumUrl}` that drives the Console ▸ Settings ▸ Netboot card. |

**The boot depot is plain HTTP, by contract.** Neither GRUB's HTTP client nor casper's busybox wget can do TLS, redirects, or chunked encoding; every boot asset must be a direct `200` with a `Content-Length` (the depot also tolerates shim's double-slash request shape, see [the appendix](#no-medium-at-all-uefi-http-boot)). This is deliberate, not an oversight, and it does not weaken the signature chain (the kernel is verified after download, whatever carried it). Treat the depot like any provisioning service: keep it on the LAN / management VLAN the boxes live on. The only secret in the whole flow is the enrolment token, and a leaked token **cannot self-admit** a box, a new machine lands PENDING until an operator approves it; regenerating the token re-keys the fleet (see [Ownership](#ownership-keys-and-rotation)). If operators reach the control plane over HTTPS via a proxy, the boxes still need a plain-HTTP path to these routes.

**Serving the artifacts.** Point two env vars at the built directories (they default to `deploy/dist/image` and `deploy/dist/boot` relative to the repo):

```
IMAGE_DIST_DIR=/srv/polyptic/image     # holds <arch>/{vmlinuz,initrd,polyptic.iso}
BOOT_DIST_DIR=/srv/polyptic/boot       # holds polyptic-boot.img + shim{x64,aa64}.efi + grub{x64,aa64}.efi
```

The images are large, mount a volume rather than baking them into the server image, and set the two vars to the mount.

---

## Building the artifacts

### The live image (Linux build host)

> **This build cannot run on macOS.** It needs `unsquashfs`/`mksquashfs`/`chroot`/loop-mounts plus `xorriso` (the ISO wrapper); install `sbsigntool` too so the signed-kernel guard uses the real signature parser. The **pure identity layer** in `deploy/live/` *is* verifiable anywhere: `sh deploy/live/test/identity.test.sh` (also run by `bun test packages/e2e/netboot-identity.test.ts`).

```bash
# 1) the agent binary (seeds the image + the existing depot)
deploy/build-agent.sh amd64

# 2) the live image → deploy/dist/image/amd64/{vmlinuz,initrd,polyptic.iso} (+ SHA256SUMS)
#    Reuses the SAME `polyptic-agent setup` substrate; needs a casper live ISO as the base.
sudo BASE_ISO=/path/ubuntu-24.04.x-live-server-amd64.iso deploy/build-live-image.sh amd64
```

What the build guarantees, and why:

- **The kernel ships exactly as Canonical signed it.** `vmlinuz` is a byte-identical copy of the base ISO's kernel, which is a Canonical-signed EFI PE; the build **fails** if the signature is missing, because under Secure Boot GRUB would refuse an unsigned kernel at boot with `bad shim signature`.
- **The kernel never drifts from its modules.** The exact kernel package *and* the metapackages are held (`apt-mark hold`) so no apt operation inside the image can move the ABI away from the initrd + `/lib/modules` it shipped with, the classic netboot footgun.
- **The root image is wrapped in `polyptic.iso`.** casper's netboot mechanism is `iso-url=<url ending .iso>`: the initramfs wgets the **whole ISO into RAM** and loop-mounts the squashfs inside it. (The `netboot=http fetch=` form floating around old guides does not exist in casper 20.04 through 26.04.) The wrapper is minimal, just the squashfs plus casper's metadata.
- **RAM sizing:** because the ISO lands in a tmpfs (capped at about half of RAM by default), a box needs roughly **2x the ISO size plus the running system's working set**. Keep the image lean.
- The default kiosk browser for the netboot image is **cog** (WPE): Ubuntu's Chromium is snap-only and unreliable inside a casper overlay (`BROWSER=chromium` overrides).

**26.04 / dracut outlook.** Ubuntu 26.04's own live ISOs still ship casper + initramfs-tools, so this flow holds as-is. When Ubuntu's live images move to dracut-live, the cmdline mechanism changes from casper's `iso-url=` to dracut's `root=live:<url>` (which fetches a bare squashfs, no ISO wrapper); that migration is a scoped follow-up, and the depot side is unchanged either way.

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

- `POLYPTIC_BASE` must be plain `http://` (the script rejects `https://`; GRUB and casper have no TLS).
- `grub/grub.cfg` sits at the **volume root**, not next to the EFI binaries: grubnet's baked-in prefix is `/grub` on whatever device it loaded from, and it never reads a config beside the binaries.
- The stage-1 config on the stick is deliberately dumb, it carries only the control-plane address. **The real menu lives server-side** in the generated `/boot/grub.cfg`, so menu changes never require reflashing dongles.
- The pins exist because of SBAT revocation, and are bumped deliberately, never floated; see [Secure Boot](#secure-boot).

---

## The boot medium: dongle or offload

Download it from **Console ▸ Settings ▸ Netboot ▸ Download boot medium** (`polyptic-boot.img`), then `dd` it to a USB stick. It is **byte-identical for the whole fleet and for both arches** (the per-box identity is derived from each box's own hardware at runtime), so flash one, clone it, and there is nothing unique to prepare per box. It is only read for a few seconds at power-on.

Plug it in and the server-side menu offers:

- **Boot now (diskless)**, leave the USB in. The box is fully **diskless**; nothing whatsoever is written locally. Best for disposable / hot-swap panels.
- **Offload to this box, then boot**, writes *just the signed shim + GRUB pair* (the pointer, not the OS) into the box's **existing EFI System Partition** under `EFI/polyptic/`, drops the same stage-1 config at the ESP's `/grub/grub.cfg`, and adds a UEFI boot entry (`efibootmgr`, "Polyptic Netboot"). Pull the USB and the box self-boots the identical HTTP flow forever, **Secure Boot still ON** (the offloaded loaders are the same signed binaries). One USB can walk a rack, offloading each box.

**Offload never repartitions, formats, or wipes.** It only adds files to the ESP that's already there plus one boot entry, and it **refuses to overwrite a `/grub/grub.cfg` it didn't write itself** (its own file carries a `# polyptic-offload` marker; a foreign file aborts the offload loudly). The full live OS still streams from the control plane into RAM on every boot, what lands on disk is the few-MB signed loader pair, never an OS, identity, or state. (Mechanically: the offload menu entry adds `polyptic.offload=1` to the kernel cmdline; the live image's `polyptic-offload.service` does the ESP install once, from Linux userland where `efibootmgr` exists, fetching the loaders tokenlessly from `/dist/boot/`.)

---

## No medium at all: UEFI HTTP Boot

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

## Secure Boot

**It stays on.** That is the point of the signed chain, and the reason the loader is Ubuntu's shim + GRUB rather than anything Polyptic compiles.

**What it is.** Secure Boot is a UEFI feature that will only run a boot binary whose cryptographic signature chains to a key the firmware trusts (its `db` keystore, which normally holds Microsoft's keys). It exists to stop a machine booting tampered or unauthorised early code, a bootkit.

**How the chain verifies.** The first stage is Ubuntu's **shim**, signed by Microsoft's third-party UEFI CA, which virtually every UEFI machine already trusts. shim embeds Canonical's certificate and uses it to verify the second stage, Ubuntu's **network GRUB** ("grubnet"). GRUB, running under Secure Boot, registers a `shim_lock` verifier: when a menu entry's `linux` command loads the kernel, the **whole kernel is read into memory first and its Canonical signature is checked on that buffer** before any of it executes. The check is transport-agnostic, a kernel fetched over plain HTTP is verified exactly like one read from disk, so booting over the LAN subtracts nothing from the chain. An unsigned or tampered kernel stops the boot with `bad shim signature`.

```
firmware db (Microsoft UEFI CA 2011)
  → shim 15.8 (Microsoft-signed)
     → grubnet (Canonical-signed; verified against shim's embedded certificate)
        → vmlinuz (Canonical-signed; verified by GRUB's shim_lock on the loaded buffer)
           → initrd, polyptic.iso / squashfs (NOT signature-verified, by design; see below)
```

Polyptic signs **nothing** and manages **no keys**: every verified stage is a byte-identical redistribution of binaries Canonical ships for its own netboot installer, and the kernel in the live image is the Canonical-signed one from the base ISO (the image build refuses to package anything else).

**What is verified, and what is not.**

| Stage | Signature-verified? | By |
|---|---|---|
| shim | **yes** | the firmware `db` (Microsoft UEFI CA 2011) |
| GRUB (grubnet) | **yes** | shim's embedded Canonical certificate |
| kernel (`vmlinuz`) | **yes** | GRUB's `shim_lock` verifier, on the loaded buffer, any transport |
| GRUB config (`/boot/grub.cfg`) | no | config files are exempt in this model |
| `initrd` | no | explicitly exempt (`GRUB_VERIFY_FLAGS_SKIP_VERIFICATION`) |
| `polyptic.iso` / squashfs | no | fetched by userspace (casper) after the verified kernel is running |

The unverified rows are **not a Polyptic shortcut; they are the standard shim model**, the same boundary every stock Ubuntu machine boots with (Ubuntu's own security documentation states that initrd images aren't validated). Secure Boot's job is to guarantee the machine only executes signed early-boot code: firmware, loaders, kernel. The initrd and root image are trusted the way the rest of Polyptic is: they come from **your** control plane over **your** LAN, addressed by the boot config, and a box that boots them still cannot self-admit, it lands PENDING until an operator approves it. Extending signature coverage to the initrd and cmdline is possible via a **UKI** (a unified kernel image: kernel + initrd + cmdline sealed in one signed PE) and is the tracked future-work path, at the cost of signing every image build, exactly the key management this design avoids today.

**SBAT: why the loader versions are pinned.** Beyond signatures, shim enforces **SBAT**, a generation-based revocation scheme: firmware carries a minimum-generation list (advanced over time by Ubuntu updates, and even by Windows on dual-boot hardware), and a loader below the minimum is refused *even though its signature is valid*. This is why `deploy/build-boot-medium.sh` pins **exact package versions with SHA-256 hashes** instead of fetching "latest": the GA noble GRUB build carries an SBAT generation that is **already revoked** on up-to-date firmware, and the shim packages also contain a `.signed.previous` binary (shim 15.4) that is revoked everywhere, both are one careless download away. The pinned pair (shim 15.8, GRUB 2.12 from noble-updates) survives every SbatLevel published as of 2026-07. When Ubuntu ships new signed loaders (a security notice against `shim-signed` / `grub2-signed`), **bump the pins deliberately**: update the deb URLs + hashes in the script, rebuild the medium, reflash / re-offload. Never ship the `.previous` binaries, and never relax the pin to "whatever is newest".

**Firmware caveats.** A minority of x86 boards ship a "Windows only" Secure Boot policy whose `db` lacks the Microsoft **third-party** CA that signs shim; they refuse the medium at power-on with a security violation. The fix is a firmware toggle (usually named like "Allow Microsoft 3rd Party UEFI CA"), not disabling Secure Boot. Very new machines that enrol only Microsoft's 2023 UEFI CA may likewise refuse the 2011-signed shim; if you hit one, check for a newer `shim-signed` to pin.

**Secure Boot off also works.** The same medium boots with Secure Boot disabled (shim prints "Booting in insecure mode" and carries on); no rebuild, no config change. Useful for lab VMs with no certificates enrolled, but it does not exercise the verified chain, so test at least one unit with Secure Boot ON.

---

## Ownership, keys, and rotation

- **Ownership = the boot key.** Whoever can make a box chain `<base>/boot/grub.cfg`, via dongle, offloaded entry, UEFI HTTP Boot, or site DHCP, enrols it against that server. Multiple Polyptic instances on one network = different keys, zero collision.
- **The netboot key is a standing fleet secret, by design.** It lives in the boot chain (USB / offloaded ESP / DHCP), not on a wiped disk. **Regenerate** the enrolment token (Console ▸ Settings ▸ Enrolment token) to re-key the fleet, the change is live on the next `agent/hello` *and* the next `GET /boot/grub.cfg`, so boxes re-pend until re-keyed. The media themselves are tokenless, so nothing needs reflashing on rotation.
- **Token exposure is bounded and matches today's trust model.** `GET /boot/grub.cfg` serves the token ungated, and it appears in `/proc/cmdline` on the booted kiosk, the same exposure as the `curl … | sh` one-liner passing it via env. It is only a *coarse* filter: a valid token on a **new** box lands it **PENDING**, and an operator still approves it under Machines before it renders anything. Keep the provisioning network operator-only. The downloadable medium is tokenless, so possession of a stick grants nothing beyond "reach `/boot/grub.cfg`".
