/**
 * POL-133 — presentation controls: every new field is optional-with-default, so payloads and stored
 * compositions written BEFORE this ticket parse forever, and parse to EXACTLY the old behaviour
 * (zoom 100%, the old feed sizing, the old QR colours). Plus the QR scannability gate: a colour pair
 * a camera provably can't read is refused at the contract edge.
 */
import { describe, expect, test } from "bun:test";

import {
  PageElement,
  PlaylistEntry,
  PlaylistSurface,
  SetPlaylistEntryZoomBody,
  contrastRatio,
  hexLuminance,
  qrContrastIssue,
} from "../src/index";

describe("POL-133 back-compat: pre-existing payloads parse to the old behaviour", () => {
  test("a pre-POL-133 playlist entry (no zoom) parses with zoom 1", () => {
    const entry = PlaylistEntry.parse({
      kind: "web",
      url: "https://example.test/dash",
      durationSeconds: 30,
      sourceId: "source-1",
    });
    expect(entry.zoom).toBe(1);
  });

  test("a pre-POL-133 playlist SURFACE parses whole, every entry unzoomed", () => {
    const surface = PlaylistSurface.parse({
      id: "content-web",
      region: { x: 0, y: 0, w: 1920, h: 1080 },
      type: "playlist",
      items: [
        { kind: "web", url: "https://example.test/a", durationSeconds: 10 },
        { kind: "video", url: "https://example.test/b.mp4" },
      ],
      startedAt: "2026-07-15T00:00:00.000Z",
    });
    expect(surface.items.map((i) => i.zoom)).toEqual([1, 1]);
  });

  test("a pre-POL-133 embed element (empty props) parses with zoom 1", () => {
    const el = PageElement.parse({
      id: "pe-1",
      kind: "embed",
      x: 0,
      y: 0,
      w: 50,
      h: 50,
      props: {},
    });
    expect(el.kind).toBe("embed");
    if (el.kind === "embed") expect(el.props.zoom).toBe(1);
  });

  test("a pre-POL-133 feed element parses with fontScale 100 — the old sizing exactly", () => {
    const el = PageElement.parse({
      id: "pe-2",
      kind: "feed",
      x: 0,
      y: 0,
      w: 26,
      h: 42,
      props: { url: "https://example.test/rss", items: 4 },
    });
    if (el.kind === "feed") expect(el.props.fontScale).toBe(100);
  });

  test("a pre-POL-133 QR element parses with the old hardcoded colours", () => {
    const el = PageElement.parse({
      id: "pe-3",
      kind: "qr",
      x: 0,
      y: 0,
      w: 9,
      h: 16,
      props: { url: "https://example.com" },
    });
    if (el.kind === "qr") {
      expect(el.props.fg).toBe("#09090b");
      expect(el.props.bg).toBe("#ffffff");
    }
  });
});

describe("QR scannability gate (POL-133)", () => {
  const qr = (fg: string, bg: string) => ({
    id: "pe-qr",
    kind: "qr",
    x: 0,
    y: 0,
    w: 9,
    h: 16,
    props: { url: "https://example.com", fg, bg },
  });

  test("an unscannable pair (white on white) is REFUSED at the contract edge", () => {
    expect(PageElement.safeParse(qr("#ffffff", "#ffffff")).success).toBe(false);
    expect(PageElement.safeParse(qr("#dddddd", "#ffffff")).success).toBe(false);
  });

  test("a high-contrast brand pair is accepted", () => {
    expect(PageElement.safeParse(qr("#1a237e", "#ffffff")).success).toBe(true); // navy on white
    expect(PageElement.safeParse(qr("#09090b", "#fafafa")).success).toBe(true);
  });

  test("an inverted pair passes the schema but carries a loud warning for the Studio", () => {
    // Inverted QRs scan on most, not all, cameras — allowed, but the console must shout.
    expect(PageElement.safeParse(qr("#ffffff", "#09090b")).success).toBe(true);
    const issue = qrContrastIssue("#ffffff", "#09090b");
    expect(issue?.level).toBe("warn");
  });

  test("marginal contrast warns without refusing", () => {
    const issue = qrContrastIssue("#767676", "#ffffff"); // ~4.5:1 boundary region
    expect(issue === null || issue.level === "warn").toBe(true);
    const low = qrContrastIssue("#999999", "#ffffff"); // ~2.8:1 — below the floor
    expect(low?.level).toBe("refuse");
  });

  test("non-hex colours are unjudgeable, never refused", () => {
    expect(qrContrastIssue("rebeccapurple", "#ffffff")).toBeNull();
    expect(PageElement.safeParse(qr("rebeccapurple", "white")).success).toBe(true);
  });

  test("luminance/contrast helpers behave (3-digit hex, black/white extremes)", () => {
    expect(hexLuminance("#fff")).toBeCloseTo(1, 5);
    expect(hexLuminance("#000")).toBeCloseTo(0, 5);
    expect(hexLuminance("not-a-colour")).toBeNull();
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#000000", "#000000")).toBeCloseTo(1, 5);
  });
});

describe("SetPlaylistEntryZoomBody (POL-133)", () => {
  test("requires a source id and a zoom within the D62 bounds", () => {
    expect(SetPlaylistEntryZoomBody.safeParse({ sourceId: "source-1", zoom: 1.5 }).success).toBe(true);
    expect(SetPlaylistEntryZoomBody.safeParse({ sourceId: "", zoom: 1.5 }).success).toBe(false);
    expect(SetPlaylistEntryZoomBody.safeParse({ sourceId: "source-1", zoom: 9 }).success).toBe(false);
    expect(SetPlaylistEntryZoomBody.safeParse({ zoom: 1.5 }).success).toBe(false);
  });
});
