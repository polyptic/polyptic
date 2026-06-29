# Console design reference

`console.dc.html` is the **canonical UI spec for Phase 3** — the "Polyptych Console v2" design
from the Claude Design project (`ebc2c163-ece8-4b11-b30c-b8c1aaec717d`, file
`Polyptych Console v2.dc.html`). It's a static prototype (`{{ }}` template bindings + a `support.js`
runtime on claude.ai/design); we read it for exact **layout, components, styling, labels and
states**, then build the real SolidJS console (`packages/console`) to match.

To see it rendered, open the file in the Claude Design project. Locally this `.dc.html` won't run
without its runtime, but the inline CSS + markup are the reference.

## Views it defines
- **Sign-in** — operator access to the console (we back this with OIDC; Bucket B / D11).
- **App shell** — left nav rail: Wall · Machines (pending badge) · Content · Scenes · Settings · theme · account.
- **Wall** — the murals canvas: mural switcher, scene switcher + save, content library + unplaced-screens tray, zoomable canvas of screens & **combined surfaces**, floating select toolbar, context inspector (single / combined / multi / empty) + live activity feed.
- **Machines** — fleet: enrolment token (copy/regenerate), Pending (approve/reject), Approved (revoke). UI for the Phase-2b enrollment engine.
- **Content** — content-source library: list + add/edit (name, type, address, auth strategy).
- **Scenes** — saved presets: save current wall, apply, schedule (illustrative), duplicate, delete.
- **Settings** — appearance/theme, enrolment token, replay first-run, account/sign-out.
- **Cold-start wizard** — first run: Step 1 connect (token + approve a dialing-in machine), Step 2 map screens (ident → name → place).
- **Overlays** — toast, save-scene modal, add/edit content-source modal.

Maps onto decisions **D20–D25** (murals, surfaces, content library, scenes+layout, activity feed).
