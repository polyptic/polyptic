# Polyptic — Claude working guide

**Read this first every session**, then `docs/ROADMAP.md` (where we are + what's next) and `docs/DECISIONS.md` (locked calls — do not re-litigate). If a decision genuinely changes, update `docs/DECISIONS.md` with the new entry and reasoning.

## What this is
Polyptic is a **generic, self-hostable** system to centrally orchestrate **walls of screens / fleets of display kiosks** from a web UI. Vendor-neutral by design — no dependency on any specific dashboard, identity provider, or content source. Full narrative: `docs/DESIGN.md`. Build reference: `docs/ARCHITECTURE.md`.

## Non-negotiables (the spirit — keep these true)
1. **Screens are first-class and named; machines are plumbing.** The API/layout/scenes address named screens. Ident mode maps physical panels → screen identities.
2. **One global desired-state, reconciled** (Kubernetes-controller style). Agents are dumb reconcilers; the control plane is the brain.
3. **Instant.** Changes propagate over **WebSocket** and apply in **< ~150ms with no page reload**. Snappy enough to impress stakeholders — a hard requirement, the antithesis of the old clunky setup.
4. **Zero-click cold boot to content.** Power on → autologin → compositor → agent reconnects → renders. No clicks, no sleeps, no typed passwords.
5. **Generic everywhere.** Display backend (Wayland/sway **and** X11/i3), identity (OIDC, any IdP), and content (pluggable adapters) are all swappable. Never hard-wire a vendor.
6. **Buy the substrate, build the brain.** Device stack (Ubuntu, sway/greetd/systemd, Chrome — surf fallback) is borrowed. Only `server` + `agent` + `player` are ours.

## Two web apps (don't conflate)
- **Console** (`packages/console`, **Vue 3 + Vite + Vue Router + Pinia + Vue Flow**) — the operator app: the murals canvas (Vue Flow), machines / content / scenes / settings, sign-in. (D28; the old SolidJS `packages/admin` is being retired by 3e.)
- **Player** — headless page shown fullscreen on each wall screen; connects over WS, renders its screen's slice. This is what makes changes instant (DOM diff, no reload).

## Two WS channels
- **Agent channel** (machine ↔ server): enrollment, heartbeat, window placement, screenshots, ident, OS lifecycle.
- **Player channel** (screen ↔ server): content for that screen's slice, pushed live. Content never routes through the agent — it goes server → player directly, for speed.

## Stack (locked — see DECISIONS.md)
- **TypeScript everywhere**, ESM, **bun** workspaces, single `tsconfig.base.json`. Bun installs deps, runs TS natively (`bun --watch`), and serves the Vite player — no Node/pnpm/tsx.
- **`@polyptic/protocol`** — shared zod contracts. **All cross-process messages are defined and validated here.** Change the contract here first.
- **`@polyptic/server`** — Fastify + Postgres + `ws`; REST + WebSocket; Prometheus `/metrics`.
- **`@polyptic/agent`** — Bun single binary; controls host via IPC sockets + child processes; `DisplayBackend` interface (`wayland-sway` | `x11-i3`, auto-detected).
- **`@polyptic/console`** — Vue 3 + Vite + Vue Router + Pinia + Vue Flow (the operator console; D28). **`@polyptic/player`** — Vue 3 + Vite (migrated from SolidJS at 3b; renders span slices for video walls). `@polyptic/admin` (SolidJS) — legacy, retired by 3e.

## Repo layout
```
CLAUDE.md                 this file
README.md                 product overview
docs/DESIGN.md            full design narrative
docs/ARCHITECTURE.md      build-facing reference (data model, API, gotchas)
docs/ROADMAP.md           phased dev path + CURRENT marker
docs/DECISIONS.md         decisions log (ADR-lite)
packages/protocol         shared zod contracts (the keystone)
packages/server           control plane (TODO)
packages/agent            per-client agent (TODO)
packages/player           per-screen renderer (TODO)
deploy/                    docker-compose (dev) + Helm chart (later)
```

## Conventions
- TS **strict**; ESM; 2-space indent; prefer `type` inference from zod schemas (`z.infer`) over hand-written types.
- Every boundary (WS message, REST body, DB row) is a zod schema in `protocol`. Parse at the edge; trust types within.
- Keep the agent **unprivileged**; isolate the few privileged host actions behind a minimal helper.
- No vendor names in core code paths — integrations live behind adapters/backends.

## Anti-drift ritual
1. Start of session: read `CLAUDE.md` → `docs/ROADMAP.md` (CURRENT + next task) → `docs/DECISIONS.md`.
2. When you finish a chunk, move the CURRENT marker in ROADMAP and note what's next.
3. When you make a material choice, append it to DECISIONS.md (date, choice, why).
4. If you're about to hard-wire a vendor or add a click/sleep/reload, stop — that violates a non-negotiable.
