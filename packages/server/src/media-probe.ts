/**
 * POL-109 — MEDIA INGEST: the probing seam.
 *
 * An upload is not a byte sink. Before a file becomes a ContentSource we want to know what it IS
 * (duration, dimensions, codecs), we want a picture of it (poster frame / thumbnail), and we want to
 * refuse — AT UPLOAD, with a sentence an operator can act on — a file the wall browser provably
 * cannot decode. The alternative is what we had: an AVI accepted with a smile and discovered as a
 * black screen on the wall.
 *
 * THE SEAM (CLAUDE.md non-negotiable 5/6 — "buy the substrate, build the brain", "no vendor names in
 * core code paths"). Core (`media.ts`, `rest.ts`, `state.ts`) knows only `MediaProber`: it probes, it
 * makes posters, and it may be UNAVAILABLE. The one implementation that shells out to an external
 * media toolchain lives HERE and nowhere else, exactly like `DisplayBackend` (sway/i3) and
 * `ContentSource`; a future in-process decoder or a hosted transcoding service drops in by
 * implementing the same three methods. The binaries are configurable (`MEDIA_PROBE_CMD` /
 * `MEDIA_FRAME_CMD`) so an operator can point us at their own build without touching code.
 *
 * DEGRADE, NEVER REFUSE (D129). A dev laptop or a minimal container may have no toolchain at all. In
 * that case `available()` is false, ingest still accepts the upload, the source carries
 * `media.probed = false` plus a warning, and the wall behaves exactly as it did before this ticket.
 * A server that cannot inspect a file has learned NOTHING about it — turning "I don't know" into "no"
 * would break every existing deployment's uploads, and silence is not evidence of guilt.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Hard ceiling on any external tool invocation — a wedged decoder must never wedge an upload. */
const TOOL_TIMEOUT_MS = 20_000;
/** Poster frames are wall-sized at most; a 4K still is pointless for a library tile / pre-buffer. */
const POSTER_MAX_WIDTH = 1280;
/** Library thumbnails are list-row sized (retina-generous). */
const THUMB_MAX_WIDTH = 480;

/** What a prober can establish about a file. Every field is optional: a prober reports what it CAN. */
export interface ProbeResult {
  /** Container/format, lowercased, as the tool names it (may be a comma-joined family, e.g. "mov,mp4"). */
  container?: string;
  durationSeconds?: number;
  width?: number;
  height?: number;
  videoCodec?: string;
  audioCodec?: string;
  /** True when the file carries at least one decodable VIDEO (or still-image) stream. */
  hasVideoStream: boolean;
}

/**
 * The ingest seam. `available()` tells the caller whether this prober can do anything at all on this
 * host (cached — it is asked on every upload); `probe()` returns null when the file could be reached
 * but not understood; `poster()` writes a still to `outPath` and reports whether it managed to.
 * Implementations must never throw for an ordinary bad file — that is a `null` / `false`, not a 500.
 */
export interface MediaProber {
  /** For logs + diagnostics only. Never branched on by core. */
  readonly name: string;
  available(): Promise<boolean>;
  probe(path: string): Promise<ProbeResult | null>;
  poster(input: string, outPath: string, opts: PosterOptions): Promise<boolean>;
}

export interface PosterOptions {
  /** Seek offset for a video (clamped against its duration by the caller). Omit for a still image. */
  atSeconds?: number;
  maxWidth: number;
}

/** The poster width for a video pre-buffer frame. */
export const POSTER_WIDTH = POSTER_MAX_WIDTH;
/** The thumbnail width for a library image tile. */
export const THUMBNAIL_WIDTH = THUMB_MAX_WIDTH;

// ─────────────────────────────────────────────────────────────────────────────
// Playability policy — the actual product decision, kept as a PURE function so it is fully testable
// without any toolchain, and so the "what can a wall play" knowledge lives in one readable place.
//
// The wall browser is a modern Chromium (D77) or, on the fallback boxes, WebKitGTK (D63). Both decode
// the same short list, and it is not the same list as "things a media player can open". These are the
// containers/codecs the HTML <video> element is specified/known to play; everything else — AVI,
// WMV/ASF, FLV, MPEG-2 program streams, DivX/Xvid (MPEG-4 Part 2), VC-1 — plays in VLC on the
// operator's laptop and shows a black rectangle on the wall. That gap is the bug this ticket closes.
// ─────────────────────────────────────────────────────────────────────────────

/** Container tokens a wall browser can demux. A tool reports a FAMILY ("mov,mp4,m4a,3gp,3g2,mj2"), so
 *  we intersect rather than compare — and "matroska,webm" passes here, with the codec check below
 *  doing the real work (a .mkv carrying VP9+Opus is byte-for-byte a WebM; one carrying MPEG-4 ASP is
 *  refused on its codec, which is the honest reason anyway). */
const PLAYABLE_CONTAINERS = new Set(["mp4", "mov", "m4a", "3gp", "3g2", "webm", "matroska", "ogg", "ogv"]);

