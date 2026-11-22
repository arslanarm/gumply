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
 * #429bvzwr / #wfn2pdcx: how `--mcp` ends when the AI app closes stdin.
 * - The cleanup (the throwaway Chromium profile) is best effort: on Windows our
 *   own GPU and network-service children still hold files in it (ENOTEMPTY,
 *   EPERM). The next MCP start sweeps leftovers older than a day.
 * - Linux and macOS: the graceful exit (`app.exit`, `process.exit`), which ends
 *   the process.
 * - Windows: in MCP mode Electron's graceful quit never completes, and once
 *   `process.exit` has started Node's teardown no timer runs either (CI). So no
 *   graceful exit at all: Node's own exit (`process.reallyExit`, keeping the
 *   code) synchronously, and if that returns, `taskkill /F /T` on our own
 *   process tree (its GPU and network children included).
 */
export interface McpExitSteps {
  cleanup: () => void;
  graceful: (code: number) => void;
  reallyExit?: (code: number) => void;
  killTree: () => void;
}

export function exitMcp(platform: NodeJS.Platform | string, steps: McpExitSteps, code: number): void {
  try {
    steps.cleanup();
  } catch {
    // Left for the next start's sweep.
  }
  if (platform !== "win32") {
    steps.graceful(code);
    return;
  }
  steps.reallyExit?.(code);
  steps.killTree();
}

/**
 * A support tool for "the AI app can't connect" (#3cp6ysgs): with
 * `GUMPLY_MCP_TRACE=<file>` an `--mcp` launch appends how it was read and what
 * happened to that file. Never to stdio (stdout is the protocol), nothing when
 * the variable is unset, and best effort: a failed write is dropped and never
 * affects MCP. The file holds the vault path and the start of what the AI app
 * sent (docs/mcp.md says so).
 */
export function mcpTracer(
  file: string | undefined,
  append: (file: string, text: string) => void,
  stamp: () => string = () => `${new Date().toISOString()} [${process.pid}]`,
): (line: string) => void {
  if (!file) return () => {};
  return (line) => {
    try {
      append(file, `${stamp()} ${line}\n`);
    } catch {
      // A support aid only.
    }
  };
}
