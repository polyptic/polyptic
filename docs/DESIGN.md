# Polyptych — Design Notes

*Last updated 2026-06-29.*

Design record for **Polyptych** — a *generic, vendor-neutral* display-wall / kiosk-fleet orchestration product. Driven by the need to replace the AMRC ACS demo wall's fragile Windows boot scripts, but built as a standalone product with **no dependency on ACS**. The repo `README.md` + `docs/ARCHITECTURE.md` are the concise mirrors; this is the working narrative. (A formal Shape Up **pitch** will be added as `docs/PITCH.md`.)

> **Reframe (important):** earlier drafts were ACS-coupled. Decision today: Polyptych is a generic product we *can use for* ACS — not based on it. ACS is one example integration (it validated the OIDC + dashboard-embedding paths); nothing in the product depends on Factory+, Sparkplug, ConfigDB, the UNS, or `@amrc-factoryplus/service-client`.
>
> **Naming:** working name was "Mural" → changed to **Polyptych** after a clash review (see *Naming* below).

Produced from two multi-agent passes: (1) research + architecture (7 research lanes → 3 architectures → judged), (2) a name-clash sweep for "Mural".

---

## TL;DR — the recommendation

Build **Polyptych**: a small **bespoke TypeScript control plane** (`polyptych-server`, runs on any Kubernetes or Docker host), **thin per-client agents** (`polyptych-agent`) that dial *outbound* and reconcile to desired state (Kubernetes-controller-style), and a **web "mosaic player"** (`polyptych-player`) that renders each screen's slice of *one global layout*. Run the player **on a minimal Wayland compositor (`sway`)** for a free VNC/screenshot preview and a **native-window escape hatch**.

**Buy the substrate, build the brain.** Device management (Ubuntu + `sway` + `greetd` + `systemd`) and rendering (Chromium kiosk) are borrowed wholesale. The *only* net-new build is the control plane that owns **one global layout + named scenes + an API** — which no off-the-shelf signage product provides.

**Screens, not machines.** Users drive *named screens* ("Nessie", "Bertha"…); a client is just plumbing. An **ident mode** flashes each screen's name on its physical panel so onboarding/relabelling is point-and-confirm.

**Vendor-neutral.** Any web content/dashboard/image/video; **generic OIDC** (any IdP); content **adapters** (Grafana ships as a first-class *optional* adapter, never a dependency). Ships as a Helm chart **and** a docker-compose.

**Quick win first (days):** point an existing wall at anonymous/`kiosk` dashboard URLs to delete any plaintext-password boot hack immediately and validate that the wall can be decoupled from human auth. Reversible, no new infra.

---

## The problem we're killing (the AMRC instance)

- 3 Windows thin clients, each driving 2 of 6 screens. Layout: `[Grafana][Grafana] [Grafana][ACS Visualiser] [Grafana][Grafana]`.
- Each boots a fragile AutoHotkey-style script: *click here / wait 2s / open chrome / wait 10s / type plaintext password*.
- Any startup change breaks it; tweaking a screen = RDP in (which logs out the local session), edit, trial-and-error.
- Smart plugs cut power EOD → cold-boot must reach content with **zero clicks**.

Polyptych solves this as the *general* case: any wall, any content, any IdP, configured from a web UI with scenes + an API.

---

## Core design principles

1. **Screen is first-class; machine is plumbing.** Registry/layout/scenes/API all address *named screens*. Onboarding maps a machine's outputs to screen identities. → **ident mode** (flash name/number/colour on each output).
2. **One global layout, reconciled** — Kubernetes-controller pattern (spec/status, generation/observedGeneration). The fleet is one consistent system, not N kiosks.
3. **Buy the substrate, build the brain** — only the global-layout + scenes + API + UI is bespoke.
4. **Compositor owns geometry; systemd owns lifecycle** — no click/sleep timing hacks; crash recovery is `Restart=always`.
5. **Typed surfaces** so we're never trapped in an iframe-only model.
6. **Outbound-only agents** — no inbound ports/NAT into the client LAN.
7. **Pluggable adapters + generic OIDC** — integrations are seams, not foundations.

