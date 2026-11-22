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
export function mcpModeArgs(argv: readonly string[]): McpModeArgs | null {
  // A4: `gumply mcp --vault …` (the npm form) works too. A .deb puts the app at
  // /usr/bin/gumply, the npm bin's name, so that command must not open a window.
  // `mcp` is the first argument (packaged) or the one after the app folder (dev).
  const subcommand = argv[1] === "mcp" || (argv[2] === "mcp" && !argv[1]!.startsWith("-"));
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
export function mcpLaunchCommand(context: LaunchContext): { command: string; args: string[]; hint?: "appimage" | "macos-location" } {
  const { execPath, packaged, appPath, platform, appImage } = context;
  // Linux: MCP mode shows nothing, so it must not need a display. Without this
  // switch Chromium picks X11 or Wayland from the environment, and an AI app
  // started over SSH, on a headless box or with a stale XDG_SESSION_TYPE exits
  // before serving. It has to be on the command line: from main.ts it's too late.
  const mcp = platform === "linux" ? ["--mcp", "--ozone-platform=headless"] : ["--mcp"];
  if (!packaged) return { command: execPath, args: [appPath, ...mcp] };
  if (platform === "linux" && appImage && appImage.startsWith("/")) return { command: appImage, args: mcp, hint: "appimage" };
  // Run from the disk image or a translocated copy: that path goes away.
  if (platform === "darwin" && !/^\/Applications\/|^\/Users\/[^/]+\/Applications\//.test(execPath)) {
    return { command: execPath, args: ["--mcp"], hint: "macos-location" };
  }
  return { command: execPath, args: mcp };
}
