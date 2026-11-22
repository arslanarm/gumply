/**
 * MCP settings and audit log formats (spec/mcp §2 and §4, D35), shared by
 * the MCP server (`apps/mcp`) and the app's Settings → MCP (A3). Pure: the
 * callers read and write the files.
 *
 * `.gumply/mcp.json` is `{ "enabled": true, "access": "read" | "append" | "edit" }`.
 * No file, an unreadable one or an invalid one means enabled at `read`.
 */

export type McpAccess = "read" | "append" | "edit";
export const MCP_ACCESS_LEVELS: readonly McpAccess[] = ["read", "append", "edit"];

export interface McpSettings {
  enabled: boolean;
  access: McpAccess;
}

/** Vault-relative, with `/` (callers join it with the platform's separator). */
export const MCP_SETTINGS_PATH = ".gumply/mcp.json";
export const MCP_AUDIT_PATH = ".gumply/mcp-log.jsonl";

export const DEFAULT_MCP_SETTINGS: McpSettings = { enabled: true, access: "read" };

function asObject(text: string | null | undefined): Record<string, unknown> | null {
  if (text === null || text === undefined) return null;
  try {
    const raw: unknown = JSON.parse(text);
    return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function isMcpAccess(value: unknown): value is McpAccess {
  return MCP_ACCESS_LEVELS.includes(value as McpAccess);
}

/** The settings in `.gumply/mcp.json`'s text (null: no file). */
export function parseMcpSettings(text: string | null | undefined): McpSettings {
  const data = asObject(text);
  if (!data) return { ...DEFAULT_MCP_SETTINGS };
  return { enabled: data.enabled !== false, access: isMcpAccess(data.access) ? data.access : "read" };
}

/**
 * The file's new text after a change. Keys other than `enabled` and
 * `access` (a later version's, or the user's) are kept as they were.
 */
export function serializeMcpSettings(current: string | null | undefined, patch: Partial<McpSettings>): string {
  const data = asObject(current) ?? {};
  const settings = parseMcpSettings(current);
  const next = { ...data, enabled: patch.enabled ?? settings.enabled, access: patch.access ?? settings.access };
  return `${JSON.stringify(next, null, 2)}\n`;
}

/** One row of `.gumply/mcp-log.jsonl` (versions and ids only, never page text). */
export interface McpAuditEntry {
  at: string;
  tool: string;
  id: string;
  before: string | null;
  after: string | null;
  client: string;
}

/** The log's rows, oldest first; lines that aren't a well-formed row are skipped. */
export function parseMcpAuditLog(text: string): McpAuditEntry[] {
  const out: McpAuditEntry[] = [];
  for (const line of text.split("\n")) {
    const data = asObject(line.trim() || null);
    if (!data) continue;
    const { at, tool, id, before, after, client } = data;
    if (typeof at !== "string" || typeof tool !== "string" || typeof id !== "string") continue;
    out.push({
      at,
      tool,
      id,
      before: typeof before === "string" ? before : null,
      after: typeof after === "string" ? after : null,
      client: typeof client === "string" ? client : "",
    });
  }
  return out;
}

/** How to start Gumply's MCP server from an AI app (before `--vault <path>`). */
export interface McpLaunchCommand {
  command: string;
  args: string[];
}

/** `GET /api/mcp/settings` (spec/api-mcp-settings). */
export interface McpSettingsResponse extends McpSettings {
  /** Whether `.gumply/mcp.json` exists (else the defaults apply). */
  configured: boolean;
  /** The vault's absolute path, for the setup snippets. */
  vaultPath: string;
  /** `process.platform` of the machine running Gumply (where the AI app runs too). */
  platform: string;
  command: McpLaunchCommand;
  /** The newest audit rows first, at most 50. */
  recent: McpAuditEntry[];
}

/** `PUT /api/mcp/settings` body: either or both. */
export type McpSettingsPatch = Partial<McpSettings>;
