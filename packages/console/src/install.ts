/**
 * POL-176 — install-to-disk helpers for the Machines view.
 *
 * A live-booted box streams its whole OS image into RAM at every power-cycle; installing puts the
 * OS on an internal disk (A/B slots, updates staged by the box's own poll and applied on reboot).
 * These are the pure pieces the card and the install dialog lean on: which disks are offerable,
 * what the strips say, and when "update ready — reboot to apply" is true. Kept out of the component
 * so they stay testable.
 */
import type { MachineDisk, MachineView } from "@polyptic/protocol";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/** `256060514304` → `238 GiB` — the number an operator recognises a disk by. Sub-GiB disks (SD
 *  cards, weird virtual media) fall back to MiB rather than printing `0 GiB`. */
export function formatDiskSize(sizeBytes: number): string {
  const gib = sizeBytes / GIB;
  if (gib >= 10) return `${Math.round(gib)} GiB`;
  if (gib >= 1) return `${Math.round(gib * 10) / 10} GiB`;
  return `${Math.round(sizeBytes / MIB)} MiB`;
}

/** `20260709T110917Z-1bdb6281` → `20260709T110917Z · 1bdb6281` — the design's two-part image id
 *  (same treatment as the Settings build list). */
export function formatImageId(imageId: string): string {
  const cut = imageId.lastIndexOf("-");
  return cut > 0 ? `${imageId.slice(0, cut)} · ${imageId.slice(cut + 1)}` : imageId;
}

/** The disks the install dialog may offer: internal only. A removable medium (the USB stick the box
 *  booted from, an SD card) is never a valid target — the server 400s it too; filtering here keeps
 *  the dialog from offering a disk the request would refuse. */
export function installTargets(disks: MachineDisk[] | undefined): MachineDisk[] {
  return (disks ?? []).filter((d) => !d.removable);
}

type Installing = NonNullable<MachineView["installing"]>;

/** What each installer phase reads as on the card strip. */
const PHASE_LABEL: Record<Installing["phase"], string> = {
  starting: "starting",
  wiping: "wiping the disk",
  partitioning: "partitioning",
  fetching: "fetching the image",
  verifying: "verifying",
  "writing-loader": "writing the boot loader",
  "boot-entry": "setting the boot entry",
  done: "done",
  failed: "failed",
};

/** The install currently RUNNING on this box, or null — `done` and `failed` are outcomes, rendered
 *  by their own strips. */
export function activeInstall(m: Pick<MachineView, "installing">): Installing | null {
  const inst = m.installing;
  if (!inst || inst.phase === "done" || inst.phase === "failed") return null;
  return inst;
}

/** The active strip's headline: `Installing to disk — fetching the image (42%)`. */
export function installProgressText(installing: Installing): string {
  const pct = installing.percent != null ? ` (${Math.round(installing.percent)}%)` : "";
  return `Installing to disk — ${PHASE_LABEL[installing.phase]}${pct}`;
}

/**
 * "Update ready — reboot to apply": the box's poll has STAGED an image to its inactive slot and
 * that image differs from the one running (the live vitals' id when the box is talking, else the
 * persisted one). Suppressed while an install strip is on the card — one story at a time.
 */
export function updateReady(
  m: Pick<MachineView, "stagedImageId" | "imageId" | "vitals" | "installing">,
): boolean {
  if (!m.stagedImageId || m.installing) return false;
  const running = m.vitals?.imageId ?? m.imageId;
  return m.stagedImageId !== running;
}
