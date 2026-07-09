/**
 * Video decode packages (POL-46 regression).
 *
 * Found on a real wall: uploaded MP4s silently never played. `surf` (WebKitGTK) decodes <video>
 * through GStreamer and pulls plugins-base + plugins-good as hard deps — which cover WebM/VP8/VP9
 * but NOT H.264/AAC. Those live in the ffmpeg-backed `gstreamer1.0-libav`, a mere *recommends*, and
 * setup installs with --no-install-recommends. So the image shipped a browser that could not play
 * the format everyone uploads. These tests pin the decoders into every real kiosk backend.
 */
import { describe, expect, test } from "bun:test";

import { corePackages } from "../src/setup/distro";

describe("kiosk video decode", () => {
  test("apt kiosk backends install the ffmpeg-backed decoders (H.264/AAC)", () => {
    for (const backend of ["wayland-sway", "x11-i3"] as const) {
      expect(corePackages("apt", backend)).toContain("gstreamer1.0-libav");
      expect(corePackages("apt", backend)).toContain("gstreamer1.0-plugins-good");
    }
  });

  test("dnf and pacman carry their equivalents", () => {
    expect(corePackages("dnf", "wayland-sway")).toContain("gstreamer1-libav");
    expect(corePackages("pacman", "wayland-sway")).toContain("gst-libav");
  });

  test("dev-open stays minimal — it drives no display, so it needs no decoders", () => {
    expect(corePackages("apt", "dev-open")).not.toContain("gstreamer1.0-libav");
  });
});
