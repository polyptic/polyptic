#!/usr/bin/env bun
/**
 * Regenerate `packages/server/assets/boot-theme.txt`, the GRUB boot theme (POL-47) — BYTE-IDENTICAL to
 * what the control plane serves at `GET /boot/theme.txt` (both come from `buildBootThemeTxt()`).
 *
 *     bun deploy/render-boot-theme.ts
 *
 * WHY A CHECKED-IN FILE (mirrors render-boot-logo.ts). `build-boot-medium.sh` bakes this theme onto the
 * boot medium so the OFFLINE/Wi-Fi menu paints the branded splash with no server to fetch it from
 * (POL-74/D69) — GRUB/UEFI cannot join WPA, so the offline path has no control plane to `curl`. POL-74
 * baked it with a best-effort BUILD-TIME curl (silent plain medium when the server wasn't reachable);
 * POL-80 replaced that with a build-time `bun` GENERATION — but the cluster's medium-baking Jobs are
 * `ubuntu:24.04` containers with `/repo` files but NO `bun` on PATH, so the generation failed and the
 * medium shipped PLAIN again (a regression). So the theme becomes a COMMITTED asset, exactly like
 * `boot-logo.png`: `build-boot-medium.sh` just COPIES it — no `bun`, no network, no runtime — and it
 * works identically in the cluster and on a macOS laptop (POL-82/D77).
 *
 * Re-run this whenever the theme in `boot-theme.ts` changes. `bun test` fails if the committed file
 * stops matching `buildBootThemeTxt()` (packages/e2e/boot-splash.test.ts), so it can never drift from
 * the served theme — but it cannot see that you forgot to re-run it, so re-run it.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bootBgPng, buildBootThemeTxt } from "../packages/server/src/boot-theme.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(REPO_ROOT, "packages/server/assets/boot-theme.txt");
// The theme's desktop-image (POL-130): rendered together because the theme REQUIRES it — a theme
// without a decodable desktop-image makes GRUB 2.12 error the moment a menu entry boots.
const BG_OUT = resolve(REPO_ROOT, "packages/server/assets/boot-bg.png");

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, buildBootThemeTxt(), "utf8");
console.log(`render-boot-theme: wrote ${OUT}`);
await writeFile(BG_OUT, bootBgPng());
console.log(`render-boot-theme: wrote ${BG_OUT}`);
