# Polyptych — local development

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

`bun run dev` first builds the shared contract (`@polyptych/protocol`) and then starts
four processes together under [`concurrently`](https://www.npmjs.com/package/concurrently),
colour-coded by name:

| name (colour)    | process               | what it does                                                              |
| ---------------- | --------------------- | ------------------------------------------------------------------------- |
| `server` (green)   | `@polyptych/server` | HTTP + WS on **:8080**; loads the registry from Postgres; REST API + `/admin` |
| `player` (cyan)    | `@polyptych/player` | Vite dev server on **:5173**; the per-screen renderer (SolidJS)           |
| `admin`  (magenta) | `@polyptych/admin`  | Vite dev server on **:5174**; the operator Admin UI (SolidJS)             |
| `agent`  (yellow)  | `@polyptych/agent`  | dials the server, registers one screen, opens the player page             |

Stop the stack with **Ctrl-C**. Postgres keeps running in Docker (that's what makes the
[persistence check](#the-persistence-check--survives-a-restart) work); stop it with
`bun run db:down`.

> **Ports:** server `8080`, player `5173`, admin `5174`, Postgres `5432`. If any is busy,
> free it before you start (the stack has no fallback ports).

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
cd packages/agent && POLYPTYCH_MACHINE_ID=machine-b POLYPTYCH_CONNECTOR=HDMI-2 bun run dev
```

A **second machine** appears in the Admin UI, with its own screen (the next sequential id,
e.g. `screen-2`). Status dots track each agent independently — kill one and only its
machine goes grey. Screen ids stay globally sequential and stable per `(machineId, connector)`.

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

## REST routes

All bodies/params are validated against the `@polyptych/protocol` zod schemas. CORS is
enabled for the player and admin origins.

### Phase 2a — registry & admin actions

| method & path                                | body                          | effect                                                                 |
| -------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------- |
| `GET  /api/v1/machines`                      | —                             | registered `Machine[]`                                                  |
| `POST /api/v1/screens/:screenId/rename`      | `{ "friendlyName": string }`  | rename + persist + broadcast `admin/state`; `404` unknown screen       |
| `POST /api/v1/screens/:screenId/ident`       | `{ "on": bool, "ttlMs"? }`    | `server/ident-pulse` to that screen's player(s); auto-off after `ttlMs` |
| `POST /api/v1/machines/:machineId/ident`     | `{ "on": bool, "ttlMs"? }`    | ident every screen on that machine; `404` unknown machine              |

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
| `DATABASE_URL`          | `postgres://polyptych:polyptych@localhost:5432/polyptych`     | Postgres connection used when `STORE=postgres`                 |
| `PORT`                  | `8080`                                                         | server HTTP + WS port                                          |
| `PLAYER_BASE_URL`       | `http://localhost:5173`                                       | base the server uses to build each `playerUrl`                 |
| `POLYPTYCH_MACHINE_ID`  | `/etc/machine-id` if present, else `dev-mac`                  | the agent's machine identity (used for the multi-machine demo) |
| `POLYPTYCH_CONNECTOR`   | `HDMI-1`                                                       | the agent's output connector (used for the multi-machine demo) |
| `POLYPTYCH_BACKEND`     | _(auto → `dev-open`)_                                          | force the agent's display backend                              |

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

See [`ROADMAP.md`](./ROADMAP.md) for what comes next (Phase 2b: enrollment/claim + mTLS).
