# Polyptic Netboot (bare box → screen, no OS install)

Boot a bare machine straight into Polyptic **over the network, into RAM**, no operating system installed, nothing written to the disk. Power on → the box streams a live Polyptic image from the control plane → it comes up as a named, placed screen. Swap a dead panel like a lightbulb: the replacement is generic, because nothing unique ever lived on its disk.

This is the answer to two problems at once (POL-33 / [D46](DECISIONS.md)):

1. **No hidden install step.** The `curl … /install | sh` one-liner ([DISTRIBUTION.md](DISTRIBUTION.md)) still needs an OS on the box first. Netboot removes that: the box has no OS until it fetches one, and it fetches a *live* one that never touches disk.
2. **Who owns a booting box on a shared LAN?** **Ownership is by key, not by who-answered-the-network-first.** A box belongs to the server whose **enrolment token** its boot chain carries. So Polyptic never runs DHCP, and two control planes on one VLAN (staging next to production) coexist for free, each box carries exactly one server's key.

> **amd64 first.** The image + boot medium are built for amd64 today; arm64 is a drop-in follow-up (the single `/boot.ipxe` already auto-selects the arch via iPXE `${buildarch}`).

---

## Quick start: end to end (zero to pixels)

Follow these in order. Steps 1–3 run **once** on a Linux build host + the control plane; step 5 is per-box (or one config change for the whole fleet). The later sections drill into each piece.

