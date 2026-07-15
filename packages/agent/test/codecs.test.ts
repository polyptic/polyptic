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

/**
 * Cast hardware-decode packages (POL-144/D135 regression).
 *
 * A real iPhone mirror came through torn and banded on an Intel wall box: the image shipped the
 * GStreamer `va` decode plugin (in plugins-bad) but no VA DRIVER, so UxPlay's decodebin fell back to
 * software avdec_h264 and the CPU-bound frames reached waylandsink through its SHM stride path. The
 * fix ships a vendor-neutral VA driver so H.264 decodes in hardware to dmabuf. These tests pin it so
 * a future package trim cannot silently reintroduce the software path.
 */
describe("cast hardware decode", () => {
  test("apt wayland-sway ships the VA driver + diagnostics behind the cast receiver", () => {
    const pkgs = corePackages("apt", "wayland-sway");
    expect(pkgs).toContain("va-driver-all");
    expect(pkgs).toContain("vainfo");
    // The `va` decode plugin itself rides inside plugins-bad, which cast already pulls.
    expect(pkgs).toContain("gstreamer1.0-plugins-bad");
  });

  test("the VA driver rides ONLY with the cast-capable backend, never x11-i3 or dev-open", () => {
    // Cast is wayland-sway-only (POL-67/D111); the VA path has no reason to land elsewhere.
    expect(corePackages("apt", "x11-i3")).not.toContain("va-driver-all");
    expect(corePackages("apt", "dev-open")).not.toContain("va-driver-all");
  });
});
