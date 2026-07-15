# Console design reference

`console.dc.html` is the **canonical UI spec for Phase 3** — the "Polyptic Console v2" design
prototype. It's a static HTML mockup (`{{ }}` template bindings + a small `support.js` runtime);
we read it for exact **layout, components, styling, labels and states**, then build the real
**Vue** console (`packages/console`) to match.

Locally this `.dc.html` won't run without its runtime, but the inline CSS + markup are the reference.

> **v4 (2026-06-29):** brand is now **Polyptic**; the **logo mark** (hinged panels + squared centre on
> a rounded holder, theme-inverting) replaces the old "P" — implemented as `Logo.vue`; and the **scene
> controls moved to the top-left of the Wall top bar** (active scene + Save scene lead it). The full
> scene rail/management is built in **3d** against this reference.

## Views it defines
- **Sign-in** — operator access to the console (we back this with OIDC; Bucket B / D11).
- **App shell** — left nav rail: Wall · Machines (pending badge) · Content · Scenes · Settings · theme · account.
- **Wall** — the murals canvas: mural switcher, scene switcher + save, content library + unplaced-screens tray, zoomable canvas of screens & **combined surfaces**, floating select toolbar, context inspector (single / combined / multi / empty) + live activity feed.
- **Machines** — fleet: enrolment token (copy/regenerate), Pending (approve/reject), Approved (revoke). UI for the Phase-2b enrollment engine.
- **Content** — content-source library: list + add/edit (name, type, address, auth strategy).
- **Scenes** — saved presets: save current wall, apply, delete, and REAL scheduling (POL-89/D93: named dayparts, weekday/date recurrence, priority, a default scene, and a "what plays when" week strip). The mock's illustrative `at HH:MM` box is gone.
- **Settings** — appearance/theme, enrolment token, replay first-run, account/sign-out.
- **Cold-start wizard** — first run: Step 1 connect (token + approve a dialing-in machine), Step 2 map screens (ident → name → place).
- **Overlays** — toast, save-scene modal, add/edit content-source modal.

Maps onto decisions **D20–D25** (murals, surfaces, content library, scenes+layout, activity feed).
