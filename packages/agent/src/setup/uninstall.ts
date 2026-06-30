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
import { AGENT_SERVICE, COMPOSITOR_LAUNCHER, SESSION_TARGET } from "./templates";
import { STATE_PATH, loadState } from "./state";

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

  // 3 ─ remove our systemd user units.
  log.step("remove systemd user units");
  sys.remove(`${UNIT_DIR}/${AGENT_SERVICE}`);
  sys.remove(`${UNIT_DIR}/${SESSION_TARGET}`);
  sys.exec("systemctl", ["daemon-reload"], { desc: "reload systemd manager", allowFail: true });

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

function restoreDisplayManager(
  sys: Sys,
  log: Logger,
  state: ReturnType<typeof loadState>,
  needsVerification: string[],
): void {
  log.step("restore display manager + default target");
  sys.exec("systemctl", ["disable", "greetd"], { desc: "disable greetd", allowFail: true });

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
