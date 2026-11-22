/**
 * The desktop app's MCP mode (spec/mcp §1, v0.8 A3): `Gumply --mcp --vault
 * <path> [--read-only]` runs the same stdio MCP server as `gumply mcp`, with
 * no window, menu, tray or single-instance lock, so an AI app can start it
 * while the app is open. The packaged app can't run as plain Node (the
 * RunAsNode fuse is off), hence a flag on the app itself.
 */

export interface McpModeArgs {
  /** As given (resolved by the caller); null when `--vault` is missing. */
  vault: string | null;
  readOnly: boolean;
}

/**
 * The MCP mode's arguments, or null when this launch isn't one. Flags Electron
 * or Chromium add (`--no-sandbox`, `--enable-logging`…) are ignored.
 */
export function mcpModeArgs(argv: readonly string[], firstUserArg = 1): McpModeArgs | null {
  // A4: `gumply mcp --vault …` (the npm form) works too. A .deb puts the app at
  // /usr/bin/gumply, the npm bin's name, so that command must not open a window.
  // Only when `mcp` is exactly the first user argument (`firstUserArg`: 1 when
  // packaged, 2 in development after the app folder): a vault or file named
  // `mcp` anywhere else still opens the app.
  const subcommand = argv[firstUserArg] === "mcp";
  if (!argv.includes("--mcp") && !subcommand) return null;
  let vault: string | null = null;
  let readOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--vault") vault = argv[index + 1] ?? null;
    else if (arg.startsWith("--vault=")) vault = arg.slice("--vault=".length) || null;
    else if (arg === "--read-only") readOnly = true;
  }
  return { vault, readOnly };
}

export const MCP_MODE_USAGE = "Usage: Gumply --mcp --vault <path> [--read-only]";

export interface LaunchContext {
  /** `process.execPath`. */
  execPath: string;
  /** `app.isPackaged`. */
  packaged: boolean;
  /** `app.getAppPath()`: the app folder Electron needs first in development. */
  appPath: string;
  platform: NodeJS.Platform | string;
  /** `APPIMAGE`: the .AppImage file itself (Linux AppImage launches only). */
  appImage?: string;
  /** #4ckqijua: `userNamespacesWork()` (development on Linux only; packaged builds don't need it). */
  userNamespaces?: boolean;
  /** #4ckqijua: `hasFusermount()` (AppImage launches only). */
  fusermount?: boolean;
}

/**
 * #4ckqijua: the probe electron-builder's AppImage `AppRun` uses before adding
 * `--no-sandbox` (`unshare -Ur true`): the kernel has user namespaces and an
 * unprivileged process may create one and map itself in it. Ubuntu 23.10+ restricts that through AppArmor
 * (`kernel.apparmor_restrict_unprivileged_userns = 1`) for any binary without a
 * profile; the `.deb` installs one for /opt/Gumply/gumply, and AppRun handles
 * the AppImage, but development Electron (node_modules) has neither.
 */
export function userNamespacesWork(
  exists: (path: string) => boolean,
  run: (command: string, args: string[]) => number | null,
): boolean {
  // `-Ur` (map root), exactly as AppRun: under Ubuntu's restriction a bare
  // `unshare --user` still succeeds, but mapping a uid is refused, and that is
  // what Chromium's namespace sandbox needs.
  return exists("/proc/self/ns/user") && run("unshare", ["-Ur", "true"]) === 0;
}

/** #4ckqijua: the static AppImage runtime mounts itself with `fusermount` (from fuse3, or fuse 2). */
export function hasFusermount(exists: (path: string) => boolean): boolean {
  return ["/usr/bin", "/bin", "/usr/local/bin"].some((dir) => exists(`${dir}/fusermount3`) || exists(`${dir}/fusermount`));
}

/**
 * How an AI app starts this app's MCP mode (before `--vault <path>`), for
 * Settings → MCP (A4). The AI app starts it without a login shell or the
 * user's PATH, so the command is always an absolute path that still exists
 * when the app isn't running:
 * - AppImage: `$APPIMAGE`, the file itself. `execPath` is inside the image's
 *   temporary mount, which is gone once Gumply quits;
 * - .deb (`/opt/Gumply/gumply`), Windows and macOS installs: `execPath`;
 * - development: Electron with the app folder first;
 * - on Linux, `--ozone-platform=headless` too (no display needed).
 * `hint` names a location the user may move, so the dialog can say to copy
 * the snippet again afterwards.
 */
export function mcpLaunchCommand(context: LaunchContext): {
  command: string;
  args: string[];
  hint?: "appimage" | "macos-location";
  warning?: "fuse";
} {
  const { execPath, packaged, appPath, platform, appImage } = context;
  // Linux: MCP mode shows nothing, so it must not need a display. Without this
  // switch Chromium picks X11 or Wayland from the environment, and an AI app
  // started over SSH, on a headless box or with a stale XDG_SESSION_TYPE exits
  // before serving. It has to be on the command line: from main.ts it's too late.
  const mcp = platform === "linux" ? ["--mcp", "--ozone-platform=headless"] : ["--mcp"];
  if (!packaged) {
    // #4ckqijua: development Electron has no AppArmor profile and no AppRun, so
    // where user namespaces are restricted Chromium's sandbox can't start and
    // aborts ("SUID sandbox helper… not configured"). Apply AppRun's own rule:
    // without working user namespaces, run without the sandbox. MCP mode never
    // creates a window or loads web content, so the sandbox protects nothing
    // there. Packaged builds keep theirs (AppArmor profile, or AppRun decides).
    const sandbox = platform === "linux" && context.userNamespaces === false ? ["--no-sandbox"] : [];
    return { command: execPath, args: [appPath, ...mcp, ...sandbox] };
  }
  if (platform === "linux" && appImage && appImage.startsWith("/")) {
    // The static runtime needs a `fusermount` to mount itself (#4ckqijua): say so instead of failing silently.
    return { command: appImage, args: mcp, hint: "appimage", ...(context.fusermount === false ? { warning: "fuse" as const } : {}) };
  }
  // Run from the disk image or a translocated copy: that path goes away.
  if (platform === "darwin" && !/^\/Applications\/|^\/Users\/[^/]+\/Applications\//.test(execPath)) {
    return { command: execPath, args: ["--mcp"], hint: "macos-location" };
  }
  return { command: execPath, args: mcp };
}

/**
 * #429bvzwr: how `--mcp` ends. The cleanup (the throwaway Chromium profile) is
 * best effort: on Windows our own GPU and network-service child processes
 * still hold files in it, so removing it can throw (ENOTEMPTY), and that must
 * never stop the exit, or the process lingers after the AI app closed stdin.
 * The next MCP start sweeps leftovers older than a day.
 */
export function exitAfterCleanup(
  cleanup: () => void,
  exit: (code: number) => void,
  code: number,
  /**
   * #wfn2pdcx: a guaranteed end. On Windows, in MCP mode, Electron's
   * `app.exit`/`process.exit` only schedule a quit that never completes
   * (CI: the process lingered after "exit 0" with no error). So a hard exit is
   * armed first and fires after `graceMs` if we're still alive.
   */
  hard?: { exit: (code: number) => void; graceMs: number; setTimer?: (fn: () => void, ms: number) => unknown },
): void {
  try {
    cleanup();
  } catch {
    // Left for the next start's sweep.
  }
  if (hard) (hard.setTimer ?? setTimeout)(() => hard.exit(code), hard.graceMs);
  exit(code);
}

