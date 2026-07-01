/**
 * `polyptic-agent setup --uninstall` — teardown / restore.
 *
 * Reverses the provision: disables greetd + the kiosk services and RESTORES the display manager and
 * default target that were in place before (recorded in /etc/polyptic/.setup-state.json at install),
 * so the box returns to its prior boot behaviour. `--purge` additionally removes /etc/polyptic
 * (agent.toml + the durable credential) and the kiosk user (only if setup created it).
 */
import { basename } from "node:path";
import type { Sys } from "./system";
import type { Logger } from "./log";
import type { SetupOptions } from "./args";
import type { SetupResult } from "./install";
import { AGENT_SERVICE, COMPOSITOR_LAUNCHER, ROLLBACK_SERVICE, ROLLBACK_TIMER, SESSION_TARGET } from "./templates";
import { OTA_SUDOERS_PATH } from "./ota";
import { PLYMOUTH_QUIT_DROPIN, PLYMOUTH_THEME_DIR } from "./plymouth";
import { STATE_PATH, loadState } from "./state";
import type { SetupState } from "./state";

const UNIT_DIR = "/etc/systemd/user";

export function runUninstall(sys: Sys, opts: SetupOptions, log: Logger): SetupResult {
  const needsVerification: string[] = [];
  const assumptions: string[] = [];
  const state = loadState(sys);
  const user = state.user ?? opts.user;
  const home = `/home/${user}`;

  log.banner(`Polyptic device teardown${opts.purge ? " (--purge)" : ""}`);

  // 1 ─ best-effort stop of a running agent in the kiosk user's session.
  log.step("stop the running kiosk agent (best-effort)");
  sys.exec("pkill", ["-u", user, "-f", "polyptic-agent"], {
    desc: `stop polyptic-agent for user ${user}`,
    allowFail: true,
  });

  // 2 ─ restore the display manager + default target (unless --no-enable).
  if (opts.enable) {
    restoreDisplayManager(sys, log, state, needsVerification);
  } else {
    log.step("restore display manager");
    log.skip("display-manager restore skipped (--no-enable)");
  }

  // 3 ─ remove our systemd user units (incl. the OTA rollback guard) + the reboot sudoers rule (POL-28).
  log.step("remove systemd user units");
  sys.remove(`${UNIT_DIR}/${AGENT_SERVICE}`);
  sys.remove(`${UNIT_DIR}/${SESSION_TARGET}`);
  sys.remove(`${UNIT_DIR}/${ROLLBACK_SERVICE}`);
  sys.remove(`${UNIT_DIR}/${ROLLBACK_TIMER}`);
  sys.remove(OTA_SUDOERS_PATH);
  sys.exec("systemctl", ["daemon-reload"], { desc: "reload systemd manager", allowFail: true });
  // The OTA slot tree lives under the kiosk home ($HOME/.polyptic/agent); it is removed with the user
  // on --purge (below). A non-purge teardown leaves it, harmless without the units.

  // 4 ─ greetd config: restore the original if we backed one up, else remove ours.
  log.step("restore/remove greetd config");
  if (!sys.restoreBackup("/etc/greetd/config.toml")) {
    sys.remove("/etc/greetd/config.toml");
  }

  // 5 ─ compositor config + launcher we wrote (leave the rest of the home dir untouched).
  log.step("remove compositor config");
  sys.remove(`${home}/.config/sway/config`);
  sys.remove(`${home}/.config/i3/config`);
  sys.remove(COMPOSITOR_LAUNCHER);

  // 5b ─ boot splash: restore the prior Plymouth theme + kernel cmdline (POL-7).
  teardownSplash(sys, log, state, needsVerification);

  // 6 ─ purge: agent config/credential + the kiosk user (only if we created it).
  if (opts.purge) {
    log.step("purge agent config + kiosk user");
    sys.remove("/etc/polyptic");
    if (state.createdUser) {
      sys.exec("userdel", ["-r", user], { desc: `remove kiosk user ${user} (and home)`, allowFail: true });
    } else {
      log.info(`kiosk user '${user}' pre-existed setup — left in place.`);
    }
  } else {
    log.step("keep agent config");
    log.info(
      `kept /etc/polyptic (agent.toml + credential) and the kiosk user. Use --purge to remove them. ` +
        `(${basename(STATE_PATH)} retained for reference.)`,
    );
  }

  log.banner("teardown complete");
  log.info("Power-cycle to boot into the restored display manager / target.");
  needsVerification.push(
    "Confirm the box boots back into its prior display manager (or to a console if none) after teardown.",
  );

  return { needsVerification, assumptions };
}

