# Polyptic: local development

How to run the Polyptic stack on a dev machine: the control plane with a persistent
**Postgres** registry, the **operator console**, the **player**, and one or more dev
**agents**. The headline property is the instant path. Change a screen's content with one
REST call and the player swaps it in place with **no page reload**.

The registry (machines, screens, murals, content) lives in **PostgreSQL** by default and
is loaded on boot, so a rename survives a server restart. The store is swappable, and
`STORE=memory` uses an in-memory double that needs no Docker. That is what `bun run test`
uses.

Everything runs on **Bun**. Postgres runs in **Docker**. Works on macOS and Linux.

---

## Prerequisites

- **Bun ≥ 1.1**. Install from <https://bun.sh> (`curl -fsSL https://bun.sh/install | bash`) and check with `bun --version`.
- **Docker** (with the Compose plugin), only to run **Postgres** for dev. Check with `docker compose version`.

> No Node, nvm, pnpm, or tsx. Bun installs the deps and runs the TypeScript
> server/agent/console natively. Docker runs **only** the Postgres container, so with
> `STORE=memory` you need no Docker at all (that is the test path).

---

## Install & run

From the repo root:

```sh
bun install
bun run db:up      # start Postgres 16 in Docker (named volume `pgdata`)
bun run dev        # build the contract, then run the whole stack
```

