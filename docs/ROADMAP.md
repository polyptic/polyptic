# Polyptych — Development Roadmap

The remembered path. Fixed direction, flexible detail. Update the **CURRENT** marker as we go. Phases are sequenced by dependency, not by calendar.

> **CURRENT: Phase 0 → entering Phase 1.** Foundation (docs, contract, workspace) is in place; next is the live vertical slice.

---

## Phase 0 — Foundation ✅ (this commit)
Anchor docs (`CLAUDE.md`, `ROADMAP.md`, `DECISIONS.md`), monorepo skeleton (pnpm workspaces + `tsconfig.base`), and the shared **contract** (`@polyptych/protocol`, zod). The keystone everything builds against.
**DoD:** workspace resolves; protocol types compile; design + decisions committed.

## Phase 1 — Live vertical slice ◀ NEXT
The thinnest end-to-end thing that proves the spine and the **instant** property.
- `server`: holds desired-state in memory, exposes a WS hub + a stub REST call to set one screen's content.
- `agent`: connects, registers one fake "screen", launches one player (on dev, just opens the page).
- `player`: SolidJS page, connects over WS, renders one surface, **swaps content via DOM with no reload** when the server pushes a change.
- `deploy`: docker-compose runs the server (+ Postgres, unused yet) for local dev.
**DoD:** change a screen's URL via a REST call → it updates on the player in < ~150ms, no reload. Demo-able.
**Good candidate for a parallel build** (server / agent / player against the locked contract).

## Phase 2 — Screens-first registry + enrollment + ident
Real Machine/Output/Screen registry in Postgres. Outbound WSS **enrollment** (bootstrap token → claim → mTLS cert). **Ident mode** (flash friendly name on each output). Multiple screens across multiple machines.
**DoD:** image-and-enroll a 2nd machine; name its screens via ident; address screens by name.

## Phase 3 — Layout, scenes, adapters, instant fan-out
Global virtual-canvas **Layout** (arbitrary regions). Named, versioned **Scenes**. **Admin UI** layout editor + scene switcher. **Typed surfaces** + **content adapters** (web, dashboard/Grafana, image, video). Atomic scene fan-out across all screens.
**DoD:** drag content onto named screens; save a scene; switch scenes → all screens flip together, instantly.

## Phase 4 — Real device stack + zero-click boot
Ubuntu image: greetd autologin → compositor → systemd-supervised agent + Chromium per output. `DisplayBackend` (`wayland-sway` default, `x11-i3` fallback). Agent as single-file `.deb`. Declarative provisioning (cloud-init/Ansible/image). Crash/restore hardening.
**DoD:** cold power-on → wall shows the active scene with zero interaction; survives EOD smart-plug cut.

## Phase 5 — Preview, health, resilience, packaging
`grim` thumbnails (always-on) + on-demand `wayvnc`→noVNC through the control plane. Prometheus metrics, fleet/screen health in the admin UI. Agent caches last-good slice (rides out control-plane outages). Helm chart for any cluster.
**DoD:** see every screen live in the UI; control-plane restart never blanks the wall.

## Phase 6 — Auth, properly
Generic **OIDC** for admin UI/API (any IdP). Per-source auth strategies (`public`/`anonymous`/`reverse-proxy`/`oidc`). mTLS agent identity (or OIDC client creds).
**DoD:** a sensitive dashboard shows authenticated content on the wall without a human logging in; admin UI is OIDC-gated.

## Phase 7 — Nice-to-haves
Media: image/video/**slideshow** + Office→media conversion (server-side). **Native-app** surfaces (CAD/RTSP/etc.) via the agent's top-level-window placement.
**DoD:** play a looping video + a converted slide deck as scene content; place one native window beside web tiles.

---

### Parallel AMRC track (independent, anytime)
**Phase 0-AMRC quick win:** point the *existing Windows wall* at anonymous Grafana `&kiosk` / `d-solo` URLs to delete the plaintext-password boot hack now. No Polyptych code; reversible. Relieves pain while the product is built.
