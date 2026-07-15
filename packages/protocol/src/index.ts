/**
 * @polyptic/protocol — the single source of truth for every cross-process message.
 *
 * Two WS channels (see CLAUDE.md):
 *   - agent channel  (machine ↔ server): enrollment, heartbeat, placement, capture, ident, lifecycle
 *   - player channel (screen  ↔ server): content for that screen's slice, pushed live (the "instant" path)
 *
 * Everything that crosses a process boundary is defined and validated here. Parse at the edge,
 * trust the inferred types within.
 */
import { z } from "zod";

import { MachineTags } from "./selector";
import { Daypart, Schedule, SchedulerSettings } from "./schedule";

/** POL-103 — machine tags + the selector grammar that targets bulk operations. */
export {
  MACHINE_TAG_PATTERN,
  MachineTag,
  MachineTags,
  distinctTags,
  matchesSelector,
  normalizeTag,
  parseSelector,
  selectByTags,
} from "./selector";
export type { MachineSelector, ParseSelectorResult } from "./selector";

// The scene scheduler (POL-89/D93): dayparts, schedules, settings AND the shared resolver — the
// server's ticker and the console's week strip answer "what plays when" with the same function.
export * from "./schedule";

export const PROTOCOL_VERSION = 1;

// ─────────────────────────────────────────────────────────────────────────────
// Primitives
// ─────────────────────────────────────────────────────────────────────────────

/** A rectangle on a virtual canvas or within a screen, in pixels. */
export const Geometry = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
});
export type Geometry = z.infer<typeof Geometry>;