/** Reverse configureSplash: restore the prior Plymouth theme, remove our theme + cmdline edits. */
function teardownSplash(sys: Sys, log: Logger, state: SetupState, needsVerification: string[]): void {
  log.step("remove boot splash (restore Plymouth theme + kernel cmdline)");

  // 1 ─ restore the prior default theme (`-R` also rebuilds the initramfs), or note it.
  if (sys.which("plymouth-set-default-theme")) {
    if (state.priorPlymouthTheme) {
      sys.exec("plymouth-set-default-theme", ["-R", state.priorPlymouthTheme], {
        desc: `restore prior plymouth theme ${state.priorPlymouthTheme}`,
        allowFail: true,
      });
    } else {
      log.info("no prior plymouth theme recorded; leaving the distro default.");
      if (sys.which("update-initramfs")) {
        sys.exec("update-initramfs", ["-u"], { desc: "rebuild initramfs", allowFail: true });
      } else if (sys.which("dracut")) {
        sys.exec("dracut", ["-f"], { desc: "rebuild initramfs", allowFail: true });
      } else if (sys.which("mkinitcpio")) {
        sys.exec("mkinitcpio", ["-P"], { desc: "rebuild initramfs", allowFail: true });
      }
      needsVerification.push(
        "Boot splash removed but no prior Plymouth theme was recorded — set your preferred default theme if wanted.",
      );
    }
  }

  // 2 ─ remove our theme + the plymouth-quit drop-in.
  sys.remove(PLYMOUTH_THEME_DIR);
  sys.remove(PLYMOUTH_QUIT_DROPIN);
  sys.exec("systemctl", ["daemon-reload"], { desc: "reload systemd manager", allowFail: true });

  // 3 ─ restore the kernel cmdline we edited (backup written at install), then regenerate.
  if (sys.restoreBackup("/etc/default/grub")) {
    if (sys.which("update-grub")) {
      sys.exec("update-grub", [], { desc: "regenerate grub config", allowFail: true });
    } else if (sys.which("grub2-mkconfig")) {
      sys.exec("grub2-mkconfig", ["-o", "/boot/grub2/grub.cfg"], { desc: "regenerate grub2 config", allowFail: true });
    } else if (sys.which("grub-mkconfig")) {
      sys.exec("grub-mkconfig", ["-o", "/boot/grub/grub.cfg"], { desc: "regenerate grub config", allowFail: true });
    }
  }
  sys.restoreBackup("/boot/firmware/cmdline.txt");
  sys.restoreBackup("/boot/cmdline.txt");
}

function restoreDisplayManager(
  sys: Sys,
  log: Logger,
  state: ReturnType<typeof loadState>,
  needsVerification: string[],
): void {
  log.step("restore display manager + default target");
  sys.exec("systemctl", ["disable", "greetd"], { desc: "disable greetd", allowFail: true });

  // Undo the getty@tty1 mask install applied to free VT1 for greetd, so a normal text login returns.
  sys.exec("systemctl", ["unmask", "getty@tty1.service"], {
    desc: "unmask getty@tty1 (restore the VT1 text login)",
    allowFail: true,
  });

  if (state.priorDisplayManager) {
    sys.exec("systemctl", ["enable", state.priorDisplayManager], {
      desc: `re-enable prior display manager ${state.priorDisplayManager}`,
      allowFail: true,
    });
    log.info(`re-enabled prior display manager: ${state.priorDisplayManager}`);
  } else {
    log.info("no prior display manager was recorded (box was CLI/Server-minimal).");
    needsVerification.push(
      "No prior display manager existed: after teardown the box returns to the (text) default target " +
        "unless one is re-enabled manually.",
    );
  }

  if (state.priorDefaultTarget) {
    sys.exec("systemctl", ["set-default", state.priorDefaultTarget], {
      desc: `restore default target ${state.priorDefaultTarget}`,
      allowFail: true,
    });
  }
  sys.exec("systemctl", ["daemon-reload"], { desc: "reload systemd manager", allowFail: true });
}
