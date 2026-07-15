/**
 * POL-18 — the player-side predicate for agent-placed windows. Player.vue branches BOTH its probe
 * target list and its template on this one function, so pinning it here pins the whole contract:
 * a `placement: "window"` surface is never probed and never painted by the player.
 */
import { describe, expect, test } from "bun:test";

import { Surface } from "@polyptic/protocol";
import { isAgentPlacedWindow } from "../src/surface-style";

const region = { x: 0, y: 0, w: 1920, h: 1080 };

describe("isAgentPlacedWindow", () => {
  test("web/dashboard with placement 'window' are agent-placed", () => {
    const web = Surface.parse({
      id: "s1",
      type: "web",
      url: "https://blocks.example/",
      placement: "window",
      region,
    });
    const dash = Surface.parse({
      id: "s2",
      type: "dashboard",
      url: "https://dash.example/",
      placement: "window",
      region,
    });
    expect(isAgentPlacedWindow(web)).toBe(true);
    expect(isAgentPlacedWindow(dash)).toBe(true);
  });

  test("framed web (default placement) and media are the player's to render", () => {
    const web = Surface.parse({ id: "s1", type: "web", url: "https://a.example/", region });
    const img = Surface.parse({ id: "s2", type: "image", src: "https://a.example/x.png", region });
    const vid = Surface.parse({ id: "s3", type: "video", src: "https://a.example/x.mp4", region });
    expect(isAgentPlacedWindow(web)).toBe(false);
    expect(isAgentPlacedWindow(img)).toBe(false);
    expect(isAgentPlacedWindow(vid)).toBe(false);
  });

  test("a pre-POL-18 frame without the field parses to 'iframe' — never a hole", () => {
    // Zod fills the default, so an old stored slice can never render as an unexpected hole.
    const web = Surface.parse({ id: "s1", type: "web", url: "https://a.example/", region });
    expect(web.type === "web" && web.placement).toBe("iframe");
  });
});