/** A physical video output as enumerated by the compositor (e.g. sway `get_outputs`). */
export const Output = z.object({
  connector: z.string(), // "DP-1", "HDMI-A-1"
  make: z.string().optional(),
  model: z.string().optional(),
  serial: z.string().optional(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  position: z.object({ x: z.number().int(), y: z.number().int() }).optional(),
});
export type Output = z.infer<typeof Output>;

// "dev-open" is the development backend: it just opens player URLs in the host's default
// browser (macOS `open` / Linux `xdg-open`) so the system runs on any dev machine with no
// compositor. The real placement backends (wayland-sway, x11-i3) land in Phase 4.
export const DisplayBackend = z.enum(["wayland-sway", "x11-i3", "dev-open"]);
export type DisplayBackend = z.infer<typeof DisplayBackend>;

/** POL-67 — which kiosk browser the box drives. `chrome` (Google Chrome, native Wayland) is the
 *  default where installable and is what makes REMOTE DevTools possible; `surf` (WebKitGTK under
 *  Xwayland, D63) is the fallback whose only inspector is on-panel. The console branches its
 *  per-screen Inspect/DevTools affordance on this. */
export const KioskBrowser = z.enum(["chrome", "surf"]);
export type KioskBrowser = z.infer<typeof KioskBrowser>;

/** Enrollment lifecycle of a machine (Phase 2b). New machines arrive `pending`; an operator
 * approves them. Existing/auto-registered machines default to `approved`. */
export const EnrollmentStatus = z.enum(["pending", "approved", "rejected"]);
export type EnrollmentStatus = z.infer<typeof EnrollmentStatus>;

/**
 * POL-104 — what a box IS, physically. Sent on every `agent/hello` and used for two things: to match a
 * pre-registration (see {@link PreRegistration}), and to make a pending-approval card informative — an
 * operator approving 50 boxes was previously staring at 50 identical UUIDs.
 *
 * Every field is optional and best-effort. A box in a VM has no chassis serial (or a placeholder one);
 * an unprivileged agent may not be able to read `/sys/class/dmi/id/product_serial` at all; a
 * Wi-Fi-bridged VM's MAC is rewritten by its host (POL-63/POL-78). NOTHING here is a credential and
 * nothing here is trusted as proof — the enrolment token is the credential, this is a description.
 */
export const HostIdentity = z.object({
  /** Non-loopback, non-virtual interface MACs, lower-case colon form, sorted. */
  macs: z.array(z.string()).default([]),
  /** DMI chassis/product serial, when readable and not an obvious placeholder. */
  dmiSerial: z.string().optional(),
  dmiProduct: z.string().optional(),
  dmiVendor: z.string().optional(),
  /** `x64` / `arm64` — the box's CPU architecture, as the agent's runtime reports it. */
  arch: z.string().optional(),
});
export type HostIdentity = z.infer<typeof HostIdentity>;

/**
 * POL-117 — is this hostname worth showing a human? Every netbooted box boots the same live image,
 * so every box reports `localhost.localdomain` — a wall of identical "names" that identify nothing.
 * Shared by the server (which refuses to ADOPT such a hostname as the machine label) and the console
 * (which refuses to DISPLAY one that predates the fix), so the two ends can never disagree about
 * what counts as meaningless. Returns the trimmed hostname when it carries information, else null.
 */
export function meaningfulHostname(hostname: string | undefined | null): string | null {
  const h = hostname?.trim();
  if (!h) return null;
  const lower = h.toLowerCase();
  if (lower === "localhost" || lower === "localhost.localdomain") return null;
  if (lower.endsWith(".localdomain")) return null;
  return h;
}

/** A client machine. Plumbing — users address screens, not machines. */
export const Machine = z.object({
  id: z.string(), // stable; sourced from /etc/machine-id
  /** The human name shown in the console. Defaults from the box's reported hostname when that
   *  hostname means something (see `meaningfulHostname`), else stays = `id` — the "unnamed" sentinel
   *  the console renders honestly ("Unnamed box"). An operator rename (POL-117) always wins. */
  label: z.string(),
  agentVersion: z.string().optional(),
  backend: DisplayBackend.optional(),
  /** POL-67 — the kiosk browser the agent reported on hello (absent for dev-open / older agents). */
  browser: KioskBrowser.optional(),
  outputs: z.array(Output).default([]),
  status: EnrollmentStatus.default("approved"),
  /** POL-103 — free-form operator tags ("atrium", "floor:2", "canary"). Flat and opaque: a selector
   *  matches them by set membership, never by parsing them. They are what bulk operations target. */
  tags: MachineTags.default([]),
  lastSeen: z.string().datetime().optional(),
  /** POL-59 — whether an operator has ARMED this box for a remote shell. Default false: a console
   *  compromise must not silently reach a terminal on every box. Disarming kills any live session. */
  shellEnabled: z.boolean().default(false),
  /** POL-59 — when the shell was armed / last used. A sweep auto-disarms a box idle past the TTL
   *  (SHELL_ARM_TTL_MS) so a forgotten armed box is not a standing shell-openable target. */
  shellArmedAt: z.string().datetime().optional(),
  /** POL-104 — what the box IS (MACs / DMI serial / arch), as it last reported. Descriptive, never a
   *  credential; kept so a PENDING card is informative even while the box is offline. */
  hardware: HostIdentity.optional(),
  /** POL-104 — the enrolment token this machine FIRST enrolled on, and its name at that moment. */
  enrolledTokenId: z.string().optional(),
  enrolledTokenName: z.string().optional(),
  /** POL-104 — this machine matched a pre-registration (named / tagged / approved from it). */
  preRegistered: z.boolean().optional(),
  /** POL-134 — when the server last signed this machine's CSR into an mTLS client cert. Absent on
   *  machines that never asked (pre-POL-25 agents, or an mTLS-off deployment). */
  mtlsCertIssuedAt: z.string().datetime().optional(),
  /** POL-134 — when this machine FIRST connected over the mTLS listener: proof the box actually
   *  holds and presents a working cert, not just that one was issued. Drives the auto-promotion to
   *  require-mTLS and the per-machine cert state in Settings. */
  mtlsSeenAt: z.string().datetime().optional(),
});
export type Machine = z.infer<typeof Machine>;

/** A screen: the first-class, named entity users actually configure. */
export const Screen = z.object({
  id: z.string(), // control-plane assigned, stable
  friendlyName: z.string(), // "Nessie", "Big-Bertha"
  machineId: z.string(),
  connector: z.string(), // which Output on that machine
  /** POL-119 — operator has enabled ad-hoc casting (AirPlay receiver) to this screen. Persistent and
   *  TTL-less by design (unlike the shell arm): a meeting-room panel stays castable until an operator
   *  turns it off. Part of desired state — the agent runs one receiver per cast-enabled connector,
   *  advertised under the screen's friendlyName, and a sender's PIN entry (always on, displayed on the
   *  glass) is the per-session gate, so leaving this enabled is not an open door. */
  castEnabled: z.boolean().default(false),
});
export type Screen = z.infer<typeof Screen>;

// ─────────────────────────────────────────────────────────────────────────────
// Typed surfaces — what renders inside a region of a screen
// ─────────────────────────────────────────────────────────────────────────────

const SurfaceBase = z.object({
  id: z.string(),
  region: Geometry, // position within the screen
  /** Video-wall spanning (Phase 3b): when set, this surface shows the sub-rectangle at
   *  (offsetX,offsetY) of a contentW×contentH content. The player sizes the content to
   *  contentW×contentH and translates it by -(offsetX,offsetY) so this screen renders only its
   *  slice of the spanning content. Unset = an ordinary single-screen tile. */
  span: z
    .object({
      contentW: z.number().positive(),
      contentH: z.number().positive(),
      offsetX: z.number(),
      offsetY: z.number(),
    })
    .optional(),
});

/** Page zoom for a FRAMED surface (web/dashboard), as a scale factor — 1 = 100%, like a browser's
 *  zoom control (POL-57). The player renders the frame at 1/zoom of its region and scales it up, so
 *  the embedded page sees a proportionally smaller CSS viewport and lays itself out bigger. Bounds
 *  match a browser's practical range; only framed surfaces carry it (media has `fit`/native size). */
export const Zoom = z.number().min(0.25).max(4);
export type Zoom = z.infer<typeof Zoom>;

export const WebSurface = SurfaceBase.extend({
  type: z.literal("web"),
  url: z.string().url(),
  /** "iframe" (default) or "window" — a top-level OS window placed by the agent (framing-blocked/native escape hatch). */
  placement: z.enum(["iframe", "window"]).default("iframe"),
  interactive: z.boolean().default(false),
  zoom: Zoom.default(1),
});

export const DashboardSurface = SurfaceBase.extend({
  type: z.literal("dashboard"),
  url: z.string().url(), // adapter-built (e.g. a single-panel dashboard embed URL)
  refreshSeconds: z.number().int().positive().optional(),
  zoom: Zoom.default(1),
});

export const ImageSurface = SurfaceBase.extend({
  type: z.literal("image"),
  src: z.string().url(),
  fit: z.enum(["cover", "contain"]).default("cover"),
});

export const VideoSurface = SurfaceBase.extend({
  type: z.literal("video"),
  src: z.string().url(),
  loop: z.boolean().default(true),
  muted: z.boolean().default(true),
});

// ── Playlists (POL-34) ────────────────────────────────────────────────────────
// A playlist is a library-authored CAROUSEL of content. The server resolves each step's source to a
// concrete PlaylistEntry at assignment time and ships the whole rotation to the player in ONE surface;
// the PLAYER advances it locally — a timer for content that never ends by itself, the `ended` event
// for a video left untimed. Content rotation must survive a control-plane outage like everything else
// the player shows, so the server never drives ticks over the wire.

/** What one resolved playlist entry renders as — every renderable kind except another playlist. */
export const PlaylistEntryKind = z.enum(["web", "dashboard", "image", "video"]);
export type PlaylistEntryKind = z.infer<typeof PlaylistEntryKind>;

/** One resolved step of a playlist, as the player receives it. */
export const PlaylistEntry = z.object({
  kind: PlaylistEntryKind,
  url: z.string().url(),
  /** Seconds this entry holds the screen. Absent ONLY for video, meaning "advance when it ends". */
  durationSeconds: z.number().int().min(1).max(86400).optional(),
  /** The library source this entry resolved from — how send-time auth stamping (POL-24) finds the
   *  entry's credential profile. Absent on an entry with nothing to stamp. */
  sourceId: z.string().optional(),
  /** POL-133 — page zoom for THIS entry while it is on air, meaningful only for the framed kinds
   *  (web/dashboard; media has no page to zoom). Same D62 model as a directly-assigned page: the
   *  server remembers the operator's value per (target, entry source) pair and stamps it in at
   *  resolution time. Default 1 so a pre-POL-133 payload parses to exactly the old behaviour. */
  zoom: Zoom.default(1),
});
export type PlaylistEntry = z.infer<typeof PlaylistEntry>;

export const PlaylistSurface = SurfaceBase.extend({
  type: z.literal("playlist"),
  /** The resolved rotation, in order. May be empty if every referenced source was since deleted —
   *  the player treats an empty playlist as nothing to show. */
  items: z.array(PlaylistEntry),
  /** ISO instant the playlist was (re-)assigned — the rotation anchor. A fully-TIMED playlist derives
   *  its current entry from (now − startedAt) mod cycle, so wall members stay in phase with each other
   *  and a rebooting box rejoins the rotation mid-cycle instead of restarting it. A playlist with any
   *  untimed video can't be derived from a clock and plays sequentially from the top. */
  startedAt: z.string(),
});
export type PlaylistSurface = z.infer<typeof PlaylistSurface>;

// ── Pages (POL-42) — authored compositions of framing elements ───────────────
//
// A PAGE is a content source composed in the console's Studio: an ordered list of elements, each
// positioned in PERCENT of the page (so one definition renders at any resolution), drawn over a
// solid background. The definition travels INSIDE the ScreenSlice as one `page` surface, so
// video-wall spanning and the <150ms DOM-diff path work unchanged — saving in the Studio re-pushes
// the slice and the wall updates in place, no reload.
//
// The STORED definition never carries a resolved URL, a credential, or live feed items: an embed or
// image element references a library source BY ID, and the server resolves + credential-stamps at
// SEND time into `PageSurface.data` (same clean-at-rest pattern as POL-24 token stamping). Feed and
// weather data are polled server-side and delivered through the same `data` bundle.

export const PageAspect = z.enum(["16:9", "9:16"]);
export type PageAspect = z.infer<typeof PageAspect>;

/** A percent coordinate within the page (elements are placed in % so pages are resolution-free). */
const PagePercent = z.number().min(0).max(100);

const PageElementBase = z.object({
  id: z.string().min(1).max(64),
  x: PagePercent,
  y: PagePercent,
  w: z.number().min(0.5).max(100),
  h: z.number().min(0.5).max(100),
});

/** Embed: a content source (by id — credentials are stamped server-side) or a raw URL (no
 *  credentials, by design) framed in a region. This is what composites a dashboard onto a page.
 *  Sources that require `placement:"window"` cannot go on a page (No-Gos). */
export const PageEmbedElement = PageElementBase.extend({
  kind: z.literal("embed"),
  props: z.object({
    sourceId: z.string().optional(),
    url: z.string().url().optional(),
    /** POL-133 — page zoom for the framed page, AUTHORED in the Studio as a property of the element
     *  (not per-screen like D62): a composition must render identically in the Studio preview and on
     *  every wall showing it (the D74 one-renderer invariant), so anything that changes how the page
     *  lays out is part of the composition itself. Same browser-zoom semantics as `WebSurface.zoom`
     *  (the frame is laid out at 1/zoom and scaled back up); default 1 keeps old compositions
     *  byte-identical. */
    zoom: Zoom.default(1),
  }),
});

/** Scrolling text strip. Plain CSS transform animation — fine on the Chrome/amd64 GPU boxes that
 *  are the primary wall target; on the surf/arm64 fallback it is an operator choice (see D66/D74). */
export const PageTickerElement = PageElementBase.extend({
  kind: z.literal("ticker"),
  props: z.object({
    text: z.string().max(2000).default(""),
    /** Scroll speed in px/s (at 1080p-equivalent scale). */
    speed: z.number().min(20).max(120).default(60),
    fg: z.string().max(32).default("#fafafa"),
    bg: z.string().max(32).default("#101014"),
  }),
});

/** RSS/Atom headlines, polled SERVER-side (~5 min, last-good on failure) — the player never fights
 *  CORS. Items arrive in `PageSurface.data.feeds[elementId]`. */
export const PageFeedElement = PageElementBase.extend({
  kind: z.literal("feed"),
  props: z.object({
    url: z.string().max(500).default(""),
    items: z.number().int().min(2).max(8).default(4),
    /** POL-133 — text size as a PERCENT of the feed's height-proportional default (100 = exactly the
     *  pre-POL-133 sizing, so an old composition parses to an identical render). Scales the masthead,
     *  headlines and ages together, keeping the card's own proportions. */
    fontScale: z.number().min(50).max(200).default(100),
  }),
});

/** An uploaded/linked image from the library (kind image), by source id. */
export const PageImageElement = PageElementBase.extend({
  kind: z.literal("image"),
  props: z.object({
    sourceId: z.string().optional(),
    fit: z.enum(["contain", "cover"]).default("contain"),
  }),
});

export const PageTextElement = PageElementBase.extend({
  kind: z.literal("text"),
  props: z.object({
    text: z.string().max(500).default("Text"),
    /** Point size at 1080p-equivalent scale (rendered proportionally via container units). */
    size: z.number().min(14).max(120).default(40),
    color: z.string().max(32).default("#fafafa"),
    align: z.enum(["left", "center", "right"]).default("left"),
  }),
});

/** Live clock. Updates a text node once a minute (once a second with seconds on) — no animation,
 *  safe on every box (D66). */
export const PageClockElement = PageElementBase.extend({
  kind: z.literal("clock"),
  props: z.object({
    format: z.enum(["24h", "12h"]).default("24h"),
    seconds: z.boolean().default(false),
    color: z.string().max(32).default("#fafafa"),
  }),
});

export const PageShapeElement = PageElementBase.extend({
  kind: z.literal("shape"),
  props: z.object({
    fill: z.string().max(32).default("#18181b"),
    radius: z.number().min(0).max(48).default(12),
    opacity: z.number().min(10).max(100).default(100),
  }),
});

/** Local conditions, fetched SERVER-side from Open-Meteo (keyless, cached ~15 min) so the provider
 *  stays swappable behind the poller. Data arrives in `PageSurface.data.weather[elementId]`. */
export const PageWeatherElement = PageElementBase.extend({
  kind: z.literal("weather"),
  props: z.object({
    location: z.string().max(120).default(""),
    units: z.enum(["C", "F"]).default("C"),
  }),
});

// ── QR colours + scannability (POL-133) ──────────────────────────────────────
// A QR that doesn't scan is worse than an ugly one, so the colour pair is validated AT THE CONTRACT
// EDGE: the module/background contrast a camera needs is part of what makes the stored definition a
// QR element at all. The helpers live here (not in the elements package) because the zod refine needs
// them, and the console reuses them for its authoring-time warning.

/** Parse `#rgb` / `#rrggbb` to sRGB relative luminance (0..1), or null for any other colour text.
 *  Non-hex colours (named colours, gradients) can't be judged, so they're never refused. */
export function hexLuminance(color: string): number | null {
  const m = /^#(?:([0-9a-f]{3})|([0-9a-f]{6}))$/i.exec(color.trim());
  if (!m) return null;
  const hex = m[1] ? m[1].split("").map((c) => c + c).join("") : m[2]!;
  const channel = (i: number) => {
    const v = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

/** WCAG-style contrast ratio (1..21) between two hex colours, or null when either isn't hex. */
export function contrastRatio(a: string, b: string): number | null {
  const la = hexLuminance(a);
  const lb = hexLuminance(b);
  if (la === null || lb === null) return null;
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** The contrast a QR needs to scan reliably. Below this the pair is REFUSED at the contract edge. */
export const QR_MIN_CONTRAST = 3;
/** Below this (but ≥ the minimum) the pair is allowed with a loud authoring-time warning. */
export const QR_SAFE_CONTRAST = 4.5;

/**
 * Why a QR colour pair is a problem, or null when it's fine. `refuse` fails the schema; `warn` is
 * for the Studio to shout about (inverted codes and low-but-legal contrast scan on most, not all,
 * cameras). Non-hex colours return null — unjudgeable, so never refused.
 */
export function qrContrastIssue(
  fg: string,
  bg: string,
): { level: "refuse" | "warn"; message: string } | null {
  const ratio = contrastRatio(fg, bg);
  if (ratio === null) return null;
  if (ratio < QR_MIN_CONTRAST) {
    return {
      level: "refuse",
      message: `QR contrast ${ratio.toFixed(1)}:1 is below ${QR_MIN_CONTRAST}:1 — this code will not scan`,
    };
  }
  const lfg = hexLuminance(fg)!;
  const lbg = hexLuminance(bg)!;
  if (lfg > lbg) {
    return { level: "warn", message: "Light modules on a dark background — some cameras refuse inverted QR codes" };
  }
  if (ratio < QR_SAFE_CONTRAST) {
    return {
      level: "warn",
      message: `QR contrast ${ratio.toFixed(1)}:1 is marginal — may not scan in poor light`,
    };
  }
  return null;
}

/** Static QR code, encoded to SVG client-side in the shared elements package — no network.
 *  POL-133 — module (`fg`) and background (`bg`) colours are authorable; the defaults are exactly
 *  the pre-POL-133 hardcoded render, so an old composition parses to an identical code. A pair the
 *  camera provably can't read (hex colours below the minimum contrast) is refused here, at the
 *  contract edge — an unscannable QR is worse than an ugly one. */
export const PageQrElement = PageElementBase.extend({
  kind: z.literal("qr"),
  props: z
    .object({
      url: z.string().max(500).default(""),
      fg: z.string().max(32).default("#09090b"),
      bg: z.string().max(32).default("#ffffff"),
    })
    .superRefine((p, ctx) => {
      const issue = qrContrastIssue(p.fg, p.bg);
      if (issue?.level === "refuse") ctx.addIssue({ code: "custom", message: issue.message });
    }),
});

/** Time to a target time-of-day. Updates a text node per minute — no animation (D66). */
export const PageCountdownElement = PageElementBase.extend({
  kind: z.literal("countdown"),
  props: z.object({
    label: z.string().max(120).default(""),
    /** Target time-of-day, "HH:MM" server-local to the viewer. */
    target: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .default("17:00"),
    color: z.string().max(32).default("#fafafa"),
  }),
});

export const PageElement = z.discriminatedUnion("kind", [
  PageEmbedElement,
  PageTickerElement,
  PageFeedElement,
  PageImageElement,
  PageTextElement,
  PageClockElement,
  PageShapeElement,
  PageWeatherElement,
  PageQrElement,
  PageCountdownElement,
]);
export type PageElement = z.infer<typeof PageElement>;
export type PageElementKind = PageElement["kind"];

/** The authored page: elements in draw order (last = frontmost) over a solid background. */
export const PageDefinition = z.object({
  aspect: PageAspect.default("16:9"),
  bg: z.string().max(32).default("#0b0b0e"),
  elements: z.array(PageElement).max(100).default([]),
});
export type PageDefinition = z.infer<typeof PageDefinition>;

// ── Send-time page data (never stored) ───────────────────────────────────────

/** What an embed element's source resolved to. `web`/`dashboard` frame the url; `image`/`video`
 *  render it as media. The url is already credential-stamped when the source has a profile. */
export const PageEmbedResolution = z.object({
  url: z.string(),
  kind: z.enum(["web", "dashboard", "image", "video"]),
});
export type PageEmbedResolution = z.infer<typeof PageEmbedResolution>;

export const PageImageResolution = z.object({ src: z.string() });
export type PageImageResolution = z.infer<typeof PageImageResolution>;

export const PageFeedItem = z.object({
  title: z.string(),
  link: z.string().optional(),
  publishedAt: z.string().optional(),
});
export type PageFeedItem = z.infer<typeof PageFeedItem>;

export const PageFeedData = z.object({
  items: z.array(PageFeedItem),
  fetchedAt: z.string(),
  /** The feed's own channel title, when it declared one. */
  title: z.string().optional(),
});
export type PageFeedData = z.infer<typeof PageFeedData>;

export const PageWeatherData = z.object({
  tempC: z.number(),
  /** WMO weather interpretation code, as Open-Meteo reports it. */
  code: z.number().int(),
  description: z.string(),
  location: z.string(),
  fetchedAt: z.string(),
});
export type PageWeatherData = z.infer<typeof PageWeatherData>;

/** The live half of a page surface, stamped by the server at SEND time (decorateSliceForSend):
 *  resolved embed/image sources (credential-stamped) + last-polled feed/weather data, all keyed by
 *  element id. Stored slices never carry it, so the DB never holds a token or a stale headline. */
export const PageData = z.object({
  embeds: z.record(z.string(), PageEmbedResolution).optional(),
  images: z.record(z.string(), PageImageResolution).optional(),
  feeds: z.record(z.string(), PageFeedData).optional(),
  weather: z.record(z.string(), PageWeatherData).optional(),
});
export type PageData = z.infer<typeof PageData>;

/** A rendered page: ONE surface, so span math (video walls) and the keyed DOM-diff path work
 *  unchanged. Zoom does not apply to pages (they scale by design — % regions + container units). */
export const PageSurface = SurfaceBase.extend({
  type: z.literal("page"),
  definition: PageDefinition,
  data: PageData.optional(),
});
export type PageSurface = z.infer<typeof PageSurface>;

export const Surface = z.discriminatedUnion("type", [
  WebSurface,
  DashboardSurface,
  ImageSurface,
  VideoSurface,
  PlaylistSurface,
  PageSurface,
]);
export type Surface = z.infer<typeof Surface>;

/** The renderable unit a single player receives: its screen's canvas + the surfaces on it. */
export const ScreenSlice = z.object({
  screenId: z.string(),
  canvas: Geometry, // the screen's own pixel space (x/y usually 0,0)
  surfaces: z.array(Surface),
});
export type ScreenSlice = z.infer<typeof ScreenSlice>;

/** The control plane's desired state. `revision` increments on every change; agents/players reconcile to it.
 *  (The full Scene snapshot model lives below, near the other Phase-3 console types.) */
export const DesiredState = z.object({
  revision: z.number().int().nonnegative(),
  activeSceneId: z.string().nullable(),
  screens: z.array(Screen),
  /** screenId → slice to render right now. */
  slices: z.record(z.string(), ScreenSlice),
});
export type DesiredState = z.infer<typeof DesiredState>;

// ─────────────────────────────────────────────────────────────────────────────
// Agent channel  (machine ↔ server)
// ─────────────────────────────────────────────────────────────────────────────

export const AgentHello = z.object({
  t: z.literal("agent/hello"),
  protocol: z.literal(PROTOCOL_VERSION),
  machineId: z.string(),
  agentVersion: z.string(),
  backend: DisplayBackend,
  /** POL-67 — which kiosk browser this box drives (chrome = remote DevTools available). Omitted by
   *  dev-open (no kiosk browser) and by pre-POL-67 agents. */
  browser: KioskBrowser.optional(),
  outputs: z.array(Output),
  /** The box's os.hostname(), used as the human machine label (additive-safe; optional). */
  hostname: z.string().optional(),
  /** POL-104 — the box's physical identity (MACs / DMI serial / arch). Optional: a pre-POL-104 agent
   *  sends none, and a pending card then simply says less. */
  hardware: HostIdentity.optional(),
  /** First contact only: the operator-configured enrollment secret. The server validates it,
   * creates the machine as `pending`, and replies `server/enrolled` with a durable credential. */
  bootstrapToken: z.string().optional(),
  /** Subsequent connections: the durable per-machine credential issued by `server/enrolled`. */
  credential: z.string().optional(),
  /**
   * POL-25 — a PEM PKCS#10 certificate-signing request. The agent generates its keypair ON THE BOX
   * (the private key never crosses the wire) and sends the CSR whenever it wants an mTLS client cert
   * issued or renewed. A server with mTLS enabled signs it (CN forced to `machineId`) on any hello
   * that authenticates — the 2b credential/token seam, no new enrolment step — and returns the cert
   * in `server/enrolled.mtls`. Servers without mTLS ignore it.
   */
  csrPem: z.string().optional(),
});

// ── Host vitals (POL-92) ─────────────────────────────────────────────────────
//
// What a box knows about ITSELF, sampled from /proc + /sys on every heartbeat and carried on
// `agent/status`. The fleet's known failure modes are physical — a browser software-rendering on a
// broken GPU path pegs the CPU (D77), a wedged page eats the RAM, a respawn loop churns — and until
// now none of them were visible to an operator without a shell session on the box.
//
// EVERY field is optional. A pre-POL-92 agent sends no `vitals` at all; a NON-Linux agent (dev-open
// on a laptop) sends none either; a box whose kernel exposes no thermal zone simply omits `tempC`.
// The console and the metrics exporter therefore render what they have and say nothing about what
// they don't — an absent number is never rendered as a zero.

/** One supervised kiosk browser (one per output), as the agent sees it right now. */
export const BrowserVitals = z.object({
  connector: z.string(),
  /** Is a browser child alive on this output at all? */
  running: z.boolean(),
  pid: z.number().int().positive().optional(),
  /** Resident set of the browser process TREE (the parent + its renderer/GPU children). */
  rssBytes: z.number().nonnegative().optional(),
  /** How many times the agent has respawned this output's browser since it started supervising it.
   *  A climbing number is a crash loop — the wall may look fine between respawns. */
  respawns: z.number().int().nonnegative().optional(),
  /**
   * THE D77 TELL. True when some process in this browser's tree holds an open fd on `/dev/dri/*` —
   * i.e. it is talking to the GPU. False means the browser is rendering the wall IN SOFTWARE, which
   * on a real panel pegs the CPU (the surf/Xwayland DRI3 bug, POL-67) and cooks the box. Absent when
   * the agent could not tell (no /proc, no browser running, fds unreadable).
   */
  gpuAccel: z.boolean().optional(),
});
export type BrowserVitals = z.infer<typeof BrowserVitals>;

/** A single cheap sample of the host's health, taken by the agent at heartbeat time. */
export const MachineVitals = z.object({
  /** When the box took this sample (ISO, the box's own clock). */
  at: z.string().optional(),
  /** Whole-host CPU busy %, 0–100, averaged over the interval since the previous sample. */
  cpuPercent: z.number().min(0).max(100).optional(),
  cores: z.number().int().positive().optional(),
  /** 1/5/15-minute load averages. */
  loadavg: z.array(z.number().nonnegative()).length(3).optional(),
  memUsedBytes: z.number().nonnegative().optional(),
  memTotalBytes: z.number().nonnegative().optional(),
  memPercent: z.number().min(0).max(100).optional(),
  /** The root filesystem — on a netbooted box that is the RAM-backed image (tmpfs/overlay), so a
   *  full "disk" means a full box. */
  diskUsedBytes: z.number().nonnegative().optional(),
  diskTotalBytes: z.number().nonnegative().optional(),
  diskPercent: z.number().min(0).max(100).optional(),
  /** Hottest thermal zone, °C. Absent on hosts that expose none (VMs, most laptops-as-servers). */
  tempC: z.number().optional(),
  uptimeSec: z.number().nonnegative().optional(),
  /** The live image this box is RUNNING (`/etc/polyptic/image-id`), which is how an operator learns
   *  a box never took the last roll-out. */
  imageId: z.string().optional(),
  /** Per-output browser health (RSS, respawns, and the GPU tell). */
  browsers: z.array(BrowserVitals).optional(),
});
export type MachineVitals = z.infer<typeof MachineVitals>;

export const AgentStatus = z.object({
  t: z.literal("agent/status"),
  machineId: z.string(),
  observedRevision: z.number().int().nonnegative(),
  screens: z.array(
    z.object({
      connector: z.string(),
      ok: z.boolean(),
      note: z.string().optional(),
      /** POL-119 — a cast (AirPlay) session is live on this connector right now: the supervised
       *  receiver owns at least one visible window (the mirror itself, or its PIN prompt). Level-
       *  reported here (heartbeat + immediate status on change) so it self-heals across reconnects
       *  instead of needing an edge-triggered ack that a dropped frame would strand. Optional =
       *  back-compat with agents that predate casting. */
      casting: z.boolean().optional(),
      /** POL-136 — the PIN a sender must type RIGHT NOW to pair with this connector's receiver.
       *  The receiver prints its per-pairing PIN to stdout only (it never draws a window at pairing
       *  time — the D111 premise this corrects), so the agent, which owns that stdout, learns it and
       *  level-reports it here for the server to surface on the panel via the player overlay.
       *  Present only while a pairing is in progress; absent = no pairing (or a pre-POL-136 agent).
       *  Digits only (UxPlay pins are 4-digit, zero-padded — "0000" is a valid pin). */
      castPin: z.string().regex(/^\d{1,8}$/).optional(),
    }),
  ),
  /** POL-92 — host vitals, sampled each heartbeat. Optional: an older agent (or a backend with no
   *  /proc to read) sends a status frame without it, and it still parses. */
  vitals: MachineVitals.optional(),
});

export const AgentThumbnail = z.object({
  t: z.literal("agent/thumbnail"),
  machineId: z.string(),
  connector: z.string(),
  mime: z.string(), // "image/jpeg"
  dataBase64: z.string(),
});

/** POL-55 — the agent's answer to `server/reboot`, sent BEFORE it triggers the reboot (the socket
 *  dies moments later). `accepted: false` means the agent declined and the box stays up: a dev
 *  backend, a non-Linux host, or no way to reach the privileged reboot helper. */
export const AgentRebootAck = z.object({
  t: z.literal("agent/reboot-ack"),
  machineId: z.string(),
  accepted: z.boolean(),
  /** Why the agent declined, when `accepted` is false. */
  reason: z.string().optional(),
});

// ── Remote shell (POL-59) ─────────────────────────────────────────────────────
//
// An operator-initiated, UNPRIVILEGED PTY on a running box, tunnelled over the agent's EXISTING
// outbound WS. A kiosk box sits behind NAT and dials out (D12), so there is nothing to SSH *into*;
// relaying a terminal over the channel we already authenticate reuses the whole trust model and
// adds no inbound surface, no sshd, and no second key system.
//
// The shell is DISARMED by default and armed per box by an operator (`Machine.shellEnabled`), runs
// as the unprivileged kiosk user, and cannot change what the wall displays. Bytes are base64 so a
// PTY's raw output (which is not valid UTF-8 mid-sequence) survives a JSON frame intact.

/** One shell session, scoped to one machine. Minted by the server when an operator opens a terminal. */
export const ShellSessionId = z.string().min(1).max(64);

/** Agent → server: the PTY started (or refused to). `ok: false` carries the reason for the operator. */
export const AgentShellOpened = z.object({
  t: z.literal("agent/shell-opened"),
  machineId: z.string(),
  sessionId: ShellSessionId,
  ok: z.boolean(),
  /** Why the agent declined: not armed, no PTY available, wrong backend, spawn failure. */
  reason: z.string().optional(),
});

/** Agent → server: a chunk of PTY output (stdout+stderr, base64). */
export const AgentShellData = z.object({
  t: z.literal("agent/shell-data"),
  machineId: z.string(),
  sessionId: ShellSessionId,
  dataBase64: z.string(),
});

/** Agent → server: the PTY exited; the session is over and must not be reused. */
export const AgentShellClosed = z.object({
  t: z.literal("agent/shell-closed"),
  machineId: z.string(),
  sessionId: ShellSessionId,
  /** Process exit code, when the shell exited normally. */
  exitCode: z.number().int().optional(),
  reason: z.string().optional(),
});

/** POL-50 — the agent's answer to `server/inspect`: whether the wall's Web Inspector is now open.
 *  This ack, not the operator's click, is what the console displays — only the box knows whether
 *  surf relaunched and took the keystroke. `ok: false` means the screen is un-inspected and carries
 *  why (nothing placed on that output, no `xdotool`, or a backend that owns no browser). */
export const AgentInspectAck = z.object({
  t: z.literal("agent/inspect-ack"),
  machineId: z.string(),
  connector: z.string(),
  /** The inspector state the agent actually reached (false on any failure). */
  on: z.boolean(),
  ok: z.boolean(),
  /** Why the agent could not honour the request, when `ok` is false. */
  reason: z.string().optional(),
});

// ── Remote DevTools tunnel (POL-67) ──────────────────────────────────────────
//
// Chrome on the box listens on a LOOPBACK-ONLY `--remote-debugging-port`; these frames tunnel its
// DevTools protocol (plain HTTP for the frontend files + target list, a WebSocket for CDP) over the
// agent's existing outbound WS — the POL-59 shell-relay pattern, because the trust model is the
// same: the port is code-exec-adjacent, so it is never exposed on the network, and the server only
// relays for a screen an operator has ARMED (`server/inspect on` → the agent's ack). Bodies and CDP
// frames ride base64 so bytes survive JSON.

export const DevtoolsSessionId = z.string().min(1).max(64);
/** A path on the box's DevTools HTTP server, e.g. "/json/list" or "/devtools/inspector.html?…". */
export const DevtoolsPath = z.string().min(1).max(4096).startsWith("/");

/** Agent → server: the answer to one `server/devtools-request` (one proxied HTTP GET). */
export const AgentDevtoolsResponse = z.object({
  t: z.literal("agent/devtools-response"),
  machineId: z.string(),
  reqId: z.string().min(1).max(64),
  ok: z.boolean(),
  /** HTTP status from Chrome (ok only). */
  status: z.number().int().optional(),
  contentType: z.string().optional(),
  bodyBase64: z.string().optional(),
  /** Why the box refused / failed: DevTools not armed, wrong browser, Chrome unreachable. */
  error: z.string().optional(),
});

/** Agent → server: the CDP WebSocket to Chrome connected (or refused). */
export const AgentDevtoolsOpened = z.object({
  t: z.literal("agent/devtools-opened"),
  machineId: z.string(),
  sessionId: DevtoolsSessionId,
  ok: z.boolean(),
  reason: z.string().optional(),
});

/** Agent → server: one CDP frame from Chrome (base64 of the text frame). */
export const AgentDevtoolsData = z.object({
  t: z.literal("agent/devtools-data"),
  machineId: z.string(),
  sessionId: DevtoolsSessionId,
  dataBase64: z.string(),
});

/** Agent → server: the CDP socket to Chrome closed; the session is over. */
export const AgentDevtoolsClosed = z.object({
  t: z.literal("agent/devtools-closed"),
  machineId: z.string(),
  sessionId: DevtoolsSessionId,
  reason: z.string().optional(),
});

export const AgentMessage = z.discriminatedUnion("t", [
  AgentHello,
  AgentStatus,
  AgentThumbnail,
  AgentRebootAck,
  AgentShellOpened,
  AgentShellData,
  AgentShellClosed,
  AgentInspectAck,
  AgentDevtoolsResponse,
  AgentDevtoolsOpened,
  AgentDevtoolsData,
  AgentDevtoolsClosed,
]);
export type AgentMessage = z.infer<typeof AgentMessage>;

export const ServerToAgentApply = z.object({
  t: z.literal("server/apply"),
  revision: z.number().int().nonnegative(),
  machineId: z.string(),
  /** For each output: which screen it is and the URL to point a player at. */
  screens: z.array(
    z.object({
      connector: z.string(),
      screenId: z.string(),
      playerUrl: z.string().url(),
      /** POL-119 — run a cast (AirPlay) receiver for this connector. Rides the apply payload — not a
       *  session frame — because it is desired STATE: an agent that restarts or reconnects must
       *  re-reach it from the next apply alone. Optional = back-compat with older servers. */
      castEnabled: z.boolean().optional(),
      /** POL-119 — the screen's friendly name, stamped at send time like the player render's: the
       *  receiver advertises it on mDNS, so the Screen Mirroring menu shows "Boardroom Left", not a
       *  connector id. A rename re-applies and restarts that receiver (brief advertisement blip). */
      friendlyName: z.string().optional(),
    }),
  ),
});

export const ServerToAgentIdent = z.object({
  t: z.literal("server/ident"),
  on: z.boolean(),
});

export const ServerToAgentCapture = z.object({
  t: z.literal("server/capture"),
  connector: z.string().optional(), // omit = all outputs
});

/**
 * POL-55 — reboot this machine now, on an operator's say-so. The fleet-wide image roll-out already
 * reboots stale boxes (each box polls the manifest and reboots itself); this is the other direction:
 * the control plane pushing a reboot at ONE named machine, for the box that has wedged itself.
 *
 * The agent is unprivileged, so it does not call `reboot` — it asks a root-owned systemd helper to
 * (see the agent's ./host.ts). It answers `agent/reboot-ack` first, then triggers; a machine that
 * cannot reboot (dev backend, non-Linux, no helper) declines and stays up.
 */
export const ServerToAgentReboot = z.object({
  t: z.literal("server/reboot"),
  /** Advisory, logged on the box (e.g. "requested by an operator from the console"). */
  reason: z.string().optional(),
});

/**
 * POL-50 / POL-67 — enable/disable inspection of the page on the panel driven by `connector`. What
 * that MEANS depends on the box's kiosk browser (see `Machine.browser`):
 *
 *   - chrome (POL-67): ARM/DISARM the remote DevTools tunnel for this connector. Nothing changes on
 *     the glass and nothing reloads; the agent simply starts honouring `server/devtools-*` frames
 *     for this output, and the operator drives Chrome DevTools from their own browser.
 *   - surf (D63): show/hide the Web Inspector ON the panel. WebKitGTK exposes no tunnel-able remote
 *     inspector, and surf takes `-N` only at launch, so honouring this RELAUNCHES that output's
 *     browser (the page reloads) and someone at the screen reads the console/network.
 *
 * Either way the agent answers `agent/inspect-ack`, and that ack — never the operator's click — is
 * what drives `ScreenView.inspecting`.
 */
export const ServerToAgentInspect = z.object({
  t: z.literal("server/inspect"),
  /** Which output to pop the inspector on. */
  connector: z.string(),
  on: z.boolean(),
});

/**
 * POL-25 — the mTLS client-certificate bundle issued at enrolment. The agent persists it (0600) and
 * presents `certPem` on every subsequent `wss://` dial to the server's dedicated mTLS listener, where
 * a wrong/absent/expired cert fails the TLS HANDSHAKE — rejected before any app-layer code runs.
 * `caPem` is the deployment's own agent CA, which the agent pins as the ONLY trusted issuer for that
 * listener (no public PKI involved). The private key stays on the box: it was generated there and
 * only its CSR crossed the wire (see `AgentHello.csrPem`).
 */
export const MtlsBundle = z.object({
  /** The deployment's agent CA (PEM) — the agent pins this as the mTLS listener's only trust root. */
  caPem: z.string(),
  /** This machine's signed client certificate (PEM), CN = machineId, issued by `caPem`. */
  certPem: z.string(),
  /** The mTLS listener's port. The agent dials the SAME HOST it already knows, on this port. */
  port: z.number().int().positive(),
  /** Full wss:// URL override (`AGENT_MTLS_PUBLIC_URL`) for deployments where the mTLS endpoint is
   *  not simply same-host-different-port (e.g. a separate LoadBalancer in Kubernetes). */
  url: z.string().optional(),
});
export type MtlsBundle = z.infer<typeof MtlsBundle>;

/** Issued after a valid first-contact enrollment: the durable credential the agent persists and
 * presents on every reconnect (instead of the bootstrap token). `status` tells the agent whether
 * it still needs operator approval.
 *
 * POL-25 — `credential` became OPTIONAL: in OPEN mode with mTLS enabled the frame carries only the
 * `mtls` cert bundle (open mode never had app credentials). A gated enrolment always includes it. */
export const ServerToAgentEnrolled = z.object({
  t: z.literal("server/enrolled"),
  machineId: z.string(),
  credential: z.string().optional(),
  status: EnrollmentStatus,
  /** POL-25 — present when the server signed this hello's `csrPem`: the client-cert bundle the agent
   *  persists and reconnects with over the mTLS listener. */
  mtls: MtlsBundle.optional(),
});

/** The machine is recognised but still awaiting operator approval — keep the connection open; no
 * screens are admitted yet. The agent receives `server/apply` once approved. */
export const ServerToAgentPending = z.object({
  t: z.literal("server/pending"),
  reason: z.string().optional(),
  /** The machine's id, so the pending board can show the operator what to approve. */
  machineId: z.string().optional(),
  /** POL-46 — a player page to show fullscreen on every output WHILE pending, instead of leaving the
   *  wall black. Optional: an older agent simply ignores it, and a server that cannot resolve a
   *  player base omits it.
   *
   *  POL-117 — pre-approval ident rides THIS frame, deliberately: a pending box holds no screens, so
   *  there is no player WS to pulse, and the trust model wants nothing new reachable pre-approval.
   *  The server re-sends `server/pending` with `&ident=1` appended to the URL (and again without it
   *  to clear); the agent's existing "re-place when the URL changed" handling swaps the board, and
   *  the pending page renders its flash overlay. No new frame, no new agent code, old agents included. */
  pendingUrl: z.string().optional(),
});

/** Authentication failed (bad/absent token or credential, or the machine was rejected). The server
 * closes the connection after this frame. */
export const ServerToAgentRejected = z.object({
  t: z.literal("server/rejected"),
  reason: z.string(),
});

/** Server → agent: start a PTY for this session. The agent REFUSES unless the box is armed. */
export const ServerToAgentShellOpen = z.object({
  t: z.literal("server/shell-open"),
  sessionId: ShellSessionId,
  /** Initial terminal size; a PTY with a wrong size makes `top` and editors unusable. */
  cols: z.number().int().positive().max(1000).default(80),
  rows: z.number().int().positive().max(1000).default(24),
});

/** Server → agent: operator keystrokes (base64, so control bytes survive JSON). */
export const ServerToAgentShellData = z.object({
  t: z.literal("server/shell-data"),
  sessionId: ShellSessionId,
  dataBase64: z.string(),
});

/** Server → agent: the operator's terminal was resized; SIGWINCH the PTY. */
export const ServerToAgentShellResize = z.object({
  t: z.literal("server/shell-resize"),
  sessionId: ShellSessionId,
  cols: z.number().int().positive().max(1000),
  rows: z.number().int().positive().max(1000),
});

/** Server → agent: tear the PTY down (operator closed the terminal, disarmed the box, or dropped). */
export const ServerToAgentShellClose = z.object({
  t: z.literal("server/shell-close"),
  sessionId: ShellSessionId,
  reason: z.string().optional(),
});

/** Server → agent: proxy ONE HTTP GET to the armed connector's DevTools port (POL-67). The agent
 *  answers `agent/devtools-response` with the same `reqId`, and REFUSES unless that connector's
 *  DevTools are armed (`server/inspect on`) — defense in depth under the server's own gate. */
export const ServerToAgentDevtoolsRequest = z.object({
  t: z.literal("server/devtools-request"),
  reqId: z.string().min(1).max(64),
  connector: z.string(),
  path: DevtoolsPath,
});

/** Server → agent: open a CDP WebSocket to the armed connector's DevTools port. */
export const ServerToAgentDevtoolsOpen = z.object({
  t: z.literal("server/devtools-open"),
  sessionId: DevtoolsSessionId,
  connector: z.string(),
  path: DevtoolsPath,
});

/** Server → agent: one CDP frame from the operator's DevTools frontend (base64 of the text frame). */
export const ServerToAgentDevtoolsData = z.object({
  t: z.literal("server/devtools-data"),
  sessionId: DevtoolsSessionId,
  dataBase64: z.string(),
});

/** Server → agent: tear the CDP socket down (tab closed, screen disarmed, operator dropped). */
export const ServerToAgentDevtoolsClose = z.object({
  t: z.literal("server/devtools-close"),
  sessionId: DevtoolsSessionId,
  reason: z.string().optional(),
});

export const ServerToAgentMessage = z.discriminatedUnion("t", [
  ServerToAgentApply,
  ServerToAgentIdent,
  ServerToAgentCapture,
  ServerToAgentReboot,
  ServerToAgentInspect,
  ServerToAgentEnrolled,
  ServerToAgentPending,
  ServerToAgentRejected,
  ServerToAgentShellOpen,
  ServerToAgentShellData,
  ServerToAgentShellResize,
  ServerToAgentShellClose,
  ServerToAgentDevtoolsRequest,
  ServerToAgentDevtoolsOpen,
  ServerToAgentDevtoolsData,
  ServerToAgentDevtoolsClose,
]);
export type ServerToAgentMessage = z.infer<typeof ServerToAgentMessage>;

// ─────────────────────────────────────────────────────────────────────────────
// Player channel  (screen ↔ server) — the instant content path
// ─────────────────────────────────────────────────────────────────────────────

export const PlayerHello = z.object({
  t: z.literal("player/hello"),
  protocol: z.literal(PROTOCOL_VERSION),
  screenId: z.string(),
  /** POL-54 — the screen's player token. The server mints it into the `?token=` of every playerUrl it
   *  hands an agent (`server/apply`), the player echoes it here, and the /player channel REJECTS a
   *  hello without a valid one whenever auth is enabled — so "anyone who can reach the server" can no
   *  longer subscribe to any screen's slice (which carries stamped credential URLs, POL-24). Optional
   *  on the wire: a dev deployment with AUTH_ENABLED=false stays open, exactly like /admin and REST. */
  token: z.string().min(1).max(200).optional(),
});

export const PlayerAck = z.object({
  t: z.literal("player/ack"),
  screenId: z.string(),
  revision: z.number().int().nonnegative(),
});

/** POL-86: a timestamped debug line from the player — the box's own account of what happened on the
 *  glass (probe failures, aborted loads, heal actions). The server writes these to its log, so a
 *  broken boot is diagnosable from `kubectl logs` alone: no SSH, no DevTools, and no racing to read
 *  a console that a refresh wipes. The player rate-caps itself and replays the tail of a previous
 *  page-life on boot (from localStorage), because the evidence of a failed load used to be DESTROYED
 *  by the very refresh that fixed it. */
export const PlayerDiag = z.object({
  t: z.literal("player/diag"),
  screenId: z.string(),
  /** Player-side ISO-8601 timestamp — preserves true ordering even for replayed lines. */
  at: z.string().max(40),
  msg: z.string().max(500),
});
export type PlayerDiag = z.infer<typeof PlayerDiag>;

export const PlayerMessage = z.discriminatedUnion("t", [PlayerHello, PlayerAck, PlayerDiag]);
export type PlayerMessage = z.infer<typeof PlayerMessage>;

/** Pushed whenever this screen's slice changes. The player applies it via DOM diff — no reload. */
export const ServerToPlayerRender = z.object({
  t: z.literal("server/render"),
  revision: z.number().int().nonnegative(),
  /** The screen's current friendly name, stamped from the registry at send time (NOT part of the
   *  stored slice — see ControlPlane.renameScreen). The player labels its idle splash / dev badge
   *  with this so a console rename shows through live, instead of the raw `screen-N` id (POL-29). */
  friendlyName: z.string(),
  /** POL-119 — this screen is cast-enabled (AirPlay receiver armed). Stamped at send time like
   *  `friendlyName`; the player's status badge shows a cast glyph when badges are on, so someone at
   *  the glass can tell which panels accept Screen Mirroring. Optional = back-compat. */
  castEnabled: z.boolean().optional(),
  slice: ScreenSlice,
});

/** Ident overlay: flash the screen's friendly name so an operator can map physical panels. */
export const ServerToPlayerIdent = z.object({
  t: z.literal("server/ident-pulse"),
  on: z.boolean(),
  friendlyName: z.string(),
  color: z.string().default("#00c2ff"),
});

/** Fleet-wide, operator-toggleable display settings pushed to every player (POL-6). Structured as an
 *  object so future on-screen overlay flags slot in without a new message. Sent to a player right after
 *  its first `server/render` (on hello) and re-broadcast to ALL players whenever an operator flips it. */
export const DisplaySettings = z.object({
  /** Show the player status badge (`live · screen-N · rev`) and any passive dev overlays on every
   *  screen. Default is decided SERVER-side — prod off, dev on — so it is a runtime setting, not a
   *  build-time flag; an operator can override the default in either direction from the console. */
  showBadges: z.boolean(),
});
export type DisplaySettings = z.infer<typeof DisplaySettings>;

/** Push the current fleet-wide display settings to a player (badge visibility, …). */
export const ServerToPlayerSettings = z.object({
  t: z.literal("server/settings"),
  settings: DisplaySettings,
});

/** POL-136 — AirPlay pairing PIN overlay: show (or clear, with null) the PIN a sender must type on
 *  the phone right now. Ephemeral like `server/ident-pulse` — never part of the stored slice — and
 *  replayed to a player that (re)connects mid-pairing, straight after its first render. The player
 *  draws it fullscreen and big: at pairing time no receiver window exists on the box (the receiver
 *  only opens one once mirroring starts), so the player IS what's on the glass. */
export const ServerToPlayerCastPin = z.object({
  t: z.literal("server/cast-pin"),
  /** Digits only, zero-padding preserved ("0000" is a valid pin); null clears the overlay. */
  pin: z.string().regex(/^\d{1,8}$/).nullable(),
});

export const ServerToPlayerMessage = z.discriminatedUnion("t", [
  ServerToPlayerRender,
  ServerToPlayerIdent,
  ServerToPlayerSettings,
  ServerToPlayerCastPin,
]);
export type ServerToPlayerMessage = z.infer<typeof ServerToPlayerMessage>;

// ─────────────────────────────────────────────────────────────────────────────
// Admin channel  (admin UI ↔ server) — registry views + live status
// ─────────────────────────────────────────────────────────────────────────────

export const ConnectionState = z.enum(["online", "offline"]);
export type ConnectionState = z.infer<typeof ConnectionState>;

/** A screen plus its live status, denormalized for the admin UI. */
export const ScreenView = Screen.extend({
  online: z.boolean(), // is a player currently connected for this screen?
  revision: z.number().int().nonnegative(), // last revision this screen's player observed
  surfaceCount: z.number().int().nonnegative(),
  /** What's on the screen now — a library source's name+kind, an ad-hoc URL's derived name, or null.
   *  Lets the console tiles + inspector show the actual content, not just a surface count. */
  content: z
    .object({
      name: z.string(),
      // Mirrors ContentKind (declared below); inlined because this schema evaluates first.
      kind: z.enum(["web", "dashboard", "image", "video", "playlist", "page"]),
      /** POL-57 — the page zoom currently applied, present only for framed (web/dashboard) content.
       *  Absent for media, which has no zoom, so the console knows when to offer the control. */
      zoom: Zoom.optional(),
      /** POL-133 — present only for playlist content: the live rotation's steps, in order, each with
       *  its display name and (for framed steps only) the zoom currently applied on THIS screen. The
       *  console renders one per-step zoom control from exactly this — the same presence-is-the-
       *  question pattern as `zoom` above. */
      entries: z
        .array(
          z.object({
            sourceId: z.string().optional(),
            name: z.string(),
            kind: PlaylistEntryKind,
            zoom: Zoom.optional(),
          }),
        )
        .optional(),
    })
    .nullable()
    .optional(),
  /** POL-50 — is the kiosk browser's Web Inspector currently open ON this panel? Ephemeral (never
   *  persisted, cleared when the machine drops) and set only from the agent's `agent/inspect-ack`,
   *  so the console reflects the wall rather than the last click. Optional = back-compat. */
  inspecting: z.boolean().optional(),
  /** POL-50 — why the box last refused to show its inspector (no `xdotool`, nothing placed on that
   *  output, a backend that owns no browser). Ephemeral: cleared when a new request is delivered, on
   *  success, and when the machine drops. A refusal leaves `inspecting` false, i.e. UNCHANGED, so
   *  without this the console cannot tell "the wall said no" from "the wall hasn't answered yet". */
  inspectError: z.string().optional(),
  /** POL-119 — a cast (AirPlay) session is live on this panel NOW: the box's receiver owns a visible
   *  window (mirror or PIN prompt). Ephemeral, agent-reported via `agent/status.screens[].casting`,
   *  cleared when the machine drops. Optional = back-compat. (`castEnabled` — the persistent operator
   *  toggle — is inherited from `Screen`.) */
  castActive: z.boolean().optional(),
});
export type ScreenView = z.infer<typeof ScreenView>;

/** A machine plus its screens and live status, denormalized for the admin UI. */
export const MachineView = z.object({
  id: z.string(),
  label: z.string(),
  agentVersion: z.string().optional(),
  backend: DisplayBackend.optional(),
  /** POL-67 — the box's kiosk browser: `chrome` = the console's Inspect action opens REMOTE
   *  DevTools; `surf` (or absent, e.g. an older agent) = the on-panel inspector (POL-50). */
  browser: KioskBrowser.optional(),
  online: z.boolean(), // is the agent's WS currently connected?
  status: EnrollmentStatus, // pending machines await operator approval
  /** POL-103 — the machine's operator tags; the console renders them as chips and filters on them. */
  tags: MachineTags.default([]),
  outputCount: z.number().int().nonnegative(), // outputs the agent reported (shown for pending machines with no screens yet)
  lastSeen: z.string().datetime().optional(),
  /** POL-59 — operator has armed this box for a remote shell (drives the Machines-view terminal). */
  shellEnabled: z.boolean().default(false),
  /** POL-68 — an operator-requested reboot is in flight: the box accepted `server/reboot` and has
   *  not reconnected yet. Live-only (never persisted) and bounded server-side, so a box that dies
   *  mid-reboot doesn't read "rebooting…" forever. Optional = back-compat. */
  rebooting: z.boolean().optional(),
  /** POL-59 — when the arming was set / last refreshed (for the "auto-disarms in N min" hint). */
  shellArmedAt: z.string().datetime().optional(),
  /** POL-92 — the machine's LATEST host vitals sample (the head of the server's per-machine ring).
   *  Absent while the box is offline, before its first heartbeat, or when it runs an agent/backend
   *  that samples nothing — the console then says so rather than drawing empty meters. */
  vitals: MachineVitals.optional(),
  /** POL-104 — what the box IS: MACs, chassis serial, arch. Persisted from `agent/hello`, so a card
   *  still shows it while the box is OFFLINE (an operator commissioning a rack needs to tell one
   *  pending UUID from another, and the boxes come and go). Absent for a pre-POL-104 agent. */
  hardware: HostIdentity.optional(),
  /** POL-104 — the address the agent's socket is coming from, RIGHT NOW. Live-only (a stale IP is a
   *  lie), so it is present only while the machine is online. */
  ip: z.string().optional(),
  /** POL-104 — the enrolment token this machine first enrolled on: which stick/batch it came in on.
   *  `name` is a snapshot taken at enrolment, so a deleted token still reads sensibly. */
  enrolledVia: z
    .object({ tokenId: z.string(), name: z.string(), revoked: z.boolean().default(false) })
    .optional(),
  /** POL-104 — this machine matched a pre-registration and was named/approved from it. */
  preRegistered: z.boolean().optional(),
  /** POL-134 — which agent channel this machine's LIVE session arrived on. Present only while
   *  online; `mtls` means the box completed the client-cert handshake for its current session. */
  agentChannel: z.enum(["plain", "mtls"]).optional(),
  /** POL-134 — per-machine cert state for the Settings card (mirrors `Machine`). */
  mtlsCertIssuedAt: z.string().datetime().optional(),
  mtlsSeenAt: z.string().datetime().optional(),
  screens: z.array(ScreenView),
});
export type MachineView = z.infer<typeof MachineView>;

// ─────────────────────────────────────────────────────────────────────────────
// Murals & placement (Phase 3) — the spatial canvas model
// ─────────────────────────────────────────────────────────────────────────────

/** A named, switchable canvas. A deployment has several murals; screens are placed onto one. */
export const Mural = z.object({
  id: z.string(),
  name: z.string(),
});
export type Mural = z.infer<typeof Mural>;

/** A screen placed on a mural at a position/size in canvas pixels (default size = the screen's
 *  native resolution). A screen with NO placement is "unplaced" (lives in the tray). A screen is
 *  placed on at most one mural at a time. */
export const Placement = z.object({
  muralId: z.string(),
  screenId: z.string(),
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
});
export type Placement = z.infer<typeof Placement>;

/** A "combined surface" (video wall): adjacent placed screens combined so one piece of content
 *  spans across all of them. The combined geometry is the union of the members' placements; each
 *  member shows its slice (see Surface.span). Split returns them to individual screens. */
export const VideoWall = z.object({
  id: z.string(),
  muralId: z.string(),
  memberScreenIds: z.array(z.string()).min(2),
  /** Operator-given name (e.g. "Atrium Wall"). Optional for back-compat with walls stored before
   *  naming existed; the console falls back to a member-derived label when absent. */
  name: z.string().min(1).max(80).optional(),
});
export type VideoWall = z.infer<typeof VideoWall>;

/** The kind of a content source — mirrors the renderable Surface types. `playlist` (POL-34) is the
 *  composite kind: a carousel over the other renderables. `page` (POL-42) is an authored composition
 *  created in the console's Studio; it has a `definition`, not a `url`. */
export const ContentKind = z.enum(["web", "dashboard", "image", "video", "playlist", "page"]);
export type ContentKind = z.infer<typeof ContentKind>;

/** One AUTHORED step of a playlist source (POL-34): a reference to another library source plus how
 *  long it holds the screen. `durationSeconds` is REQUIRED for content that never ends by itself
 *  (web/dashboard/image — the server rejects an untimed static) and OPTIONAL for video, where absence
 *  means "advance when the video ends". Playlists cannot nest. */
export const PlaylistItem = z.object({
  sourceId: z.string(),
  durationSeconds: z.number().int().min(1).max(86400).optional(),
});
export type PlaylistItem = z.infer<typeof PlaylistItem>;

// ── Credential profiles (POL-24) ─────────────────────────────────────────────
// Bucket-A content auth (D11/D17), first real strategy through the seam: a CREDENTIAL PROFILE is a
// centrally-managed OAuth client (id + secret + token endpoint at the operator's IdP). The server
// exchanges it for short-lived JWT access tokens via the client-credentials grant and stamps the
// current token into content URLs at SEND time (`?{tokenParam}=<jwt>` — Grafana `url_login` style),
// so an unattended screen always loads already-authenticated. Many sources share one profile.

/** The auth strategy a profile implements. One value today; the enum IS the D11 seam. */
export const CredentialStrategy = z.enum(["oauth-client-credentials"]);
export type CredentialStrategy = z.infer<typeof CredentialStrategy>;

/** A credential profile as configured. The client SECRET is intentionally NOT part of this shape —
 *  it is write-only (accepted on create/update, held server-side, never broadcast or returned). */
export const CredentialProfile = z.object({
  id: z.string(),
  name: z.string().min(1).max(120),
  strategy: CredentialStrategy,
  /** The IdP's OAuth token endpoint, e.g. https://idp/realms/x/protocol/openid-connect/token. */
  tokenEndpoint: z.string().url(),
  clientId: z.string().min(1).max(200),
  /** Optional `scope` sent with the grant (Entra requires "api://…/.default"). */
  scope: z.string().min(1).max(500).optional(),
  /** Optional `audience` param for IdPs that take one (Auth0 etc.). */
  audience: z.string().min(1).max(500).optional(),
  /** Query parameter the token is delivered in at send time (Grafana [auth.jwt] url_login default). */
  tokenParam: z.string().min(1).max(64).default("auth_token"),
});
export type CredentialProfile = z.infer<typeof CredentialProfile>;

export const CredentialTokenStatus = z.enum(["ok", "pending", "error"]);
export type CredentialTokenStatus = z.infer<typeof CredentialTokenStatus>;

/** A profile plus its live token health, denormalized for the console (never any secret). */
export const CredentialProfileView = CredentialProfile.extend({
  tokenStatus: CredentialTokenStatus,
  /** When the currently-cached token expires (absent while pending/error). */
  tokenExpiresAt: z.string().datetime().optional(),
  /** The IdP's last error, verbatim, when tokenStatus is "error". */
  lastError: z.string().optional(),
  /** How many content sources reference this profile (drives the delete guard + console copy). */
  inUseBy: z.number().int().nonnegative(),
});
export type CredentialProfileView = z.infer<typeof CredentialProfileView>;

/** A reusable, named entry in the content LIBRARY. A screen or video wall is assigned a source by id;
 *  the server resolves it to the surface(s) it renders. 3c carries linkable URLs; Phase 7 adds uploaded
 *  media served from a disk volume (an upload becomes a source whose url points at the media route).
 *  POL-34 adds the `playlist` kind: it has NO url — its content is `items`, an ordered carousel over
 *  other (non-playlist) sources; `items` may be EMPTY on a stored playlist (deleting a referenced
 *  source strips it out). POL-42 adds the `page` kind: also url-less — its content is `definition`,
 *  the Studio's saved composition. */
export const ContentSource = z
  .object({
    id: z.string(),
    name: z.string().min(1).max(120),
    kind: ContentKind,
    url: z.string().url().optional(),
    /** POL-24 — the credential profile whose token is stamped into this source's URL at send time.
     *  null/undefined = unauthenticated. Meaningful for web/dashboard kinds. */
    credentialProfileId: z.string().nullable().optional(),
    /** POL-34 — playlist kind only: the authored carousel steps, in order. */
    items: z.array(PlaylistItem).optional(),
    /** POL-42 — page kind only: the Studio's saved composition. */
    definition: PageDefinition.optional(),
  })
  .superRefine((s, ctx) => {
    if (s.kind === "playlist") {
      if (s.url !== undefined) ctx.addIssue({ code: "custom", message: "a playlist has no url" });
      if (s.items === undefined) ctx.addIssue({ code: "custom", message: "a playlist needs items" });
    } else if (s.kind === "page") {
      if (s.url !== undefined) ctx.addIssue({ code: "custom", message: "a page has no url" });
      if (s.definition === undefined)
        ctx.addIssue({ code: "custom", message: "a page needs a definition" });
    } else {
      if (s.url === undefined) ctx.addIssue({ code: "custom", message: "url is required" });
    }
    if (s.kind !== "playlist" && s.items !== undefined)
      ctx.addIssue({ code: "custom", message: "items are only valid on a playlist" });
    if (s.kind !== "page" && s.definition !== undefined)
      ctx.addIssue({ code: "custom", message: "a definition is only valid on a page" });
  });
export type ContentSource = z.infer<typeof ContentSource>;

// ── Scenes (Phase 3d) ────────────────────────────────────────────────────────
// A Scene is a named SNAPSHOT of a mural's whole wall — its layout (placements), grouping (video
// walls) and content (per screen + per wall) — re-appliable in one click. Content is captured as the
// assignment (a library sourceId or an ad-hoc url), so applying re-resolves a source to its CURRENT url.

/** A content assignment captured in a scene: a library source, an ad-hoc url, or nothing (null). */
export const SceneContent = z
  .object({ sourceId: z.string().optional(), url: z.string().url().optional() })
  .nullable();
export type SceneContent = z.infer<typeof SceneContent>;

export const ScenePlacement = z.object({
  screenId: z.string(),
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
});

export const SceneWall = z.object({
  memberScreenIds: z.array(z.string()).min(2),
  content: SceneContent,
});

export const SceneScreen = z.object({
  screenId: z.string(),
  content: SceneContent,
});

export const Scene = z.object({
  id: z.string(),
  name: z.string().min(1).max(120),
  muralId: z.string(),
  placements: z.array(ScenePlacement), // layout
  walls: z.array(SceneWall), // grouping + each wall's content
  screens: z.array(SceneScreen), // content for placed, non-walled screens
  // A scene carries NO time of its own (POL-89/D93 dropped D24's illustrative `scheduleAt`): WHEN a
  // scene plays is a `Schedule` — a scene bound to a daypart on a recurrence, at a priority.
});
export type Scene = z.infer<typeof Scene>;

export const AdminHello = z.object({
  t: z.literal("admin/hello"),
  protocol: z.literal(PROTOCOL_VERSION),
});
// ── Remote shell, operator half (POL-59) ─────────────────────────────────────
// The console opens/feeds/closes a terminal over the SAME authenticated /admin socket it already
// uses for state. The server relays to the machine's agent socket and back; it never interprets
// the bytes. `machineId` is on every frame: the relay is scoped to one box, never broadcast.

export const AdminShellOpen = z.object({
  t: z.literal("admin/shell-open"),
  machineId: z.string(),
  cols: z.number().int().positive().max(1000).default(80),
  rows: z.number().int().positive().max(1000).default(24),
});

export const AdminShellData = z.object({
  t: z.literal("admin/shell-data"),
  machineId: z.string(),
  sessionId: ShellSessionId,
  dataBase64: z.string(),
});

export const AdminShellResize = z.object({
  t: z.literal("admin/shell-resize"),
  machineId: z.string(),
  sessionId: ShellSessionId,
  cols: z.number().int().positive().max(1000),
  rows: z.number().int().positive().max(1000),
});

export const AdminShellClose = z.object({
  t: z.literal("admin/shell-close"),
  machineId: z.string(),
  sessionId: ShellSessionId,
});

export const AdminMessage = z.discriminatedUnion("t", [
  AdminHello,
  AdminShellOpen,
  AdminShellData,
  AdminShellResize,
  AdminShellClose,
]);
export type AdminMessage = z.infer<typeof AdminMessage>;

/** Server → admin: the session the operator asked for is live (or was refused). */
export const ServerToAdminShellOpened = z.object({
  t: z.literal("server/shell-opened"),
  machineId: z.string(),
  sessionId: ShellSessionId,
  ok: z.boolean(),
  reason: z.string().optional(),
});

/** Server → admin: PTY output, relayed verbatim from the box. */
export const ServerToAdminShellData = z.object({
  t: z.literal("server/shell-data"),
  machineId: z.string(),
  sessionId: ShellSessionId,
  dataBase64: z.string(),
});

/** Server → admin: the session ended (shell exited, box dropped, or the operator disarmed it). */
export const ServerToAdminShellClosed = z.object({
  t: z.literal("server/shell-closed"),
  machineId: z.string(),
  sessionId: ShellSessionId,
  reason: z.string().optional(),
});

export const ServerToAdminShellMessage = z.discriminatedUnion("t", [
  ServerToAdminShellOpened,
  ServerToAdminShellData,
  ServerToAdminShellClosed,
]);
export type ServerToAdminShellMessage = z.infer<typeof ServerToAdminShellMessage>;

/** A line in the Live Activity feed — a human-readable record of a notable event.
 *  `accent` (POL-68) marks operator-initiated lifecycle events (reboot requested, console session
 *  opened) — notable but neither good nor bad, rendered in the console's accent blue. */
export const ActivityEvent = z.object({
  id: z.string(),
  at: z.string(), // ISO timestamp
  severity: z.enum(["info", "good", "warn", "bad", "accent"]),
  text: z.string(),
});
export type ActivityEvent = z.infer<typeof ActivityEvent>;

/** Why a bootloader install (the netboot "offload") ended the way it did (POL-58). The box posts one
 *  of these to `POST /boot/report` the moment it knows, so the outcome reaches the operator instead of
 *  dying in a journal on a diskless box. `installed` is the only success. */
export const BootReportCode = z.enum([
  "installed", // the loaders are on the ESP and the firmware boots them first — verified, not assumed
  "not-uefi", // booted in legacy BIOS/CSM mode: no UEFI boot entries exist to add
  "no-base", // no polyptic.base= on the kernel cmdline
  "no-efibootmgr", // the tool is missing from the image
  "no-efivars", // the firmware's boot variables are unreadable
  "unsupported-arch",
  "no-esp", // no EFI System Partition on any internal disk
  "ambiguous-esp", // several ESPs and none is clearly the boot one — needs polyptic.offload_disk=
  "no-partnum",
  "no-loaders", // the signed shim/GRUB pair could not be downloaded from the depot
  "mount-failed",
  "foreign-grub-cfg", // a GRUB config we did not write sits at our path; never clobbered
  "nvram-write-failed", // the firmware refused the boot entry (variable storage full?)
  "nvram-entry-missing", // it accepted the entry, then dropped it
  "nvram-not-persisted",
  "boot-order-not-first", // the entry exists but the firmware still boots something else first
  "esp-too-small", // POL-63: the Wi-Fi local payload (kernel + initrd-wifi + spare slot) won't fit
  "no-local-payload", // POL-63: a Wi-Fi box's offload found no payload for its arch on the medium
  // POL-116: not a bootloader outcome at all — an initramfs one. The box's boot medium pinned a build
  // (D67's offline menu) that retention (D54) has since pruned from the depot, so it healed itself in
  // the initramfs and streamed the ACTIVE image instead. It IS up, on a rootfs its on-stick kernel did
  // not ship with, until update-poll re-pins the medium — hence a report rather than a silent swap.
  "pinned-build-missing",
]);
export type BootReportCode = z.infer<typeof BootReportCode>;

/** The body of `POST /boot/report`. `detail` is a human sentence composed on the box; the server
 *  renders it into one Live Activity line and never interprets it. */
export const BootReportBody = z.object({
  ok: z.boolean(),
  code: BootReportCode,
  detail: z.string().max(200).default(""),
  /** The box's stable netboot identity (`dmi-…` / `mac-…`), when it could derive one. */
  machineId: z.string().max(128).default(""),
});
export type BootReportBody = z.infer<typeof BootReportBody>;

/** Full registry snapshot, pushed to admin clients on connect and on every change. */
export const ServerToAdminState = z.object({
  t: z.literal("admin/state"),
  revision: z.number().int().nonnegative(),
  machines: z.array(MachineView),
  murals: z.array(Mural), // Phase 3
  placements: z.array(Placement), // Phase 3 — which screen sits where on which mural
  videoWalls: z.array(VideoWall), // Phase 3b — combined surfaces
  contentSources: z.array(ContentSource), // Phase 3c — the content library
  scenes: z.array(Scene), // Phase 3d — saved wall snapshots
  activity: z.array(ActivityEvent).optional(), // Live Activity feed (newest first); optional = back-compat
  settings: DisplaySettings.optional(), // POL-6 — fleet-wide display settings (badge toggle); optional = back-compat
  credentialProfiles: z.array(CredentialProfileView).optional(), // POL-24 — content auth profiles; optional = back-compat
  // POL-89 — the scene scheduler. The console feeds these three straight into the shared resolver to
  // paint its "what plays when" week strip, so the strip cannot disagree with the server's ticker.
  dayparts: z.array(Daypart).optional(), // optional = back-compat
  schedules: z.array(Schedule).optional(),
  scheduler: SchedulerSettings.optional(),
});
export const ServerToAdminMessage = z.discriminatedUnion("t", [ServerToAdminState]);
export type ServerToAdminMessage = z.infer<typeof ServerToAdminMessage>;

// REST bodies — admin actions
export const RenameScreenBody = z.object({ friendlyName: z.string().min(1).max(64) });
export type RenameScreenBody = z.infer<typeof RenameScreenBody>;

/** POST /api/v1/machines/:id/rename — POL-117. Writes `Machine.label`, the same field the hostname
 *  used to default into, so an operator name simply WINS over whatever the box reported. Any machine,
 *  any status, any time — naming is how an operator tells identical netbooted boxes apart, so it must
 *  work on a still-pending machine too. */
export const RenameMachineBody = z.object({ label: z.string().trim().min(1).max(64) });
export type RenameMachineBody = z.infer<typeof RenameMachineBody>;

/** Ident pulse request: flash a screen's friendly name so an operator can map physical panels. */
export const IdentBody = z.object({
  on: z.boolean(),
  ttlMs: z.number().int().positive().optional(), // optional auto-off, for fire-and-forget pulses
});
export type IdentBody = z.infer<typeof IdentBody>;

/** Reboot request for one machine (POL-55). The reason rides through to the box's journal. */
export const RebootBody = z.object({ reason: z.string().max(200).optional() });
export type RebootBody = z.infer<typeof RebootBody>;

/** POST /api/v1/machines/:id/shell — arm or disarm a box for the remote shell (POL-59). */
export const ShellArmBody = z.object({ enabled: z.boolean() });
export type ShellArmBody = z.infer<typeof ShellArmBody>;

/** Show/hide the Web Inspector on one screen's panel (POL-50). Relaunches that output's browser. */
export const InspectBody = z.object({ on: z.boolean() });
export type InspectBody = z.infer<typeof InspectBody>;

// ── Tags + selector-targeted bulk operations (POL-103) ───────────────────────
//
// PUT /api/v1/machines/:id/tags replaces a machine's whole tag set — add and remove are the same
// call, so the console never has to reconcile two half-applied mutations.
//
// The bulk routes take a TARGET, which is either a `selector` (the tag grammar in selector.ts) or an
// explicit `machineIds` list (the console's checkboxes). Never both-optional-and-absent: a bulk verb
// with no target is a 400, never a fleet-wide fan-out. Each answers a per-machine RESULT list —
// partial success is the normal case, and three offline boxes must not fail the other nine.

export const SetMachineTagsBody = z.object({ tags: MachineTags });
export type SetMachineTagsBody = z.infer<typeof SetMachineTagsBody>;

const bulkTargetShape = {
  /** A tag selector, e.g. `tag=atrium` or `tag=floor:2,tag=canary` (AND). */
  selector: z.string().max(200).optional(),
  /** Or an explicit set of machines — what the console's checkboxes send. */
  machineIds: z.array(z.string().min(1)).max(500).optional(),
};

/** Exactly-one-target: a bulk verb that names nothing must never mean "everything". */
function requireTarget(
  value: { selector?: string; machineIds?: string[] },
  ctx: z.RefinementCtx,
): void {
  const hasSelector = typeof value.selector === "string" && value.selector.trim() !== "";
  const hasIds = Array.isArray(value.machineIds) && value.machineIds.length > 0;
  if (!hasSelector && !hasIds) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "name a target: a tag selector (e.g. tag=atrium) or a non-empty machineIds list",
    });
  }
  if (hasSelector && hasIds) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "name ONE target: a selector or a machineIds list, not both",
    });
  }
}

