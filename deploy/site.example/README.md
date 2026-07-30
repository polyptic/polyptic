# The site layer

Copy this directory to `deploy/site` (which is gitignored) and fill in what your organisation needs.
`deploy/build-live-image.sh` consumes it at step 6. An absent or empty `deploy/site` is an exact
no-op, so a build with no site layer behaves exactly as it did before this existed.

```
cp -r deploy/site.example deploy/site
```

Everything here is vendor-neutral by design. Polyptic knows nothing about what you put in it.

## The one rule

**Packages install at build time. Registration happens on the box, at boot.**

This is not a style preference. Endpoint tooling writes a bearer credential to disk when it
registers, and `rootfs.squashfs` is served **without authentication** — a box has no session before
it boots, so the boot chain cannot present one. Anyone who can reach the control plane can download
the image and unpack it. So a registration performed during the build publishes its own credential.

Install is public and identical on every box. Registration is per-box and secret. Keep them apart.

## Layout

| Path | What it does | Runs where |
|---|---|---|
| `apt/*.sources`, `apt/*.list` | added to `/etc/apt/sources.list.d/`, so the nightly refresh keeps your tooling patched | build |
| `apt/keyrings/*` | added to `/etc/apt/keyrings/`; reference them with `Signed-By:` | build |
| `packages.list` | one package per line, `#` comments allowed. Installed with `--no-install-recommends`, and a package missing for one architecture is skipped loudly rather than failing the build | build |
| `debs/*.deb` | for vendors who ship a download rather than an archive. Installed via `apt-get install ./file.deb` so dependencies resolve | build |
| `rootfs/` | copied into the image as-is. CA certificates, policy drop-ins, inventory tag files, your own systemd units. Applied **before** packages install, so a package's postinst sees your config | build |
| `units.wants` | one unit name per line, enabled under `multi-user.target` | build |
| `configure.sh` | escape hatch for what files cannot express. Runs in the chroot. **Must be non-interactive.** Must not register anything | build |
| `seal.sh` | runs last, just before the image is sealed, with the rootfs path as `$1`. Strip per-host state here | build |
| `firstboot.d/*` | executable, run in filename order at every boot with your secrets in the environment. **Registration goes here** | box |

## Why `seal.sh` matters more than it looks

Endpoint agents mint a host identity the first time they register. Bake one in already-registered and
every box in your fleet reports as the same host, which is why vendors publish a golden-image
procedure. Every Polyptic boot is a golden-image first boot, so `seal.sh` is where you run whatever
that procedure says (usually deleting an identity file or calling the vendor's own reset).

The consequence, stated plainly so nobody is surprised: your boxes will then register fresh on every
boot. Your security function needs to expect that host-record turnover and agree how long records are
kept. In exchange, no box can ever drift from its build.

## Secrets

Secrets never go in this directory and never go in the image. They ride the **boot medium** as
`polyptic/site.conf`, next to the Wi-Fi credentials, and are handed to your `firstboot.d/` scripts in
RAM at boot. See `site.conf.example` for the format.

Each secret arrives two ways:

- as an environment variable, named exactly as in `site.conf`
- as a file at `$POLYPTIC_SITE_SECRETS_DIR/<KEY>`, mode 0600

Prefer the file when the tool accepts one. A value passed on a command line is visible in `ps` to
anything else running on the box.

## Nothing here may black the wall

A `firstboot.d` script that fails, hangs or is misconfigured costs a journal line and nothing else.
Hooks are time-boxed, they run alongside the session rather than before it, and the screen always
wins. Read failures in Console ▸ Logs. If you need a hook to be load-bearing, make that explicit in
your own monitoring, because Polyptic will not hold a public screen blank waiting for it.

A failure at **build** time is the opposite: `configure.sh` or `seal.sh` returning non-zero fails the
build, because a silently non-compliant image is worse than no new image.

## What does not belong here

Anything that manages durable per-machine state, or assumes a human logs in. These boxes wipe their
writable layer on every boot (installed ones too) and nobody ever signs in to them. So directory
joins, local-admin password rotation, per-user network drives, TPM-sealed disk encryption and
interactive-login MFA all either do nothing or actively break the boot. Endpoint protection,
vulnerability scanning, inventory tagging, CA trust and log forwarding are the things that work.