/** Video codecs a wall browser can decode. */
const PLAYABLE_VIDEO_CODECS = new Set(["h264", "avc1", "hevc", "h265", "vp8", "vp9", "av1", "theora"]);

/** Audio codecs a wall browser can decode. An undecodable audio track can fail the WHOLE element in
 *  Chromium, so a hostile track is a rejection, not a shrug — see the note on `assessPlayability`. */
const PLAYABLE_AUDIO_CODECS = new Set(["aac", "mp3", "mp4a", "opus", "vorbis", "flac", "pcm_s16le"]);

/** Friendly names for the codecs we refuse most often — so the message says what the file IS. */
const CODEC_LABELS: Record<string, string> = {
  mpeg4: "MPEG-4 Part 2 (DivX/Xvid)",
  msmpeg4v3: "MS-MPEG-4 v3 (DivX 3)",
  msmpeg4v2: "MS-MPEG-4 v2",
  wmv1: "Windows Media Video 7",
  wmv2: "Windows Media Video 8",
  wmv3: "Windows Media Video 9",
  vc1: "VC-1",
  mpeg1video: "MPEG-1 video",
  mpeg2video: "MPEG-2 video",
  mjpeg: "Motion JPEG",
  ac3: "Dolby Digital (AC-3)",
  eac3: "Dolby Digital Plus (E-AC-3)",
  dts: "DTS",
  wmav1: "Windows Media Audio 1",
  wmav2: "Windows Media Audio 2",
  mp2: "MPEG audio layer 2",
};

const CONTAINER_LABELS: Record<string, string> = {
  avi: "AVI",
  asf: "ASF / WMV",
  flv: "Flash Video",
  mpeg: "MPEG program stream",
  mpegts: "MPEG transport stream",
  wav: "WAV",
};

function label(map: Record<string, string>, key: string): string {
  return map[key] ?? key.toUpperCase();
}

/** The advice half of every rejection — one sentence, one action. */
const CONVERT_ADVICE =
  "Convert it to MP4 (H.264 video + AAC audio) or WebM (VP9 + Opus) and upload it again.";

export type Playability =
  | { ok: true; warning?: string }
  | { ok: false; reason: "codec" | "undecodable"; message: string };

/**
 * Can a wall browser play this probed file? PURE — the whole ingest verdict, given only facts.
 *
 * The rules, in the order an operator would ask them:
 *  1. No video stream in a file that claims to be a video → it is not a video we can show. Refuse.
 *  2. Container the browser cannot demux (AVI, WMV, FLV, MPEG-PS/TS) → refuse, and NAME it.
 *  3. Video codec the browser cannot decode (MPEG-4 Part 2, WMV, VC-1, MPEG-2, MJPEG) → refuse.
 *  4. Audio codec the browser cannot decode (AC-3, DTS, WMA) → refuse. Wall videos play MUTED, so it
 *     is tempting to shrug; we don't, because Chromium can fail the entire media element on an
 *     undecodable track and the failure mode we are here to kill is precisely "black rectangle".
 *  5. Anything the prober is unsure about (an unknown-but-not-blacklisted codec, no codec reported)
 *     → ACCEPT with a warning. Ingest refuses on EVIDENCE, never on absence of it.
 */
export function assessPlayability(probe: ProbeResult): Playability {
  if (!probe.hasVideoStream) {
    return {
      ok: false,
      reason: "undecodable",
      message:
        "This file has no playable video track. It may be audio-only, corrupt, or not really a video. " +
        CONVERT_ADVICE,
    };
  }

  const tokens = (probe.container ?? "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  if (tokens.length > 0 && !tokens.some((t) => PLAYABLE_CONTAINERS.has(t))) {
    const name = label(CONTAINER_LABELS, tokens[0] ?? "");
    return {
      ok: false,
      reason: "codec",
      message: `Screens can't play ${name} files, so they would show as a black screen. ${CONVERT_ADVICE}`,
    };
  }

  const video = (probe.videoCodec ?? "").toLowerCase();
  if (video && !PLAYABLE_VIDEO_CODECS.has(video)) {
    const name = label(CODEC_LABELS, video);
    return {
      ok: false,
      reason: "codec",
      message: `Screens can't play ${name} video because the wall browser decodes H.264, H.265, VP8, VP9 and AV1 only. ${CONVERT_ADVICE}`,
    };
  }

  const audio = (probe.audioCodec ?? "").toLowerCase();
  if (audio && !PLAYABLE_AUDIO_CODECS.has(audio)) {
    const name = label(CODEC_LABELS, audio);
    return {
      ok: false,
      reason: "codec",
      message: `The video's audio track is ${name}, which the wall browser can't decode, so it can refuse the whole file. Re-encode the audio as AAC or Opus (the video track is fine) and upload it again.`,
    };
  }

  if (!video) {
    return {
      ok: true,
      warning: "The video's codec couldn't be identified. Check it on a screen before you rely on it.",
    };
  }
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementations
// ─────────────────────────────────────────────────────────────────────────────

/** The prober used when no toolchain is configured/installed: knows nothing, claims nothing. */
export class NullMediaProber implements MediaProber {
  readonly name = "none";
  async available(): Promise<boolean> {
    return false;
  }
  async probe(): Promise<ProbeResult | null> {
    return null;
  }
  async poster(): Promise<boolean> {
    return false;
  }
}

/** Raw shape of the probe tool's JSON — only the fields we consume, all treated as untrusted. */
interface ToolStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
}
interface ToolProbeJson {
  streams?: ToolStream[];
  format?: { format_name?: string; duration?: string };
}