export const BulkRebootBody = z
  .object({ ...bulkTargetShape, reason: z.string().max(200).optional() })
  .superRefine(requireTarget);
export type BulkRebootBody = z.infer<typeof BulkRebootBody>;

export const BulkIdentBody = z
  .object({ ...bulkTargetShape, on: z.boolean(), ttlMs: z.number().int().positive().optional() })
  .superRefine(requireTarget);
export type BulkIdentBody = z.infer<typeof BulkIdentBody>;

export const BulkShellBody = z
  .object({ ...bulkTargetShape, enabled: z.boolean() })
  .superRefine(requireTarget);
export type BulkShellBody = z.infer<typeof BulkShellBody>;

export const BulkApproveBody = z.object({ ...bulkTargetShape }).superRefine(requireTarget);
export type BulkApproveBody = z.infer<typeof BulkApproveBody>;

/**
 * What happened to ONE machine in a bulk fan-out:
 *   applied — the verb reached the box (or changed persisted state, for approve/tag)
 *   offline — matched, but its agent socket is down: reported, never fatal
 *   skipped — matched, but the verb does not apply (rebooting a pending box, approving an approved one)
 *   failed  — the control plane tried and errored (the sentence says how)
 */
export const BulkOutcome = z.enum(["applied", "offline", "skipped", "failed"]);
export type BulkOutcome = z.infer<typeof BulkOutcome>;

