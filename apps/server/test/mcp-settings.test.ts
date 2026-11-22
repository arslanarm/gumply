import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpSettingsResponse } from "@gumply/core";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { MCP_RECENT_ROWS } from "../src/mcp-settings";
import { cleanupVaults, createTestServer, getJson, jsonRequest } from "./helpers";

afterEach(cleanupVaults);

const settingsPath = (dir: string) => join(dir, ".gumply", "mcp.json");

describe("GET/PUT /api/mcp/settings (A3)", () => {
  it("no file: enabled at read, not configured; the npm command and the vault path", async () => {
    const { app, dir } = await createTestServer();
    const body = await getJson<McpSettingsResponse>(app, "/api/mcp/settings");
    expect(body).toEqual({
      enabled: true,
      access: "read",
      configured: false,
      vaultPath: dir,
      platform: process.platform,
      command: { command: "gumply", args: ["mcp"] },
      recent: [],
    });
    // Reading never creates the file.
    await expect(readdir(join(dir, ".gumply")).catch(() => [])).resolves.not.toContain("mcp.json");
  });

  it("the desktop app's own command when it passes one", async () => {
    const { store, dir } = await createTestServer();
    const app = createApp({ vaultPath: dir, store, mcpCommand: { command: "/opt/Gumply/gumply", args: ["--mcp"] } });
    expect((await getJson<McpSettingsResponse>(app, "/api/mcp/settings")).command).toEqual({ command: "/opt/Gumply/gumply", args: ["--mcp"] });
  });

  it("PUT writes only .gumply/mcp.json, keeps its other keys, and answers the new state", async () => {
    const { app, dir } = await createTestServer();
    await mkdir(join(dir, ".gumply"), { recursive: true });
    await writeFile(settingsPath(dir), '{"access":"append","note":"by hand"}\n');
    const before = (await readdir(dir)).sort();

    const response = await jsonRequest(app, "PUT", "/api/mcp/settings", { access: "edit" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as McpSettingsResponse;
    expect(body).toMatchObject({ enabled: true, access: "edit", configured: true });
    expect(JSON.parse(await readFile(settingsPath(dir), "utf8"))).toEqual({ access: "edit", note: "by hand", enabled: true });

    await jsonRequest(app, "PUT", "/api/mcp/settings", { enabled: false });
    expect(JSON.parse(await readFile(settingsPath(dir), "utf8"))).toEqual({ access: "edit", note: "by hand", enabled: false });
    expect((await readdir(dir)).sort()).toEqual(before);
    expect((await readdir(join(dir, ".gumply"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("a bad body is a 400 and changes nothing", async () => {
    const { app, dir } = await createTestServer();
    for (const body of [{}, { access: "admin" }, { enabled: "yes" }, { access: "read", extra: 1 }, [1]]) {
      expect((await jsonRequest(app, "PUT", "/api/mcp/settings", body)).status).toBe(400);
    }
    await expect(readFile(settingsPath(dir), "utf8")).rejects.toThrow();
  });

  it("another site can't change it (the local-only guard)", async () => {
    const { app, dir } = await createTestServer();
    const response = await app.request("/api/mcp/settings", {
      method: "PUT",
      headers: { Origin: "https://evil.example", Host: "localhost:8787", "content-type": "application/json" },
      body: JSON.stringify({ access: "edit" }),
    });
    expect(response.status).toBe(403);
    await expect(readFile(settingsPath(dir), "utf8")).rejects.toThrow();
  });

  it("recent activity: the newest audit rows first, from the log and its rotated file, at most 50", async () => {
    const { app, dir } = await createTestServer();
    await mkdir(join(dir, ".gumply"), { recursive: true });
    const row = (n: number) => JSON.stringify({ at: `2026-11-22T10:${String(n).padStart(2, "0")}:00.000Z`, tool: "append_to_page", id: `Note ${n}`, before: "a", after: "b", client: "claude-code" });
    await writeFile(join(dir, ".gumply", "mcp-log.jsonl.1"), `${Array.from({ length: 30 }, (_, n) => row(n)).join("\n")}\n`);
    await writeFile(join(dir, ".gumply", "mcp-log.jsonl"), `${Array.from({ length: 30 }, (_, n) => row(30 + n)).join("\n")}\nnot json\n`);
    const { recent } = await getJson<McpSettingsResponse>(app, "/api/mcp/settings");
    expect(recent).toHaveLength(MCP_RECENT_ROWS);
    expect(recent[0]!.id).toBe("Note 59");
    expect(recent.at(-1)!.id).toBe("Note 10");
  });
});
