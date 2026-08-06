/**
 * @polyptic/e2e — boot branding against the REAL control plane (POL-194).
 *
 * The unit suite (boot-brand.test.ts) pins the lockup and the validator. This one drives the routes:
 * an operator saves a brand under /api/v1, and a booting box — which has no session at all — then
 * pulls it back off the ungated boot depot as the PNG GRUB draws and as the source the image build
 * bakes into the Plymouth splash.
 *
 * The rasteriser is optional on a developer's machine, so the PNG assertions branch on whether
 * `rsvg-convert` is on PATH. That branch is the feature, not a concession: a control plane without a
 * rasteriser must serve the committed lockup and SAY SO, never 404 a path a wall is booting from.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 8113;
const BASE = `http://localhost:${PORT}`;
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const serverEntry = resolve(repoRoot, "packages", "server", "src", "index.ts");

const MARK =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M2 2h20v20H2z" fill="#f43f5e"/></svg>';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let proc: ReturnType<typeof Bun.spawn> | null = null;
let hasRasteriser = false;

async function put(markSvg: string | null, wordmark: string): Promise<Response> {
  return fetch(`${BASE}/api/v1/settings/boot-brand`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ markSvg, wordmark }),
  });
}

beforeAll(async () => {
  hasRasteriser = (await Bun.spawn(["sh", "-c", "command -v rsvg-convert"], { stdout: "ignore", stderr: "ignore" }).exited) === 0;
  proc = Bun.spawn(["bun", serverEntry], {
    cwd: repoRoot,
    env: {
      ...(process.env as Record<string, string>),
      STORE: "memory",
      PORT: String(PORT),
      AUTH_ENABLED: "false",
      LOG_LEVEL: "error",
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) {
        await res.body?.cancel();
        return;
      }
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error(`server did not become ready on ${BASE}`);
}, 40_000);

afterAll(() => {
  proc?.kill();
});

describe("a fresh control plane is on the Polyptic lockup", () => {
  test("GET /api/v1/settings/boot-brand reports no brand", async () => {
    const res = await fetch(`${BASE}/api/v1/settings/boot-brand`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ markSvg: null, wordmark: "", updatedAt: null, note: null });
  });

  test("GET /boot/logo.png serves the committed default, with a Content-Length GRUB requires", async () => {
    const res = await fetch(`${BASE}/boot/logo.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/png");
    expect(Number(res.headers.get("content-length"))).toBeGreaterThan(0);
    const png = new Uint8Array(await res.arrayBuffer());
    expect(png[0]).toBe(0x89); // PNG signature
    // The committed lockup is 480x210 — the size the GRUB theme paints at, with no rescale.
    const view = new DataView(png.buffer);
    expect(view.getUint32(16)).toBe(480);
    expect(view.getUint32(20)).toBe(210);
  });

  test("GET /boot/brand/mark.svg 404s and wordmark.txt is empty — both mean 'keep ours'", async () => {
    expect((await fetch(`${BASE}/boot/brand/mark.svg`)).status).toBe(404);
    const wordmark = await fetch(`${BASE}/boot/brand/wordmark.txt`);
    expect(wordmark.status).toBe(200);
    expect(await wordmark.text()).toBe("");
  });
});

describe("saving a brand", () => {
  test("PUT refuses a bad mark BY NAME rather than with 'invalid file'", async () => {
    const res = await put('<svg viewBox="0 0 1 1"><text>Acme</text></svg>', "");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("paths");
  });

  test("PUT refuses a wordmark past the cap", async () => {
    expect((await put(null, "W".repeat(200))).status).toBe(400);
  });

  test("PUT stores the mark + wordmark and reports whether this host could render it", async () => {
    const res = await put(MARK, "Northgate");
    expect(res.status).toBe(200);
    const brand = (await res.json()) as { markSvg: string; wordmark: string; updatedAt: string; note: string | null };
    expect(brand.markSvg).toBe(MARK);
    expect(brand.wordmark).toBe("Northgate");
    expect(brand.updatedAt).not.toBeNull();
    // A host with no rasteriser is a DEGRADATION with a sentence, never a failed save.
    if (hasRasteriser) expect(brand.note).toBeNull();
    else expect(brand.note).toContain("rasteriser");
  });

  test("the boot depot now hands the image build the operator's source", async () => {
    const mark = await fetch(`${BASE}/boot/brand/mark.svg`);
    expect(mark.status).toBe(200);
    expect(mark.headers.get("content-type")).toContain("image/svg+xml");
    expect(await mark.text()).toBe(MARK);
    expect(await (await fetch(`${BASE}/boot/brand/wordmark.txt`)).text()).toBe("Northgate");
  });

  test("GRUB's logo is the operator's render — at the same fixed size, and still decodable", async () => {
    const res = await fetch(`${BASE}/boot/logo.png`);
    expect(res.status).toBe(200);
    const png = Buffer.from(await res.arrayBuffer());
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    expect(view.getUint32(16)).toBe(480);
    expect(view.getUint32(20)).toBe(210);
    if (!hasRasteriser) return; // the committed default, which the previous suite already pinned

    // grub-png-check.sh is the gate every writer of theme bitmaps runs (POL-130). Running it on what
    // the ROUTE actually served is the assertion that matters: "file exists" is not "file loads".
    const tmp = `${process.env.TMPDIR ?? "/tmp"}/polyptic-e2e-brand-logo.png`;
    await Bun.write(tmp, png);
    const check = Bun.spawn(
      ["sh", resolve(repoRoot, "deploy/live/usr/local/lib/polyptic/grub-png-check.sh"), tmp],
      { stdout: "ignore", stderr: "ignore" },
    );
    expect(await check.exited).toBe(0);
  });
});

describe("removing a brand puts every screen back on the Polyptic lockup", () => {
  test("PUT with a null mark and an empty wordmark clears it", async () => {
    const res = await put(null, "");
    expect(res.status).toBe(200);
    const brand = (await res.json()) as { markSvg: string | null; wordmark: string; note: string | null };
    expect(brand.markSvg).toBeNull();
    expect(brand.wordmark).toBe("");
    // Nothing to render, so nothing to complain about — even on a host with no rasteriser.
    expect(brand.note).toBeNull();
  });

  test("and the depot is back to the committed default", async () => {
    expect((await fetch(`${BASE}/boot/brand/mark.svg`)).status).toBe(404);
    expect((await fetch(`${BASE}/boot/logo.png`)).status).toBe(200);
  });
});