export const BulkMachineResult = z.object({
  machineId: z.string(),
  label: z.string(),
  outcome: BulkOutcome,
  /** A plain sentence when the outcome is not `applied` — shown to the operator verbatim. */
  detail: z.string().optional(),
});
export type BulkMachineResult = z.infer<typeof BulkMachineResult>;

export const BulkOpResponse = z.object({
  ok: z.literal(true),
  action: z.string(),
  /** How the target was named, echoed back (the selector text, or "N machines"). */
  target: z.string(),
  matched: z.number().int().nonnegative(),
  applied: z.number().int().nonnegative(),
  results: z.array(BulkMachineResult),
});
export type BulkOpResponse = z.infer<typeof BulkOpResponse>;

/** POST /api/v1/screens/:id/cast — enable or disable casting (AirPlay receiver) on one screen
 *  (POL-119). Persistent, no TTL; disabling kills the receiver and any live session immediately. */
export const CastArmBody = z.object({ enabled: z.boolean() });
export type CastArmBody = z.infer<typeof CastArmBody>;

// REST bodies — murals & placement (Phase 3)
export const CreateMuralBody = z.object({ name: z.string().min(1).max(64) });
export type CreateMuralBody = z.infer<typeof CreateMuralBody>;

export const RenameMuralBody = z.object({ name: z.string().min(1).max(64) });
export type RenameMuralBody = z.infer<typeof RenameMuralBody>;

