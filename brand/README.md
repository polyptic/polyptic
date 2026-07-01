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
| `png/icon-<size>.png` | Rasterized default variant at 16, 32, 48, 64, 128, 180, 192, 256, 512, 1024 px. |
| `png/icon-dark-<size>.png` | Rasterized inverted variant at the same sizes. |

PNGs are RGBA with transparent rounded corners. Common picks: `16`/`32`/`48` favicon, `180`
apple-touch, `192`/`512` PWA manifest.

## Regenerating the PNGs

```sh
./brand/generate.sh
```

Requires [librsvg](https://gitlab.gnome.org/GNOME/librsvg) (`brew install librsvg`, provides
`rsvg-convert`). Edit the `sizes` array in `generate.sh` to change the set.
