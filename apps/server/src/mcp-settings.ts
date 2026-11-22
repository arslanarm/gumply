/**
 * `GET/PUT /api/mcp/settings` (v0.8 A3, spec/api v1.25, spec/api-mcp-settings): the app's
 * Settings → MCP. Reads and writes the vault's `.gumply/mcp.json` (the file
 * the MCP server reads on every write call, spec/mcp §2) and shows the newest
 * rows of its audit log. Behind the same local-only guard as every `/api`
 * route; MCP tools never see `.gumply/`.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { tempPathBeside } from "./temp-files.js";

/** The Settings section lists this many audit rows. */
export const MCP_RECENT_ROWS = 50;

/** The npm bin (`gumply mcp`): the fallback when the built server isn't next to this one. */
export const NPM_MCP_COMMAND: McpLaunchCommand = { command: "gumply", args: ["mcp"], hint: "npm" };

/**
 * A4: how an AI app starts the MCP server for the browser build (the desktop
 * app passes its own command). AI apps start it without a login shell, so
 * neither `gumply` nor an nvm `node` is on their PATH: use this Node's
 * absolute path and the absolute path of the built `apps/mcp/dist/gumply.mjs`
 * when it exists (the server runs from `apps/server/src` or `dist`).
 */
export function browserMcpCommand(
  moduleUrl: string = import.meta.url,
  nodePath: string = process.execPath,
  exists: (path: string) => boolean = existsSync,
): McpLaunchCommand {
  try {
    const script = fileURLToPath(new URL("../../mcp/dist/gumply.mjs", moduleUrl));
    if (exists(script)) return { command: nodePath, args: [script, "mcp"] };
  } catch {
    // Not a file URL (bundled): the npm form below.
  }
  return NPM_MCP_COMMAND;
}

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

export function mcpSettingsRoutes(vaultPath: string, command: McpLaunchCommand = browserMcpCommand()): Hono {
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
    const temp = tempPathBeside(settingsFile);
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
