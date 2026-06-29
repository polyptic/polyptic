# Polyptych — Development Roadmap

The remembered path. Fixed direction, flexible detail. Update the **CURRENT** marker as we go. Phases are sequenced by dependency, not by calendar.

> **CURRENT: Phase 1 ✅ done → building Phase 2a.** Vertical slice runs on bun (REST→player render ~4ms over WS, stable-id in-place swap, no reload; e2e 8/8). Now building Phase 2a: a persistent **Postgres** registry + multiple machines + a minimal **Admin UI** + **ident mode**.

---

## Phase 0 — Foundation ✅ (this commit)
Anchor docs (`CLAUDE.md`, `ROADMAP.md`, `DECISIONS.md`), monorepo skeleton (bun workspaces + `tsconfig.base`), and the shared **contract** (`@polyptych/protocol`, zod). The keystone everything builds against.
**DoD:** workspace resolves; protocol types compile; design + decisions committed.

## Phase 1 — Live vertical slice ✅ (done)
The thinnest end-to-end thing that proves the spine and the **instant** property.
- `server`: in-memory desired-state, Fastify REST + WS hub (`/agent`, `/player`) on :8080.
- `agent`: connects, registers one screen, opens the player via the `dev-open` backend.
- `player`: SolidJS page, connects over WS, renders the slice, **swaps content via keyed DOM diff (no reload)**.
- `deploy`: docker-compose Postgres (Phase 2+, unused by the slice); run everything with `bun run dev`.
**DoD met:** REST change → player render in **~4ms** over WS, **stable-id in-place swap**, no reload. Verified by `scratchpad/harness.ts` (8/8) + typecheck + Vite build. See `docs/DEV.md`. Built in parallel against the locked contract, then cross-reviewed + fixed.

## Phase 2a — Registry (Postgres) + multi-machine + Admin UI + ident ◀ CURRENT
Real Machine/Output/Screen/Scene registry in **PostgreSQL** (dev via `deploy/docker-compose.yml`), behind a `Store` interface (`PostgresStore` default; `MemoryStore` test double). Multiple machines × screens. A minimal **Admin UI** (`packages/admin`): live machines→screens list with connection status, **rename**, and an **ident** button. **Ident mode** flashes a screen's friendly name (the player overlay is already built). Promote the e2e harness into committed `bun test`.
**DoD:** bring up Postgres + the stack; connect 2 machines; see both machines' screens in the Admin UI; click ident → the player flashes the name; rename a screen → persists across a server restart.

## Phase 2b — Enrollment/claim + mTLS identity
Outbound-WSS **enrollment**: agent dials with a one-time bootstrap token → appears **pending** → operator **claims/approves** in the Admin UI → durable identity. Harden agent↔server identity to **mTLS** client certs keyed to `/etc/machine-id` (D12).
**DoD:** a fresh machine shows as pending; approving it admits its screens; an unknown/unapproved machine is rejected.

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
