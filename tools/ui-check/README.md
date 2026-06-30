# UI smoke check

Browser-level checks for the **console** — the layer the `bun:test` e2e suites (which drive the
server over REST/WS) can't reach: rendered DOM and real user interactions. This is where the
content-identity and drag-to-assign regressions lived, because nothing tested a pixel or a real drag.

It drives a **running dev stack** with Playwright + your installed system Chrome (no browser
download — it launches with `channel: "chrome"`).

## Run

```bash
# 1. bring the dev stack up (in another terminal)
POLYPTIC_OUTPUTS="HDMI-1,HDMI-2" bun run dev      # console :5175, server :8080, player :5173

# 2. open a player per screen + place a screen on the canvas (so there's something to drag onto)

# 3. run the smoke
bun run ui-smoke
```

Asserts: sign-in lands on `/wall`, and **dragging a library source onto a screen actually applies**
(the tile flips to the source's name). Exits non-zero on a real failure; skips the drag test (still
exit 0) when there's no solo placed screen to target.

Override targets/creds via env: `PP_CONSOLE`, `PP_SERVER`, `PP_PLAYER`, `PP_EMAIL`, `PP_PASSWORD`.

## Next step (not yet done)

A self-contained version that **spins up its own ephemeral stack** (server `STORE=memory`, a fake
agent with 2 outputs, console, players), sets up deterministic state, runs the checks, and tears
down — so it can gate CI without depending on a hand-arranged dev canvas. That's the proper home for
a growing UI suite (combine + rename, scene apply, ident, etc.).
