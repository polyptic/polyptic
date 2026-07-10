# Polyptic brand assets

Standalone icon files for the Polyptic mark — favicons, PWA/manifest icons, README embeds,
packaging, social, etc.

**Source of truth:** [`packages/console/src/components/Logo.vue`](../packages/console/src/components/Logo.vue).
The SVGs here reproduce that component's geometry exactly (a rounded holder with two 62%-opacity
side panels and a solid centre panel). If the component changes, update `icon.svg` / `icon-dark.svg`
and re-run the generator.

## Files

| File | Use |
| --- | --- |
| `icon.svg` | Canonical mark — dark holder (`#18181b`), light panels (`#fafafa`). For light / on-light backgrounds. |
| `icon-dark.svg` | Inverted mark — light holder, dark panels. For dark backgrounds (matches the console dark theme). |
| `favicon.svg` | Tab icon. Same geometry, but the fills follow `prefers-color-scheme` — one file for both tab strips. |
| `favicon.ico` | Tab-icon fallback: 16/32/48 px of the **canonical** mark, for browsers that ignore SVG icons (Safari). |
| `png/icon-<size>.png` | Rasterized default variant at 16, 32, 48, 64, 128, 180, 192, 256, 512, 1024 px. |
| `png/icon-dark-<size>.png` | Rasterized inverted variant at the same sizes. |

PNGs are RGBA with transparent rounded corners. Common picks: `16`/`32`/`48` favicon, `180`
apple-touch, `192`/`512` PWA manifest.

The `.ico` deliberately carries the canonical (dark-holder) mark rather than the adaptive one: it
can't respond to the colour scheme, and a light-on-dark mark stays legible on a light *and* a dark
tab strip — where the inverted variant would disappear into a light one.

## Where the favicons are served from

`generate.sh` copies `favicon.svg`, `favicon.ico` and (for the console) `apple-touch-icon.png` into
each web app's Vite `public/` dir, which Vite copies to the built `dist/` root:

| App | Files | Served at |
| --- | --- | --- |
| `packages/console/public` | `favicon.svg`, `favicon.ico`, `apple-touch-icon.png` | `/` |
| `packages/player/public` | `favicon.svg`, `favicon.ico` | `/player/` |

**Those copies are committed.** `vite build` runs inside the Docker image, which has no librsvg, so
the icons must already be on disk. That makes drift possible — so `packages/e2e/favicon.test.ts`
asserts each copy is byte-identical to its source here. Edit the source, re-run the generator,
commit the result.

## Regenerating

```sh
./brand/generate.sh
```

Rasterizes the PNG set, packs `favicon.ico` from the 16/32/48 px PNGs (`make-ico.ts`), then syncs
the favicons into the two `public/` dirs. Requires
[librsvg](https://gitlab.gnome.org/GNOME/librsvg) (`brew install librsvg`, provides `rsvg-convert`)
and `bun`. Edit the `sizes` array in `generate.sh` to change the rasterized set.
