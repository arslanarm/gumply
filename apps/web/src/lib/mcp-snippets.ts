/**
 * Settings → MCP (A3, spec/mcp §5): the setup snippets for Claude Code and
 * Claude Desktop, filled with this vault and the right command. Pure, so the
 * quoting is unit-tested.
 */
import type { McpLaunchCommand } from "@gumply/core";

/** `gumply-<vault folder>`: one entry per vault in an AI app's config. */
export function mcpServerName(vaultPath: string): string {
  const folder = vaultPath.split(/[\\/]/).filter(Boolean).pop() ?? "";
  const slug = folder
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug ? `gumply-${slug}` : "gumply";
}

/** One shell word: double-quoted when needed, for POSIX shells or Windows. */
export function shellQuote(value: string, platform: string): string {
  if (/^[\w@%+=:,./-]+$/.test(value)) return value;
  if (platform === "win32") return `"${value.replace(/"/g, '\\"')}"`;
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** The full command an AI app runs: the launcher, its arguments, then this vault. */
export function mcpLaunchArgs(command: McpLaunchCommand, vaultPath: string): string[] {
  return [...command.args, "--vault", vaultPath];
}

/** `claude mcp add …` (user scope: it works in every project). */
export function claudeCodeSnippet(command: McpLaunchCommand, vaultPath: string, platform: string): string {
  const words = [command.command, ...mcpLaunchArgs(command, vaultPath)].map((word) => shellQuote(word, platform));
  return `claude mcp add --transport stdio --scope user ${mcpServerName(vaultPath)} -- ${words.join(" ")}`;
}

/** The `claude_desktop_config.json` block (JSON escapes Windows backslashes). */
export function claudeDesktopSnippet(command: McpLaunchCommand, vaultPath: string): string {
  const entry = { command: command.command, args: mcpLaunchArgs(command, vaultPath) };
  return JSON.stringify({ mcpServers: { [mcpServerName(vaultPath)]: entry } }, null, 2);
}

/** Where Claude Desktop keeps its config on this OS. */
export function claudeDesktopConfigPath(platform: string): string {
  if (platform === "darwin") return "~/Library/Application Support/Claude/claude_desktop_config.json";
  if (platform === "win32") return "%APPDATA%\\Claude\\claude_desktop_config.json";
  return "~/.config/Claude/claude_desktop_config.json";
}
