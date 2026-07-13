/**
 * Static QR encoding for the page QR element — client-side, in the shared package, no network
 * (the pitch's call). `qrcode-generator` is a zero-dependency MIT encoder; we render its module
 * matrix as ONE SVG path (unit squares) so the element scales losslessly to any panel.
 */
import qrcode from "qrcode-generator";

interface QrRender {
  path: string;
  modules: number;
}

const cache = new Map<string, QrRender | null>();

function render(text: string): QrRender | null {
  if (!text.trim()) return null;
  const cached = cache.get(text);
  if (cached !== undefined) return cached;
  let result: QrRender | null = null;
  try {
    // Type 0 = auto-size to the data; M = the usual signage-grade error correction.
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const modules = qr.getModuleCount();
    let path = "";
    for (let row = 0; row < modules; row += 1) {
      for (let col = 0; col < modules; col += 1) {
        if (qr.isDark(row, col)) path += `M${col} ${row}h1v1h-1z`;
      }
    }
    result = { path, modules };
  } catch {
    result = null; // data too long for the largest symbol — render nothing rather than throw
  }
  // Bound the cache: studio keystrokes churn URLs; a page has few QR elements.
  if (cache.size > 64) cache.clear();
  cache.set(text, result);
  return result;
}

export function qrSvgPath(text: string): string | undefined {
  return render(text)?.path;
}

export function qrModuleCount(text: string): number {
  return render(text)?.modules ?? 0;
}
