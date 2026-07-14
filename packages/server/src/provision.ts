/**
 * Zero-touch, AIR-GAPPED edge provisioning — served by the control plane (k3s-style).
 *
 * A machine that can reach ONLY the server (no internet) boots and enrols entirely from these
 * TOP-LEVEL, UNGATED routes (registered OUTSIDE the /api/v1 operator gate, like /healthz — the machine
 * carries no operator session):
 *
 *   GET /dist/agent/:arch                         → the prebuilt agent BINARY for arm64|amd64, streamed.
 *                                                   No boot path fetches it: the live image bakes the
 *                                                   binary in at build time. Kept for agent OTA (POL-28).
 *
 * NETBOOT (POL-33/D47) is the ONLY supported way a machine becomes a screen (D58). A bare machine boots
 * Ubuntu's SIGNED shim+GRUB chain over the network into a live Polyptic image in RAM, Secure Boot stays
 * ON, no OS install:
 *   GET /boot/grub.cfg                            → the generated GRUB menu with the control-plane base
 *                                                   (and, in GATED mode, the enrolment token) baked in
 *                                                   from THIS request. Ungated, the box has no session.
 *   GET /grub/grub.cfg (+ per-arch aliases)       → the SAME menu where an HTTP-booted grubnet looks:
 *                                                   its baked prefix resolves to (http,host:port)/grub
 *                                                   at the server root, not next to the shim URL.
 *   GET /boot/theme.txt, GET /boot/logo.png       → the GRUB theme that makes that menu the Polyptic
 *                                                   splash rather than a text console (POL-47).
 *   GET /dist/image/:arch/{vmlinuz,initrd,rootfs.squashfs} → the live-image artifacts, Range-streamed to RAM.
 *   GET /dist/boot/:file                          → the dd-able universal dongle (polyptic-boot.img) and
 *                                                   the four signed loaders (shim + GRUB .efi), TOKENLESS
 *                                                   so ungated (UEFI HTTP Boot / offload).
 *   GET /api/v1/settings/netboot                  → operator-facing netboot info for the console (GATED,
 *                                                   under /api/v1; secret-free, points at the URLs above).
 *
 * SAFETY: every path segment is matched against a strict whitelist (no '/', no '..'), and the resolved
 * absolute path is asserted to stay INSIDE its configured root before any file is touched — the same
 * traversal-safety contract as the media serve route. A missing artifact is a clean 404, never a
 * traversal or a 500.
 */
import { createReadStream } from "node:fs";
import type { Stats } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { BootReportBody, NetbootInfo } from "@polyptic/protocol";
import type { BootReportBody as BootReport } from "@polyptic/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { bootGfxPreamble, buildBootThemeTxt } from "./boot-theme";
import { constantTimeEqual } from "./enroll";
import type { Enrollment } from "./enroll";

/** The GRUB boot theme's one image (POL-47), committed beside the server sources and copied wholesale
 *  into the Docker image. Resolved off this module rather than the repo root so it is found from any
 *  CWD and in the container alike. Rebuild it with `bun deploy/render-boot-logo.ts`. */
const BOOT_LOGO_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "assets", "boot-logo.png");


/** Repo root (…/packages/server/src → repo) so the dev defaults find `deploy/dist` regardless of the
 *  server's CWD. In the Docker image the env (AGENT_DIST_DIR=/app/deploy/dist, etc.) overrides these. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// ─────────────────────────────────────────────────────────────────────────────
// Config / wiring
// ─────────────────────────────────────────────────────────────────────────────

export interface ProvisionConfig {
  /** Directory holding the prebuilt agent binaries `polyptic-agent-<arch>`. */
  agentDistDir: string;
  /** Directory holding the netboot live-image artifacts: `<arch>/{vmlinuz,initrd,rootfs.squashfs}` (POL-33). */
  imageDistDir: string;
  /** Directory holding the boot depot: `polyptic-boot.img` + the four signed loaders (POL-33/D47). */
  bootDistDir: string;
  /** Last-resort base URL when the request carries no Host/forwarded headers. */
  publicBaseUrl: string;
}