---

## Architecture (layers)

- **Device:** Ubuntu 24.04 minimal → `greetd` passwordless autologin (`kiosk`) → `sway` (outputs pinned by connector) → `systemd --user` services launch the agent + one Chromium `--app` per output (own `--user-data-dir`, popup-suppression flags, `exit_type` reset). No `swayidle`; `output * dpms on`. **Wayland's no-self-positioning is the feature** — all geometry goes through the compositor via `swaymsg` IPC. *GPU caveat:* Intel/AMD trouble-free; NVIDIA needs extra config or an X11+i3 fallback — verify on real hardware.
- **Rendering — hybrid typed surfaces:** default `web-url`/`dashboard-*` tiles render in the CSS-grid **player**; `web-window`/`native-app` are placed by the agent as **top-level windows** (escape hatch for framing-blocked / non-web / future sources). Dashboards use single-panel embeds (e.g. Grafana `/d-solo`, all vars + `&kiosk` in the URL).
- **Control plane (`polyptych-server`):** TypeScript/Node (Fastify + `ws` + Postgres + `zod`), standalone, runs on any k8s/Docker. Owns the Machine/Output/Screen registry, the **one global virtual-canvas Layout** (arbitrary regions — not a fixed grid), and named **immutable versioned Scenes**. Reconcile: bump one global `desiredRevision` → recompute each machine's slice → fan out apply; optional PREPARE/COMMIT barrier for tear-free flips. Web UI: layout editor, scenes, live preview, ident trigger, fleet health. Prometheus `/metrics`.
- **Transport:** agents dial **outbound `wss://` only**; ~10s lease, reconnect backoff+jitter; each agent **caches its last-good slice** and keeps rendering through controller outages.
- **Auth (generic):** admin UI/API via **OIDC** standard discovery (any IdP). Per-content-source strategies: `public` · `anonymous-viewer` · `reverse-proxy-header-injection` · `persisted-session` · `oidc`. Agent identity: bootstrap token → mTLS cert keyed to `/etc/machine-id` (or OIDC client creds).
- **Preview:** always-on `grim` JPEG thumbnails up the outbound WSS (show *real* render + auth state); on-demand `wayvnc`→noVNC tunnelled through the control plane; WYSIWYG intended-layout diagram alongside.

---

## Content model (typed surfaces) + adapters + media

Surface types: `web-url` · `dashboard-panel` · `dashboard-page` (player iframes) · `web-window` · `native-app` (agent top-level windows) · `image` · `video` · `slideshow`.

**Adapters** resolve a logical source → concrete URL/launch-spec + auth strategy + refresh. `web`, `grafana` (reference), `media`, `native`. New integrations = new adapters; the core model never changes.

**Office/PowerPoint (nice-to-have, phase 5):** pre-convert PPTX → images/PDF/MP4 server-side (`soffice --headless --convert-to`) and play as `image`/`slideshow`/`video`. Never render Office live. Images/MP4 the player handles natively. Whole media track is a clearly-labelled phase-5 item so v1 stays lean.

---

## Swarm / "screens not machines" / ident mode

- `Machine { id=/etc/machine-id, label, outputs[] }`, `Screen { id, friendlyName, machineId, output, resolution }`. Screen carries the stable id + fun name; Machine is onboarding plumbing.
- **Onboarding:** image a client → agent registers + enumerates outputs (`swaymsg -t get_outputs` → connector + make/model/serial) → trigger **ident mode** → each panel shows its name/number/colour → confirm/rename in UI. Swap a panel → re-ident.
- **One global layout** = the screens are regions of a single canvas; scenes are named snapshots; switching fans out atomically.

---

## Build vs buy

