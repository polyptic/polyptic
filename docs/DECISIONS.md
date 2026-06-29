# Polyptych — Decisions Log

ADR-lite. Newest at the bottom. Don't re-litigate accepted decisions in passing — if one needs to change, add a new entry that supersedes the old and say why.

| # | Date | Decision | Status | Why |
|---|------|----------|--------|-----|
| D1 | 2026-06-29 | **Generic, vendor-neutral product** — not coupled to ACS/Factory+. ACS is one example deployment. | Accepted | Reusable across any wall; ACS was only used to validate OIDC + dashboard embedding. |
| D2 | 2026-06-29 | **Name: Polyptych** (working name "Mural" rejected). | Accepted | "Mural" clashes with Tactivos MURAL (registered SW marks, owns the namespace) — fine internally, risky for spin-out. Polyptych keeps the multi-panel metaphor, clean namespace. Trademark/domain not yet cleared — clear before any public launch. |
| D3 | 2026-06-29 | **Architecture: control plane + thin reconciling agents + per-screen player.** Desired-state, Kubernetes-controller style. | Accepted | One global layout, swarm-consistent; matches a model the team already thinks in. |
| D4 | 2026-06-29 | **Screens are first-class & named; machines are plumbing.** Ident mode maps panels → screens. | Accepted | User's core mental model; makes config + onboarding intuitive. |
| D5 | 2026-06-29 | **Instant updates over WebSocket, DOM-diff in the player, no reload (< ~150ms).** | Accepted | Hard requirement — must impress stakeholders; old setup was slow/clunky. |
| D6 | 2026-06-29 | **TypeScript everywhere**, ESM, **pnpm** workspaces. | Accepted | Team strength; one language across server/agent/player/contract. |
| D7 | 2026-06-29 | **Agent = Bun single binary**; controls host via IPC sockets + child processes; stays unprivileged with a minimal privileged helper. | Accepted | Trivial edge deploy (one file); no runtime to install; small blast radius. |
| D8 | 2026-06-29 | **Player & Admin UI = SolidJS + Vite.** | Accepted | Lean, fast, good for a page that runs unattended for days. |
| D9 | 2026-06-29 | **Generic display backend**: `DisplayBackend` interface with `wayland-sway` (default) + `x11-i3` (fallback), runtime auto-detected. | Accepted | Must be generic; Wayland best for Intel/AMD, X11 for NVIDIA/edge cases. |
| D10 | 2026-06-29 | **Shared contract in `@polyptych/protocol` (zod).** All cross-process messages defined + validated there. | Accepted | Single source of truth for wire types; enables parallel package builds. |
| D11 | 2026-06-29 | **Auth: anonymous-first, login-page acceptable initially**, but build the per-source auth-strategy seam (`public`/`anonymous`/`reverse-proxy`/`oidc`) from day one. | Accepted | Get moving fast; some content needs real auth "very soon after" — must be a config change, not a rewrite. |
| D12 | 2026-06-29 | **Outbound-only agents** (dial control plane over WSS); enrollment via one-time bootstrap token → claim → durable mTLS cert. | Accepted | No inbound ports/NAT holes into the client LAN; cold boot = reconnect; secure enrollment. |
| D13 | 2026-06-29 | **Two WS channels**: agent channel (device/placement/lifecycle) and player channel (content). Content goes server → player directly, never via the agent. | Accepted | Keeps content path fast (instant) and the agent simple. |
| D14 | 2026-06-29 | **Build order: vertical slice first** (server+agent+player proving instant on one screen), then breadth. | Accepted | De-risks the spine + the headline "instant" property early; demo-able sooner. |
| D15 | 2026-06-29 | **Obsidian dropped as the doc home; everything lives in the repo.** | Accepted | The vault's gdrive-sync plugin kept trashing externally-written notes; the repo is the durable source of truth. |
