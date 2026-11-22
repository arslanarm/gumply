/**
 * `.gumply/mcp.json` (spec/mcp §2, D35): `{ enabled, access }`, per vault.
 * No file → enabled at `read`; an unreadable or invalid file → `read` too.
 * Read again on every write call, so lowering the level takes effect at once.
 * The format lives in core (`mcp-settings.ts`), shared with the app's
 * Settings → MCP (A3).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MCP_ACCESS_LEVELS, MCP_SETTINGS_PATH, parseMcpSettings, type McpAccess, type McpSettings } from "@gumply/core";

export type Access = McpAccess;
export type { McpSettings };
export const ACCESS_LEVELS: readonly Access[] = MCP_ACCESS_LEVELS;

export const SETTINGS_FILE = join(...MCP_SETTINGS_PATH.split("/"));

export function readSettings(vault: string): McpSettings {
  let text: string | null = null;
  try {
    text = readFileSync(join(vault, SETTINGS_FILE), "utf8");
  } catch {
    text = null;
  }
  return parseMcpSettings(text);
}

export function rank(access: Access): number {
  return ACCESS_LEVELS.indexOf(access);
}

/** `--read-only` can only lower the level, never raise it. */
export function effectiveAccess(settings: McpSettings, readOnly: boolean): Access {
  return readOnly ? "read" : settings.access;
}