**Borrow wholesale:** device stack (Ubuntu, `sway`/`greetd`/`systemd`, Chromium kiosk, `grim`, `wayvnc`); `grafana/grafana-kiosk` for the Phase-0/1 quick win; balena's OTA/env-as-config *discipline* (ship the agent as a single-file `.deb`, provision the image declaratively) — **not** balenaCloud the SaaS.

**Build (only net-new):** `polyptych-server` (registry + global layout + versioned scenes + REST/WS API + web UI) and `polyptych-agent`. Tightly scoped, *not* a generic signage CMS.

**Rejected:** signage CMSs (Xibo/Anthias/PiSignage/info-beamer) all model N independent screens with playlists — no one-global-layout, no scenes-across-fleet; borrow Xibo's *data model* as inspiration only. balenaCloud = SaaS (fails self-host) + content-agnostic; openBalena strips the very features that made it attractive. Commercial AV controllers (Userful/Datapath/Hiperwall) = enterprise/appliance, off-stack. SaaS-only (ScreenCloud/Yodeck) ruled out.

---

## Roadmap (quick win first)

- **Phase 0 (1–3 days, reversible, on current boxes):** anonymous/`kiosk` dashboard URLs → kills the plaintext-password hack today; validates auth-decoupling.
- **Phase 1 (≈1–2 wk):** one Ubuntu client, autologin→sway→systemd Chromium per screen, static config. *Verify GPU/Wayland.*
- **Phase 2 (≈2–3 wk):** control-plane MVP + agent reconciling one scene; screen registry + ident mode.
- **Phase 3 (≈3–5 wk):** mosaic player across all screens + typed surfaces + scenes + layout editor + atomic fan-out.
- **Phase 4 (≈2–3 wk):** thumbnails + on-demand VNC; Helm + compose packaging; OIDC + mTLS identity; Prometheus; last-good-slice caching.
- **Phase 5 (nice-to-have):** image/video/slideshow + Office→media conversion; native-app surfaces as needs arrive.

**Effort:** ~1.5–3 engineer-months to v1 for 1–2 TS/Linux engineers, front-loaded by the days-scale Phase 0. Biggest estimate risk: GPU/Wayland validation on the real hardware.

---

## Naming — why Polyptych (not Mural)

Multi-modal clash sweep (commercial products, same-concept signage/display tools, npm/PyPI/crates/Docker, GitHub, trademark + domains, fallback names):

- **No same-concept clash.** Nothing in display-wall/signage/kiosk/dashboard space is named "Mural" (incumbents: Userful, Hiperwall, Activu, VuWall, Barco, Xibo, Screenly, Yodeck…). The only conceptually-identical hit is Stanford's *defunct ~2000 academic "MURAL"* tiled-display renderer — no trademark, no namespace; proves "Mural" is the *obvious* name (validating, not blocking).
- **But the adjacent clash is big:** **MURAL by Tactivos, Inc.** (mural.co) — ~$2B-valuation visual-collaboration whiteboard, registered US+intl software marks (USPTO `97134497` "MURAL", `99516057` "MURAL AI", Nice classes 9/42), a "Mural for Interactive Displays" line, total SEO + domain lock-up (`mural.*`, `getmural`, `usemural` all gone). Mural Pay (fintech) crowds the bare brand further.
- **Namespace for bare "mural" is closed:** npm/PyPI abandoned, crates.io active (May 2026), Docker Hub org held, `github.com/mural` + `/muralco` taken.
- **Verdict:** Mural is *fine as an internal codename* (low risk; unenforceable against an internal University deployment) but **high-risk for any open-source/commercial spin-out** (trademark + namespace + SEO). Qualified variants (`Murald`, `OpenMural`) don't help — they keep the dominant MURAL element.
- **Decision:** since Polyptych is framed as a *generic product* (spin-out plausible), adopt a distinct, clearable name **now**. **Polyptych** = a multi-panel painting whose panels compose one image (perfect screens/scenes/mosaic metaphor); npm `polyptych` free, only scattered hobby GitHub repos. *Trademark/domain not yet cleared — do a formal clearance before any public launch.*

