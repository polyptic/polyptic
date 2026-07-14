/**
 * POL-110 — the crossfade's safety catch (D66).
 *
 * Animating opacity on a software-rendering wall box drops the promoted layer, repaints the region on
 * the CPU and pegs a core. So the player refuses to animate unless it can PROVE the box is on a GPU,
 * and "prove" means the WebGL renderer string does not name a software rasteriser. The load-bearing
 * property is the direction of the doubt: anything we cannot read is treated as software.
 */
import { describe, expect, test } from "bun:test";

import { rendererIsSoftware } from "../src/gpu";

describe("rendererIsSoftware", () => {
  test("the software rasterisers D66 was written about", () => {
    expect(rendererIsSoftware("ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))")).toBe(true);
    expect(rendererIsSoftware("Mesa/X.org llvmpipe (LLVM 15.0.7, 256 bits)")).toBe(true);
    expect(rendererIsSoftware("softpipe")).toBe(true);
    expect(rendererIsSoftware("Microsoft Basic Render Driver")).toBe(true);
  });

  test("real GPUs — the only boxes allowed to fade", () => {
    expect(rendererIsSoftware("ANGLE (AMD, AMD Radeon Graphics (radeonsi, renoir), OpenGL 4.6)")).toBe(
      false,
    );
    expect(rendererIsSoftware("Mesa Intel(R) UHD Graphics (TGL GT1)")).toBe(false);
    expect(rendererIsSoftware("Apple M2")).toBe(false);
  });

  test("an unknown or missing renderer counts as SOFTWARE — a hard cut is never wrong", () => {
    expect(rendererIsSoftware(null)).toBe(true);
    expect(rendererIsSoftware(undefined)).toBe(true);
    expect(rendererIsSoftware("")).toBe(true);
  });
});
