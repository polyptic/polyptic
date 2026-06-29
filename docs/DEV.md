# Polyptic — local development

How to run the **Phase 2a** stack on your dev machine: a persistent **Postgres**
registry, **multiple machines**, a minimal **Admin UI**, and **ident mode** — on top
of the Phase 1 headline property (change a screen's content with one REST call and
watch the player swap it in place in **< ~150 ms, with no page reload**).

Phase 2a adds a real **Store**. The registry (machines, screens incl. `friendlyName`,
per-screen surfaces) now lives in **PostgreSQL** by default and is loaded on boot, so a
**rename survives a server restart**. The store is swappable: `STORE=memory` uses an
in-memory test double (no Docker needed — that's what `bun run test` uses).

Everything runs on **Bun**. Postgres runs in **Docker**. Works on macOS and Linux.

---

## Prerequisites

- **Bun ≥ 1.1** — <https://bun.sh> (`curl -fsSL https://bun.sh/install | bash`). Check with `bun --version`.
- **Docker** (with the Compose plugin) — only to run **Postgres** for dev. Check with `docker compose version`.

> No Node, nvm, pnpm, or tsx needed — Bun installs the deps and runs the TypeScript
> server/agent/admin natively. Docker is used **only** for the Postgres container;
> if you set `STORE=memory` you don't need Docker at all (that's the test path).

---

## Install & run

From the repo root:

```sh
bun install
bun run db:up      # start Postgres 16 in Docker (named volume `pgdata`)
bun run dev        # build the contract, then run the whole stack
```

