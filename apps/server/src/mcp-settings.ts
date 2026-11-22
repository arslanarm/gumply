/**
 * `GET/PUT /api/mcp/settings` (v0.8 A3, spec/api-mcp-settings): the app's
 * Settings → MCP. Reads and writes the vault's `.gumply/mcp.json` (the file
 * the MCP server reads on every write call, spec/mcp §2) and shows the newest
 * rows of its audit log. Behind the same local-only guard as every `/api`
 * route; MCP tools never see `.gumply/`.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  isMcpAccess,
  MCP_AUDIT_PATH,
  MCP_SETTINGS_PATH,
  parseMcpAuditLog,
  parseMcpSettings,
  serializeMcpSettings,
  type McpAuditEntry,
  type McpLaunchCommand,
  type McpSettingsPatch,
  type McpSettingsResponse,
} from "@gumply/core";
import { Hono } from "hono";
import { badRequest } from "./errors.js";

/** The Settings section lists this many audit rows. */
export const MCP_RECENT_ROWS = 50;

/** The npm bin (`gumply mcp`), unless the desktop app says how to start itself. */
export const NPM_MCP_COMMAND: McpLaunchCommand = { command: "gumply", args: ["mcp"] };

const vaultFile = (vaultPath: string, relative: string) => join(vaultPath, ...relative.split("/"));

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** The newest rows of the log and its first rotated file (`.1`), newest first. */
async function recentAudit(vaultPath: string): Promise<McpAuditEntry[]> {
  const file = vaultFile(vaultPath, MCP_AUDIT_PATH);
  const rows = [...parseMcpAuditLog((await readText(`${file}.1`)) ?? ""), ...parseMcpAuditLog((await readText(file)) ?? "")];
  return rows.slice(-MCP_RECENT_ROWS).reverse();
}

export function parseMcpSettingsPatch(body: unknown): McpSettingsPatch {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw badRequest("Expected { enabled?, access? }");
  const data = body as Record<string, unknown>;
  const patch: McpSettingsPatch = {};
  for (const key of Object.keys(data)) {
    if (key !== "enabled" && key !== "access") throw badRequest(`Unknown setting: ${key}`);
  }
  if ("enabled" in data) {
    if (typeof data.enabled !== "boolean") throw badRequest("enabled must be true or false");
    patch.enabled = data.enabled;
  }
  if ("access" in data) {
    if (!isMcpAccess(data.access)) throw badRequest("access must be read, append or edit");
    patch.access = data.access;
  }
  if (!("enabled" in patch) && !("access" in patch)) throw badRequest("Nothing to change");
  return patch;
}

export function mcpSettingsRoutes(vaultPath: string, command: McpLaunchCommand = NPM_MCP_COMMAND): Hono {
  const api = new Hono();
  const settingsFile = vaultFile(vaultPath, MCP_SETTINGS_PATH);

  const current = async (): Promise<McpSettingsResponse> => {
    const text = await readText(settingsFile);
    return {
      ...parseMcpSettings(text),
      configured: text !== null,
      vaultPath,
      platform: process.platform,
      command,
      recent: await recentAudit(vaultPath),
    };
  };

  api.get("/settings", async (c) => c.json<McpSettingsResponse>(await current()));

  api.put("/settings", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw badRequest("Expected JSON");
    }
    const patch = parseMcpSettingsPatch(body);
    const next = serializeMcpSettings(await readText(settingsFile), patch);
    // Atomic: the MCP server reads this file on every write call.
    await mkdir(join(vaultPath, ".gumply"), { recursive: true });
    const temp = `${settingsFile}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, next, "utf8");
      await rename(temp, settingsFile);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    return c.json<McpSettingsResponse>(await current());
  });

  return api;
}