/** Place or move a screen on a mural (canvas pixels; w/h default to the screen's resolution). */
export const PlaceScreenBody = z.object({
  muralId: z.string(),
  x: z.number(),
  y: z.number(),
  w: z.number().positive().optional(),
  h: z.number().positive().optional(),
});
export type PlaceScreenBody = z.infer<typeof PlaceScreenBody>;

// REST bodies — combined surfaces (Phase 3b)
export const CombineScreensBody = z.object({
  muralId: z.string(),
  memberScreenIds: z.array(z.string()).min(2),
  name: z.string().min(1).max(80).optional(), // optional name at creation; else a default is derived
});
export type CombineScreensBody = z.infer<typeof CombineScreensBody>;

/** Rename a combined surface (video wall). */
export const RenameVideoWallBody = z.object({ name: z.string().min(1).max(80) });
export type RenameVideoWallBody = z.infer<typeof RenameVideoWallBody>;

/** Assign content to a single screen OR a video wall (it spans across members): either a library
 *  source (`sourceId`) or an ad-hoc link (`url`). Exactly one of the two. */
export const SetContentBody = z
  .object({
    sourceId: z.string().optional(),
    url: z.string().url().optional(),
  })
  .refine((b) => (b.sourceId === undefined) !== (b.url === undefined), {
    message: "provide exactly one of sourceId or url",
  });
