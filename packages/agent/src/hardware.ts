/**
 * What the box IS (POL-104) — the physical identity carried on every `agent/hello`.
 *
 * Two jobs, both on the SERVER side: matching a pre-registration (so a box an operator declared
 * before it ever booted names itself, tags itself and — if they said so — approves itself), and making
 * a pending-approval card informative. Commissioning a rack used to mean approving N identical UUIDs.
 *
 * NONE of this is a credential, and the server never treats it as one: the enrolment token is what
 * authenticates a box, and this is only consulted after that has already passed. Which is what makes
 * it acceptable to key on something as soft as a MAC — and it IS soft: a Wi-Fi-bridged VM's MAC is
 * rewritten by its host (the POL-63/POL-78 homelab lesson), so what a box reports is not always what
 * is printed on its sticker.
 *
 * Everything here is best-effort and unprivileged. `/sys/class/dmi/id/product_serial` is root-only on
 * most distributions, so an unprivileged agent typically CANNOT read it — we try, and simply omit the
 * field when we can't (`board_serial` and `product_uuid` are the same story). A missing field is
 * always omitted, never faked and never zeroed: a card that says nothing beats a card that lies.
 */
import { readFileSync } from "node:fs";
import { arch as osArch, networkInterfaces } from "node:os";

import type { HostIdentity } from "@polyptic/protocol";

/** Interface-name prefixes that are never a box's identity: loopback, containers, bridges, VPNs and
 *  the virtual devices a wall box's own stack brings up. */
const VIRTUAL_IFACE = /^(lo|docker|veth|br-|virbr|tun|tap|wg|zt|tailscale|utun|awdl|llw|bridge|vmnet)/i;

/** Read one `/sys/class/dmi/id/*` file. Unreadable (permissions, no DMI at all) → undefined. */
function readDmi(name: string): string | undefined {
  try {
    const value = readFileSync(`/sys/class/dmi/id/${name}`, "utf8").trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The box's non-virtual, non-loopback interface MACs, lower-case colon form, sorted + de-duplicated. */
export function readMacs(): string[] {
  const macs = new Set<string>();
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (VIRTUAL_IFACE.test(name)) continue;
    for (const addr of addrs ?? []) {
      if (addr.internal) continue;
      const mac = addr.mac?.toLowerCase();
      if (!mac || mac === "00:00:00:00:00:00") continue;
      macs.add(mac);
    }
  }
  return [...macs].sort();
}

/**
 * Sample the box's physical identity. Never throws — a host with no `/sys` (macOS dev laptop) or an
 * agent that may not read DMI simply reports its MACs and its architecture.
 */
export function readHostIdentity(): HostIdentity {
  const serial = readDmi("product_serial") ?? readDmi("board_serial");
  return {
    macs: readMacs(),
    ...(serial ? { dmiSerial: serial } : {}),
    ...(readDmi("product_name") ? { dmiProduct: readDmi("product_name") } : {}),
    ...(readDmi("sys_vendor") ? { dmiVendor: readDmi("sys_vendor") } : {}),
    arch: osArch(),
  };
}
