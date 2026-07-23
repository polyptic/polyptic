/**
 * POL-176 — install-to-disk: the agent-side parsers and gates.
 *
 * Everything here is the PURE surface of src/install.ts: how the agent decides live vs installed,
 * how an lsblk inventory becomes the wire's disk list, how the update-state and install-status
 * files are read, and — the load-bearing one — which install requests the agent REFUSES. The
 * destructive path is `wipe the named disk`, so the refusal table is pinned line by line.
 */
import { describe, expect, test } from "bun:test";

import {
  bootModeFromCmdline,
  installRefusal,
  isTerminalPhase,
  parseInstallStatusLine,
  parseLsblkDisks,
  parseUpdateState,
  tailInstallStatus,
} from "../src/install";
import type { MachineDisk } from "@polyptic/protocol";

// ─────────────────────────────────────────────────────────────────────────────
// bootModeFromCmdline
// ─────────────────────────────────────────────────────────────────────────────

describe("bootModeFromCmdline (POL-176)", () => {
  test("polyptic.bootpath=disk means INSTALLED", () => {
    const cmdline =
      "BOOT_IMAGE=/vmlinuz root=/dev/sda2 polyptic.bootpath=disk polyptic.server_url=ws://cp/agent quiet splash";
    expect(bootModeFromCmdline(cmdline, false)).toBe("installed");
  });

  test("a netbooted cmdline (polyptic.bootpath=wired) is LIVE", () => {
    const cmdline =
      "root=live:http://cp/dist/image/amd64/rootfs.squashfs rd.overlay=1 polyptic.bootpath=wired quiet splash";
    expect(bootModeFromCmdline(cmdline, false)).toBe("live");
  });

  test("a local-medium boot (polyptic.bootpath=local) is LIVE", () => {
    expect(bootModeFromCmdline("root=live:… polyptic.bootpath=local", false)).toBe("live");
  });

  test("an older live boot with polyptic params but NO bootpath tag is LIVE", () => {
    expect(bootModeFromCmdline("polyptic.server_url=ws://cp/agent quiet", false)).toBe("live");
  });

  test("a live-ISO boot (root=live:CDLABEL=…, no polyptic params) is LIVE", () => {
    expect(bootModeFromCmdline("BOOT_IMAGE=/vmlinuz root=live:CDLABEL=POLYPTIC quiet", false)).toBe("live");
  });

  test("a box with only /etc/polyptic/image-id (no polyptic cmdline) is LIVE", () => {
    expect(bootModeFromCmdline("BOOT_IMAGE=/vmlinuz root=/dev/mapper/vg-root ro", true)).toBe("live");
  });

  test("a plain Linux host with neither reports NOTHING — never a guess", () => {
    expect(bootModeFromCmdline("BOOT_IMAGE=/vmlinuz root=UUID=abcd ro quiet", false)).toBeUndefined();
  });

  test("no readable cmdline at all reports nothing (unless the image-id stamp says live)", () => {
    expect(bootModeFromCmdline(null, false)).toBeUndefined();
    expect(bootModeFromCmdline(null, true)).toBe("live");
  });

  test("`polyptic.bootpath=disk` must be a whole parameter, not a substring of something else", () => {
    expect(bootModeFromCmdline("mypolyptic.bootpath=diskish polyptic.base=http://cp", false)).toBe("live");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseLsblkDisks
// ─────────────────────────────────────────────────────────────────────────────

const LSBLK_FIXTURE = JSON.stringify({
  blockdevices: [
    {
      name: "sda",
      type: "disk",
      size: 256_060_514_304,
      model: "SAMSUNG MZ7LN256",
      rm: false,
      fstype: null,
      label: null,
      children: [
        { name: "sda1", type: "part", size: 536870912, rm: false, fstype: "vfat", label: "ESP" },
        { name: "sda2", type: "part", size: 255000000000, rm: false, fstype: "ext4", label: "Ubuntu 24.04" },
      ],
    },
    {
      name: "sdb",
      type: "disk",
      size: 15_931_539_456,
      model: "USB Flash Disk",
      rm: true,
      fstype: "vfat",
      label: "POLYPTIC",
    },
    { name: "zram0", type: "disk", size: 8_000_000_000, rm: false },
    { name: "loop0", type: "loop", size: 500_000_000, rm: false, fstype: "squashfs" },
    { name: "nvme0n1", type: "disk", size: 512_110_190_592, model: null, rm: false },
  ],
});

describe("parseLsblkDisks (POL-176)", () => {
  const disks = parseLsblkDisks(LSBLK_FIXTURE) ?? [];

  test("only real top-level disks survive: no zram, no loop, no partitions", () => {
    expect(disks.map((d) => d.device)).toEqual(["/dev/sda", "/dev/sdb", "/dev/nvme0n1"]);
  });

  test("the internal SSD carries model, size, and a human contents summary", () => {
    const sda = disks[0] as MachineDisk;
    expect(sda.sizeBytes).toBe(256_060_514_304);
    expect(sda.model).toBe("SAMSUNG MZ7LN256");
    expect(sda.removable).toBe(false);
    // The summary is what the console's destructive confirm shows: fstype (label) per partition.
    expect(sda.contents).toBe("vfat (ESP), ext4 (Ubuntu 24.04)");
  });

  test("a USB stick is flagged removable (never a valid install target)", () => {
    const sdb = disks[1] as MachineDisk;
    expect(sdb.removable).toBe(true);
    expect(sdb.contents).toBe("vfat (POLYPTIC)");
  });

  test("a blank disk says `empty`, and a null model is simply absent", () => {
    const nvme = disks[2] as MachineDisk;
    expect(nvme.contents).toBe("empty");
    expect(nvme.model).toBeUndefined();
  });

  test("older lsblk string forms parse too (rm: \"1\", size as a string)", () => {
    const parsed = parseLsblkDisks(
      JSON.stringify({ blockdevices: [{ name: "sda", type: "disk", size: "1000", rm: "1" }] }),
    );
    expect(parsed).toEqual([
      { device: "/dev/sda", sizeBytes: 1000, removable: true, contents: "empty" },
    ]);
  });

  test("garbage is null (unknown), an empty device list is [] (known: no disks)", () => {
    expect(parseLsblkDisks("not json")).toBeNull();
    expect(parseLsblkDisks("{}")).toBeNull();
    expect(parseLsblkDisks(JSON.stringify({ blockdevices: [] }))).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseUpdateState
// ─────────────────────────────────────────────────────────────────────────────

describe("parseUpdateState (POL-176)", () => {
  test("reads running and staged, verbatim", () => {
    expect(parseUpdateState("running=20260720T000000Z-aaaa1111\nstaged=20260723T000000Z-bbbb2222\n")).toEqual({
      running: "20260720T000000Z-aaaa1111",
      staged: "20260723T000000Z-bbbb2222",
    });
  });

  test("staged == running is still reported — the CONSOLE compares, not the box", () => {
    const state = parseUpdateState("running=X\nstaged=X\n");
    expect(state.staged).toBe("X");
  });

  test("unknown lines, blank values and junk are ignored without a claim", () => {
    expect(parseUpdateState("# comment\nslot=b\nstaged=\n")).toEqual({});
    expect(parseUpdateState("")).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseInstallStatusLine
// ─────────────────────────────────────────────────────────────────────────────

describe("parseInstallStatusLine (POL-176)", () => {
  test("a progress line carries phase, percent and detail", () => {
    expect(parseInstallStatusLine("fetching|42|rootfs.squashfs 210 MiB of 492 MiB")).toEqual({
      phase: "fetching",
      percent: 42,
      detail: "rootfs.squashfs 210 MiB of 492 MiB",
    });
  });

  test("`-` percent means unknown and is omitted, never zeroed", () => {
    expect(parseInstallStatusLine("wiping|-|sgdisk --zap-all /dev/sda")).toEqual({
      phase: "wiping",
      detail: "sgdisk --zap-all /dev/sda",
    });
  });

  test("the detail may itself contain pipes — only the first two are structural", () => {
    expect(parseInstallStatusLine("failed|-|curl: (7) refused | retried 3x")?.detail).toBe(
      "curl: (7) refused | retried 3x",
    );
  });

  test("terminal lines are done|100 and failed|-", () => {
    expect(parseInstallStatusLine("done|100|installed to /dev/sda, slot A")?.phase).toBe("done");
    expect(isTerminalPhase("done")).toBe(true);
    expect(isTerminalPhase("failed")).toBe(true);
    expect(isTerminalPhase("fetching")).toBe(false);
  });

  test("an unknown phase or a torn line is dropped, not forwarded", () => {
    expect(parseInstallStatusLine("exploding|50|what")).toBeNull();
    expect(parseInstallStatusLine("fetching")).toBeNull();
    expect(parseInstallStatusLine("")).toBeNull();
  });

  test("an out-of-range percent is clamped to the contract's 0–100", () => {
    expect(parseInstallStatusLine("fetching|170|x")?.percent).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// installRefusal — the destructive-action gate
// ─────────────────────────────────────────────────────────────────────────────

describe("installRefusal (POL-176) — the agent's own gate under the operator's confirm", () => {
  const disks: MachineDisk[] = [
    { device: "/dev/sda", sizeBytes: 256e9, removable: false, contents: "empty" },
    { device: "/dev/sdb", sizeBytes: 16e9, removable: true, contents: "vfat (POLYPTIC)" },
  ];

  test("a live box installing to its inventoried internal disk is allowed", () => {
    expect(installRefusal("/dev/sda", "live", disks)).toBeNull();
  });

  test("an INSTALLED box refuses — it would wipe the disk it is running from", () => {
    expect(installRefusal("/dev/sda", "installed", disks)).toContain("already runs from its internal disk");
  });

  test("a box with no boot mode (dev / non-fleet) refuses", () => {
    expect(installRefusal("/dev/sda", undefined, disks)).toContain("did not boot a Polyptic live image");
  });

  test("a device the box never reported refuses — nothing outside the inventory is touchable", () => {
    expect(installRefusal("/dev/sdc", "live", disks)).toContain("not a disk this box reported");
    expect(installRefusal("/dev/sda", "live", undefined)).toContain("not a disk this box reported");
  });

  test("removable media refuses — the boot stick must never be the install target", () => {
    expect(installRefusal("/dev/sdb", "live", disks)).toContain("removable media");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// tailInstallStatus — forwarding, truncation, termination
// ─────────────────────────────────────────────────────────────────────────────

/** A scripted file: each poll reads the current content (null = not created yet). */
function scriptedReader(states: Array<string | null>): () => Promise<string | null> {
  let i = 0;
  return () => Promise.resolve(states[Math.min(i++, states.length - 1)] ?? null);
}

async function drain(
  states: Array<string | null>,
  opts: { timeoutMs?: number } = {},
): Promise<{ lines: string[]; end: string }> {
  const lines: string[] = [];
  const end = await new Promise<string>((resolve) => {
    tailInstallStatus(
      (line) => lines.push(`${line.phase}${line.percent !== undefined ? `@${line.percent}` : ""}`),
      (why) => resolve(why),
      { read: scriptedReader(states), pollMs: 1, timeoutMs: opts.timeoutMs ?? 5_000 },
    );
  });
  return { lines, end };
}

describe("tailInstallStatus (POL-176)", () => {
  test("forwards each NEW complete line once, and stops on done", async () => {
    const { lines, end } = await drain([
      null, // installer not started yet
      "starting|0|\n",
      "starting|0|\nwiping|-|zap\nfetching|10|x\n",
      "starting|0|\nwiping|-|zap\nfetching|10|x\ndone|100|installed\n",
    ]);
    expect(lines).toEqual(["starting@0", "wiping", "fetching@10", "done@100"]);
    expect(end).toBe("done");
  });

  test("a torn (newline-less) last line waits for its newline instead of forwarding half a line", async () => {
    const { lines } = await drain([
      "starting|0|\nfetching|1",
      "starting|0|\nfetching|12|x\ndone|100|ok\n",
    ]);
    expect(lines).toEqual(["starting@0", "fetching@12", "done@100"]);
  });

  test("truncation (the installer restarting its file) restarts the tail from the top", async () => {
    const { lines, end } = await drain([
      "starting|0|\nwiping|-|zap\n",
      "starting|0|\n", // truncated + rewritten from scratch
      "starting|0|\nfailed|-|disk vanished\n",
    ]);
    expect(lines).toEqual(["starting@0", "wiping", "starting@0", "failed"]);
    expect(end).toBe("failed");
  });

  test("an installer that never concludes is abandoned at the timeout", async () => {
    const { end } = await drain(["starting|0|\n"], { timeoutMs: 15 });
    expect(end).toBe("timeout");
  });
});