---

## Open questions / decisions needed (for Alex)

1. **Data sensitivity:** is every wall dashboard safe for anonymous Viewer, or does some need the reverse-proxy / OIDC path? (Biggest fork; AMRC-specific.)
2. **Thin-client GPU:** Intel/AMD (trouble-free on wlroots) or NVIDIA (extra config / X11 fallback)? Verify on real hardware — also gates `grim`/`wayvnc` preview.
3. **Embeddability of any given source** (e.g. the ACS Visualiser): does it send `X-Frame-Options`/CSP `frame-ancestors`? If not iframable → render as a top-level `web-window`.
4. **How real/soon is the non-web future?** Concrete near-term native-app need or speculative? Sets how much native-window machinery to build now vs defer.
5. **Operating commitment:** appetite to own a bespoke control plane (~1.5–3 eng-months + maintenance)? (Recommendation assumes yes.)
6. **Spin-out intent:** how seriously open-source/productise Polyptych? Determines when to do formal trademark/domain clearance for the name.
7. **Network/identity:** can clients reach the control plane over WSS on the same LAN/VLAN; is mTLS client-cert (or OIDC client creds) acceptable to the security team for agent identity?

---

## Appendix — key technical gotchas (generic)

- **Wayland positioning:** Chromium `--window-position` is a no-op natively — placement MUST go through `sway` (config or IPC). X11 works (fallback).
- **Multiple Chromium share `app_id="chromium"`** on Wayland → match on **title**, an **IPC placer** keyed on launch order, or force **XWayland** (`--ozone-platform=x11` + `--class=`).
- **Each Chromium needs its own `--user-data-dir`** or a second launch opens a tab in the first.
- **Hard power cut → "Restore pages":** suppress with `--disable-session-crashed-bubble --hide-crash-restore-bubble` *and* sed-reset `exit_type`/`exited_cleanly` in profile `Preferences`.
- **Headless autologin:** `--password-store=basic` (avoid gnome-keyring prompt); `--force-device-scale-factor=1`; `--autoplay-policy=no-user-gesture-required` if media plays.
- **Dashboard embedding:** source must permit framing (no `X-Frame-Options: deny`; if CSP on, list player origin in `frame-ancestors`). Keep player + content on **one registrable domain** for `SameSite=Lax` cookies. Grafana: `[security] allow_embedding=true`, `/d-solo/<uid>/<slug>?orgId=1&panelId=<id>&kiosk&<all vars>`; put every var + `&kiosk` in the URL (in-iframe refresh can drop kiosk — grafana/grafana#102455); pin version, re-test on upgrade.
- **Cross-origin iframe load-failure is undetectable** (SOP) → parent-side watchdog: spinner, load timeout, periodic `iframe.src = iframe.src`, error card + backoff.
- **`grafana-kiosk`** flags: `-URL`, `-kiosk-mode=full|tv|tv-list|disabled`, `-login-method=anon|local|gcom|goauth`, `-playlist`, `-window-position=X,Y`, `-window-size=W,H`.

## Appendix — AMRC example-integration facts (from the ACS repo read)

Polyptych depends on none of this; recorded because AMRC is the first deployment.
- Grafana 6.52.4 (Helm), Keycloak OIDC realm `factory_plus` (Auth Code + PKCE, `offline_token`), Traefik 23.1.0 `IngressRoute` (`grafana.<baseUrl>`, `visualiser.<baseUrl>`, `i3x.<baseUrl>`); no kiosk configured today.
- ACS Visualiser = `acs-visualiser` Node/Express (live MQTT traffic view); **no explicit frame headers found** — confirm iframability at runtime, else render as a top-level `web-window`.
- `i3X-Explorer` (`~/code/i3X-Explorer`) is a separate Electron app — *not* the wall visualiser.
- For the AMRC deployment, host `polyptych-server` on the existing cluster behind Traefik and point its admin OIDC at Keycloak; that's an integration choice, not a product requirement.