export type SetContentBody = z.infer<typeof SetContentBody>;

/** Set the page zoom on a single screen's OR a video wall's framed content (POL-57). The server
 *  remembers the value against the (target, content) pair, so re-assigning the same page to the same
 *  screen later restores the zoom the operator last dialled in. */
export const SetZoomBody = z.object({ zoom: Zoom });
export type SetZoomBody = z.infer<typeof SetZoomBody>;

/** POL-133 — set the page zoom on ONE step of the playlist a screen/wall is showing, identified by
 *  the step's library source. Same D62 model, same table: the value is remembered against the
 *  (target, step source) pair, so it survives restarts, scene switches and re-assignment — and the
 *  same source assigned DIRECTLY to that target shares the dialled-in zoom, which is D62's "zoom
 *  belongs to the (target, content) pair" taken at its word. */
export const SetPlaylistEntryZoomBody = z.object({
  /** The step's library source id (`PlaylistEntry.sourceId`). */
  sourceId: z.string().min(1),
  zoom: Zoom,
});
export type SetPlaylistEntryZoomBody = z.infer<typeof SetPlaylistEntryZoomBody>;

// REST bodies — content library (Phase 3c; playlists POL-34; pages POL-42)
export const CreateContentSourceBody = z
  .object({
    name: z.string().min(1).max(120),
    kind: ContentKind,
    url: z.string().url().optional(),
    /** POL-24 — attach a credential profile (null/omitted = unauthenticated). */
    credentialProfileId: z.string().nullable().optional(),
    /** POL-34 — playlist kind only: the carousel steps. A new playlist needs at least one. */
    items: z.array(PlaylistItem).min(1).max(100).optional(),
    /** POL-42 — required when kind is `page`; the Studio's saved composition. */
    definition: PageDefinition.optional(),
  })
  .superRefine((b, ctx) => {
    if (b.kind === "playlist") {
      if (b.url !== undefined) ctx.addIssue({ code: "custom", message: "a playlist has no url" });
      if (b.items === undefined)
        ctx.addIssue({ code: "custom", message: "a playlist needs at least one item" });
    } else if (b.kind === "page") {
      if (b.url !== undefined) ctx.addIssue({ code: "custom", message: "a page has no url" });
      if (b.definition === undefined)
        ctx.addIssue({ code: "custom", message: "a page needs a definition" });
    } else {
      if (b.url === undefined) ctx.addIssue({ code: "custom", message: "url is required" });
    }
    if (b.kind !== "playlist" && b.items !== undefined)
      ctx.addIssue({ code: "custom", message: "items are only valid on a playlist" });
    if (b.kind !== "page" && b.definition !== undefined)
      ctx.addIssue({ code: "custom", message: "a definition is only valid on a page" });
  });