`bun run dev` first builds the shared contract (`@polyptic/protocol`) and then starts
four processes together under [`concurrently`](https://www.npmjs.com/package/concurrently),
colour-coded by name:

| name (colour)      | process               | what it does                                                              |
| ------------------ | --------------------- | ------------------------------------------------------------------------- |
| `server` (green)   | `@polyptic/server`   | HTTP + WS on **:8080**. Loads the registry from Postgres and serves the REST API and the `/admin` channel |
| `player` (cyan)    | `@polyptic/player`   | Vite dev server on **:5173**. The per-screen renderer (Vue)               |
| `console` (blue)   | `@polyptic/console`  | Vite dev server on **:5175**. The Vue operator console (Wall · Content · Scenes · Machines · Settings) |
| `agent`  (yellow)  | `@polyptic/agent`    | dials the server and registers one screen                                 |

Stop the stack with **Ctrl-C**. Postgres keeps running in Docker, which is what makes the
[persistence check](#the-persistence-check) work. Stop it with `bun run db:down`.

> **Ports:** server `8080`, player `5173`, console `5175`, Postgres `5432`. If any
> is busy, free it before you start because the stack has no fallback ports.

### What to expect

1. **db** (Docker) reports healthy (`pg_isready`) and the **server** logs that it is
   listening on `:8080` after loading the persisted registry.
2. The **agent** connects to `ws://localhost:8080/agent`, sends `agent/hello`, and the
   server registers the machine and assigns its output the first screen id **`screen-1`**.
   Ids are handed out sequentially (`screen-1`, `screen-2`, …) **globally across machines**,
   stable per `(machineId, connector)`, and the default `friendlyName` is "Screen N".
3. Open the player at `http://localhost:5173/?screen=screen-1`. Set `POLYPTIC_DEV_OPEN=1`
   on the agent to have the agent open that tab in your default browser.
4. The **player** connects to `ws://localhost:8080/player`, sends `player/hello`, and the
   server replies with `server/render`. With no surfaces yet the canvas is empty.

---

## Open the console

Open **<http://localhost:5175>** and sign in with the prefilled dev account.

The console connects to the server's `/admin` WebSocket channel and shows the live
registry. You land on the **Wall**, a [Vue Flow](https://vueflow.dev) spatial canvas
(pan, zoom, drag, snap-to-grid). The server seeds one mural named **"Wall"** on first
boot, and the **mural switcher** creates more and picks the active one. An **Unplaced
screens** tray lists every screen with no placement. Drag a screen from the tray onto the
canvas to place it on the active mural (its box defaults to the screen's output
resolution), and drag a placed screen to move it.

Select a screen to open the right-hand **inspector**, which drives the same server
actions the `curl` examples below do: rename the screen, flash its name on the physical
panel (**Ident**), read which machine drives it, and assign content. The console
re-renders live as agents connect and disconnect, screens are renamed, placed or moved,
and content changes, because the server broadcasts `admin/state` on every change.

---

## The ident demo: map a physical panel to its screen identity

In the console, select a screen and click **Ident**. The server sends a
`server/ident-pulse` to that screen's player socket(s), and the **player tab flashes the
screen's friendly name** as a full-screen overlay. That is how an operator maps a
physical panel on the wall back to its screen identity.

Equivalent over REST:

> Every `/api/v1` route sits behind the same session auth as the console. To drive the
> routes from plain `curl`, start the stack with `AUTH_ENABLED=false` (dev and tests
> only). The server warns loudly at boot when auth is off.

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

In the console, rename a screen (e.g. `screen-1` → **"Nessie"**). The new name shows up
immediately in every connected console, and it is **persisted** to Postgres.

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

A **second machine** appears in the console, with its own screen (the next sequential id,
e.g. `screen-2`). Status tracks each agent independently, so kill one and only its
machine goes offline. Screen ids stay globally sequential and stable per `(machineId, connector)`.

---

## A local video wall from one agent (`POLYPTIC_OUTPUTS`)

The multi-machine demo above runs **two agents** to get two screens. For a quick local
**video-wall** demo you instead want **one** agent advertising **multiple outputs**, so a
single `bun run dev` gives you ≥2 screens to drag into a wall on the console.

Set **`POLYPTIC_OUTPUTS`** to a comma-separated list of connector names. The agent advertises
one **1920×1080** output per connector (blanks are trimmed, duplicates de-duped):

```sh
# one machine (dev-mac) with two outputs → two screens, ready to combine into a wall
POLYPTIC_OUTPUTS="HDMI-1,HDMI-2" bun run dev
```

or run the agent on its own against an already-running server:

```sh
cd packages/agent && POLYPTIC_OUTPUTS="HDMI-1,HDMI-2,HDMI-3" bun run dev
```

The server hands each output the next sequential `screen-N` id (stable per
`(machineId, connector)`, as always), so the new screens appear in the console's **Unplaced
screens** tray. Drag them onto a mural and combine them into a spanning video wall.

When `POLYPTIC_OUTPUTS` is **unset** the agent advertises its single default output
(`POLYPTIC_CONNECTOR`, else `HDMI-1`).

---

## The persistence check

1. **Rename** a screen (console or the rename `curl` above), e.g. `screen-1` → "Nessie".
2. **Stop the stack** with **Ctrl-C**. Leave **Postgres running**, because
   `bun run db:up` started it as a separate Docker container and its data lives in the
   `pgdata` volume.
3. **Restart** with `bun run dev`.
4. The server reloads the registry from Postgres on boot, so the screen is **still "Nessie"**.

The rename outlived the server process because it was written through to Postgres, not just
held in memory. To prove it is really the DB: `bun run db:down` then `db:up` keeps the data,
and only `docker compose -f deploy/docker-compose.yml down -v` wipes the volume.

---

## Enrolment & approval

Enrolment puts a **claim step** between an agent dialling in and its screens going live, and
gives every machine a durable per-machine **credential** that it presents on each reconnect.
There are two modes, selected by a single server env var, **`POLYPTIC_BOOTSTRAP_TOKEN`**.
The mode is seeded from the environment on **first boot** and persisted in the store, and
the console's Settings can regenerate the enrolment token later.

### Open mode, the dev default

If `POLYPTIC_BOOTSTRAP_TOKEN` is **unset** on first boot, the server runs in **open mode**.
Any agent that dials in is **auto-registered and auto-approved** (`status: approved`), its
screens are created, and it receives `server/apply` immediately. This is what plain
`bun run dev` does, so every demo above works with no extra setup.

To make open mode impossible to miss, the server logs a prominent **warning** at boot:

```
WARN  ⚠️  ENROLLMENT IS OPEN: POLYPTIC_BOOTSTRAP_TOKEN is unset — every agent that connects is auto-registered AND auto-approved. …
```

### Gated mode, enrolment on

Set `POLYPTIC_BOOTSTRAP_TOKEN` on the **server** to turn enrolment on, and set the **same** token on
each **agent** so it can make first contact:

```sh
# one shared secret for this demo — any non-empty string
export POLYPTIC_BOOTSTRAP_TOKEN="dev-secret-please-change"
bun run dev
```

Setting it in the shell before `bun run dev` (or via `deploy/.env.example` → `.env`, see
[Configuration](#configuration)) means the bundled **`dev-mac`** agent inherits the same token, so in
gated mode even that first built-in agent comes up **PENDING** until you approve it. Nothing reaches a
screen until an operator says so.

> **Switching an existing OPEN deployment to gated:** give each already-running agent the bootstrap
> token once. On its next `agent/hello` the server re-issues it a durable credential (and admits it if it
> was already approved). A machine that presents *neither* a valid token *nor* a credential is rejected
> by design, so hand the token to your existing agents before you flip to gated.

A first connection no longer goes straight to content. The flow:

1. The agent sends `agent/hello` carrying the **bootstrap token** (from its own
   `POLYPTIC_BOOTSTRAP_TOKEN`). The server checks the token, creates the machine as **`pending`**,
   records the outputs it reported, mints a random durable **credential**, and replies
   `server/enrolled` (carrying that credential) then `server/pending`. **No screens are created and no
   `server/apply` is sent.**
2. The machine appears in the console under **Machines** as **online + PENDING**, showing
   the number of outputs it reported but **no screens** yet.
3. An operator clicks **Approve**. The server flips the machine to **`approved`**, creates its screens
   from the persisted outputs and, because the agent is still connected, **live-admits** it by
   sending `server/apply` there and then. Approve also works while the agent is offline, and the
   machine is admitted on its next reconnect.
4. On every later reconnect the agent presents its **credential** instead of the token. An approved
   machine is admitted straight away, and a still-pending one gets `server/pending` again and keeps
   waiting.

**Turned away.** An agent that presents **neither** a valid token **nor** a valid credential, or one
whose machine you **Reject**, receives `server/rejected {reason}` and the server **closes** the
socket. Clicking **Reject** on a machine drops its agent on the spot (if connected) and it is never
admitted.

### Where the credential lives

- **Agent side (the raw secret):** the agent persists the credential it received in `server/enrolled`
  to **`${POLYPTIC_STATE_DIR or ~/.polyptic}/credential-<machineId>`** (one file per machine id). On
  the next boot it reads that file and reconnects with the credential, no token needed. Delete the
  file to force a fresh enrolment. The agent falls back to the bootstrap token and the server
  **re-issues** a credential for the existing machine, carrying its current status.
- **Server side (hash only):** the server stores **only** `sha256(credential)` on the machine, never
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

In the console, `dev-mac` and `machine-b` both show **PENDING** with their reported output count and
no screens, and `impostor` never appears. Click **Approve** on `machine-b` and its screen is created.
**Reject** a machine and its agent is dropped. The same actions over REST are below.

---

## REST routes

The routes the demos above use. All bodies and params are validated against the
`@polyptic/protocol` zod schemas.

### Murals & placement

The Wall view's spatial model. A mutation persists through the Store and broadcasts a fresh
`admin/state` (carrying `murals[]` + `placements[]`) so every console client stays live.

| method & path                                  | body                                         | effect                                                                                              |
| ---------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `POST   /api/v1/murals`                        | `{ "name": string }`                         | create a mural; appears in `admin/state.murals`                                                      |
| `POST   /api/v1/murals/:muralId/rename`        | `{ "name": string }`                         | rename a mural; `404` unknown mural                                                                  |
| `DELETE /api/v1/murals/:muralId`               | —                                            | delete a mural and **unplace its screens** (their placements are removed); `404` unknown mural       |
| `PUT    /api/v1/screens/:screenId/placement`   | `{ "muralId", "x", "y", "w"?, "h"? }`        | place or move a screen on a mural (canvas pixels); **`w`/`h` default to the screen's resolution**; `404` unknown screen |
| `DELETE /api/v1/screens/:screenId/placement`   | —                                            | unplace a screen (back to the Unplaced tray); `404` unknown screen                                   |

`packages/e2e/murals.e2e.test.ts` drives these end-to-end against the real server.

### Registry & admin actions

| method & path                                | body                          | effect                                                                 |
| -------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------- |
| `GET  /api/v1/machines`                      | —                             | registered `Machine[]`                                                  |
| `POST /api/v1/screens/:screenId/rename`      | `{ "friendlyName": string }`  | rename + persist + broadcast `admin/state`; `404` unknown screen       |
| `POST /api/v1/screens/:screenId/ident`       | `{ "on": bool, "ttlMs"? }`    | `server/ident-pulse` to that screen's player(s); auto-off after `ttlMs` |
| `POST /api/v1/machines/:machineId/ident`     | `{ "on": bool, "ttlMs"? }`    | ident every screen on that machine; `404` unknown machine              |

### Enrolment actions

| method & path                                | body                    | effect                                                                                                                                  |
| -------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/machines/:machineId/approve`   | —                       | `pending → approved`; create screens from the machine's persisted outputs; **live-admit** (`server/apply`) if the agent is connected now; broadcast `admin/state`. `404` unknown machine |
| `POST /api/v1/machines/:machineId/reject`    | `{ "reason"?: string }` | `→ rejected`; if connected, send `server/rejected` + close the agent WS; never admit; broadcast `admin/state`. `404` unknown machine    |

With the stack in **gated mode** and a machine showing pending, drive the same actions the console
buttons do:

```sh
# approve machine-b → its screens are created and (if online) it is admitted live
curl -X POST localhost:8080/api/v1/machines/machine-b/approve

# or turn one away (optional reason)
curl -X POST localhost:8080/api/v1/machines/machine-b/reject \
  -H 'content-type: application/json' \
  -d '{"reason":"not one of ours"}'
```

### Content: the instant path

| method & path                              | body                              | effect                                                            |
| ------------------------------------------ | --------------------------------- | ----------------------------------------------------------------- |
| `GET  /api/v1/state`                       | —                                 | the full `DesiredState`                                           |
| `GET  /api/v1/screens`                     | —                                 | registered `Screen[]`                                             |
| `POST /api/v1/screens/:screenId/surfaces`  | `{ "surfaces": Surface[] }`       | replace that screen's slice surfaces, bump revision, push render  |
| `POST /api/v1/demo/web`                    | `{ "screenId", "url" }`           | convenience: one full-canvas web surface (the instant demo)       |

### The instant demo

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

### Opening a player by hand

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
| `AUTH_ENABLED`          | `true`                                                         | **server.** `false` skips the session gate on `/api/v1` and the `/admin` WS (dev and tests only, with a loud boot warning) |
| `POLYPTIC_BOOTSTRAP_TOKEN` | _(unset → **open mode**)_                                 | **server + agent.** Set on the **server** to gate enrolment, and set the **same** value on each **agent** for first contact. Unset on the server's first boot = open mode (auto-approve, with the boot warning) |
| `PLAYER_BASE_URL`       | `http://localhost:5173`                                       | base the server uses to build each `playerUrl`                 |
| `POLYPTIC_MACHINE_ID`  | `/etc/machine-id` if present, else `dev-mac`                  | the agent's machine identity (used for the multi-machine demo) |
| `POLYPTIC_CONNECTOR`   | `HDMI-1`                                                       | the agent's output connector (used for the multi-machine demo) |
| `POLYPTIC_OUTPUTS`     | _(unset → single output on `POLYPTIC_CONNECTOR`)_             | **agent.** Comma-separated connector names (e.g. `HDMI-1,HDMI-2`), one 1920×1080 output each, so one agent yields ≥2 screens for a local video-wall demo. Blanks trimmed, duplicates de-duped |
| `POLYPTIC_BACKEND`     | _(auto → `dev-open`)_                                          | force the agent's display backend                              |
| `POLYPTIC_DEV_OPEN`    | _(unset → off)_                                                | **agent (dev-open).** Set `1` to auto-open each player URL in the host browser |
| `POLYPTIC_STATE_DIR`   | `~/.polyptic`                                                | **agent.** Directory where the agent persists its durable credential, as `credential-<machineId>` |

The dev canvas defaults to **1920×1080**.

---

## Tests

```sh
bun run test
```

This builds the contract, then runs `bun test`. The tests use the **in-memory** store
(`STORE=memory`), so **no Docker or Postgres is required**. The Postgres path is exercised
by running the real stack (above) and by the `full` container profile.

---

## Containerised stack (prod-like)

For a container-portable run (Postgres **and** the server in Docker), use the `full`
compose profile:

```sh
docker compose -f deploy/docker-compose.yml --profile full up --build
```

The `server` service is built from `deploy/server.Dockerfile`, waits for Postgres to be
healthy, and reaches the DB over the compose network at host `db`. Plain `bun run db:up`
never touches this service. It only starts Postgres for the dev loop. See the comments at
the top of `deploy/docker-compose.yml`.
