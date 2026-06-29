/**
 * Argument parsing + usage for `polyptych-agent setup`.
 *
 * Fully non-interactive (suits cloud-init / Ansible / a `.deb` postinst); every run is idempotent so
 * there is nothing to confirm. `--dry-run` previews the whole provision without touching the box.
 */

export type Backend = "wayland-sway" | "x11-i3" | "dev-open";
export type BrowserChoice = "chromium" | "cog";

export interface OutputPin {
  connector: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
}

export interface SetupOptions {
  mode: "install" | "uninstall";
  dryRun: boolean;
  help: boolean;
  /** Control-plane agent-channel URL → agent.toml `server_url`. */
  serverUrl?: string;
  /** One-time enrollment token → agent.toml `bootstrap_token`. */
  bootstrapToken?: string;
  backend: Backend;
  /** Kiosk login user (created if missing). */
  user: string;
  /** Single-output connector override → agent.toml `connector`. */
  connector?: string;
  /** Compositor output pins (positions/resolutions). */
  outputs: OutputPin[];
  browser: BrowserChoice;
  chromiumDeb?: string;
  chromiumPpa?: string;
  /** Path the systemd unit launches (the installed single binary). */
  agentBin: string;
  /** agent.toml path. */
  configPath: string;
  /** Actively `systemctl restart greetd` now (default: enable only; take effect on reboot). */
  start: boolean;
  /** Enable services + swap the display manager to greetd (default true). */
  enable: boolean;
  /** Install OS dependency packages (default true; `--skip-deps` to skip on pre-baked images). */
  installDeps: boolean;
  /** uninstall: also remove /etc/polyptych and the kiosk user. */
  purge: boolean;
}

function parseOutputPin(s: string): OutputPin {
  const m = /^([A-Za-z0-9_-]+)(?:=(\d+)x(\d+))?(?:@(-?\d+),(-?\d+))?$/.exec(s);
  if (!m || !m[1]) {
    throw new Error(`--output expects CONNECTOR[=WxH][@X,Y], e.g. DP-1=1920x1080@0,0 (got "${s}")`);
  }
  const pin: OutputPin = { connector: m[1] };
  if (m[2] && m[3]) {
    pin.width = Number(m[2]);
    pin.height = Number(m[3]);
  }
  if (m[4] !== undefined && m[5] !== undefined) {
    pin.x = Number(m[4]);
    pin.y = Number(m[5]);
  }
  return pin;
}

export function parseArgs(argv: string[]): SetupOptions {
  const opts: SetupOptions = {
    mode: "install",
    dryRun: false,
    help: false,
    backend: "wayland-sway",
    user: "kiosk",
    outputs: [],
    browser: "chromium",
    agentBin: "/usr/local/bin/polyptych-agent",
    configPath: "/etc/polyptych/agent.toml",
    start: false,
    enable: true,
    installDeps: true,
    purge: false,
  };

  const need = (i: number, name: string): string => {
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`flag ${name} requires a value`);
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    switch (a) {
      case "install":
        opts.mode = "install";
        break;
      case "uninstall":
      case "teardown":
      case "--uninstall":
        opts.mode = "uninstall";
        break;
      case "-n":
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "-h":
      case "--help":
        opts.help = true;
        break;
      case "--server-url":
        opts.serverUrl = need(i, a);
        i++;
        break;
      case "--bootstrap-token":
        opts.bootstrapToken = need(i, a);
        i++;
        break;
      case "--backend": {
        const v = need(i, a);
        i++;
        if (v !== "wayland-sway" && v !== "x11-i3" && v !== "dev-open") {
          throw new Error(`--backend must be wayland-sway | x11-i3 | dev-open (got "${v}")`);
        }
        opts.backend = v;
        break;
      }
      case "--user":
        opts.user = need(i, a);
        i++;
        break;
      case "--connector":
        opts.connector = need(i, a);
        i++;
        break;
      case "--output":
        opts.outputs.push(parseOutputPin(need(i, a)));
        i++;
        break;
      case "--browser": {
        const v = need(i, a);
        i++;
        if (v !== "chromium" && v !== "cog") {
          throw new Error(`--browser must be chromium | cog (got "${v}")`);
        }
        opts.browser = v;
        break;
      }
      case "--chromium-deb":
        opts.chromiumDeb = need(i, a);
        i++;
        break;
      case "--chromium-ppa":
        opts.chromiumPpa = need(i, a);
        i++;
        break;
      case "--agent-bin":
        opts.agentBin = need(i, a);
        i++;
        break;
      case "--config":
        opts.configPath = need(i, a);
        i++;
        break;
      case "--start":
        opts.start = true;
        break;
      case "--no-start":
        opts.start = false;
        break;
      case "--no-enable":
        opts.enable = false;
        break;
      case "--skip-deps":
        opts.installDeps = false;
        break;
      case "--purge":
        opts.purge = true;
        break;
      case "-y":
      case "--yes":
        // accepted for scripting symmetry; setup is already non-interactive + idempotent
        break;
      default:
        throw new Error(`unknown argument: ${a} (try --help)`);
    }
  }

  return opts;
}

export function usage(): string {
  return `polyptych-agent setup — provision a stock box into a Polyptych kiosk (D26/D27)

USAGE
  polyptych-agent setup [options]              provision (idempotent)
  polyptych-agent setup uninstall [--purge]    tear down / restore the prior display manager

WHAT IT DOES (each step idempotent + logged; --dry-run previews without changes)
  distro-detect (apt/dnf/pacman) -> install deps (greetd, sway, .deb Chromium, grim, wayvnc, fonts)
  -> create the kiosk user -> write /etc/greetd/config.toml (autologin -> compositor)
  -> write the sway/i3 config (pin outputs, no idle/blank, dpms on, hand off to systemd)
  -> write the systemd user unit(s) (polyptych-agent, Restart=always) -> write /etc/polyptych/agent.toml
  -> make greetd the display manager. Cold boot: greetd -> sway -> agent -> Chromium-per-output.

OPTIONS
  --server-url <wss://host/agent>   control-plane URL (-> agent.toml). Omit to write agent.toml.example.
  --bootstrap-token <token>         enrollment token for the server's GATED mode (2b).
  --backend <wayland-sway|x11-i3|dev-open>   default wayland-sway (x11-i3 = NVIDIA/fallback, D9).
  --user <name>                     kiosk login user (default: kiosk).
  --output <CONNECTOR[=WxH][@X,Y]>  pin a compositor output; repeatable. e.g. DP-1=1920x1080@0,0
  --connector <name>                single-output connector override (-> agent.toml).
  --browser <chromium|cog>          kiosk browser (default chromium; cog = WPE/WebKit fallback, D27).
  --chromium-deb <path|url>         install a specific .deb Chromium (Ubuntu snap avoidance).
  --chromium-ppa <ppa>              add a PPA that ships a real .deb Chromium (Ubuntu).
  --agent-bin <path>                binary the unit launches (default: /usr/local/bin/polyptych-agent).
  --config <path>                   agent.toml path (default: /etc/polyptych/agent.toml).
  --start                           also \`systemctl restart greetd\` now (default: take effect on reboot).
  --no-enable                       write configs but do not enable services / swap the display manager.
  --skip-deps                       do not install OS packages (pre-baked image).
  --purge                           (uninstall) also remove /etc/polyptych and the kiosk user.
  -n, --dry-run                     print the plan; make no changes (safe to run as non-root).
  -h, --help                        this help.

Run as root (sudo) for a real provision. After it completes: power-cycle (or --start) -> the agent
enrols over WSS -> approve the machine in the console.`;
}