/**
 * The one implementation that shells out to an external media toolchain (the usual pair: a JSON-
 * emitting stream inspector + a frame extractor). Both binaries are configurable; if either is
 * missing the prober simply reports itself unavailable and the server degrades (D129).
 */
export class ExternalToolMediaProber implements MediaProber {
  readonly name: string;
  private availability?: Promise<boolean>;

  constructor(
    private readonly probeCmd: string,
    private readonly frameCmd: string,
  ) {
    this.name = `${probeCmd}/${frameCmd}`;
  }

  /** Cached: probed once per process (an upload asks on every request). */
  available(): Promise<boolean> {
    this.availability ??= this.detect();
    return this.availability;
  }

  private async detect(): Promise<boolean> {
    for (const cmd of [this.probeCmd, this.frameCmd]) {
      try {
        await run(cmd, ["-version"], { timeout: TOOL_TIMEOUT_MS });
      } catch {
        return false;
      }
    }
    return true;
  }

  async probe(path: string): Promise<ProbeResult | null> {
    let stdout: string;
    try {
      const result = await run(
        this.probeCmd,
        [
          "-v",
          "error",
          "-show_streams",
          "-show_format",
          "-of",
          "json",
          path,
        ],
        { timeout: TOOL_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      );
      stdout = result.stdout;
    } catch {
      // A file the tool cannot open/parse at all. Not an exception — an answer: "I can't read this".
      return null;
    }

    let json: ToolProbeJson;
    try {
      json = JSON.parse(stdout) as ToolProbeJson;
    } catch {
      return null;
    }

    const streams = Array.isArray(json.streams) ? json.streams : [];
    const video = streams.find((s) => s.codec_type === "video");
    const audio = streams.find((s) => s.codec_type === "audio");
    if (!video && !audio && !json.format?.format_name) return null;

    const durationRaw = json.format?.duration ?? video?.duration;
    const duration = durationRaw !== undefined ? Number(durationRaw) : Number.NaN;

    const result: ProbeResult = { hasVideoStream: video !== undefined };
    const container = json.format?.format_name?.toLowerCase();
    if (container) result.container = container;
    if (Number.isFinite(duration) && duration > 0) result.durationSeconds = duration;
    if (typeof video?.width === "number" && video.width > 0) result.width = Math.round(video.width);
    if (typeof video?.height === "number" && video.height > 0) result.height = Math.round(video.height);
    if (video?.codec_name) result.videoCodec = video.codec_name.toLowerCase();
    if (audio?.codec_name) result.audioCodec = audio.codec_name.toLowerCase();
    return result;
  }

  async poster(input: string, outPath: string, opts: PosterOptions): Promise<boolean> {
    // scale=w:-2 keeps the aspect ratio on an even height (encoders demand even dimensions), and the
    // min() keeps a small source from being UPscaled into a blurry poster.
    const filter = `scale='min(${Math.round(opts.maxWidth)},iw)':-2`;
    const args: string[] = ["-v", "error", "-y"];
    if (opts.atSeconds !== undefined && opts.atSeconds > 0) {
      args.push("-ss", opts.atSeconds.toFixed(2)); // before -i = fast keyframe seek
    }
    args.push("-i", input, "-frames:v", "1", "-vf", filter, outPath);

    try {
      await run(this.frameCmd, args, { timeout: TOOL_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Build the process-wide prober from the environment. `MEDIA_PROBE_CMD` / `MEDIA_FRAME_CMD` name the
 * binaries (defaults are the ubiquitous pair shipped in our device image and in every CI runner);
 * `MEDIA_PROBE=off` disables probing entirely, which is also the escape hatch if an operator's
 * toolchain ever misbehaves. Nothing here can throw — a bad config degrades to the null prober.
 */
export function createMediaProber(env: Record<string, string | undefined> = process.env): MediaProber {
  if ((env.MEDIA_PROBE ?? "").toLowerCase() === "off") return new NullMediaProber();
  const probeCmd = env.MEDIA_PROBE_CMD?.trim() || "ffprobe";
  const frameCmd = env.MEDIA_FRAME_CMD?.trim() || "ffmpeg";
  return new ExternalToolMediaProber(probeCmd, frameCmd);
}
