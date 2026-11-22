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
  if (!argv.includes("--mcp")) return null;
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

/** How an AI app starts this app's MCP mode (before `--vault <path>`), for Settings → MCP. */
export function mcpLaunchCommand(execPath: string, packaged: boolean, appPath: string): { command: string; args: string[] } {
  // In development the executable is Electron itself, which needs the app folder first.
  return packaged ? { command: execPath, args: ["--mcp"] } : { command: execPath, args: [appPath, "--mcp"] };
}