`bun run dev` first builds the shared contract (`@polyptic/protocol`) and then starts
five processes together under [`concurrently`](https://www.npmjs.com/package/concurrently),
colour-coded by name:

| name (colour)      | process               | what it does                                                              |
| ------------------ | --------------------- | ------------------------------------------------------------------------- |
| `server` (green)   | `@polyptic/server`   | HTTP + WS on **:8080**; loads the registry from Postgres; REST API + `/admin` |
| `player` (cyan)    | `@polyptic/player`   | Vite dev server on **:5173**; the per-screen renderer (SolidJS)           |
| `admin`  (magenta) | `@polyptic/admin`    | Vite dev server on **:5174**; the legacy operator Admin UI (SolidJS, retired at 3e) |
| `console` (blue)   | `@polyptic/console`  | Vite dev server on **:5175**; the new Vue operator console (Phase 3a: the Wall view) |
| `agent`  (yellow)  | `@polyptic/agent`    | dials the server, registers one screen, opens the player page             |

Stop the stack with **Ctrl-C**. Postgres keeps running in Docker (that's what makes the
[persistence check](#the-persistence-check--survives-a-restart) work); stop it with
`bun run db:down`.

> **Ports:** server `8080`, player `5173`, admin `5174`, console `5175`, Postgres `5432`. If any
> is busy, free it before you start (the stack has no fallback ports).

### What to expect

1. **db** (Docker) reports healthy (`pg_isready`); the **server** logs that it is listening
   on `:8080` after loading the persisted registry.
2. **agent** connects to `ws://localhost:8080/agent`, sends `agent/hello`, and the
   server registers the machine and assigns its output the first screen id **`screen-1`**
   (ids are handed out sequentially `screen-1`, `screen-2`, … **globally across machines**,
   stable per `(machineId, connector)`; default `friendlyName` is "Screen N").
3. The agent's **`dev-open`** backend opens the player URL in your default browser, so a
   tab opens automatically at roughly `http://localhost:5173/?screen=screen-1`.
4. **player** connects to `ws://localhost:8080/player`, sends `player/hello`, and the
   server replies with `server/render`. With no surfaces yet you'll see an empty canvas.

---

## Open the Admin UI

Open **<http://localhost:5174>** in a browser.

The Admin UI connects to the server's `/admin` WebSocket channel and shows the live
registry: each **machine** and its **screens**, with **status dots**:

- a **machine** dot is green when its agent's WS is connected (online), grey when not;
- a **screen** dot is green when a player is currently connected for that screen.

It updates live — connect or kill an agent/player, rename a screen, push surfaces, and the
list re-renders immediately (the server broadcasts `admin/state` on every change).

---

## The ident demo — map a physical panel to its screen identity

In the Admin UI, click **Ident** on a screen. The server sends a `server/ident-pulse` to
that screen's player socket(s), and the **player tab flashes the screen's friendly name**
as a full-screen overlay (already built into the player). That's how an operator maps a
physical panel on the wall back to its screen identity.

Equivalent over REST (handy for scripting / the Phase 1-style demo):

```sh
# Flash screen-1's name for 3 seconds, then auto-off (ttlMs).
curl -X POST localhost:8080/api/v1/screens/screen-1/ident \
  -H 'content-type: application/json' \
  -d '{"on":true,"ttlMs":3000}'

# Or ident every screen on a machine at once:
curl -X POST localhost:8080/api/v1/machines/dev-mac/ident \
  -H 'content-type: application/json' \
  -d '{"on":true,"ttlMs":3000}'
```

(Without `ttlMs`, send `{"on":false}` yourself to clear the overlay.)

---

## The rename demo

In the Admin UI, rename a screen (e.g. `screen-1` → **"Nessie"**). The new name shows up
immediately across all admin clients, and it is **persisted** to Postgres.

Equivalent over REST:

```sh
curl -X POST localhost:8080/api/v1/screens/screen-1/rename \
  -H 'content-type: application/json' \
  -d '{"friendlyName":"Nessie"}'
```

A `404` comes back for an unknown screen id.

---

## The multi-machine demo

The first agent registers as machine `dev-mac` with one output. Start a **second agent**
in another terminal, posing as a different machine with a different connector:

```sh
cd packages/agent && POLYPTIC_MACHINE_ID=machine-b POLYPTIC_CONNECTOR=HDMI-2 bun run dev
```

A **second machine** appears in the Admin UI, with its own screen (the next sequential id,
e.g. `screen-2`). Status dots track each agent independently — kill one and only its
machine goes grey. Screen ids stay globally sequential and stable per `(machineId, connector)`.

---

## A local video wall from one agent (`POLYPTIC_OUTPUTS`)

The multi-machine demo above runs **two agents** to get two screens. For a quick local
**video-wall** demo you instead want **one** agent advertising **multiple outputs**, so a
single `bun run dev` gives you ≥2 screens to drag into a wall on the Console (`:5175`).

Set **`POLYPTIC_OUTPUTS`** to a comma-separated list of connector names. The agent advertises
one **1920×1080** output per connector (blanks are trimmed/skipped, duplicates de-duped):

```sh
# one machine (dev-mac) with two outputs → two screens, ready to combine into a wall
POLYPTIC_OUTPUTS="HDMI-1,HDMI-2" bun run dev
```

or run the agent on its own against an already-running server:

```sh
cd packages/agent && POLYPTIC_OUTPUTS="HDMI-1,HDMI-2,HDMI-3" bun run dev
```

The server hands each output the next sequential `screen-N` id (stable per
`(machineId, connector)`, as always), so the new screens appear in the Console's **Unplaced
screens** tray — drag them onto a mural and combine them into a spanning video wall.

When `POLYPTIC_OUTPUTS` is **unset** the agent advertises its single default output
(`POLYPTIC_CONNECTOR`, else `HDMI-1`) — exactly as before.

---

## The persistence check — survives a restart

This is the Phase 2a Definition of Done.

1. **Rename** a screen (Admin UI or the rename `curl` above), e.g. `screen-1` → "Nessie".
2. **Stop the stack** with **Ctrl-C** (this stops the server/player/admin/agent). Leave
   **Postgres running** — `bun run db:up` started it as a separate Docker container, and
   its data lives in the `pgdata` volume.
3. **Restart** with `bun run dev`.
4. The server reloads the registry from Postgres on boot — the screen is **still "Nessie"**.

The rename outlived the server process because it was written through to Postgres, not just
held in memory. (To prove it's really the DB: `bun run db:down` then `db:up` keeps the data;
only `docker compose -f deploy/docker-compose.yml down -v` wipes the volume.)

---

## Phase 2b — Enrollment & approval

Phase 2b puts a **claim step** between an agent dialing in and its screens going live, and gives every
machine a durable per-machine **credential** that it presents on each reconnect. There are two modes,
selected by a single server env var — **`POLYPTIC_BOOTSTRAP_TOKEN`**.

> **mTLS is not part of 2b.** Hardening the agent↔server *transport* to mutual-TLS client certs (D12)
> is deferred to the deploy / transport layer. Phase 2b is the **app-level** identity only:
> enrollment, the durable credential, and operator approval.

### OPEN MODE — the dev default (unchanged Phase 2a behaviour)

If `POLYPTIC_BOOTSTRAP_TOKEN` is **unset**, the server runs in **open mode**. Any agent that dials in
is **auto-registered and auto-approved** (`status: approved`), its screens are created, and it receives
`server/apply` immediately — exactly as in Phase 2a. This is what plain `bun run dev` does, so every
demo above keeps working with no extra setup.

To make open mode impossible to miss, the server logs a prominent **warning** at boot:

```
WARN  enrollment is OPEN (POLYPTIC_BOOTSTRAP_TOKEN unset) — every agent is auto-approved. Do not run like this in production.
```

### GATED MODE — enrollment on

Set `POLYPTIC_BOOTSTRAP_TOKEN` on the **server** to turn enrollment on, and set the **same** token on
each **agent** so it can make first contact:

```sh
# one shared secret for this demo — any non-empty string
export POLYPTIC_BOOTSTRAP_TOKEN="dev-secret-please-change"
bun run dev
```

Setting it in the shell before `bun run dev` (or via `deploy/.env.example` → `.env`, see
[Configuration](#configuration)) means the bundled **`dev-mac`** agent inherits the same token — so in
gated mode even that first built-in agent comes up **PENDING** until you approve it. Nothing reaches a
screen until an operator says so.

> **Switching an existing OPEN deployment to gated:** give each already-running agent the bootstrap
> token once. On its next `agent/hello` the server re-issues it a durable credential (and admits it if it
> was already approved). A machine that presents *neither* a valid token *nor* a credential is rejected
> by design — so don't flip to gated without handing the token to your existing agents first.

A first connection no longer goes straight to content. The flow:

1. The agent sends `agent/hello` carrying the **bootstrap token** (from its own
   `POLYPTIC_BOOTSTRAP_TOKEN`). The server checks the token, creates the machine as **`pending`**,
   records the outputs it reported, mints a random durable **credential**, and replies
   `server/enrolled` (carrying that credential) then `server/pending`. **No screens are created and no
   `server/apply` is sent** — the player does not open.
2. The machine appears in the **Admin UI** (<http://localhost:5174>) as **online + PENDING**, showing
   the number of outputs it reported but **no screens** yet.
3. An operator clicks **Approve**. The server flips the machine to **`approved`**, creates its screens
   from the persisted outputs, and — because the agent is still connected — **live-admits** it by
   sending `server/apply` there and then. The agent's `dev-open` backend opens the player tab and the
   screen goes live. (Approve also works while the agent is offline; the machine is admitted on its
   next reconnect.)
4. On every later reconnect the agent presents its **credential** instead of the token. An approved
   machine is admitted straight away; a still-pending one just gets `server/pending` again and keeps
   waiting.

**Turned away.** An agent that presents **neither** a valid token **nor** a valid credential — or one
whose machine you **Reject** — receives `server/rejected {reason}` and the server **closes** the
socket. Clicking **Reject** on a machine drops its agent on the spot (if connected) and it is never
admitted.

### Where the credential lives

- **Agent side (the raw secret):** the agent persists the credential it received in `server/enrolled`
  to **`${POLYPTIC_STATE_DIR or ~/.polyptic}/credential-<machineId>`** (one file per machine id). On
  the next boot it reads that file and reconnects with the credential — no token needed. Delete the
  file to force a fresh enrollment: the agent falls back to the bootstrap token and the server
  **re-issues** a credential for the existing machine, carrying its current status.
- **Server side (hash only):** the server stores **only** `sha256(credential)` on the machine — never
  the raw secret. On reconnect it hashes what the agent sends and compares. A leaked registry database
  cannot be used to impersonate an agent.

The credential is a random **32-byte hex** string (`node:crypto` `randomBytes`).

### Try it (gated)

```sh
# 1. server + the dev stack in gated mode (the bundled dev-mac agent is itself gated):
export POLYPTIC_BOOTSTRAP_TOKEN="dev-secret-please-change"
bun run dev

# 2. in another terminal, a second fresh agent carrying the SAME token:
cd packages/agent && \
  POLYPTIC_MACHINE_ID=machine-b POLYPTIC_CONNECTOR=HDMI-2 \
  POLYPTIC_BOOTSTRAP_TOKEN="dev-secret-please-change" bun run dev

# 3. an impostor with the WRONG token — rejected and disconnected, never shows up:
cd packages/agent && \
  POLYPTIC_MACHINE_ID=impostor POLYPTIC_CONNECTOR=HDMI-9 \
  POLYPTIC_BOOTSTRAP_TOKEN="nope" bun run dev
```

In the Admin UI, `dev-mac` and `machine-b` both show **PENDING** with their reported output count and
no screens; `impostor` never appears. Click **Approve** on `machine-b` → its screen is created and its
player tab opens; **Reject** a machine → its agent is dropped. The same actions over REST are below.

---

## Phase 3a — the Vue console

Phase 3a introduces the new **Vue operator console** (`@polyptic/console`) and the spatial **Wall**
view. `bun run dev` now launches it alongside everything else: it runs on **<http://localhost:5175>**
(blue in the `concurrently` output). The legacy SolidJS Admin UI on **:5174** stays put for now — it is
retired at Phase 3e — so during 3a you have both: `:5174` for machine enrollment/approval, `:5175` for
the Wall.

Open **<http://localhost:5175>** and you land on the **Wall** — a [Vue Flow](https://vueflow.dev)
spatial canvas (pan, zoom, drag, snap-to-grid). The server seeds one mural named **"Wall"** on first
boot; use the **mural switcher** to create more and pick the active one. Down the side, an **Unplaced
screens** tray lists every screen with no placement: **drag a screen from the tray onto the canvas** to
place it on the active mural (its box defaults to the screen's output resolution). Drag a placed screen
to move it; it snaps to the grid.

Select a screen (shift-click for multi-select; *combining* placed screens into one surface is Phase 3b)
to open the right-hand **inspector**, which drives the same server actions the Admin UI and `curl`
examples do:

- **rename** the screen's friendly name (`POST /api/v1/screens/:id/rename`);
- **Ident** — flash the name on the physical panel (`POST /api/v1/screens/:id/ident`);
- read its **status / "driven by"** machine;
- **assign content** — type a URL and the screen shows it (`POST /api/v1/demo/web {screenId,url}`,
  the existing instant path — the player is unchanged in 3a).

The console connects to the server's `/admin` WebSocket (the same channel the Admin UI uses) and now
reads the extra `murals[]` + `placements[]` carried in `admin/state`; it re-renders live as murals are
created/renamed/deleted and screens are placed/moved/unplaced. The mural and placement REST surface it
calls is documented under [Phase 3a — murals & placement](#phase-3a--murals--placement) below.

The other console nav routes (Machines, Content, Scenes, Settings, combined surfaces, the content
library) are **"coming soon" placeholders** in 3a — only the Wall is wired up.

---

## REST routes

All bodies/params are validated against the `@polyptic/protocol` zod schemas. CORS is
enabled for the player and admin origins.

### Phase 3a — murals & placement

The Wall view's spatial model. A mutation persists through the Store and broadcasts a fresh
`admin/state` (now carrying `murals[]` + `placements[]`) so every console/admin client stays live.

| method & path                                  | body                                         | effect                                                                                              |
| ---------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `POST   /api/v1/murals`                        | `{ "name": string }`                         | create a mural; appears in `admin/state.murals`                                                      |
| `POST   /api/v1/murals/:muralId/rename`        | `{ "name": string }`                         | rename a mural; `404` unknown mural                                                                  |
| `DELETE /api/v1/murals/:muralId`               | —                                            | delete a mural and **unplace its screens** (their placements are removed); `404` unknown mural       |
| `PUT    /api/v1/screens/:screenId/placement`   | `{ "muralId", "x", "y", "w"?, "h"? }`        | place or move a screen on a mural (canvas pixels); **`w`/`h` default to the screen's resolution**; `404` unknown screen |
| `DELETE /api/v1/screens/:screenId/placement`   | —                                            | unplace a screen (back to the Unplaced tray); `404` unknown screen                                   |

These are exactly what `packages/e2e/murals.e2e.test.ts` drives end-to-end against the real server:
a default **"Wall"** mural is seeded, `POST /murals` adds one, `PUT …/placement` places a screen with
defaulted `w`/`h`, `DELETE …/placement` unplaces it, and `DELETE /murals/:id` cascades to unplace.

### Phase 2a — registry & admin actions

| method & path                                | body                          | effect                                                                 |
| -------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------- |
| `GET  /api/v1/machines`                      | —                             | registered `Machine[]`                                                  |
| `POST /api/v1/screens/:screenId/rename`      | `{ "friendlyName": string }`  | rename + persist + broadcast `admin/state`; `404` unknown screen       |
| `POST /api/v1/screens/:screenId/ident`       | `{ "on": bool, "ttlMs"? }`    | `server/ident-pulse` to that screen's player(s); auto-off after `ttlMs` |
| `POST /api/v1/machines/:machineId/ident`     | `{ "on": bool, "ttlMs"? }`    | ident every screen on that machine; `404` unknown machine              |

### Phase 2b — enrollment actions

| method & path                                | body                    | effect                                                                                                                                  |
| -------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/machines/:machineId/approve`   | —                       | `pending → approved`; create screens from the machine's persisted outputs; **live-admit** (`server/apply`) if the agent is connected now; broadcast `admin/state`. `404` unknown machine |
| `POST /api/v1/machines/:machineId/reject`    | `{ "reason"?: string }` | `→ rejected`; if connected, send `server/rejected` + close the agent WS; never admit; broadcast `admin/state`. `404` unknown machine    |

With the stack in **gated mode** and a machine showing pending, drive the same actions the Admin UI
buttons do:

```sh
# approve machine-b → its screens are created and (if online) it is admitted live
curl -X POST localhost:8080/api/v1/machines/machine-b/approve

# or turn one away (optional reason)
curl -X POST localhost:8080/api/v1/machines/machine-b/reject \
  -H 'content-type: application/json' \
  -d '{"reason":"not one of ours"}'
```

### Phase 1 — content (the "instant" path, still works)

| method & path                              | body                              | effect                                                            |
| ------------------------------------------ | --------------------------------- | ----------------------------------------------------------------- |
| `GET  /api/v1/state`                       | —                                 | the full `DesiredState`                                           |
| `GET  /api/v1/screens`                     | —                                 | registered `Screen[]`                                             |
| `POST /api/v1/screens/:screenId/surfaces`  | `{ "surfaces": Surface[] }`       | replace that screen's slice surfaces, bump revision, push render  |
| `POST /api/v1/demo/web`                    | `{ "screenId", "url" }`           | convenience: one full-canvas web surface (the instant demo)       |

### The Phase 1 instant demo (still the headline)

With the stack running, push content to `screen-1` and watch the player swap it in place,
with **no reload**:

```sh
curl -X POST localhost:8080/api/v1/demo/web \
  -H 'content-type: application/json' \
  -d '{"screenId":"screen-1","url":"https://example.com"}'

# run again with a different URL — the player swaps the iframe src in place, instantly:
curl -X POST localhost:8080/api/v1/demo/web \
  -H 'content-type: application/json' \
  -d '{"screenId":"screen-1","url":"https://wikipedia.org"}'
```

Two side-by-side surfaces on a 1920×1080 canvas via the general route:

```sh
curl -X POST localhost:8080/api/v1/screens/screen-1/surfaces \
  -H 'content-type: application/json' \
  -d '{
    "surfaces": [
      { "id": "left",  "type": "web", "url": "https://example.com",
        "region": { "x": 0,   "y": 0, "w": 960, "h": 1080 } },
      { "id": "right", "type": "web", "url": "https://wikipedia.org",
        "region": { "x": 960, "y": 0, "w": 960, "h": 1080 } }
    ]
  }'
```

### Manual fallback

If the player tab didn't open automatically, open it by hand:

```sh
open "http://localhost:5173/?screen=screen-1"   # Linux: xdg-open, or paste into a browser
```

---

## Configuration

| env var                 | default                                                        | meaning                                                        |
| ----------------------- | ------------------------------------------------------------- | -------------------------------------------------------------- |
| `STORE`                 | `postgres`                                                     | registry backend: `postgres` (durable) or `memory` (test)      |
| `DATABASE_URL`          | `postgres://polyptic:polyptic@localhost:5432/polyptic`     | Postgres connection used when `STORE=postgres`                 |
| `PORT`                  | `8080`                                                         | server HTTP + WS port                                          |
| `POLYPTIC_BOOTSTRAP_TOKEN` | _(unset → **open mode**)_                                 | **server + agent.** Set on the **server** to gate enrollment; set the **same** value on each **agent** for first-contact. Unset on the server = open mode (auto-approve, with the boot warning). |
| `PLAYER_BASE_URL`       | `http://localhost:5173`                                       | base the server uses to build each `playerUrl`                 |
| `POLYPTIC_MACHINE_ID`  | `/etc/machine-id` if present, else `dev-mac`                  | the agent's machine identity (used for the multi-machine demo) |
| `POLYPTIC_CONNECTOR`   | `HDMI-1`                                                       | the agent's output connector (used for the multi-machine demo) |
| `POLYPTIC_OUTPUTS`     | _(unset → single output on `POLYPTIC_CONNECTOR`)_             | **agent.** Comma-separated connector names (e.g. `HDMI-1,HDMI-2`) → one 1920×1080 output each, so one agent yields ≥2 screens for a local video-wall demo. Blanks trimmed/skipped, duplicates de-duped. |
| `POLYPTIC_BACKEND`     | _(auto → `dev-open`)_                                          | force the agent's display backend                              |
| `POLYPTIC_STATE_DIR`   | `~/.polyptic`                                                | **agent.** Directory where the agent persists its durable credential, as `credential-<machineId>` |

The dev canvas defaults to **1920×1080**.

---

## Tests

```sh
bun run test
```

This builds the contract, then runs `bun test`. The tests use the **in-memory** store
(`STORE=memory`) — **no Docker / Postgres required**. The Postgres path is exercised by
running the real stack (above) and by the `full` container profile.

---

## Containerised stack (prod-like)

For a container-portable run (Postgres **and** the server in Docker), use the `full`
compose profile:

```sh
docker compose -f deploy/docker-compose.yml --profile full up --build
```

The `server` service is built from `deploy/server.Dockerfile`, waits for Postgres to be
healthy, and reaches the DB over the compose network at host `db`. Plain `bun run db:up`
never touches this service — it only starts Postgres for the dev loop. See the comments at
the top of `deploy/docker-compose.yml`.

---

## Phase 2a — Definition of Done

> Bring up Postgres + the stack; connect **2 machines**; see both machines' screens in the
> Admin UI; click **ident** → the player flashes the name; **rename** a screen → it
> **persists across a server restart**.

## Phase 2b — Definition of Done

> Set `POLYPTIC_BOOTSTRAP_TOKEN` (gated mode) and bring up the stack; a fresh agent shows as
> **PENDING** in the Admin UI; click **Approve** → its screens appear and the player opens; an
> **unknown / wrong-token** agent (and any machine you **Reject**) is turned away and disconnected.
> The agent keeps a durable credential at `${POLYPTIC_STATE_DIR or ~/.polyptic}/credential-<machineId>`
> and the server stores only its `sha256` hash. (mTLS transport hardening is deferred — see
> [`ROADMAP.md`](./ROADMAP.md).)

See [`ROADMAP.md`](./ROADMAP.md) for what comes next (Phase 3: murals — the spatial screen canvas).
