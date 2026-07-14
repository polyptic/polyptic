/**
 * POL-110 — is this box compositing on a GPU, or in software?
 *
 * D66 is blunt about the consequence of getting this wrong: on a wall box that fell back to software
 * rendering, animating opacity/transform/filter drops the promoted layer, repaints the whole region on
 * the CPU and pegs a core — which is how a wall ends up at 300% CPU showing a stuttering slideshow.
 * The crossfade (POL-110) IS an opacity animation, so it is opt-in AND capability-gated: unless the
 * player can PROVE the box is GPU-accelerated, it hard-cuts.
 *
 * The proof is local and needs no help from the agent (whose `gpuAccel` report is a separate ticket's
 * work and may not be there at all): ask WebGL who is drawing. Chrome answers with the real renderer
 * string — a discrete/integrated GPU through ANGLE, or `SwiftShader`/`llvmpipe`, which are exactly the
 * software rasterisers D66's box was stuck on. No WebGL context at all is also a "no": a box that
 * cannot get a GL context is not a box to animate on.
 *
 * The check runs ONCE, at startup, and its answer is a boolean the rotator reads — never a per-frame
 * cost. Its verdict is written to the diag trail, so a wall that hard-cuts despite a crossfade setting
 * SAYS why instead of looking broken.
 */

/** Renderer strings that mean "the CPU is drawing this". Matched case-insensitively, substring-wise. */
const SOFTWARE_RENDERERS = [
  "swiftshader",
  "llvmpipe",
  "softpipe",
  "software rasterizer",
  "microsoft basic render",
];

/** True when the WebGL renderer string names a software rasteriser (or says nothing useful). */
export function rendererIsSoftware(renderer: string | null | undefined): boolean {
  if (!renderer) return true; // unknown → assume the worst; a hard cut is never wrong
  const value = renderer.toLowerCase();
  return SOFTWARE_RENDERERS.some((needle) => value.includes(needle));
}

/** The renderer string this browser reports, or null when WebGL is unavailable / masked. */
export function readWebglRenderer(): string | null {
  try {
    const canvas = document.createElement("canvas");
    const gl = (canvas.getContext("webgl") ?? canvas.getContext("experimental-webgl")) as
      | WebGLRenderingContext
      | null;
    if (!gl) return null;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const raw = info
      ? (gl.getParameter(info.UNMASKED_RENDERER_WEBGL) as unknown)
      : (gl.getParameter(gl.RENDERER) as unknown);
    return typeof raw === "string" && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/** The one call the player makes: may this box be animated on? (Software rasteriser → no.) */
export function detectGpuAccelerated(): { accelerated: boolean; renderer: string | null } {
  const renderer = readWebglRenderer();
  return { accelerated: !rendererIsSoftware(renderer), renderer };
}
