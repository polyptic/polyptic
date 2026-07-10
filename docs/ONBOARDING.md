# Onboarding a new display

How a bare machine becomes a named, placed, content-showing screen on the wall. This is the
**operator journey**, end to end. Two ideas to hold onto:

- **A machine is plumbing; screens are what you drive.** Onboarding a machine *registers* its outputs
  as screens — but a screen is "off the wall" until you **place** it on a mural. Enrollment ≠ placement.
- **Ident mode is how you map atoms to identities.** You never have to guess which physical panel is
  which — you flash a screen's name onto the glass and confirm.

The five steps: **provision → enrol → approve → identify → place + assign**. The console's **Cold-start
wizard** walks you through the last four; below is each step, plus the manual equivalents.

---

## 0 · Prerequisites

- A reachable **control plane** (the server), e.g. `http://CONTROL_PLANE:8080`. The new machine must be
  able to reach it. It does **not** need the internet (see *Provisioning* in the README / `docs/DEPLOY.md`).
- An **enrollment token** if the server runs in **gated** mode (recommended). You never type it: it is
  baked into the boot menu the control plane serves. Read or regenerate it in the console under
  **Settings → Enrolment token**, or it's whatever you set as `POLYPTIC_BOOTSTRAP_TOKEN` at server boot.
  In **open** mode (no token, dev/lab) machines auto-approve and skip steps 1-3's gate, and the server
  logs a loud warning when open.

## 1 · Boot the machine

**Network boot is the only supported way to put Polyptic on a machine** (D57). There is no OS to
install and no agent to install: the machine boots the live image the control plane serves.

1. Download the network bootloader from **Settings → Onboard Screens** (or the cold-start wizard) and
   flash it to a USB stick (2 GB or larger). Balena Etcher or Rufus will do this.
2. Insert the stick into the machine connected to the screen and boot from it. Leave Secure Boot **on**.
3. It streams the current live image into RAM over HTTP, brings up the kiosk stack, and enrols. The
   control-plane address and enrolment token come down with the boot menu.

Netbooted machines pick up image updates on their own (D51). To boot without a stick, use UEFI HTTP
Boot or DHCP option 67; both are behind the *Boot without a USB stick* disclosure in the same card.

The agent identifies the machine by a stable DMI/MAC-derived id (a diskless machine has no persistent
`/etc/machine-id`), so every machine is distinct automatically. To advertise more than one output, set
`POLYPTIC_OUTPUTS="HDMI-1,HDMI-2"`.

## 2 · The machine dials in → **pending**

On start the agent makes an **outbound** WebSocket connection to the control plane and presents its
bootstrap token. In gated mode the machine is created **`pending`** — registered but not yet trusted —
and the agent holds the socket open, waiting. (No screens exist yet.) It now appears in the console under
**Machines**, and a badge shows on the nav rail.

## 3 · Approve it

In the console → **Machines**, the pending machine shows **Approve / Reject**.

- **Approve** → the server promotes it to `approved`, registers each reported output as a **Screen**,
  issues the agent a **durable per-machine credential** (the server stores only its `sha256`, the agent
  keeps the raw at `~/.polyptic/credential-<machineId>`), and pushes `server/apply`. From now on the box
  reconnects on its own credential — the bootstrap token is a one-time thing.
- **Reject** (optional reason) → the machine is denied and the socket closes. You can **Re-approve** a
  rejected machine later, or **Revoke** an approved one.

Open mode does this automatically the moment the agent connects.

## 4 · Identify the screens (and name them)

New screens get placeholder names. Select a screen (in the **Machines** view, or once placed, on the Wall
canvas) and hit **Ident** — its name flashes on the physical panel (per-machine **Ident all** flashes
every screen the box drives). Walk the wall, see which panel lit up, and **rename** the screen to
something meaningful — "Reception-Left", "Atrium-3". Inline rename is on the screen tile/inspector.

> This is the whole point of *screens, not machines*: after ident, the API/layout/scenes all address
> "Reception-Left", and you never touch a connector name or a machine id again.

## 5 · Place on a mural + assign content

A screen starts **unplaced** (in the left tray on the Wall view). To put it on the wall:

1. **Place** — drag the screen from the tray onto the canvas, or hit **Place**. Arrange it spatially;
   sizes default to the screen's native resolution.
2. **Combine (optional)** — shift-select adjacent placed screens and **Combine into surface** to make a
   **video wall**; one piece of content then **spans** across all member panels (bezel seams shown). Name
   the combined surface in the inspector. **Split** undoes it.
3. **Assign content** — **drag** a source from the **Content library** onto a screen or surface (or use
   the inspector's *Assign from library* / ad-hoc URL field). Sources are reusable `web` / `dashboard` /
   `image` / `video` entries, **linkable or uploaded** (Content view → Upload). The player swaps it in
   **instantly**, no reload.
4. **Save a scene (optional)** — *Save scene* snapshots the whole mural (layout + grouping + content) so
   you can re-apply the entire arrangement in one click, or schedule it.

That screen is now showing the content for real. Reboot it to confirm the **zero-click cold boot**:
power on → autologin → sway → agent reconnects on its credential → the wall renders its scene. No
clicks, and it survives an end-of-day smart-plug cut.

---

## Guided path — the Cold-start wizard

The console's **Cold-start wizard** (launch it from **Machines → Connect a machine**, or the first-run
empty state) bundles steps 2–5 into a flow:

- **Step 1 · Connect** — offers the **bootloader download** and how to boot from it (and notes when the
  server is in open mode), then **live-watches** for the new machine to appear pending and lets you
  **Approve** inline.
- **Step 2 · Map screens** — for each new screen: **Ident** (flash the panel), **name** it, and **place**
  it on a mural. Finish → straight to the Wall.

Use it for the first few boxes; the manual Machines view is faster once you know the wall.

## Day-2: changing, re-onboarding, removing

- **Re-IP / move a box** — the agent reconnects on its credential automatically; nothing to re-approve.
- **Replace a box** — reject/revoke the old machine, then boot the new one (it derives a fresh id, so it
  onboards clean). Re-ident its screens to the same names if you want scenes to keep working.
- **Decommission** — Reject the machine in the console and stop booting it from the Polyptic medium. A
  netbooted machine keeps nothing on disk, so there is nothing to uninstall.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Machine never appears | The machine can't reach the server (`curl http://CONTROL_PLANE:8080/healthz` from it) or a wrong/expired token. Check `journalctl --user -u polyptic-agent`. |
| Appears pending, won't approve | You're in gated mode — that's expected; **Approve** it. A *rejected* machine must be **Re-approved**. |
| Screen shows "Machine unreachable" | The agent/player isn't connected for that screen — the box is off, the kiosk session didn't start, or (dev) no player tab is open at `…:5173/?screen=<id>`. |
| Content tile shows a framing/CSP error | The target site refuses to be embedded (`X-Frame-Options` / `frame-ancestors`). Use an embed-friendly URL/dashboard, or the kiosk Chromium's trusted-content flags. |
| Nothing renders on the panel (kiosk) | `sway` likely didn't start on that GPU — try `WLR_NO_HARDWARE_CURSORS=1`, or provision with `--backend x11-i3` (NVIDIA / virtual-GPU fallback). See `docs/DEPLOY.md`. |

See also: **`docs/DEPLOY.md`** (device-side detail, backends, the VM walkthrough) and the README's
*Provisioning* section for the air-gapped install.
