/**
 * `.gumply/mcp.json` (spec/mcp §2, D35): `{ enabled, access }`, per vault.
 * No file → enabled at `read`; an unreadable or invalid file → `read` too.
 * Read again on every write call, so lowering the level takes effect at once.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Access = "read" | "append" | "edit";
export const ACCESS_LEVELS: readonly Access[] = ["read", "append", "edit"];

export interface McpSettings {
  enabled: boolean;
  access: Access;
}

export const SETTINGS_FILE = join(".gumply", "mcp.json");

export function readSettings(vault: string): McpSettings {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(vault, SETTINGS_FILE), "utf8"));
  } catch {
    return { enabled: true, access: "read" };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { enabled: true, access: "read" };
  const data = raw as Record<string, unknown>;
  const access = ACCESS_LEVELS.includes(data.access as Access) ? (data.access as Access) : "read";
  return { enabled: data.enabled !== false, access };
}

export function rank(access: Access): number {
  return ACCESS_LEVELS.indexOf(access);
}

/** `--read-only` can only lower the level, never raise it. */
export function effectiveAccess(settings: McpSettings, readOnly: boolean): Access {
  return readOnly ? "read" : settings.access;
}
