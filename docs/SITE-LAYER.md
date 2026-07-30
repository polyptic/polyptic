# Polyptic: the site layer

**Putting your organisation's own software into the image.**

Polyptic builds one operating system image and every screen in the fleet runs it. That is what makes the fleet predictable, and it is also why there is nowhere obvious to put the endpoint protection, vulnerability scanner, inventory agent or certificate trust your security function requires. Install any of it by hand on a box and it is gone at the next power cycle.

The **site layer** is the supported way in. You describe what your organisation needs as a directory of inputs, the build puts it into the image, and every screen comes up with it. Polyptic knows nothing about what you put in there, which is deliberate: the same mechanism has to work for the next organisation, whose requirements are different.

- [The model](#the-model)
- [Quick start](#quick-start)
- [Bundle reference](#bundle-reference)
- [Secrets](#secrets)
- [Agent identity, and the trap](#agent-identity-and-the-trap)
- [When things fail](#when-things-fail)
- [A worked example](#a-worked-example)
- [Verifying it](#verifying-it)
- [Troubleshooting](#troubleshooting)
- [What does not belong in the image](#what-does-not-belong-in-the-image)
- [What this model does and does not satisfy](#what-this-model-does-and-does-not-satisfy)

---

## The model

There are two moments, and keeping them apart is the whole design.

**At build time**, on the machine running `deploy/build-live-image.sh`, your packages, configuration files and certificate trust go into the image. This happens once per build and the result is identical on every screen.

**At boot time**, on each box, your scripts run with that box's credentials in hand. This is where a package becomes an enrolled agent.

### Why they cannot be merged

When an endpoint agent registers itself it writes a credential to disk. That is normal and unremarkable on a laptop.

Polyptic's filesystem is a single file, `rootfs.squashfs`, and it is served **with no authentication**. It has to be: a box that has not booted yet has no account and no session, so it cannot prove who it is in order to fetch its own operating system. Anyone who can reach the control plane can download that file and unpack it with one command.

So a registration performed during the build publishes its own credential to anyone on the network. Not in theory. This is why registration belongs at boot, where the credential lives in memory and dies with the boot.

### Which means credentials ride the boot medium

Registration needs a credential and the credential cannot be in the image, so it travels on the boot medium as `polyptic/site.conf`, next to the Wi-Fi credentials that already work this way. On a box installed to its own disk the medium is that box's EFI system partition, so one mechanism covers both kinds of box.

```
BUILD                                          BOOT
deploy/site/  ──►  build step 6  ──►  image    medium ──► site.conf ──► your hooks
                                        │                                    │
                        packages, config, trust               registration, in RAM only
                        (public, identical everywhere)        (per box, never published)
```

---

## Quick start

```bash
cp -r deploy/site.example deploy/site     # deploy/site is gitignored
$EDITOR deploy/site/packages.list         # what to install
$EDITOR deploy/site/firstboot.d/*.sh      # what to register, and how
sudo deploy/build-live-image.sh amd64     # step 6 picks it all up
```

Then put your credentials on the boot medium as `polyptic/site.conf` (see [Secrets](#secrets)).

`SITE_DIR` overrides the location if you keep your bundle elsewhere, for instance in a separate private repository:

```bash
SITE_DIR=/srv/polyptic-site sudo deploy/build-live-image.sh amd64
```

**An absent or empty bundle is an exact no-op.** No files touched, no package transaction, no unit enabled. If you do not need any of this, you will never notice it exists.

---

## Bundle reference

Everything is optional. Use the slots you need and delete the rest.

### `apt/*.sources`, `apt/*.list`, `apt/keyrings/*`

Package repositories and their signing keys, copied into `/etc/apt/sources.list.d/` and `/etc/apt/keyrings/`.

Prefer this over shipping a `.deb` wherever a vendor offers a repository, because the repository **persists into the image** and the nightly refresh then keeps that software patched with no further work from you. This is the same mechanism that keeps the kiosk browser current.

```
# deploy/site/apt/vendor.sources
Types: deb
URIs: https://packages.vendor.example/ubuntu
Suites: stable
Components: main
Signed-By: /etc/apt/keyrings/vendor.gpg
```

### `packages.list`

One package name per line; `#` starts a comment. Installed with `--no-install-recommends`.

A package that does not exist for the architecture being built is **skipped with a warning rather than failing the build**, because vendor coverage on arm64 rarely matches amd64 and a mixed fleet still has to build.

Recommends are declined deliberately. A vendor agent's recommended packages can drag a desktop stack into an image that streams into RAM on every boot, and that shows up as a hardware requirement on every screen.

### `debs/*.deb`

Local packages, for vendors who ship a download rather than a repository. Installed via `apt-get install ./file.deb` so dependencies resolve from the archive, rather than `dpkg -i`, which leaves a half-configured package that breaks the next transaction.

Note that anything you put here is frozen at that version until you replace the file. The nightly refresh cannot update it, because there is no repository behind it.

### `rootfs/`

Files copied into the image as-is, preserving paths. Certificate trust, policy drop-ins, inventory tag files, your own systemd units.

```
deploy/site/rootfs/
├── etc/vendor-agent/agent.conf
├── usr/local/share/ca-certificates/internal-root.crt
└── var/local/asset-tag
```

Applied **before** packages install, so a package's own setup sees your configuration rather than writing a default that you then have to overwrite. If you ship anything into `usr/local/share/ca-certificates/`, the build runs `update-ca-certificates` for you.

### `units.wants`

One systemd unit name per line, enabled under `multi-user.target`.

Usually unnecessary, because a package enables its own service through the normal Debian preset machinery. Use it for units you ship yourself via `rootfs/`. A name with no unit behind it produces a dangling symlink and a failed boot job, so only list units that exist.

### `configure.sh`

Runs inside the image's chroot, as root, after your packages and files are in place and before the initramfs is generated.

Two hard rules. It **must be non-interactive**, because there is nobody to answer a prompt and a script that waits will hang the build until it is killed. And it **must not register anything**, for the reason in [The model](#the-model).

A non-zero exit **fails the build**, deliberately. An image that boots and is quietly not compliant is worse than no new image.

### `seal.sh`

Runs on the build host, not in a chroot, with the rootfs path as `$1`, immediately before the image is sealed. This is where you strip per-host state. See [Agent identity](#agent-identity-and-the-trap), which is the reason this exists.

A non-zero exit fails the build.

### `firstboot.d/*`

Executable scripts run **on the box**, as root, at every boot, in filename order, with the network up and your credentials available. Registration goes here.

Each script gets:

| Variable | What it is |
|---|---|
| `SITE_<NAME>` | one per secret, named exactly as in `site.conf` |
| `POLYPTIC_SITE_SECRETS_DIR` | a directory of 0600 files, one per secret, for tools that want a file path |
| `POLYPTIC_MACHINE_ID` | this box's stable identity, derived from the motherboard UUID (or a hashed NIC MAC) |

Prefer the file form where a tool accepts one. A value passed on a command line is visible in `ps` to anything else running on the box.

---

## Secrets

### The file

Put it on the boot medium at `polyptic/site.conf`.

```
# Site secrets. Never in git, never in the image.
SITE_EDR_CUSTOMER_ID=1234abcd
SITE_SCANNER_KEY=a long linking key with spaces and = signs is fine
SITE_SCANNER_GROUP=signage
```

Format rules, all of which exist because an operator edits this file by hand under time pressure:

- One `SITE_<NAME>=<value>` per line. Names are `A-Z`, `0-9` and underscore.
- The value runs from the **first** `=` to the end of the line and is taken **verbatim**. Spaces, quotes, `=`, `:` and `$` all need no escaping.
- The file is **parsed, never sourced**. A value containing `$(...)` or backticks stays literal and cannot execute. A boot medium is not a trusted input.
- `#` starts a comment. An empty value counts as unset, so a template can ship blank keys.
- Trailing carriage returns are stripped, so a file edited on Windows works.
- The first occurrence of a key wins.
- **A key without the `SITE_` prefix is a hard error**, and the whole file is rejected rather than partially applied.

That last rule is worth dwelling on. A typo'd credential that is silently ignored gives you a screen that boots, renders perfectly and is enrolled in nothing, and nobody notices until an audit. Failing loudly at boot, in the log, is the far better outcome.

### How they arrive

`polyptic-site-firstboot.service` mounts the medium read-only, parses the file, copies the values into `/run` (a memory-backed filesystem), unmounts the medium, then runs your hooks. Nothing is written to the image and nothing survives a power cycle.

### If you would rather not use the medium

A `firstboot.d` script can fetch a credential from anywhere it can reach, since it runs with the network up. Fetching from an internal endpoint over TLS is a perfectly good alternative and needs no support from Polyptic. The medium is the built-in option because it needs no infrastructure.

---

## Agent identity, and the trap

Endpoint agents typically create a host identity the first time they register, then decline to register again because they believe they already have one.

Bake an image containing an agent that has already registered and **every box in the fleet claims to be the same machine**. One entry in your console where there should be forty. Detections attributed to the wrong screen. A licence count that makes no sense.

Vendors publish a procedure for this, usually called golden-image or master-image preparation, and it generally amounts to deleting an identity file or calling a reset subcommand before capturing the image. `seal.sh` is that moment.

```sh
#!/bin/sh
set -eu
ROOTFS="${1:?usage: seal.sh <rootfs>}"

rm -f "$ROOTFS/opt/vendor/etc/agent-id"
chroot "$ROOTFS" /opt/vendor/bin/vendorctl reset --identity || true
```

### The consequence, stated plainly

With the identity cleared, each box mints its own on first start. And because every Polyptic boot is a first boot, that means **a fresh registration on every power cycle** unless your tooling deduplicates on something stable.

This is a conversation to have with your security function rather than something Polyptic can solve. Two things help:

- Feed the vendor `$POLYPTIC_MACHINE_ID`, which is stable per physical box, as a hostname or external identifier where the tool supports one.
- Agree a retention and hidden-host cleanup policy up front.

In exchange, they get something a managed fleet cannot offer: no box can ever drift from its build, because nothing a box writes survives the night.

---

## When things fail

The rules differ by moment, on purpose.

**At build time, failure is fatal.** `configure.sh` or `seal.sh` returning non-zero stops the build. Nothing is published. This is correct: an image that is silently not compliant is worse than yesterday's image.

**At boot time, failure is cheap.** A `firstboot.d` script that fails, hangs or is misconfigured produces one line in the journal and nothing else:

- hooks run **alongside** the session, never before it, so they cannot delay a screen coming up
- each hook is killed after `POLYPTIC_SITE_HOOK_TIMEOUT` seconds (default 120)
- a failing hook does not stop later hooks
- the service always reports success to systemd

This is deliberate. The only output device on these machines is a screen in a public space, and a technical message on it is a worse outcome than an unenrolled box. Failures are for an operator to read in **Console ▸ Logs**, which is where the box's journal is relayed. If a hook is load-bearing for you, monitor it from your own tooling.

---

## A worked example

An organisation that needs an endpoint agent (shipped as a `.deb`, registered with a customer identifier) and a log forwarder (available from a repository).

```
deploy/site/
├── apt/
│   ├── keyrings/vendor.gpg
│   └── vendor.sources
├── debs/
│   └── vendor-agent_7.2.0_amd64.deb
├── firstboot.d/
│   └── 10-register.sh
├── packages.list
├── rootfs/
│   ├── etc/log-forwarder/forwarder.conf
│   └── usr/local/share/ca-certificates/internal-root.crt
└── seal.sh
```

**`packages.list`**

```
log-forwarder
```

**`firstboot.d/10-register.sh`**

```sh
#!/bin/sh
set -eu
log() { printf 'site/register: %s\n' "$1"; }

if [ -z "${SITE_EDR_CUSTOMER_ID:-}" ]; then
  log "no SITE_EDR_CUSTOMER_ID on the boot medium, skipping"
  exit 0
fi

/opt/vendor/bin/vendorctl register \
  --customer-id-file "$POLYPTIC_SITE_SECRETS_DIR/SITE_EDR_CUSTOMER_ID" \
  --external-id "$POLYPTIC_MACHINE_ID"

systemctl start vendor-agent.service
log "registered as $POLYPTIC_MACHINE_ID"
```

**`seal.sh`**

```sh
#!/bin/sh
set -eu
ROOTFS="${1:?usage: seal.sh <rootfs>}"
rm -f "$ROOTFS/opt/vendor/etc/agent-id"
echo "site seal.sh: agent identity cleared"
```

**On the boot medium, `polyptic/site.conf`**

```
SITE_EDR_CUSTOMER_ID=1234abcd5678
```

Note what is *not* in the hook: no `systemctl enable` (the image is read-only and the package enabled itself at build time), and no retry loop (the next boot is the retry).

---

## Verifying it

### During the build

Watch for `==> [6/9] site layer`. It lists every repository, package, file and hook it picks up, and prints a `site id` at the end. That id is a content hash of the whole bundle, written to `/etc/polyptic/site-id` in the image and published beside the image id, so "which payload is this screen running?" is a query rather than an argument.

### On a box

```bash
journalctl -u polyptic-site-firstboot -b   # what the hooks did this boot
cat /etc/polyptic/site-id                  # which bundle this image carries
ls -l /run/polyptic/site-secrets/          # secrets present, 0600, in RAM only
```

The same journal is relayed to the control plane, so **Console ▸ Logs** shows it without touching the box.

### The check that proves the design

From any machine that can reach the control plane:

```bash
curl -s http://<control-plane>/dist/image/amd64/rootfs.squashfs -o /tmp/r.squashfs
unsquashfs -l /tmp/r.squashfs | grep -i vendor-agent      # packages: expected
unsquashfs -cat /tmp/r.squashfs /opt/vendor/etc/credentials  # credentials: must not exist
```

Packages should be present. Credentials should not. If a credential ever appears, something has moved from a boot hook into the build and needs putting back. This is the check worth running in front of a security team, because it demonstrates the property rather than asserting it.

---

## Troubleshooting

**The build says `site: no <package> for arm64, skipping`.** The vendor has no package for that architecture. Expected and non-fatal, but that architecture's boxes will not have the software, so decide whether that is acceptable before shipping the image.

**The build hangs during `configure.sh`.** Something is waiting for input. Find the prompt and pass the tool's unattended flag.

**Hooks never run.** Check `/etc/polyptic/site/firstboot.d/` exists in the image and its scripts are executable. The service has a condition on that directory and skips silently when it is missing, so an empty bundle produces no noise. Non-executable files are ignored by design, so an operator's stray notes do not get run.

**A hook runs but the secret is empty.** Read `journalctl -u polyptic-site-firstboot -b`. Either no medium was found, no `polyptic/site.conf` was on it, or the file was rejected — in which case the reason is on that same line. A rejected file yields *no* secrets rather than some, so hooks run with nothing rather than half a configuration.

**Every box appears in the vendor console as the same host.** The agent identity was baked in. See [Agent identity](#agent-identity-and-the-trap) and add the clearing step to `seal.sh`.

**Software installed but never updates.** It came from a `.deb` rather than a repository, so the nightly refresh has nothing to track. Move it to `apt/` if the vendor offers a repository.

---

## What does not belong in the image

Anything that manages **durable per-machine state**, or assumes a **human signs in**. These boxes discard their writable layer at every power-off, on installed machines as well as netbooted ones, and nobody ever logs in to them.

| Thing | Why it does not work here |
|---|---|
| Directory / domain join | A machine account holds a secret that rotates, and it cannot survive the boot, so each power cycle creates a fresh computer object |
| Local admin password rotation | There is no local admin account, and no interactive login |
| Per-user network drives | They mount for a signed-in user, and there is never one |
| TPM-sealed disk encryption | An unattended screen cannot have a passphrase typed into it, and the disk holds the same image anyone can already download |
| Interactive-login MFA | Inserts an authentication prompt in front of an automatic login, which can leave a screen blank indefinitely |
| Configuration management agents | Anything they push is erased at the next boot; the image build is the configuration management |

---

## What this model does and does not satisfy

Worth putting in front of a security function early, because the mapping is unusual.

### Met, and more strongly than on a managed endpoint

- **Configuration drift is structurally zero.** No box can diverge from its build, and none can be patched by hand at 2am.
- **Attacker persistence is close to impossible.** The filesystem is read-only, the kernel is signed and verified at load, and any foothold is gone at the next reboot.
- **There are no credentials on the box to steal.** No interactive login ever happens, and the image ships neither `sudo` nor `polkit`.
- **No data at rest** in the default diskless mode. Nothing is written to a disk at all.
- **Userspace patching reaches the whole fleet** within about a day of a fix reaching the archive, with no per-host success rate to chase.

### Not met, and better said out loud

- **Automatic login, and no screen lock.** Deliberate, and what allows a wall to come back after a power cut with nobody present. The compensating controls are the list above.
- **Kernel patching is on a slower clock.** The kernel is pinned during the nightly refresh and moves only on a full rebuild, so agree a rebuild cadence and an out-of-band trigger.
- **Nothing can be remediated on the host.** A finding cannot be fixed on a machine that will not exist in eight hours. Every fix is a change to the image build, so route findings to whoever owns the build. The containment action is a reboot, which restores a filesystem with a published checksum.
- **Host records turn over.** See [Agent identity](#agent-identity-and-the-trap).

The reframe that usually helps: for a fleet like this the right thing to certify is **the image, not the endpoint**. A build id, checksums and a package manifest cover 100% of the fleet with no reporting gaps, which is a stronger claim than any per-host agent check-in rate.

---

## See also

- `deploy/site.example/README.md`: the bundle contract, next to the template itself.
- `docs/DISTRIBUTION.md`: how the image is built and served, and why the artifacts are ungated.
- `docs/NETBOOT.md`: the boot medium, and what else lives on it.
- `docs/DEPLOY.md`: the on-device guide.