> **You need:** a **Linux amd64 build host** (`unsquashfs`/`mksquashfs`/`chroot` + the iPXE toolchain, *not* macOS); a **casper live ISO** to base the image on (e.g. `ubuntu-24.04.x-live-server-amd64.iso`); a **running Polyptic control plane**; and the target boxes in **UEFI mode with Secure Boot OFF** (the self-built iPXE is unsigned, see [Secure Boot](#secure-boot)).

**1. Build the three artifacts** (on the Linux build host, from the repo root):

```bash
deploy/build-agent.sh amd64                                                   # → deploy/dist/polyptic-agent-amd64
sudo BASE_ISO=/path/ubuntu-24.04.x-live-server-amd64.iso \
     deploy/build-live-image.sh amd64                                         # → deploy/dist/image/amd64/{vmlinuz,initrd,squashfs}
POLYPTIC_BASE=https://polyptic.example.com deploy/build-ipxe.sh amd64         # → deploy/dist/ipxe/polyptic-boot-amd64.{efi,img}
```

(Order matters: the live image bakes in the agent binary, so build the agent first. `POLYPTIC_BASE` is the URL your boxes reach the control plane at, baked into the medium.)

**2. Point the control plane at the artifacts** and restart it:

```bash
IMAGE_DIST_DIR=/srv/polyptic/image     # copy deploy/dist/image/ here (a mounted volume, the images are large)
IPXE_DIST_DIR=/srv/polyptic/ipxe       # copy deploy/dist/ipxe/ here
```

The server's boot banner logs `netboot[image-amd64=true medium-amd64=true]` when it finds them.

**3. Verify the depot is serving** (from anywhere that can reach the server):

```bash
curl -s https://polyptic.example.com/boot.ipxe        # → an "#!ipxe" script with your base baked in
curl -sI https://polyptic.example.com/dist/image/amd64/squashfs | grep -i accept-ranges   # → Accept-Ranges: bytes
```

**4. (Optional but recommended) gate enrolment.** Set an enrolment token (Console ▸ Settings ▸ Enrolment token, or `POLYPTIC_BOOTSTRAP_TOKEN` on the server). Gated mode makes a new box wait for your approval; open mode auto-approves anything that netboots. Either way, `/boot.ipxe` bakes the current token in automatically.

**5. Make a box boot it**, pick **one**:

- **USB dongle (simplest):** Console ▸ Settings ▸ Netboot ▸ **Download boot medium**, then `sudo dd if=polyptic-boot-amd64.img of=/dev/sdX bs=4M` to a USB stick. Plug it into the box, boot from USB, and choose **Boot now (dongle)** or **Offload to this box** at the menu. See [The boot medium](#the-boot-medium-dongle-or-offload).
- **No medium, UEFI HTTP Boot:** point the box's firmware Boot URI at `https://polyptic.example.com/dist/ipxe/polyptic-boot-amd64.efi`. See [No medium at all](#no-medium-at-all).
- **No medium, site DHCP:** add one option-67 rule to the DHCP you already run. See [Site DHCP option 67](#site-dhcp-option-67-one-change-to-the-dhcp-you-already-run).

**6. First boot → approve → done.** The box streams the image into RAM, boots diskless, and dials in. In **gated** mode it appears **PENDING** under **Console ▸ Machines**, approve it once; it renders its screen. Place it on a mural like any screen. **Every later cold boot re-attaches automatically** (same stable hardware id + token → no re-approval, placement kept). In **open** mode it's admitted immediately.

**Troubleshooting quick hits:**

- Box won't boot the medium at all → **Secure Boot is still on** (disable it) or the firmware is BIOS/CSM (UEFI only).
- Boots iPXE but stalls fetching the image → the casper initrd's busybox resolves **IPs, not DNS**; use the server's **IP** in `POLYPTIC_BASE` if the box has no DNS.
- Boots the image but never appears in Machines → check the box reaches the control plane, and `journalctl -u polyptic-agent-env` (the identity/cmdline oneshot) on the box.
- A box re-appears as a *new* PENDING machine each boot → its firmware reports no stable DMI UUID and the id fell back to a MAC hash that changed (multi-NIC); see [stable identity](#the-life-of-a-box-power-on-to-pixels).

---

## The life of a box, power-on to pixels

```
Boot medium (USB dongle)   or   site DHCP option-67   or   UEFI HTTP Boot
        │  fetches
        ▼
GET /boot.ipxe   (control plane = BOOT DEPOT, ungated)
        │  iPXE script: control-plane base + (gated) enrolment token baked in from THIS request
        ▼
kernel + initrd over HTTP → casper `netboot=http fetch=<squashfs>` streams the root image into RAM
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

All added to [`packages/server/src/provision.ts`](../packages/server/src/provision.ts), alongside `/install` + `/dist/agent`:

| Route | Gate | What |
|---|---|---|
| `GET /boot.ipxe[?offload=1]` | **ungated** | iPXE chain script. Bakes the control-plane base (from the request `Host`, like `/install`) and, in gated mode, the current enrolment token. `?offload=1` tags the cmdline for the offload flow. The box has no operator session at boot, so this is ungated. |
| `GET /dist/image/:arch/{vmlinuz,initrd,squashfs}` | **ungated** | The live-image artifacts, streamed with real HTTP **Range** (206/416), the squashfs is hundreds of MB and streamed into RAM. |
| `GET /dist/ipxe/:file` | **ungated** | A prebuilt boot medium `polyptic-boot-<arch>.{efi,img}`. **Tokenless** (it only chains `/boot.ipxe`), so ungated like `/dist/agent`, firmware / the offload flow fetch it with no session. |
| `GET /api/v1/settings/netboot` | **gated** | Operator-facing, secret-free `NetbootInfo{baseUrl, mode, bootIpxeUrl, bootMediumUrl}` that drives the Console ▸ Settings ▸ Netboot card. |

**Serving the artifacts.** Point two env vars at the built directories (they default to `deploy/dist/image` and `deploy/dist/ipxe` relative to the repo):

```
IMAGE_DIST_DIR=/srv/polyptic/image     # holds <arch>/{vmlinuz,initrd,squashfs}
IPXE_DIST_DIR=/srv/polyptic/ipxe       # holds polyptic-boot-<arch>.{efi,img}
```

The images are large, mount a volume rather than baking them into the server image, and set the two vars to the mount. The boot banner logs which artifacts are present (`netboot[image-amd64=… medium-amd64=…]`), so a mis-pointed dir is obvious at startup.

---

## Building the artifacts (Linux build host)

> **These builds cannot run on macOS.** They need `unsquashfs`/`mksquashfs`/`chroot`/loop-mounts (live image) and the iPXE GNU/EFI toolchain, Linux only. The **pure identity layer** in `deploy/live/` *is* verifiable anywhere: `sh deploy/live/test/identity.test.sh` (also run by `bun test packages/e2e/netboot-identity.test.ts`).

```bash
# 1) the agent binary (seeds the image + the existing depot)
deploy/build-agent.sh amd64

# 2) the live image → deploy/dist/image/amd64/{vmlinuz,initrd,squashfs}
#    Reuses the SAME `polyptic-agent setup` substrate; needs a casper live ISO as the base.
sudo BASE_ISO=/path/ubuntu-24.04.x-live-server-amd64.iso deploy/build-live-image.sh amd64

# 3) the boot medium → deploy/dist/ipxe/polyptic-boot-amd64.{efi,img}
#    Bakes the control-plane base into an iPXE binary that chains /boot.ipxe.
POLYPTIC_BASE=https://polyptic.example.com deploy/build-ipxe.sh amd64
```

The live image never changes the kernel (`apt-mark hold`) so the reused ISO `initrd` stays matched to the squashfs `/lib/modules`, the #1 netboot footgun. The default kiosk browser for the netboot image is **cog** (WPE): Ubuntu's Chromium is snap-only and unreliable inside a casper overlay (`BROWSER=chromium` overrides).

---

## The boot medium: dongle or offload

Download it from **Console ▸ Settings ▸ Netboot ▸ Download boot medium** (the `.img`), then `dd` it to a USB stick. It is **byte-identical for the whole fleet** (the per-box identity is derived from each box's own hardware at runtime), so flash one, clone it, and there is nothing unique to prepare per box. It is only read for a few seconds at power-on.

Plug it in and its menu offers:

- **Boot now (dongle)**, leave the USB in. The box is fully **diskless**; nothing whatsoever is written locally. Best for disposable / hot-swap panels.
- **Offload to this box, then boot**, writes *just the tiny iPXE loader* (the pointer, not the OS) into the box's **existing EFI System Partition** and adds a UEFI boot entry (`efibootmgr`), then you pull the USB and the box self-boots the identical HTTP flow forever. One USB can walk a rack, offloading each box.

**Offload never repartitions, formats, or wipes.** It only drops `\EFI\polyptic\polyptic.efi` into the ESP that's already there and adds one boot entry. The full live OS still streams from the control plane into RAM on every boot, what lands on disk is the ~few-MB pointer, never an OS, identity, or state. (Mechanically: the menu chains `/boot.ipxe?offload=1`, which tags the kernel cmdline `polyptic.offload=1`; the live image's `polyptic-offload.service` does the ESP install once, from Linux userland where `efibootmgr` exists, iPXE itself cannot write a local ESP.)

---

## No medium at all

For shops whose hardware or network cooperates, skip the USB entirely. Both fetch the **tokenless** `polyptic-boot-<arch>.efi` (served ungated at `/dist/ipxe/…`), which then chains `/boot.ipxe`.

### UEFI HTTP Boot (per-box firmware setting)

In firmware setup, enable **UEFI HTTP Boot** and set the Boot URI to the **EFI binary** (not the script, stock UEFI HTTP Boot runs a PE/COFF app, it does not interpret an iPXE script):

```
http://polyptic.example.com/dist/ipxe/polyptic-boot-amd64.efi
```

### Site DHCP option 67 (one change to the DHCP you already run)

Point your existing DHCP at the boot binary. Because our binary *embeds* `chain <base>/boot.ipxe` and ignores the DHCP-supplied filename, you can serve it to every UEFI client without a chainload loop.

**dnsmasq:**

```ini
# UEFI PXE (TFTP): client-arch 7/9
enable-tftp
tftp-root=/srv/tftp                       # holds polyptic-boot-amd64.efi
dhcp-match=set:uefi-pxe,option:client-arch,7
dhcp-match=set:uefi-pxe,option:client-arch,9
dhcp-boot=tag:uefi-pxe,polyptic-boot-amd64.efi

# UEFI HTTP Boot: client-arch 16, vendor class "HTTPClient"
dhcp-match=set:uefi-http,option:client-arch,16
dhcp-vendorclass=set:uefi-http,HTTPClient
dhcp-option-force=tag:uefi-http,60,HTTPClient
dhcp-boot=tag:uefi-http,"http://polyptic.example.com/dist/ipxe/polyptic-boot-amd64.efi"
```

**ISC dhcpd:**

```conf
option arch code 93 = unsigned integer 16;
if substring(option vendor-class-identifier, 0, 10) = "HTTPClient" {
    option vendor-class-identifier "HTTPClient";
    filename "http://polyptic.example.com/dist/ipxe/polyptic-boot-amd64.efi";
} elsif option arch = 7 or option arch = 9 {
    next-server 10.0.0.1;                  # your TFTP server
    filename "polyptic-boot-amd64.efi";
}
```

> Polyptic still isn't *running* DHCP, you're pointing the one you already have at its boot URL. A proxyDHCP companion for truly-bare-metal (auto-boot with zero medium and no DHCP change) stays an optional, out-of-scope add-on.

---

## Secure Boot

**What it is.** Secure Boot is a UEFI feature that will only run a boot binary whose cryptographic signature chains to a key the firmware trusts (its `db` keystore, which normally holds Microsoft's keys). It exists to stop a machine booting tampered or unauthorised early code, a bootkit.

**Why netboot trips over it today.** The iPXE loader that `deploy/build-ipxe.sh` produces is one we compiled ourselves, so it is **unsigned**. With **Secure Boot ON**, UEFI's `LoadImage()` refuses it, identically whether it comes from a USB dongle, the offloaded ESP entry, PXE/TFTP, or UEFI HTTP Boot. So the prerequisite today is: **turn Secure Boot OFF** in firmware (or put the box in Setup Mode) before it will netboot. Same single caveat for both dongle and offload.

**This is a real tradeoff, and not ideal for a fixed kiosk fleet.** Disabling Secure Boot removes the firmware's guarantee that only trusted code runs before the OS. On a locked, physically-controlled wall panel the exposure is limited (an attacker needs hands on the box, and everything it runs comes from your control plane over the trusted LAN), but it is a genuine weakening you should decide on consciously, not a free default.

**The path to keeping Secure Boot ON** (tracked as follow-up work, out of scope for the first netboot build) is one of:

- **Chainload via `shim`.** `shim` is a small first-stage loader that *is* Microsoft-signed and is already trusted by virtually every UEFI machine. It can load a second-stage binary (our iPXE) if that binary is signed by a key enrolled in the firmware's **MOK** (Machine Owner Key) list. So: sign our iPXE with our own vendor key, ship `shim` + our signed iPXE, and enrol our key via MOK once per box (or pre-seed it). Secure Boot stays on.
- **Enrol our own keys.** Replace/augment the firmware's `PK`/`KEK`/`db` with our own keys and sign the iPXE (and, ideally, the kernel) with them. Cleaner cryptographically, but it means owning key management and touching firmware on every box.

Both need signing infrastructure and per-box key enrolment, which the deliberately-simple tokenless medium avoids for v1. If your environment mandates Secure Boot, treat "sign the iPXE loader + `shim`/MOK enrolment" as the prerequisite piece of work before rolling netboot out.

---

## Ownership, keys, and rotation

- **Ownership = the boot key.** Whoever can make a box chain `<base>/boot.ipxe`, via dongle, offloaded entry, or site DHCP, enrols it against that server. Multiple Polyptic instances on one network = different keys, zero collision.
- **The netboot key is a standing fleet secret, by design.** It lives in the boot chain (USB / offloaded ESP / DHCP), not on a wiped disk. **Regenerate** the enrolment token (Console ▸ Settings ▸ Enrolment token) to re-key the fleet, the change is live on the next `agent/hello` *and* the next `GET /boot.ipxe`, so boxes re-pend until re-keyed. Rebuild/rewrite the medium (or re-run offload) with the new key.
- **Token exposure is bounded and matches today's trust model.** `GET /boot.ipxe` serves the token ungated, and it appears in `/proc/cmdline` on the booted kiosk, the same exposure as the `curl … | sh` one-liner passing it via env. It is only a *coarse* filter: a valid token on a **new** box lands it **PENDING**, and an operator still approves it under Machines before it renders anything. Keep the provisioning network operator-only. The downloadable medium is tokenless, so possession of a stick grants nothing beyond "reach `/boot.ipxe`".
