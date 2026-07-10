/**
 * inspector — pop surf's Web Inspector ON the wall for one output (POL-50).
 *
 * Why on-screen and not a remote DevTools tab: WebKitGTK has no browser-openable remote inspector.
 * `WEBKIT_INSPECTOR_SERVER` opens a port that speaks WebKit's own message protocol — not HTTP, not
 * WebSocket — and its only client is another WebKitGTK app opening `inspector://host:port`, which
 * surf itself cannot even load (it prepends `http://` to any unknown scheme). Verified against
 * libwebkit2gtk-4.1 2.52.3 on Ubuntu 26.04; see D63. So there is nothing to tunnel to an operator's
 * own browser, and the inspector is shown where the page is: on the panel.
 *
 * How it is driven: surf binds Ctrl+Shift+O to `toggleinspector`, but only when it was launched with
 * `-N` (see ./surf.ts). So the sequence is: relaunch that output's surf with `-N`, focus its window,
 * then synthesise the keystroke.
 *
 * Two traps, both found the hard way and both silent when you get them wrong:
 *   1. `xdotool key --window <id>` sends the event with `XSendEvent`, which **GTK ignores**. The key
 *      must go through XTEST (`xdotool key`, no `--window`), which delivers real input to whatever
 *      currently has X focus. Hence the caller must focus the window first.
 *   2. surf is an X11 client even under sway (it renders via XWayland), so `xdotool` is the right
 *      tool on BOTH backends — but it needs `DISPLAY`, which the sway config imports into the
 *      systemd user environment (D48).
 *
 * After the inspector opens we RELOAD the page (Ctrl+R). WebKit's inspector does not backfill:
 * console lines and network requests from a load that already finished are simply not there. The
 * motivating bug (a dashboard failing during its own boot) is invisible without this, so the reload
 * is the difference between an empty Network tab and the answer.
 */
import { delay, run, which } from "./proc";

/** surf's `toggleinspector` binding (surf(1)). Requires surf to have been launched with `-N`. */
export const INSPECTOR_TOGGLE_KEY = "ctrl+shift+o";
/** surf's `reload` binding (surf(1)). */
export const RELOAD_KEY = "ctrl+r";

/** Let the freshly-focused window settle before we synthesise input into it. */
const FOCUS_SETTLE_MS = 400;
/** Let the inspector attach + wire up its Network/Console agents before we reload the page. */
const INSPECTOR_OPEN_MS = 800;

/** Assert `xdotool` is present, with a clear remediation hint. */
export async function requireXdotool(): Promise<void> {
  if (!(await which("xdotool"))) {
    throw new Error(
      "xdotool not found — the on-screen inspector synthesises Ctrl+Shift+O into surf's window " +
        "and needs it (install xdotool; the Polyptic image ships it)",
    );
  }
}

/**
 * Open surf's Web Inspector on the currently-focused window, then reload so the inspector observes
 * the page's whole load. `focus` must have already put the target surf window in X focus.
 *
 * Best-effort by contract: the browser is already relaunched with `-N` and showing content, so a
 * failure here costs the operator their inspector, not the wall.
 */
export async function openInspectorOnFocusedWindow(log: (m: string) => void): Promise<void> {
  await requireXdotool();
  await delay(FOCUS_SETTLE_MS);

  // XTEST, NOT `--window` (see the module comment): GTK drops XSendEvent-delivered keys.
  const toggle = await run("xdotool", ["key", "--clearmodifiers", INSPECTOR_TOGGLE_KEY]);
  if (toggle.code !== 0) {
    throw new Error(
      `xdotool key ${INSPECTOR_TOGGLE_KEY} failed: ${toggle.stderr.trim() || `exit ${toggle.code}`}`,
    );
  }
  log(`sent ${INSPECTOR_TOGGLE_KEY} — surf Web Inspector opening`);

  await delay(INSPECTOR_OPEN_MS);
  const reload = await run("xdotool", ["key", "--clearmodifiers", RELOAD_KEY]);
  if (reload.code !== 0) {
    // The inspector IS open; it just starts empty. Say so rather than failing the whole action.
    log(
      `reload after opening the inspector failed (${reload.stderr.trim() || `exit ${reload.code}`}) — ` +
        `the inspector is open but its Console/Network start empty until the page reloads`,
    );
    return;
  }
  log(`sent ${RELOAD_KEY} — reloading so the inspector captures the full page load`);
}