/** Resolve provisioning config from the environment, with sensible repo-relative defaults. */
export function provisionConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ProvisionConfig {
  return {
    agentDistDir: env.AGENT_DIST_DIR?.trim() || resolve(REPO_ROOT, "deploy/dist"),
    imageDistDir: env.IMAGE_DIST_DIR?.trim() || resolve(REPO_ROOT, "deploy/dist/image"),
    bootDistDir: env.BOOT_DIST_DIR?.trim() || resolve(REPO_ROOT, "deploy/dist/boot"),
    publicBaseUrl: (env.PUBLIC_BASE_URL?.trim() || "http://localhost:8080").replace(/\/+$/, ""),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Whitelists + traversal-safe path resolution
// ─────────────────────────────────────────────────────────────────────────────

/** Build target architectures we serve binaries + bundles for. */
const ARCH_RE = /^(arm64|amd64)$/;
/** The netboot live-image artifacts a diskless box streams (POL-33): the Canonical-signed kernel,
 *  the dracut initrd, and the BARE `rootfs.squashfs` that dracut's `root=live:` pulls whole into RAM
 *  (POL-35/D55 — casper's `iso-url=` wanted a whole `.iso` around the same squashfs) — plus the
 *  self-contained bootable live ISO (POL-38/D49, `build-live-iso.sh`; it bakes the token like
 *  `/boot/grub.cfg` does, and a leaked token still cannot self-admit a NEW box past the operator),
 *  the fat `initrd-wifi` + `SHA256SUMS` a box's update-poll fetches to refresh its local boot medium
 *  (POL-63/D67; the sums file is secret-free), and nothing else. */
const IMAGE_FILE_RE = /^(vmlinuz|initrd|initrd-wifi|rootfs\.squashfs|polyptic-live\.iso|SHA256SUMS)$/;
/** A build's image id, as stamped by the build scripts: `<UTC timestamp>-<8 hex>`. The leading
 *  alphanumeric rules out `.`/`..`, so it can never escape the builds/ directory (POL-45). */
const IMAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** The boot-depot files (POL-33/D47): `polyptic-boot.img` is the universal `dd`-able FAT32 dongle (both
 *  arches on one stick); the four `.efi` files are the SIGNED loaders (shim + network GRUB per arch) for
 *  UEFI HTTP Boot and the offload flow. All TOKENLESS (they only chain `/boot/grub.cfg`), so this route
 *  is ungated like `/dist/agent`. */
const BOOT_FILE_RE = /^(polyptic-boot\.img|shimx64\.efi|shimaa64\.efi|grubx64\.efi|grubaa64\.efi)$/;
/** The four signed loaders the depot serves and the offload flow installs (for the boot summary). */
const SIGNED_LOADER_FILES = ["shimx64.efi", "shimaa64.efi", "grubx64.efi", "grubaa64.efi"] as const;
/** `POST /boot/report` throttle (POL-58): a rack being offloaded posts a handful of lines a minute, so
 *  a burst of 10 with one token back every 6s is generous for real boxes and useless for a flooder. */
const REPORT_BURST = 10;
const REPORT_REFILL_MS = 6_000;

/**
 * Resolve `segments` under `root`, asserting the result stays INSIDE `root` (no traversal). Returns
 * null if the join escapes the root — callers turn that into a 404, never a leak. Mirrors the media
 * store's `safeJoin`.
 */
function safeResolve(root: string, ...segments: string[]): string | null {
  const base = resolve(root);
  const abs = resolve(base, ...segments);
  if (abs !== base && !abs.startsWith(base + sep)) return null;
  return abs;
}

/** `stat` a path, returning the Stats only when it is a regular file, else null (missing / not a
 *  file / any error). Lets a serve route branch on presence without a try/catch at each call site. */
async function statFileOrNull(abs: string): Promise<Stats | null> {
  try {
    const st = await stat(abs);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

/** First value of a (possibly comma-joined / array) header, trimmed; "" if absent. */
function headerFirst(value: string | string[] | undefined): string {
  if (value === undefined) return "";
  const raw = Array.isArray(value) ? value[0] ?? "" : value;
  const first = raw.split(",")[0] ?? "";
  return first.trim();
}

/**
 * Compute the control-plane base URL the box should target — the exact host it curled. Prefer the
 * reverse-proxy's X-Forwarded-Proto/Host, else the Host header, else the configured PUBLIC_BASE_URL.
 * Always scheme://authority with no trailing slash.
 */
export function computeBaseUrl(request: FastifyRequest, fallback: string): string {
  const fwdHost = headerFirst(request.headers["x-forwarded-host"]);
  const fwdProto = headerFirst(request.headers["x-forwarded-proto"]).toLowerCase();
  const host = headerFirst(request.headers.host);
  // With no proxy header, the socket's own protocol decides — "https" when the server itself
  // terminates TLS (TLS_CERT_FILE/TLS_KEY_FILE, POL-70/D89), "http" on the plain listener. This is
  // what keeps console-facing URLs (live-ISO downloads etc.) https under native TLS; the boot
  // chain is unaffected because buildBootGrubCfg forces http:// regardless (GRUB has no TLS).
  const socketProto = request.protocol === "https" ? "https" : "http";

  if (fwdHost) {
    const proto = fwdProto || socketProto;
    return `${proto}://${fwdHost}`.replace(/\/+$/, "");
  }
  if (host) {
    const proto = fwdProto || socketProto;
    // GRUB's http client (and other minimal fetchers) sends `Host:` WITHOUT the port. Trusting it
    // verbatim baked port-80 URLs into /boot/grub.cfg, so the very netboot menu we served over
    // :8080 pointed the kernel fetch at :80 — "connection refused" at the box (found live in the
    // POL-39 VM netboot; curl masks the bug because it always sends the port). When the header
    // carries no port and the accepted socket's port is not the protocol default, restore it.
    let authority = host;
    const hasPort = authority.startsWith("[") ? /\]:\d+$/.test(authority) : authority.includes(":");
    // The bound port comes from the listener (Bun's http sockets don't reliably expose localPort).
    const addr = request.server.server.address();
    const listenPort =
      (addr && typeof addr === "object" ? addr.port : undefined) ?? request.socket?.localPort;
    if (!hasPort && listenPort && listenPort !== (proto === "https" ? 443 : 80)) {
      authority = `${authority}:${listenPort}`;
    }
    return `${proto}://${authority}`.replace(/\/+$/, "");
  }
  return fallback.replace(/\/+$/, "");
}

/**
 * Derive the agent WebSocket URL from an HTTP(S) control-plane base: `http`→`ws`, `https`→`wss`, and
 * append the `/agent` channel path. Baked into `/boot/grub.cfg` so a diskless box's agent dials the
 * exact same host it netbooted from (the outbound-WSS channel, D12). `http://h:8080` → `ws://h:8080/agent`.
 */
export function toWsAgentUrl(httpBase: string): string {
  return `${httpBase.replace(/\/+$/, "").replace(/^http/, "ws")}/agent`;
}

/**
 * The kernel command line a diskless box boots with (POL-33/D47, dracut since POL-35/D55).
 * CENTRALISED here because it is the one half of the boot contract that lives in the server:
 *   - `root=live:<url of a bare squashfs>` is dracut's live-image mechanism. `livenet` curls the
 *     image into the initramfs tmpfs and `dmsquash-live` loop-mounts it, nothing touches disk
 *     ("live image, no install"). It replaces casper's `boot=casper iso-url=<url ending .iso>`,
 *     which needed a whole ISO wrapper around the same squashfs.
 *   - `rd.overlay=1` gives the writable layer as an overlayfs in RAM rather than a device-mapper
 *     snapshot (dracut-ng 110's name; `rd.live.overlay.overlayfs` is its deprecated alias). NEVER
 *     add `rd.live.ram=1`: it `dd`s a SECOND full copy of the image into RAM on top of the one
 *     livenet already downloaded.
 *   - `ip=dhcp rd.neednet=1` bring the NIC up and make dracut wait for it before the fetch.
 *   - `polyptic.server_url=` / `polyptic.token=` are picked out of /proc/cmdline by the image's
 *     parse-cmdline helper and become the agent's POLYPTIC_SERVER_URL / POLYPTIC_BOOTSTRAP_TOKEN.
 * `$arch` is a GRUB runtime variable expanded at boot; the http URLs are literals (GRUB has no TLS,
 * the boot depot is plain http by contract) and the token (when gated) is a baked literal. The caller
 * appends `polyptic.offload=1` on the offload entry only.
 */
function bootKernelCmdline(httpBase: string, token: string | undefined): string {
  const parts = [
    `root=live:${httpBase}/dist/image/$arch/rootfs.squashfs`,
    "rd.overlay=1",
    "ip=dhcp",
    "rd.neednet=1",
    // The HTTP base (for the offload flow to fetch the loaders) + the WS agent URL (for the agent).
    `polyptic.base=${httpBase}`,
    `polyptic.server_url=${toWsAgentUrl(httpBase)}`,
  ];
  if (token !== undefined) parts.push(`polyptic.token=${token}`);
  // POL-7/POL-38: boot splash instead of scrolling kernel/systemd text. The live image carries the
  // Polyptic Plymouth theme, and dracut's plymouth module bundles it into the initramfs (the theme
  // is named in /etc/dracut.conf.d/polyptic-splash.conf, which `polyptic-agent setup` writes);
  // `quiet splash` is what makes plymouthd display it. `plymouth.ignore-serial-consoles` is
  // LOAD-BEARING: any serial console (arm64 VMs get one implicitly from the devicetree) makes
  // plymouth assume a headless server and never paint the local display (verified live with
  // plymouthd --debug in the POL-38 UTM boot). A wall renders on its panel by definition.
  // `multipath=off` is a dracut cmdline gate; the image also omits the module outright.
  parts.push("multipath=off", "quiet", "splash", "plymouth.ignore-serial-consoles");
  return parts.join(" ");
}

/**
 * Build the GRUB menu served at `GET /boot/grub.cfg` (+ the /grub aliases) for a control plane at
 * `base`, baking in the WS agent URL and, in GATED mode, the current enrolment token (POL-33/D47). The
 * box has no operator session at boot, so the route is ungated; a leaked token cannot self-admit (a NEW
 * machine still lands PENDING for an operator to approve, see enroll.ts case 1). `$grub_cpu` selects
 * amd64/arm64 at boot so one menu serves both arches. The `--id offload` entry tags the cmdline so the
 * live image writes the signed loaders to the box's ESP once, then boots the same flow forever. The
 * `--id debug` entry is the live boot plus `systemd.debug-shell=1` — a passwordless root shell on tty9
 * (Ctrl+Alt+F9), the ONLY interactive access a sealed kiosk image has (no passwords, no SSH). A menu
 * item because hand-appending it in GRUB's editor (a wrapped multi-line `linux` line, a 5-second
 * timeout) proved miserable at a hot box in the field. It grants nothing an attacker with keyboard +
 * power didn't already have: GRUB configs are unverified in the shim model (D47), so anyone at the
 * menu can already edit the cmdline; the entry never auto-boots (default stays `live`). Every
 * `$var` in the emitted config is GRUB runtime syntax, written literally (never JS interpolation); the
 * commands are plain `linux`/`initrd` (noble's signed GRUB has no linuxefi). When the computed base is
 * https, http is emitted anyway: GRUB has no TLS, the boot depot is plain-HTTP by contract.
 *
 * The menu is FLAT: three sibling entries, no submenu. A confirmation submenu was tried (POL-58) and
 * reverted — it broke the very entry it guarded (see the `export` note below), and the reassurance it
 * carried belongs in the console, where the operator reads it before walking to the box, not in a GRUB
 * menu they are trying to get past. Offload is non-destructive by construction; nothing here needs a
 * safety interlock.
 *
 * The menu is also GRAPHICAL (POL-47/D65): see ./boot-theme.ts. Titles and the one line each entry
 * echoes are written for whoever walks past the wall, not for whoever built the boot chain — this
 * screen is on a public panel every time the box powers on, which is why D61's entry names do not
 * survive here. `$arch` still selects the artifacts; it is no longer announced. The debug entry keeps
 * its tty9 detail: it is the one line nobody sees unless they deliberately chose it. `set net=` must
 * precede the preamble, which interpolates `$net` into the theme URL.
 */
export function buildBootGrubCfg(base: string, token: string | undefined): string {
  const hostPort = base.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const httpBase = `http://${hostPort}`;
  const cmdline = bootKernelCmdline(httpBase, token);
  const lines = [
    "# Polyptic netboot (POL-33/D47), generated for THIS control plane from the request Host.",
    "# Ownership is by KEY: the box belongs to the server whose enrolment token it carries.",
    "# Chain: firmware db -> shim (Microsoft-signed) -> GRUB (Canonical-signed) -> Canonical-signed",
    "# kernel, verified by shim_lock even when fetched over HTTP. Secure Boot stays ON.",
  ];
  if (base.startsWith("https://")) {
    lines.push(
      "# The operator base is https, but GRUB has no TLS: the boot depot speaks plain http.",
    );
  }
  lines.push(
    'if [ "$grub_cpu" = "x86_64" ]; then set arch=amd64; else set arch=arm64; fi',
    `set net=(http,${hostPort})`,
    // `export` is LOAD-BEARING, not tidiness (POL-58). GRUB opens a fresh environment context for a
    // `submenu` (`normal/menu.c`: `if (entry->submenu) grub_env_context_open()`), and ONLY exported
    // variables cross a context boundary. A submenu wrapped around these entries therefore saw `$net`
    // and `$arch` as empty and asked the firmware for `/dist/image//vmlinuz` — "file not found", on a
    // box that had booted the identical top-level entry moments before. Exporting them makes the menu
    // safe to nest; a plain top-level menuentry never opened a context and always worked.
    "export arch",
    "export net",
    ...bootGfxPreamble("$net/boot/theme.txt"),
    "set timeout=5",
    "set default=live",
    'menuentry "Polyptic" --id live {',
    '  echo "Starting Polyptic ..."',
    `  linux  $net/dist/image/$arch/vmlinuz ${cmdline}`,
    "  initrd $net/dist/image/$arch/initrd",
    "}",
    'menuentry "Set up this screen to start without the USB stick" --id offload {',
    '  echo "Setting up this screen ..."',
    `  linux  $net/dist/image/$arch/vmlinuz ${cmdline} polyptic.offload=1`,
    "  initrd $net/dist/image/$arch/initrd",
    "}",
    // The one entry whose line may stay technical: nobody reads it unless they chose it deliberately,
    // and by then `tty9` is the fact they walked to the box for.
    'menuentry "Debug console" --id debug {',
    '  echo "Starting Polyptic with a root shell on tty9 (Ctrl+Alt+F9) ..."',
    `  linux  $net/dist/image/$arch/vmlinuz ${cmdline} systemd.debug-shell=1`,
    "  initrd $net/dist/image/$arch/initrd",
    "}",
  );
  return lines.join("\n") + "\n";
}

/** A netbooted box has no operator watching its journal, so a bootloader install that fails has, until
 *  POL-58, failed in silence. `POST /boot/report` turns each outcome into ONE Live Activity line. */
export type ActivitySink = (severity: "info" | "good" | "warn" | "bad", text: string) => void;

/** How the operator is addressed: the stable netboot id when the box derived one, else "a machine". */
function reporterName(machineId: string): string {
  const id = machineId.trim();
  if (id.length === 0) return "A machine";
  return `Machine ${id.length > 24 ? `${id.slice(0, 24)}…` : id}`;
}

/**
 * Render a boot report as one activity line + its severity (POL-58). `detail` is a sentence the box
 * composed about its own firmware and disks; the server never parses it, only quotes it — the codes
 * are the machine-readable half of the contract, and they are what tests pin.
 *
 * `installed` is `good`. Everything else is `bad` except the "the operator has to decide" cases — an
 * ambiguous ESP and a legacy-BIOS box are `warn`: nothing broke, the install just needs a human — and
 * POL-116's `pinned-build-missing`, which is not a bootloader outcome at all.
 */
export function bootReportLine(report: BootReport): { severity: "good" | "warn" | "bad"; text: string } {
  const who = reporterName(report.machineId);
  const detail = report.detail.trim();
  if (report.ok && report.code === "installed") {
    return { severity: "good", text: `${who} installed the Polyptic bootloader${detail ? `: ${detail}` : ""}` };
  }
  // POL-116: the box IS up — it just healed a pin retention had pruned and streamed the ACTIVE image
  // instead of the one its medium named. `warn`, not `bad`: nothing is broken, but the operator must
  // know the wall is running a rootfs its on-stick kernel did not ship with until the medium re-pins.
  if (report.code === "pinned-build-missing") {
    return {
      severity: "warn",
      text: `${who} could not find the OS image its boot medium was pinned to and started the current one instead${
        detail ? `: ${detail}` : ""
      }`,
    };
  }
  const severity = report.code === "ambiguous-esp" || report.code === "not-uefi" ? "warn" : "bad";
  return {
    severity,
    text: `${who} could not install the Polyptic bootloader (${report.code})${detail ? `: ${detail}` : ""}`,
  };
}

/** The bearer token on a boot report, if any. Boxes send the fleet enrolment token they netbooted with. */
function bearerToken(request: FastifyRequest): string | undefined {
  const raw = headerFirst(request.headers.authorization);
  const m = /^Bearer\s+(.+)$/i.exec(raw);
  return m?.[1]?.trim() || undefined;
}

/**
 * Parse a single `Range: bytes=start-end` header against a known `size`. The root image is hundreds
 * of MB and dracut's curl can issue byte-range GETs while streaming it, so `/dist/image` serves real
 * 206 partial content. Returns `null` for an absent / multi-range / malformed header (caller streams the
 * full 200), `{ unsatisfiable: true }` for a start past EOF (→ 416), else the inclusive `{ start, end }`.
 * Supports the suffix form `bytes=-N` (last N bytes). Mirrors the media store's range handling.
 */
export function parseRange(
  header: string | string[] | undefined,
  size: number,
): null | { unsatisfiable: true } | { start: number; end: number } {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(raw.trim());
  if (!m) return null;
  const rangeStart = m[1] ?? "";
  const rangeEnd = m[2] ?? "";
  if (rangeStart === "" && rangeEnd === "") return null;

  let start: number;
  let end: number;
  if (rangeStart === "") {
    // Suffix form: last N bytes.
    const n = Number(rangeEnd);
    if (!Number.isFinite(n) || n <= 0) return { unsatisfiable: true };
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(rangeStart);
    end = rangeEnd === "" ? size - 1 : Number(rangeEnd);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size) return { unsatisfiable: true };
  if (end >= size) end = size - 1;
  return { start, end };
}

/**
 * Whether a boot asset must be served FULLY BUFFERED so the response carries a Content-Length.
 * GRUB's shim_lock verifier and UEFI reject an unknown-size / chunked body (`verifiers.c`: an
 * unknown size trips the "big file signature isn't implemented yet" guard, so a Secure-Boot box
 * will NOT load a chunked kernel), and Bun's HTTP server forces `Transfer-Encoding: chunked` for
 * ANY streamed body EVEN with an explicit Content-Length header — so a complete Buffer is the only
 * way to emit Content-Length, and the GRUB/firmware-fetched artifacts must take it.
 *
 * The decision is BY FETCHER, never by size. The old rule (buffer anything under a 512 MiB cap)
 * OOM-killed the control plane in the field the day the root image shrank below the cap: a 486 MiB
 * `rootfs.squashfs` suddenly qualified for `readFile()` into a 512Mi-limited pod, every dracut
 * fetch crash-looped the server, and the netbooting box saw 502/503 (fpd-ago, 2026-07-10). What
 * GRUB and the firmware fetch (vmlinuz, initrd, the signed `.efi` loaders) is tens of MB and safe
 * to buffer; what userspace fetches (`rootfs.squashfs` and `initrd-wifi` via curl,
 * `polyptic-live.iso` and the dongle `.img` via a browser) is chunked-capable and streams,
 * whatever its size.
 */
const GRUB_FETCHED_IMAGE_FILES = new Set(["vmlinuz", "initrd"]);

/** The boot-depot files the FIRMWARE fetches (UEFI HTTP Boot: shim by Boot URI, then GRUB by name
 *  via shim) — 1–2 MB each, and that fetcher needs a real Content-Length, so they buffer. The
 *  dongle `polyptic-boot.img` is deliberately NOT here: nothing in the boot chain ever fetches it
 *  (it IS the boot chain) — only browsers (the console download) and the offload's curl do, both
 *  chunked-capable — and POL-63's local payload grew it from 64 MiB to ~490 MB, so buffering it
 *  OOM-killed a 512Mi pod the first time an operator clicked "Download bootloader" (fpd-ago,
 *  2026-07-11, POL-73). */
const FIRMWARE_FETCHED_BOOT_FILES = new Set(["shimx64.efi", "shimaa64.efi", "grubx64.efi", "grubaa64.efi"]);

/** Range slices up to this many bytes are buffered so the 206 carries an exact Content-Length
 *  (GRUB and the firmware only ever range small files); larger slices stream. Keeps a resuming
 *  browser download of the live ISO — `Range: bytes=N-` over hundreds of MB — from re-creating
 *  the whole-file-buffer OOM through the side door. 8 MiB. */
const RANGE_BUFFER_MAX = 8 * 1024 * 1024;

/**
 * Serve `abs` (a known-`size` regular file) as a boot asset: honour a byte Range, and — when
 * `buffer` is set because GRUB/the firmware is the fetcher — emit a Content-Length by sending a
 * complete Buffer. Everything else streams (Bun sends streams chunked; curl and browsers are
 * fine with that). Callers set any extra headers (e.g. Content-Disposition) first.
 */
async function sendBootAsset(
  reply: FastifyReply,
  abs: string,
  size: number,
  rangeHeader: string | string[] | undefined,
  buffer: boolean,
): Promise<unknown> {
  reply.header("Cache-Control", "no-store");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Accept-Ranges", "bytes");
  reply.type("application/octet-stream");

  const range = parseRange(rangeHeader, size);
  if (range && "unsatisfiable" in range) {
    reply.header("Content-Range", `bytes */${size}`);
    reply.type("text/plain; charset=utf-8");
    return reply.code(416).send("range not satisfiable");
  }
  if (range) {
    const { start, end } = range;
    const len = end - start + 1;
    reply.code(206);
    reply.header("Content-Range", `bytes ${start}-${end}/${size}`);
    if (len <= RANGE_BUFFER_MAX) {
      // Small slice: buffer it so the 206 carries a real Content-Length, not chunked.
      const buf = Buffer.allocUnsafe(len);
      const fh = await open(abs, "r");
      try {
        await fh.read(buf, 0, len, start);
      } finally {
        await fh.close();
      }
      reply.header("Content-Length", String(len));
      return reply.send(buf);
    }
    // Big slice (a browser resuming the live ISO): stream the window, never allocate it.
    return reply.send(createReadStream(abs, { start, end }));
  }
  if (buffer) {
    // A Buffer body (not a stream) is what makes Bun emit Content-Length; GRUB requires it.
    reply.header("Content-Length", String(size));
    return reply.send(await readFile(abs));
  }
  // Userspace-fetched artifacts (root image, live ISO): streamed, chunked, O(1) memory.
  return reply.send(createReadStream(abs));
}

/**
 * Resolve the downloadable boot medium under `bootDistDir`, traversal-safe: the universal `dd`-able
 * `polyptic-boot.img` dongle (one stick boots amd64 AND arm64, no per-arch media). Returns its absolute
 * path when it is a regular file, else `null` (the medium is optional, the UI falls back to pointing
 * DHCP option-67 / UEFI HTTP Boot at the shim URL when it's absent).
 */
export async function resolveBootMedium(bootDistDir: string): Promise<string | null> {
  const abs = safeResolve(bootDistDir, "polyptic-boot.img");
  if (!abs) return null;
  try {
    if ((await stat(abs)).isFile()) return abs;
  } catch {
    // medium not bundled
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Register the provisioning routes. ALL are TOP-LEVEL and UNGATED — register OUTSIDE the /api/v1 gate
 * (alongside /healthz). Pass the resolved {@link ProvisionConfig}.
 */
/** The slice of the image-updates service the ungated manifest route needs (POL-41). */
export interface ImageManifestSource {
  manifest(arch: string): Promise<{ arch: string; imageId: string; builtAt: string; sha256: string | null } | null>;
  state(): Promise<{ urgent: boolean }>;
  /**
   * Heal the ACTIVE build's `builds/<imageId>/` mirror if the depot lacks it (POL-79). The netboot
   * medium pins `root=live:…/builds/<active-id>/rootfs.squashfs`, so the serve path calls this on a
   * miss to hardlink the mirror from the arch root — no server restart needed. Best-effort and
   * idempotent; a non-active (e.g. pruned) id stays a clean 404.
   */
  ensureActiveBuild(arch: string): Promise<void>;
}

export function registerProvisionRoutes(
  fastify: FastifyInstance,
  config: ProvisionConfig,
  enrollment: Enrollment,
  imageUpdates?: ImageManifestSource,
  onBootReport?: ActivitySink,
): void {
  const { agentDistDir, imageDistDir, bootDistDir, publicBaseUrl } = config;

  // ── GET /dist/agent/:arch — the prebuilt agent binary. 404 when not bundled. ──
  fastify.get("/dist/agent/:arch", async (request, reply) => {
    const arch = (request.params as { arch?: string }).arch ?? "";
    if (!ARCH_RE.test(arch)) {
      return reply.code(404).send({ error: "unknown architecture" });
    }
    const filename = `polyptic-agent-${arch}`;
    const abs = safeResolve(agentDistDir, filename);
    if (!abs) return reply.code(404).send({ error: "not found" });

    let st;
    try {
      st = await stat(abs);
    } catch {
      return reply.code(404).send({ error: "agent binary not bundled" });
    }
    if (!st.isFile()) return reply.code(404).send({ error: "agent binary not bundled" });

    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Accept-Ranges", "bytes");
    reply.header("Content-Disposition", `attachment; filename="${filename}"`);
    reply.header("Content-Length", String(st.size));
    reply.type("application/octet-stream");
    return reply.send(createReadStream(abs));
  });

  // ─── Netboot depot (POL-33) ────────────────────────────────────────────────────────────────────

  // ── GET /boot/grub.cfg (+ /grub aliases), UNGATED per-request GRUB menu; base baked from THIS
  //    request, enrolment token baked in GATED mode. The dongle's stage-1 config chains /boot/grub.cfg;
  //    an HTTP-booted grubnet instead resolves its baked $prefix to (http,host:port)/grub at the SERVER
  //    ROOT and probes the per-arch paths first, hence the three aliases (same handler, same body). ──
  const serveBootConfig = async (request: FastifyRequest, reply: FastifyReply): Promise<string> => {
    const base = computeBaseUrl(request, publicBaseUrl);
    const config = buildBootGrubCfg(base, enrollment.currentToken);
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    // A string reply makes Fastify set Content-Length; REQUIRED, firmware/GRUB reject chunked encoding.
    reply.type("text/plain; charset=utf-8");
    return config;
  };
  fastify.get("/boot/grub.cfg", serveBootConfig);
  fastify.get("/grub/grub.cfg", serveBootConfig);
  fastify.get("/grub/x86_64-efi/grub.cfg", serveBootConfig);
  fastify.get("/grub/arm64-efi/grub.cfg", serveBootConfig);

  // ── GET /boot/theme.txt + GET /boot/logo.png, the GRUB boot theme (POL-47). UNGATED and secret-free
  //    for the same reason the menu above is: the box has no operator session at power-on. GRUB fetches
  //    the theme named in `set theme=`, then resolves the theme's `logo.png` against the theme's own
  //    directory — which is why the theme carries no base URL. Neither is on a 404-sensitive boot path:
  //    if either fails, GRUB falls back to its plain text menu and the box still boots. ──
  fastify.get("/boot/theme.txt", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    // A string reply makes Fastify set Content-Length; GRUB's http client rejects chunked encoding.
    reply.type("text/plain; charset=utf-8");
    return buildBootThemeTxt();
  });

  fastify.get("/boot/logo.png", async (_request, reply) => {
    let png: Buffer;
    try {
      png = await readFile(BOOT_LOGO_PATH);
    } catch {
      return reply.code(404).send({ error: "boot logo not bundled" });
    }
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    // A complete Buffer (not a stream) is the only way Bun emits Content-Length; GRUB requires it.
    reply.header("Content-Length", String(png.length));
    reply.type("image/png");
    return reply.send(png);
  });

  // ── POST /boot/report — the box tells the control plane how its bootloader install went (POL-58).
  //    The reporter is a diskless box mid-boot, before any agent session exists, so this lives beside
  //    the boot depot rather than under /api/v1. In GATED mode it must present the fleet enrolment
  //    token it netbooted with (same secret already baked into its cmdline); in OPEN mode — the dev
  //    default, where that token does not exist — it is ungated like the rest of the depot. The body
  //    can only ever produce ONE bounded activity line: the code is a closed enum, `detail` is capped
  //    at 200 chars by the contract, and the bucket below stops a hostile boot network from flooding
  //    the feed. Nothing here mutates the registry. ──
  const reportBucket = { tokens: REPORT_BURST, refilledAt: Date.now() };
  fastify.post("/boot/report", async (request, reply) => {
    if (!enrollment.open) {
      const provided = bearerToken(request);
      const expected = enrollment.currentToken;
      if (expected === undefined || provided === undefined || !constantTimeEqual(provided, expected)) {
        return reply.code(401).send({ error: "unauthorized" });
      }
    }

    const parsed = BootReportBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid boot report" });

    // Leaky bucket: refill one token per REPORT_REFILL_MS, never above the burst size.
    const now = Date.now();
    const gained = Math.floor((now - reportBucket.refilledAt) / REPORT_REFILL_MS);
    if (gained > 0) {
      reportBucket.tokens = Math.min(REPORT_BURST, reportBucket.tokens + gained);
      reportBucket.refilledAt = now;
    }
    if (reportBucket.tokens <= 0) return reply.code(429).send({ error: "too many boot reports" });
    reportBucket.tokens -= 1;

    const { severity, text } = bootReportLine(parsed.data);
    fastify.log.info({ event: "boot.report", code: parsed.data.code, ok: parsed.data.ok }, text);
    onBootReport?.(severity, text);
    return reply.code(204).send();
  });

  // ── GET /dist/image/:arch/:file, the live-image artifacts (vmlinuz|initrd|rootfs.squashfs),
  //    Range-aware (the squashfs is large and streamed into RAM). 404 → the box's boot cleanly stalls. ──
  // ── GET /dist/image/:arch/manifest.json — the published image identity + roll-out urgency
  //    (POL-41). UNGATED like the artifacts themselves (the box has no session) and secret-free:
  //    an image id + checksum reveal nothing an attacker can use, and the urgency flag only makes
  //    boxes reboot into the image this same depot serves. Netbooted boxes poll this every 5
  //    minutes and reboot when their /etc/polyptic/image-id no longer matches (urgent → now,
  //    else the nightly window). 404 until a POL-41 build publishes an image-id.txt.
  fastify.get("/dist/image/:arch/manifest.json", async (request, reply) => {
    if (!imageUpdates) return reply.code(404).send({ error: "image updates not wired" });
    const { arch } = request.params as { arch?: string };
    if (!arch || !ARCH_RE.test(arch)) return reply.code(404).send({ error: "unknown architecture" });
    const m = await imageUpdates.manifest(arch);
    if (!m) return reply.code(404).send({ error: "no published image for this arch" });
    const { urgent } = await imageUpdates.state();
    reply.header("Cache-Control", "no-store");
    return { ...m, urgent };
  });

  // ── GET /dist/image/:arch/builds/:imageId/:file — one RETAINED build's artifacts (POL-45).
  //    Ungated like the active artifacts above and equally secret-free. This is what the console's
  //    "Recent builds" rows download, and what an operator can grab for a build that is no longer
  //    the active one. `imageId` is whitelisted to the depot's own naming so it cannot traverse. ──
  fastify.get("/dist/image/:arch/builds/:imageId/:file", async (request, reply) => {
    const { arch, imageId, file } = request.params as { arch?: string; imageId?: string; file?: string };
    if (!arch || !ARCH_RE.test(arch)) return reply.code(404).send({ error: "unknown architecture" });
    if (!imageId || !IMAGE_ID_RE.test(imageId)) return reply.code(404).send({ error: "unknown build" });
    if (!file || !IMAGE_FILE_RE.test(file)) return reply.code(404).send({ error: "unknown image file" });
    const abs = safeResolve(imageDistDir, arch, "builds", imageId, file);
    if (!abs) return reply.code(404).send({ error: "not found" });

    let st = await statFileOrNull(abs);
    if (!st && imageUpdates) {
      // Self-heal (POL-79). The local boot medium PINS `builds/<active-id>/…` (POL-63/D67), but a
      // rebuild that reached the arch root outside the server's reconcile — an externally-run Job,
      // or a partially-failed multi-arch hook run — left no mirror, so this pinned fetch 404s and
      // the box retries forever (observed on the homelab depot). If `imageId` is the ACTIVE build,
      // hardlink its mirror from the arch root now (no restart needed) and serve it; a non-active or
      // pruned id heals nothing and stays a clean 404. Best-effort: a heal that throws (e.g. a race
      // with a concurrent heal) must never turn into a 500 — we just re-stat and answer honestly.
      await imageUpdates.ensureActiveBuild(arch).catch(() => {});
      st = await statFileOrNull(abs);
    }
    if (!st) return reply.code(404).send({ error: "build artifact not retained" });
    return sendBootAsset(reply, abs, st.size, request.headers.range, GRUB_FETCHED_IMAGE_FILES.has(file));
  });

  fastify.get("/dist/image/:arch/:file", async (request, reply) => {
    const { arch, file } = request.params as { arch?: string; file?: string };
    if (!arch || !ARCH_RE.test(arch)) return reply.code(404).send({ error: "unknown architecture" });
    if (!file || !IMAGE_FILE_RE.test(file)) return reply.code(404).send({ error: "unknown image file" });
    const abs = safeResolve(imageDistDir, arch, file);
    if (!abs) return reply.code(404).send({ error: "not found" });

    let st;
    try {
      st = await stat(abs);
    } catch {
      return reply.code(404).send({ error: "image not bundled" });
    }
    if (!st.isFile()) return reply.code(404).send({ error: "image not bundled" });

    // vmlinuz + initrd are fetched (and vmlinuz shim_lock-verified) by GRUB, which needs Content-Length;
    // sendBootAsset buffers those two. The root image + live ISO stream (curl/browser fetch them,
    // and buffering a ~500 MB body OOM-killed the pod in the field). Range-aware (206/416).
    return sendBootAsset(reply, abs, st.size, request.headers.range, GRUB_FETCHED_IMAGE_FILES.has(file));
  });

  // ── GET /dist/boot/:file, UNGATED download of the boot depot: the universal dd-able dongle
  //    (polyptic-boot.img) + the four signed loaders (shim*/grub*.efi). Tokenless (they only chain
  //    /boot/grub.cfg), so, like /dist/agent, it's ungated: UEFI HTTP Boot, DHCP option-67 and the
  //    offload flow all fetch with no session. 404 when not bundled. ──
  fastify.get("/dist/boot/:file", async (request, reply) => {
    const file = (request.params as { file?: string }).file ?? "";
    if (!BOOT_FILE_RE.test(file)) return reply.code(404).send({ error: "unknown boot file" });
    const abs = safeResolve(bootDistDir, file);
    if (!abs) return reply.code(404).send({ error: "not found" });

    let st;
    try {
      st = await stat(abs);
    } catch {
      return reply.code(404).send({ error: "boot file not bundled" });
    }
    if (!st.isFile()) return reply.code(404).send({ error: "boot file not bundled" });

    // The signed .efi loaders (fetched by shim/the firmware) buffer for their Content-Length; the
    // dongle .img streams — see FIRMWARE_FETCHED_BOOT_FILES for why that split is load-bearing.
    reply.header("Content-Disposition", `attachment; filename="${file}"`);
    return sendBootAsset(reply, abs, st.size, request.headers.range, FIRMWARE_FETCHED_BOOT_FILES.has(file));
  });

  // ── GET /api/v1/settings/netboot, GATED (auto: /api/v1 prefix → the global preHandler). Secret-free
  //    netboot info for the console (the token stays in EnrollmentInfo). ──
  fastify.get("/api/v1/settings/netboot", async (request) => {
    const base = computeBaseUrl(request, publicBaseUrl);
    // The universal dd-able dongle image, when bundled (one medium for both arches).
    const medium = await resolveBootMedium(bootDistDir);
    // The self-contained bootable live ISOs (POL-38/D49), listed per arch when built into the depot.
    const liveIsos: Array<{ arch: "arm64" | "amd64"; url: string }> = [];
    for (const arch of ["arm64", "amd64"] as const) {
      try {
        const st = await stat(join(imageDistDir, arch, "polyptic-live.iso"));
        if (st.isFile()) liveIsos.push({ arch, url: `${base}/dist/image/${arch}/polyptic-live.iso` });
      } catch {
        // not bundled for this arch — omit the entry
      }
    }
    return NetbootInfo.parse({
      baseUrl: base,
      mode: enrollment.open ? "open" : "gated",
      bootConfigUrl: `${base}/boot/grub.cfg`,
      bootMediumUrl: medium ? `${base}/dist/boot/polyptic-boot.img` : null,
      liveIsos,
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Boot diagnostics
// ─────────────────────────────────────────────────────────────────────────────

/** Whether a path exists and is a directory (for boot logging). */
async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Whether a path exists and is a regular file (for boot logging). */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** A boot-time summary of which provisioning artifacts are present, for the boot banner. */
export async function provisionBootSummary(config: ProvisionConfig): Promise<{
  agentDistDir: boolean;
  agentArm64: boolean;
  agentAmd64: boolean;
  imageDistDir: boolean;
  imageAmd64: boolean;
  bootMedium: boolean;
  signedLoaders: boolean;
}> {
  const [agentDir, arm64, amd64, imageDir, imageAmd64, medium, loaders] =
    await Promise.all([
      isDir(config.agentDistDir),
      isFile(resolve(config.agentDistDir, "polyptic-agent-arm64")),
      isFile(resolve(config.agentDistDir, "polyptic-agent-amd64")),
      isDir(config.imageDistDir),
      isFile(resolve(config.imageDistDir, "amd64", "rootfs.squashfs")),
      resolveBootMedium(config.bootDistDir).then((p) => p !== null),
      // Serving UEFI HTTP Boot / offload needs ALL FOUR loaders (shim + network GRUB, both arches).
      Promise.all(
        SIGNED_LOADER_FILES.map((f) => isFile(resolve(config.bootDistDir, f))),
      ).then((present) => present.every(Boolean)),
    ]);
  return {
    agentDistDir: agentDir,
    agentArm64: arm64,
    agentAmd64: amd64,
    imageDistDir: imageDir,
    imageAmd64,
    bootMedium: medium,
    signedLoaders: loaders,
  };
}
