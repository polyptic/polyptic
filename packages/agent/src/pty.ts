/**
 * A real PTY for the remote-shell feature (POL-59), with NO native addon.
 *
 * The agent ships as a Bun single binary (`bun build --compile`), so a native module like `node-pty`
 * is out — it would break the cross-arch compile. Instead we bind libc's `openpty(3)` + the
 * `TIOCSWINSZ` ioctl through `bun:ffi`, which resolves the symbols at RUNTIME on the box, leaving the
 * compiled binary portable. The child shell is launched via `setsid --ctty` (util-linux, present in
 * the image) so it becomes a session leader with the PTY as its CONTROLLING terminal — without that,
 * `top`, editors, and Ctrl-C job control all misbehave.
 *
 * The shell runs as whatever user the agent runs as — the unprivileged `kiosk` user on a live box
 * (POL-59 decision: access, not display control). No privilege change happens here.
 *
 * Linux/glibc only. `spawnPty` returns null on any other host (dev laptops, the `dev-open` backend),
 * which the caller turns into a clean refusal.
 */
import { closeSync, read as fsRead, write as fsWrite } from "node:fs";

/**
 * `bun:ffi`, loaded once. It has no @types (no bun-types dep) and only resolves under Bun, so the
 * import is dynamic + loosely typed and its failure is swallowed — a non-Bun context leaves this
 * null and `spawnPty` returns null. The specifier is built at runtime so tsc/bundlers don't try to
 * resolve it statically. `await` at module top level is fine (ESM + Bun).
 */
let ffiModule: { dlopen: (...a: unknown[]) => any; FFIType: any; ptr: (a: unknown) => unknown } | null =
  null;
try {
  ffiModule = await import(["bun", "ffi"].join(":"));
} catch {
  ffiModule = null;
}

export interface Pty {
  /** Register the sink for PTY output (stdout+stderr of the shell). Call once. */
  onData(cb: (chunk: Buffer) => void): void;
  /** Write operator keystrokes here. */
  write(data: Buffer): void;
  /** Apply a new window size (kernel then SIGWINCHes the foreground group). */
  resize(cols: number, rows: number): void;
  /** Kill the shell and release the fds. Idempotent. */
  close(): void;
  /** Resolves with the shell's exit code (or null if killed) when it exits. */
  readonly exited: Promise<number | null>;
}

/** `struct winsize` is four `unsigned short`: ws_row, ws_col, ws_xpixel, ws_ypixel. */
function winsize(cols: number, rows: number): Uint8Array {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setUint16(0, rows, true); // ws_row
  new DataView(buf.buffer).setUint16(2, cols, true); // ws_col
  return buf;
}

/** ioctl request number for TIOCSWINSZ on Linux (arch-independent for this code). */
const TIOCSWINSZ = 0x5414;

/**
 * Open a PTY and start `shell` on its slave side. Returns null when a real PTY can't be had — a
 * non-Linux host, or libc/openpty unavailable — so the caller refuses cleanly.
 */
export function spawnPty(opts: {
  shell: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
  cwd: string;
}): Pty | null {
  if (process.platform !== "linux") return null;

  // `bun:ffi` has no @types under tsc (no bun-types dep) and only exists under Bun. It was loaded
  // once at module init (see `ffiModule` below); bail cleanly if that didn't happen.
  if (!ffiModule) return null;
  const { dlopen, FFIType, ptr } = ffiModule;

  // openpty(3) and ioctl(2) can live in DIFFERENT libraries: glibc merged openpty from libutil into
  // libc in 2.34, but on many systems (verified on arm64 resolute) the exported symbol is still ONLY
  // in libutil.so.1, while ioctl is ONLY in libc.so.6. A single combined dlopen therefore fails
  // whichever library it picks — so bind each symbol from whichever library actually has it.
  const openSym = <T extends Record<string, unknown>>(names: string[], symbols: T): any => {
    for (const name of names) {
      try {
        return dlopen(name, symbols);
      } catch {
        /* try the next library */
      }
    }
    return null;
  };
  const ptyLib = openSym(["libutil.so.1", "libc.so.6"], {
    openpty: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.int },
  });
  const ioctlLib = openSym(["libc.so.6", "libc.so"], {
    ioctl: { args: [FFIType.int, FFIType.u64, FFIType.ptr], returns: FFIType.int },
  });
  if (!ptyLib || !ioctlLib) {
    ptyLib?.close();
    ioctlLib?.close();
    return null;
  }
  // A tiny facade so the rest of the file reads as before.
  const lib = {
    symbols: { openpty: ptyLib.symbols.openpty, ioctl: ioctlLib.symbols.ioctl },
    close: () => {
      try {
        ptyLib.close();
      } catch {
        /* noop */
      }
      try {
        ioctlLib.close();
      } catch {
        /* noop */
      }
    },
  };

  const amaster = new Int32Array(1);
  const aslave = new Int32Array(1);
  const win = winsize(opts.cols, opts.rows);
  const rc = lib.symbols.openpty(ptr(amaster), ptr(aslave), null, null, ptr(win));
  if (rc !== 0) {
    try {
      lib.close();
    } catch {
      /* best effort */
    }
    return null;
  }
  const master = amaster[0]!;
  const slave = aslave[0]!;

  // `setsid --ctty` makes the shell a session leader owning the slave as its controlling terminal, so
  // job control + $TERM-driven programs behave. The slave is this process's stdio for the child.
  const child = Bun.spawn(["setsid", "--ctty", opts.shell, "-i"], {
    stdin: slave,
    stdout: slave,
    stderr: slave,
    cwd: opts.cwd,
    env: opts.env,
  });

  // The parent doesn't need the slave once the child holds it.
  try {
    closeSync(slave);
  } catch {
    /* the child owns it now */
  }

  let closed = false;
  let sink: ((chunk: Buffer) => void) | null = null;

  const close = (): void => {
    if (closed) return;
    closed = true;
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    try {
      closeSync(master);
    } catch {
      /* already closed */
    }
    try {
      lib.close();
    } catch {
      /* noop */
    }
  };

  // A PTY master is NOT seekable, so fs streams (createReadStream) throw ESPIPE trying to seek it.
  // Read with a plain fs.read loop at position `null` (current position, no seek). On PTY teardown
  // the read fails with EIO/EBADF — that is the normal end, not an error to surface.
  const buf = Buffer.allocUnsafe(65536);
  const readLoop = (): void => {
    if (closed) return;
    fsRead(master, buf, 0, buf.length, null, (err, bytes) => {
      if (closed) return;
      if (err || bytes === 0) {
        close();
        return;
      }
      sink?.(Buffer.from(buf.subarray(0, bytes)));
      readLoop();
    });
  };

  const exited = child.exited.then((code) => {
    close();
    return code;
  });

  return {
    onData: (cb) => {
      sink = cb;
      readLoop();
    },
    write: (data) => {
      if (closed) return;
      // fs.write to the master; position null = no seek. Fire-and-forget (keystrokes are tiny).
      fsWrite(master, data, 0, data.length, null, () => {});
    },
    resize: (cols, rows) => {
      if (closed) return;
      lib.symbols.ioctl(master, BigInt(TIOCSWINSZ), ptr(winsize(cols, rows)));
    },
    close,
    exited,
  };
}
