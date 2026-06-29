# Polyptic — Development Roadmap

The remembered path. Fixed direction, flexible detail. Update the **CURRENT** marker as we go. Phases are sequenced by dependency, not by calendar.

> **CURRENT: Phase 3b next.** Project **renamed Polyptych → Polyptic** (folder `~/code/polyptic`, `@polyptic/*`, `POLYPTIC_*`, all paths/brand). **Phase 3a ✅** — the Vue console (`packages/console`: Vue 3 + Vite + Vue Router + Pinia + **Vue Flow**) + Wall murals canvas + server murals/placement + the **Polyptic logo**, on **:5175** (old SolidJS admin :5174 until 3e). **Phase 4 ✅ committed (code-complete, pending the UTM-VM visual cold-boot test)** — real sway/x11 backends + `apt install` packaging. Verified: full typecheck green, e2e **28/28**. Sub-phases left: **3b** combined surfaces (player → Vue) → 3c content library → 3d scenes (incl. scenes-left layout) → 3e machines view + cold-start → 3f sign-in (local auth) + settings. Then 5 preview/health/Helm · 6 OIDC · 7 media.

---

## Phase 0 — Foundation ✅ (this commit)
Anchor docs (`CLAUDE.md`, `ROADMAP.md`, `DECISIONS.md`), monorepo skeleton (bun workspaces + `tsconfig.base`), and the shared **contract** (`@polyptic/protocol`, zod). The keystone everything builds against.
**DoD:** workspace resolves; protocol types compile; design + decisions committed.

## Phase 1 — Live vertical slice ✅ (done)
The thinnest end-to-end thing that proves the spine and the **instant** property.
- `server`: in-memory desired-state, Fastify REST + WS hub (`/agent`, `/player`) on :8080.
- `agent`: connects, registers one screen, opens the player via the `dev-open` backend.
- `player`: SolidJS page, connects over WS, renders the slice, **swaps content via keyed DOM diff (no reload)**.
- `deploy`: docker-compose Postgres (Phase 2+, unused by the slice); run everything with `bun run dev`.
**DoD met:** REST change → player render in **~4ms** over WS, **stable-id in-place swap**, no reload. Verified by `scratchpad/harness.ts` (8/8) + typecheck + Vite build. See `docs/DEV.md`. Built in parallel against the locked contract, then cross-reviewed + fixed.

## Phase 2a — Registry (Postgres) + multi-machine + Admin UI + ident ✅ (done)
Real Machine/Output/Screen/Scene registry in **PostgreSQL** (dev via `deploy/docker-compose.yml`), behind a `Store` interface (`PostgresStore` default; `MemoryStore` test double). Multiple machines × screens. A minimal **Admin UI** (`packages/admin`): live machines→screens list with connection status, **rename**, and an **ident** button. **Ident mode** flashes a screen's friendly name (the player overlay is already built). Promote the e2e harness into committed `bun test`.
**DoD:** bring up Postgres + the stack; connect 2 machines; see both machines' screens in the Admin UI; click ident → the player flashes the name; rename a screen → persists across a server restart.

## Phase 2b — Enrollment/claim + durable credential ✅ (done)
Outbound-WSS **enrollment**: agent dials with a one-time bootstrap token → appears **pending** → operator **approves** in the Admin UI → durable per-machine **credential** (server stores only sha256; agent keeps the raw secret). Dev default is open-enrollment (auto-approve, with a boot warning); setting `POLYPTIC_BOOTSTRAP_TOKEN` switches on gating. **mTLS transport is deferred** to the deploy/hardening layer (D12) — the credential model is the app-level seam mTLS client-certs drop into.
**DoD met:** a fresh machine shows pending; approving admits its screens (live `server/apply`); an unknown/wrong-token/unapproved machine is rejected + disconnected. Verified by e2e (10 gated tests) + a Postgres restart capstone.

## Phase 3 — Murals (spatial canvas), surfaces, content library, scenes
The big UI phase. Model adopted from the **Console v2** design (D20–D25):
- **Murals (D21):** several named, switchable canvases. A Screen is **unplaced** (tray) or **placed** on one mural at `{x,y,w,h}` — operators drag/snap screens to compose a wall.
- **Combined surfaces / video walls (D22):** combine adjacent screens into one `Surface`; content **spans** it (bezel seams shown); split to undo; "ident all".
- **Content library (D23):** reusable `ContentSource` items (web/dashboard/image/video + auth strategy) dragged onto a screen or surface.
- **Scenes (D24):** save the whole composition (content + layout + grouping) per mural; switch → atomic fan-out across all screens, instantly.
- **Activity feed (D25):** live event stream in the console.
- Contract gains: Mural, Surface, ContentSource, Scene, screen placement (position/size), + the WS/REST to drive them. **Admin UI** rebuilt as the canvas console (per the chosen Claude Design direction).
**DoD:** compose a mural by snapping/combining screens; assign content from the library (incl. spanning a surface); save a scene; switch scenes → all screens flip together, instantly.

> **Missing operator flows** (not in Console v2; queued for the design agent → then build): cold-start (nothing connected), the **enrollment/approval** UI (2b's bouncer), first-time *ident→name→place* mapping, a **fleet/machines** view, **content-source** add/edit, **scene management**, and console **settings/sign-in** (admin OIDC, Phase 6).

## Phase 4 — Real device stack + zero-click boot
**Delivery = `apt install polyptic-agent`** (a `.deb`), NOT a mandatory image (D26). Setup logic lives in the agent binary (`polyptic-agent setup`, distro-aware: apt/dnf/pacman → generic across systemd Linux); image + cloud-init/Ansible are optional wrappers. Start from **Ubuntu Server-minimal** (D27); the package wires **greetd** autologin → **sway** (Wayland; `x11-i3` fallback for NVIDIA, D9) → **systemd**-supervised agent + **Chromium-per-output** (`.deb` Chromium not the snap; `cog`/WPE fallback). **Make the `DisplayBackend`s real** — replace the Phase-1 sway/x11 stubs with swaymsg-IPC placement + Chromium launching. Crash/restore hardening (`Restart=always`, popup/`exit_type` suppression, no `swayidle`, `dpms on`). Config (control-plane URL + bootstrap token) via debconf or `/etc/polyptic/agent.toml` → it enrols (2b) → approve in the console.
**DoD:** cold power-on → wall shows the active scene with zero interaction; survives EOD smart-plug cut.
> **Test note:** **OrbStack** (headless — no display) verifies the install → systemd → agent → enrolment plumbing + a *headless* sway, fast. For the **visual** cold-boot DoD use a desktop-virtualization VM with a real virtual display — **Parallels** (or UTM) — where sway + Chromium actually render. Caveats: a VM gives ~one virtual output, so *multi-output-per-client* placement + the real 6-screen wall stay a real-hardware test; and a virtual GPU may need `WLR_NO_HARDWARE_CURSORS` or the x11/i3 fallback (which usefully exercises that path). On Apple Silicon the guest is arm64 — build the `.deb` for the test VM's arch *and* for the (likely amd64) thin clients.

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
**Phase 0-AMRC quick win:** point the *existing Windows wall* at anonymous Grafana `&kiosk` / `d-solo` URLs to delete the plaintext-password boot hack now. No Polyptic code; reversible. Relieves pain while the product is built.
