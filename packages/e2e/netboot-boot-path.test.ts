/**
 * @polyptic/e2e, NETBOOT boot-path observability (POL-171).
 *
 * The 2026-07-21 field failure: a WIRED box's GRUB DHCP failed on its NIC, stage 1 silently fell
 * through to the stick's local Wi-Fi menu, and the box spent the whole day rendering the image that
 * menu PINS — rebuilds appeared to do nothing, and the only witness was /proc/cmdline. Three answers,
 * all pinned here:
 *
 *   1. Fallback boots ANNOUNCE themselves — every boot is tagged `polyptic.bootpath=` (wired menu →
 *      `wired`, local menus → `local`) and boot-path.sh reports a wired-capable box on the local
 *      chain to POST /boot/report, once per boot.
 *   2. TOTAL failure auto-dumps diagnostics — the stage-1 no-wire-no-payload path turns GRUB's own
 *      network narration on by itself, before the retry menu (was: behind a menu entry nobody at a
 *      hot wall dives for).
 *   3. Per-boot FORENSICS on the medium — boot-forensics.sh writes /polyptic/logs/boot-<ts>-<img>.txt
 *      (token REDACTED, wifi.conf never read, pruned to ~20), and offload.sh appends its verdict.
 *
 * The decision logic runs in the pure-shell suite (deploy/live/test/boot-path.test.sh); this file
 * runs it under bun/CI and pins the cross-file seams the shell suite cannot see.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BootReportCode, MachineBootPath } from "@polyptic/protocol";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const read = (...p: string[]): string => readFileSync(resolve(repoRoot, ...p), "utf8");
const liveLib = (f: string): string => read("deploy", "live", "usr", "local", "lib", "polyptic", f);

describe("boot-path: shell suite", () => {
  test("deploy/live/test/boot-path.test.sh passes", async () => {
    const proc = Bun.spawn(["sh", resolve(repoRoot, "deploy", "live", "test", "boot-path.test.sh")], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) console.error(out);
    expect(out).toContain("ALL PASS");
    expect(code).toBe(0);
  }, 60_000);
});

describe("every boot is tagged with the chain that produced it", () => {
  test("the local menus tag polyptic.bootpath=local", () => {
    // The renderer bakes the tag into `common`, so every local entry (live, live-latest, offload,
    // debug) carries it — the tag names the CHAIN, not the entry.
    expect(liveLib("render-local-grub.sh")).toContain("polyptic.bootpath=local");
  });

  test("the codes and the machine states are the same closed sets", () => {
    // The shell script, the protocol enum and the server's code→path map must agree; the protocol
    // is the source of truth, so the script's literals are pinned against it. `disk-boot` is
    // POL-176's addition: an installed box tagging its own normal path.
    for (const code of ["local-fallback-boot", "local-boot-wifi", "wired-boot", "disk-boot"] as const) {
      expect(BootReportCode.options).toContain(code);
      expect(liveLib("boot-path.sh")).toContain(code);
    }
    expect(MachineBootPath.options).toEqual(["wired", "local-fallback", "local-wifi", "disk"]);
  });

  test("the boot-path unit runs after the network, before the kiosk", () => {
    const unit = read("deploy", "live", "etc", "systemd", "system", "polyptic-boot-path.service");
    expect(unit).toContain("After=network-online.target");
    // POL-176 retired the offload unit; the installer runs off a path unit mid-session, so the
    // only ordering that still matters here is beating the kiosk to the glass.
    expect(unit).toContain("Before=greetd.service");
    expect(unit).toContain("ExecStart=/usr/local/lib/polyptic/boot-path.sh");
    // …and the image build enables it, or none of this exists on a real box.
    expect(read("deploy", "build-live-image.sh")).toContain("polyptic-boot-path.service");
  });
});

describe("the forensics writer never leaks a secret", () => {
  test("the token is redacted and wifi.conf is never read", () => {
    const forensics = liveLib("boot-forensics.sh");
    expect(forensics).toContain("polyptic.token=REDACTED");
    // wifi.conf may be NAMED (the comment that bans it) but never OPENED: no command in the script
    // takes it as an input path. The shell suite proves the PSK never lands; this pins the source.
    expect(forensics).not.toMatch(/(cat|sed|grep|head|tail|cp|<)[^\n]*wifi\.conf/);
  });

  test("install-to-disk.sh appends its verdict to THIS boot's log via the recorded path (POL-176)", () => {
    const installer = liveLib("install-to-disk.sh");
    expect(installer).toContain("append_forensics");
    expect(installer).toContain('_ff="$RUN_DIR/forensics-file"');
    // The append rides report(), so every outcome — success and every failure — lands on the medium.
    const reportFn = installer.slice(installer.indexOf("report() {"));
    expect(reportFn.slice(0, reportFn.indexOf("}"))).toContain("append_forensics");
  });
});