export type CreateContentSourceBody = z.infer<typeof CreateContentSourceBody>;

/** Partial update of a library source (any subset of fields; credentialProfileId null DETACHES;
 *  `items` replaces a playlist's whole carousel). Kind/url/items consistency is validated against the
 *  MERGED source server-side — a partial body can't judge it alone. */
export const UpdateContentSourceBody = z.object({
  name: z.string().min(1).max(120).optional(),
  kind: ContentKind.optional(),
  url: z.string().url().optional(),
  credentialProfileId: z.string().nullable().optional(),
  items: z.array(PlaylistItem).min(1).max(100).optional(),
  /** POL-42 — replace a page source's composition (the Studio's Save). */
  definition: PageDefinition.optional(),
});
export type UpdateContentSourceBody = z.infer<typeof UpdateContentSourceBody>;

// REST bodies — credential profiles (POL-24). The clientSecret crosses the wire INBOUND ONLY.
export const CreateCredentialProfileBody = z.object({
  name: z.string().min(1).max(120),
  tokenEndpoint: z.string().url(),
  clientId: z.string().min(1).max(200),
  clientSecret: z.string().min(1).max(500),
  scope: z.string().min(1).max(500).optional(),
  audience: z.string().min(1).max(500).optional(),
  tokenParam: z.string().min(1).max(64).optional(),
});
export type CreateCredentialProfileBody = z.infer<typeof CreateCredentialProfileBody>;

/** Partial update. `clientSecret` omitted = unchanged; provided = replaced (and the token re-fetched).
 *  `scope`/`audience` null = cleared. */
export const UpdateCredentialProfileBody = z.object({
  name: z.string().min(1).max(120).optional(),
  tokenEndpoint: z.string().url().optional(),
  clientId: z.string().min(1).max(200).optional(),
  clientSecret: z.string().min(1).max(500).optional(),
  scope: z.string().min(1).max(500).nullable().optional(),
  audience: z.string().min(1).max(500).nullable().optional(),
  tokenParam: z.string().min(1).max(64).optional(),
});
export type UpdateCredentialProfileBody = z.infer<typeof UpdateCredentialProfileBody>;

/** Result of POST /credential-profiles/:id/test — the IdP's live answer, never the token itself. */
export const CredentialProfileTestResult = z.object({
  ok: z.boolean(),
  /** Seconds of life the fetched token reported (ok only). */
  expiresIn: z.number().int().positive().optional(),
  /** The IdP's error, verbatim (failure only). */
  error: z.string().optional(),
});
export type CredentialProfileTestResult = z.infer<typeof CredentialProfileTestResult>;

// REST bodies — scenes (Phase 3d)
/** Save the CURRENT state of a mural as a new scene — the server snapshots placements + walls +
 *  content itself; the client only names it. */
export const CreateSceneBody = z.object({
  name: z.string().min(1).max(120),
  muralId: z.string(),
});
export type CreateSceneBody = z.infer<typeof CreateSceneBody>;

/** Rename a scene. (Scheduling is NOT here — a scene's time of day is a `Schedule`, POL-89/D93.) */
export const UpdateSceneBody = z.object({
  name: z.string().min(1).max(120).optional(),
});
export type UpdateSceneBody = z.infer<typeof UpdateSceneBody>;

// ── Auth + settings (Phase 3f) ───────────────────────────────────────────────
// Local operator accounts (D29): argon2id password hashing, HTTP-only secure session cookies,
// login rate-limit/lockout, no plaintext anywhere. OIDC is a later add-on on the same seam.

export const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
});
export type LoginBody = z.infer<typeof LoginBody>;

/**
 * What an operator account is ALLOWED to do (POL-107). Three roles, ordered — each one strictly
 * contains the one below it:
 *
 *   - `viewer`   — read the whole registry, and INVOKE a saved scene (`POST /scenes/:id/apply`).
 *                  The "staff invoke" half of the author/invoke split: a receptionist can recall a
 *                  layout the wall's owner authored, and can change nothing else.
 *   - `operator` — everything a viewer can do, plus the CONTENT + LAYOUT verbs: the content library,
 *                  murals/placements/walls, per-screen + per-wall content and zoom, scenes CRUD,
 *                  ident, capture, casting, screen renames.
 *   - `admin`    — everything, plus the FLEET + SECRETS verbs: machines (approve/reject/reboot/remove),
 *                  the remote shell and the DevTools tunnel, every `/settings/**` route (enrolment
 *                  token, image builds, display settings, HTTPS, credential profiles) and operator
 *                  management itself.
 *
 * The ordering is the whole contract: a role may do anything its rank allows, and the SERVER decides
 * (a console that hides a button is a nicety, not a permission system).
 */
export const OperatorRole = z.enum(["admin", "operator", "viewer"]);
export type OperatorRole = z.infer<typeof OperatorRole>;

/** The signed-in operator, as returned by /auth/login and /auth/me (never any secret). `role` is what
 *  the console keys its affordances off; the server enforces the same role on every route. Defaulted
 *  to `admin` so a pre-POL-107 payload (or an upgraded single-admin deployment) parses as the admin it
 *  effectively was — never as a lockout. */
export const AuthUser = z.object({
  id: z.string(),
  email: z.string().email(),
  role: OperatorRole.default("admin"),
});
export type AuthUser = z.infer<typeof AuthUser>;

/** An operator account as listed in Settings ▸ Operators (admin-only). Never carries a hash. */
export const Operator = z.object({
  id: z.string(),
  email: z.string().email(),
  role: OperatorRole,
  createdAt: z.string(),
});
export type Operator = z.infer<typeof Operator>;

/** Create an operator account (admin-only). The password is min-8, same as a self-service change. */
export const CreateOperatorBody = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
  role: OperatorRole,
});
export type CreateOperatorBody = z.infer<typeof CreateOperatorBody>;

/** Update an operator (admin-only): change the role and/or reset the password. At least one of the
 *  two must be present — an empty patch is a client bug, not a no-op. */
export const UpdateOperatorBody = z
  .object({
    role: OperatorRole.optional(),
    password: z.string().min(8).max(200).optional(),
  })
  .refine((b) => b.role !== undefined || b.password !== undefined, {
    message: "provide role and/or password",
  });
export type UpdateOperatorBody = z.infer<typeof UpdateOperatorBody>;

/** Change the current operator's password. */
export const ChangePasswordBody = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(8).max(200),
});
export type ChangePasswordBody = z.infer<typeof ChangePasswordBody>;

// ── Enrolment tokens + pre-registration (POL-104) ────────────────────────────
//
// Before POL-104 a gated deployment had exactly ONE bootstrap token, baked into every boot medium
// ever flashed. That is a flat fleet credential: one stick that walks out of the building
// compromises enrolment for the whole estate, and rotating it means re-flashing every medium.
//
// A deployment now holds a SET of named tokens, each optionally scoped by an expiry and/or a cap on
// how many NEW machines it may onboard, and each revocable on its own. Exactly one is the BAKE token
// — the one `/boot/grub.cfg` (and therefore `build-boot-medium.sh`, which lifts it back out of that
// very menu) writes into a medium's kernel cmdline.
//
// BACKWARD COMPATIBILITY IS THE WHOLE GAME HERE. Every already-flashed stick in the field carries the
// old flat token. On first boot after the upgrade the server LIFTS that token into the token table as
// a record named "Original bootstrap token" (`legacy: true`) with no expiry and no cap, and keeps it
// as the bake token — so every medium that worked yesterday works today, and nothing changes until an
// operator deliberately rotates or revokes it.

export const EnrollmentTokenView = z.object({
  id: z.string(),
  /** Operator-chosen name — the batch/site this token was cut for ("Floor 3 rollout", "Site: Leeds"). */
  name: z.string(),
  /** The secret itself. Only ever served to a signed-in operator over the auth-gated settings route. */
  secret: z.string(),
  createdAt: z.string().datetime(),
  /** Hard expiry. After this instant the token enrols nothing. Null = never expires. */
  expiresAt: z.string().datetime().nullable(),
  /** Cap on how many NEW machines this token may enrol. Null = uncapped. A re-enrol of a machine that
   *  ALREADY counted against the cap (a box that lost its credential) does not consume a second slot. */
  maxEnrollments: z.number().int().positive().nullable(),
  /** How many machines have first-enrolled on this token. */
  uses: z.number().int().nonnegative(),
  /** Revoked = blocks NEW enrolments and token re-enrols. Machines ALREADY enrolled on it keep their
   *  durable per-machine credential and keep running — revoking a token never darkens a working wall. */
  revokedAt: z.string().datetime().nullable(),
  lastUsedAt: z.string().datetime().nullable(),
  /** The token baked into `/boot/grub.cfg` and therefore into the next boot medium. Exactly one. */
  bake: z.boolean(),
  /** The pre-POL-104 flat bootstrap token, lifted into the table on upgrade. Never expires, never
   *  capped — the media already in the field depend on it. */
  legacy: z.boolean(),
});
export type EnrollmentTokenView = z.infer<typeof EnrollmentTokenView>;

/** Enrollment visibility for Settings + the cold-start wizard. `open` mode auto-approves with
 *  no token; `gated` mode requires one of the enrolment tokens (shown only to a signed-in operator).
 *  `token` is the BAKE token's secret — kept as a scalar for the pre-POL-104 console/wizard. */
export const EnrollmentInfo = z.object({
  mode: z.enum(["open", "gated"]),
  token: z.string().nullable(),
  /** POL-104 — every live token. Absent on a pre-POL-104 server (the console degrades to the scalar). */
  tokens: z.array(EnrollmentTokenView).default([]),
});
export type EnrollmentInfo = z.infer<typeof EnrollmentInfo>;

/** POST /api/v1/settings/enrollment/tokens — cut a new batch token. */
export const CreateEnrollmentTokenBody = z.object({
  name: z.string().min(1).max(120),
  /** Days from now until it expires. Omit for a token that never expires. */
  expiresInDays: z.number().int().positive().max(3650).optional(),
  /** Cap on NEW machines. Omit for uncapped. */
  maxEnrollments: z.number().int().positive().max(100000).optional(),
  /** Make this the token baked into new boot media. */
  bake: z.boolean().default(false),
});
export type CreateEnrollmentTokenBody = z.infer<typeof CreateEnrollmentTokenBody>;

/** POST /api/v1/settings/enrollment/tokens/:id/rotate — cut a successor and put the old one on a
 *  GRACE window rather than killing it, so boots in flight (and media not yet re-flashed) still land. */
export const RotateEnrollmentTokenBody = z.object({
  /** Hours the OLD secret keeps working. 0 = revoke immediately (an emergency: a stick is gone). */
  graceHours: z.number().int().nonnegative().max(8760).default(24),
});
export type RotateEnrollmentTokenBody = z.infer<typeof RotateEnrollmentTokenBody>;

/**
 * A box the operator declared BEFORE it ever booted. Matched on the first `agent/hello` that
 * authenticates, and only then: pre-registration is not a credential and grants no access on its own
 * — the box must still present a valid enrolment token. It decides what happens to a box that has
 * ALREADY proved it belongs: what it is called, which tags it carries, and whether an operator has to
 * click Approve at all.
 *
 * Keys, in match order (first hit wins; an AMBIGUOUS match — two records at the same tier — matches
 * NOTHING, because auto-naming the wrong box is worse than one manual approval):
 *   machineId  — the box's own stable netboot identity (`dmi-…`/`mac-…`). Strongest.
 *   dmiSerial  — the chassis serial off the sticker. Strong on real hardware, absent/garbage in VMs.
 *   mac        — weakest, and DELIBERATELY so: a Wi-Fi-bridged VM's MAC is rewritten by its host
 *                (POL-63/POL-78 homelab lesson), and a MAC is trivially spoofable by anyone who could
 *                already have got this far. It is a convenience for the common case, never a proof.
 */
export const PreRegistration = z.object({
  id: z.string(),
  /** The friendly name to give the box on enrolment ("Lobby left"). */
  label: z.string().min(1).max(200).optional(),
  /** Tags to apply on enrolment (composes with POL-103 machine tags; stored + shown today). */
  tags: z.array(z.string().min(1).max(60)).default([]),
  /** Approve the box the moment it enrols — the zero-click commissioning path. */
  autoApprove: z.boolean().default(true),
  machineId: z.string().min(1).optional(),
  dmiSerial: z.string().min(1).optional(),
  /** Normalized lower-case colon form (`aa:bb:cc:dd:ee:ff`). */
  mac: z.string().min(1).optional(),
  note: z.string().max(500).optional(),
  createdAt: z.string().datetime(),
  /** The machine this record matched, once it has been claimed. A record claims at most one box. */
  matchedMachineId: z.string().optional(),
  matchedAt: z.string().datetime().optional(),
  /** Which key actually matched — shown to the operator, because a MAC match is a weaker claim. */
  matchedOn: z.enum(["machineId", "dmiSerial", "mac"]).optional(),
});
export type PreRegistration = z.infer<typeof PreRegistration>;

/** POST /api/v1/pre-registrations — one record, or a CSV paste of many. */
export const CreatePreRegistrationBody = z.object({
  label: z.string().min(1).max(200).optional(),
  tags: z.array(z.string().min(1).max(60)).default([]),
  autoApprove: z.boolean().default(true),
  machineId: z.string().min(1).optional(),
  dmiSerial: z.string().min(1).optional(),
  mac: z.string().min(1).optional(),
  note: z.string().max(500).optional(),
});
export type CreatePreRegistrationBody = z.infer<typeof CreatePreRegistrationBody>;

/** POST /api/v1/pre-registrations/import — `label,mac-or-serial-or-machineId,tags…` per line. */
export const ImportPreRegistrationsBody = z.object({
  csv: z.string().max(200_000),
  autoApprove: z.boolean().default(true),
});
export type ImportPreRegistrationsBody = z.infer<typeof ImportPreRegistrationsBody>;

/** Netboot (POL-33/D47) surface for Settings: where a bare box's signed shim+GRUB chain fetches its
 *  boot menu from, and whether a prebuilt boot medium is bundled for download. Deliberately SECRET-FREE,
 *  the enrolment token that the boot flow bakes in lives only in {@link EnrollmentInfo}; this just
 *  surfaces the URLs an operator needs (control-plane base, the `/boot/grub.cfg` config URL, and the
 *  boot-medium download when present). */
/** What the published boot medium ACTUALLY is (POL-122/D110). Two media wear the same filename:
 *  the FULL universal medium (local payload per arch + Wi-Fi config — boots a Wi-Fi-only screen)
 *  and the LEAN one (`LEAN=1`: wired netboot only, no payload, no Wi-Fi). They used to be
 *  indistinguishable from outside — same name, same URL, no metadata — so an operator downloading
 *  a lean stick had no way to know their Wi-Fi screens could never boot from it. The build script
 *  now writes a sidecar manifest (`polyptic-boot.json`) beside the image and the server surfaces
 *  it here, so the console can tell the truth. `selfDescribed: false` = a medium baked before
 *  POL-122 (no manifest); its shape is then INFERRED from the image size (the lean medium is
 *  64 MiB, a payload medium is >= 384 MiB by construction) and the finer facts are unknown. */
export const BootMediumInfo = z.object({
  /** Where to download it (the same ungated `/dist/boot/polyptic-boot.img` route). */
  url: z.string(),
  /** Wired-netboot-only: no local payload, no Wi-Fi. A Wi-Fi-only screen cannot boot from it. */
  lean: z.boolean(),
  /** Arches whose local boot payload rides on the medium (empty on a lean medium). */
  arches: z.array(z.enum(["arm64", "amd64"])).default([]),
  /** The live-image id baked per arch, so the console can say how stale the stick is. */
  imageIds: z.record(z.string(), z.string()).default({}),
  /** The medium's own identity marker (`polyptic/medium-id` on the stick), when it has one. */
  mediumId: z.string().nullable().default(null),
  builtAt: z.string().nullable().default(null),
  /** Whether an enrolment token is baked into the LOCAL menu — which makes the file a credential.
   *  `null` when unknown (a pre-POL-122 medium with no manifest). */
  tokenBaked: z.boolean().nullable().default(null),
  /** Whether the medium shipped its own manifest (false → the fields above are inferred). */
  selfDescribed: z.boolean().default(false),
});
export type BootMediumInfo = z.infer<typeof BootMediumInfo>;

/** The sidecar manifest `deploy/build-boot-medium.sh` writes beside the image (`polyptic-boot.json`,
 *  emitted by `deploy/write-boot-manifest.sh`) and the server parses at the edge. This is a
 *  cross-process contract like any other: the shell writes it, the server reads it, so it lives
 *  here. Unknown/extra keys are ignored — an older or newer manifest degrades, it never 500s. */
export const BootMediumManifest = z.object({
  mediumId: z.string().nullable().default(null),
  builtAt: z.string().nullable().default(null),
  lean: z.boolean(),
  arches: z.array(z.enum(["arm64", "amd64"])).default([]),
  imageIds: z.record(z.string(), z.string()).default({}),
  tokenBaked: z.boolean().default(false),
  /** The image's size in bytes, as the builder saw it (informational). */
  bytes: z.number().int().nonnegative().nullable().default(null),
});
export type BootMediumManifest = z.infer<typeof BootMediumManifest>;

export const NetbootInfo = z.object({
  baseUrl: z.string(),
  mode: z.enum(["open", "gated"]),
  bootConfigUrl: z.string(),
  bootMediumUrl: z.string().nullable(),
  /** The published medium's real shape, `null` when none is published (POL-122). `bootMediumUrl`
   *  stays the download URL; this says WHAT that download is. */
  bootMedium: BootMediumInfo.nullable().default(null),
  /** Self-contained bootable Polyptic live ISOs in the image depot (POL-38/D49): write to a USB
   *  stick (or attach to a UEFI VM) and the box boots straight into Polyptic and enrols — the
   *  manual-provisioning alternative to netboot. One entry per arch whose artifact exists on
   *  disk. NOTE: unlike everything else here these DO bake the current enrolment token, so the
   *  FILE is a credential — the console spells that out next to the download. */
  liveIsos: z.array(z.object({ arch: z.enum(["arm64", "amd64"]), url: z.string() })).default([]),
});
export type NetbootInfo = z.infer<typeof NetbootInfo>;

/** HTTPS surface for Settings (POL-70/D89): how THIS listener is serving TLS, if at all.
 *  `off` = plain HTTP (TLS, if any, terminates upstream at an ingress — the server can't see it);
 *  `provided` = native TLS from operator-supplied TLS_CERT_FILE/TLS_KEY_FILE;
 *  `self-signed` = native TLS from the deployment's own persisted CA (TLS_MODE=self-signed) — the
 *  one mode where the console offers the CA download + per-OS trust instructions, because trusting
 *  that CA once is what turns the browser warning off for good. Secret-free: the CA *certificate*
 *  is public material by definition; its private key never leaves the store. */
export const HttpsInfo = z.object({
  mode: z.enum(["off", "provided", "self-signed"]),
  /** SANs baked into the active self-signed leaf (empty in the other modes) — every name/IP the
   *  cert answers for, so an operator can see at a glance why some OTHER hostname still warns. */
  sans: z.array(z.string()).default([]),
  /** The downloadable CA (self-signed mode only). The fingerprint lets a careful operator verify
   *  the download out-of-band before trusting it. */
  ca: z
    .object({
      createdAt: z.string(),
      fingerprintSha256: z.string(),
      /** API path of the PEM download (relative to the API base), e.g. "/settings/https/ca.crt". */
      downloadPath: z.string(),
    })
    .nullable(),
});
export type HttpsInfo = z.infer<typeof HttpsInfo>;

/**
 * POL-134 — `GET /api/v1/settings/agent-security` (auth-gated): the agent-channel security posture
 * in operator words, for the Settings card. `mode` is the whole story:
 *   - "off"       the mTLS listener is not running (explicitly disabled, or the runtime/port could
 *                 not offer it — `detail` says which).
 *   - "migrating" certs are being issued and agents move over as they reconnect; the plain channel
 *                 still admits sessions while the fleet catches up.
 *   - "required"  every live agent session rides the mTLS listener; the plain channel only
 *                 authenticates first contact and issues certs — it never carries a session.
 */
export const AgentSecurityInfo = z.object({
  mode: z.enum(["off", "migrating", "required"]),
  /** The mTLS listener's port (absent when mode is "off"). */
  port: z.number().int().positive().optional(),
  /** When the deployment graduated to require-mTLS (auto-promotion or a pinned env). */
  requiredSince: z.string().optional(),
  /** True when AGENT_MTLS_REQUIRE pins the posture (no auto-promotion either way). */
  pinned: z.boolean(),
  /** Why the listener is off, when it is ("AGENT_MTLS=off", "port 8443 in use", …). */
  detail: z.string().optional(),
  /** Per-machine cert state, one row per known machine. */
  machines: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      online: z.boolean(),
      /** The channel of the machine's live session (present only while online). */
      agentChannel: z.enum(["plain", "mtls"]).optional(),
      mtlsCertIssuedAt: z.string().optional(),
      mtlsSeenAt: z.string().optional(),
    }),
  ),
});
export type AgentSecurityInfo = z.infer<typeof AgentSecurityInfo>;

/** One arch's published live image, as served UNGATED at `/dist/image/<arch>/manifest.json` and
 *  compared by every netbooted box's 5-minute update poll (POL-41). `urgent` is the fleet-wide
 *  roll-out switch: true → boxes running a different imageId reboot within minutes (splayed);
 *  false → they wait for the nightly window. Secret-free by design (boxes have no session). */
export const ImageManifest = z.object({
  arch: z.enum(["arm64", "amd64"]),
  imageId: z.string(),
  builtAt: z.string(),
  sha256: z.string().nullable(),
  urgent: z.boolean(),
});
export type ImageManifest = z.infer<typeof ImageManifest>;

/** One retained build in the depot (POL-45). Every rebuild lands in `<arch>/builds/<imageId>/`; the
 *  newest `retainBuilds` survive and the rest are pruned. Exactly one build per arch is `active`:
 *  its artifacts are hardlinked at the arch root, so the boot chain (`/dist/image/<arch>/…`, baked
 *  into every `grub.cfg`) always serves it, and `manifest.json` publishes its id. Activating an
 *  older build is therefore a fleet ROLLBACK — boxes see an id they don't match on their 5-minute
 *  poll and reboot into it per the urgency policy. `liveIsoUrl` is the standalone bootable ISO for
 *  that build when one was built (`polyptic-live.iso`, D49), which is NOT the same artifact as the
 *  netboot payload `rootfs.squashfs` that dracut streams into RAM. */
export const ImageBuild = z.object({
  arch: z.enum(["arm64", "amd64"]),
  imageId: z.string(),
  builtAt: z.string(),
  sha256: z.string().nullable(),
  /** True for the one build per arch the depot currently serves and publishes. */
  active: z.boolean(),
  /** Absolute URL of this build's standalone live ISO, or null when it has none. */
  liveIsoUrl: z.string().nullable(),
});
export type ImageBuild = z.infer<typeof ImageBuild>;

/** The image-updates surface for Console ▸ Settings (POL-41): the rebuild schedule (server-local
 *  HH:MM, default 01:00), the urgent roll-out switch, the last hook run's outcome, the currently
 *  published per-arch images, and the retained build history (POL-45). GATED under /api/v1. */
export const ImageUpdateInfo = z.object({
  scheduleEnabled: z.boolean(),
  /** Server-local `HH:MM` the daily refresh hook fires at (default "01:00"). */
  scheduleTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  /** Weekly FULL rebuild (POL-43): rebuild from the base ISO — the cycle that rolls kernel CVEs
   *  (the daily refresh holds the kernel, D47). */
  fullScheduleEnabled: z.boolean(),
  /** Day-of-week the full rebuild fires (0 = Sunday … 6 = Saturday, default 0). */
  fullScheduleDay: z.number().int().min(0).max(6),
  /** Server-local `HH:MM` the full rebuild fires at (default "02:00"). */
  fullScheduleTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  urgent: z.boolean(),
  /** Whether the server has a daily-refresh hook configured (IMAGE_REBUILD_CMD); without one the
   *  schedule and "rebuild now" can only report, not build. */
  rebuildConfigured: z.boolean(),
  /** Whether the server has a weekly full-rebuild hook configured (IMAGE_FULL_REBUILD_CMD). */
  fullRebuildConfigured: z.boolean(),
  lastBuild: z
    .object({
      startedAt: z.string(),
      finishedAt: z.string().nullable(),
      status: z.enum(["running", "success", "failure"]),
      /** Which cycle ran: the daily in-place refresh or the weekly full rebuild. */
      kind: z.enum(["refresh", "full"]).nullable(),
      /** Tail of the hook's combined output — enough to see apt's verdict or the failure. */
      logTail: z.string(),
    })
    .nullable(),
  images: z.array(ImageManifest),
  /** Retained builds across all arches, newest first (POL-45). At most `retainBuilds` per arch. */
  builds: z.array(ImageBuild).default([]),
  /** How many builds per arch the depot keeps before pruning (IMAGE_RETAIN_BUILDS, default 3). */
  retainBuilds: z.number().int().min(1).default(3),
});
export type ImageUpdateInfo = z.infer<typeof ImageUpdateInfo>;

/** Update the image-updates schedules / urgency from the console (POL-41, POL-43). */
export const UpdateImageSettingsBody = z.object({
  scheduleEnabled: z.boolean().optional(),
  scheduleTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  fullScheduleEnabled: z.boolean().optional(),
  fullScheduleDay: z.number().int().min(0).max(6).optional(),
  fullScheduleTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  urgent: z.boolean().optional(),
});
export type UpdateImageSettingsBody = z.infer<typeof UpdateImageSettingsBody>;

/** Kick a rebuild from the console: the daily refresh (default) or the weekly full rebuild. */
export const RebuildImageBody = z.object({
  kind: z.enum(["refresh", "full"]).default("refresh"),
});
export type RebuildImageBody = z.infer<typeof RebuildImageBody>;

/** Make a retained build the one the depot serves (POL-45). A fleet-wide action: every netbooted
 *  box on a different image reboots into this one (urgent → minutes, else the nightly window). */
export const ActivateImageBody = z.object({
  arch: z.enum(["arm64", "amd64"]),
  imageId: z.string().min(1),
});
export type ActivateImageBody = z.infer<typeof ActivateImageBody>;

/** Update the fleet-wide display settings from the console (POL-6). Currently just the badge toggle. */
export const UpdateDisplaySettingsBody = z.object({
  showBadges: z.boolean(),
});
export type UpdateDisplaySettingsBody = z.infer<typeof UpdateDisplaySettingsBody>;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Parse an unknown WS frame (string or already-parsed JSON) with a schema. Throws on mismatch. */
export function parseMessage<T extends z.ZodTypeAny>(schema: T, raw: unknown): z.infer<T> {
  const json = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  return schema.parse(json);
}
