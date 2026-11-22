/**
 * append_to_page's single retry (spec/mcp §1, "Racing the app's editor"),
 * made deterministic: the handler runs in-process against a real `Vault`,
 * and the store's `update` is wrapped so the "user" saves the file right
 * before MCP's write lands (once, or every time).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/server";
import { RateLimiter } from "../src/limits.js";
import { registerWriteTools } from "../src/tools/write.js";
import { Vault } from "../src/vault.js";
import { makeVault, writeSettings, type ToolResult } from "./harness.js";

type Handler = (args: Record<string, unknown>, ctx: { mcpReq: Record<string, unknown> }) => Promise<ToolResult>;

describe("append_to_page retries once when the file changes under it", () => {
  let fixture: ReturnType<typeof makeVault>;
  let vault: Vault;
  let append: Handler;
  let updates = 0;
  const file = () => join(fixture.dir, "Projects/Plan.md");

  /** Wrap the store's update: the user saves right before each of the first `times` MCP writes. */
  const userSavesBefore = (times: number) => {
    const original = vault.store.update.bind(vault.store);
    vault.store.update = async (id, patch) => {
      updates += 1;
      if (updates <= times) {
        // Make the mtime visibly different from the one the index holds.
        await new Promise((resolve) => setTimeout(resolve, 15));
        writeFileSync(file(), `${readFileSync(file(), "utf8")}\nUser save ${updates}.\n`);
      }
      return original(id, patch);
    };
  };

  beforeEach(async () => {
    fixture = makeVault();
    writeSettings(fixture.dir, { access: "append" });
    vault = new Vault(fixture.dir);
    await vault.open();
    updates = 0;
    const handlers = new Map<string, Handler>();
    const server = { registerTool: (name: string, _config: unknown, cb: Handler) => handlers.set(name, cb) } as unknown as McpServer;
    registerWriteTools(server, { vault, readOnly: false, limiter: new RateLimiter(), logMaxBytes: 1 << 20, clientName: () => "retry-test" }, "append");
    append = handlers.get("append_to_page")!;
  });

  afterEach(() => {
    vault.close();
    fixture.cleanup();
  });

  it("a change before the first write: re-reads, retries, and keeps the user's text", async () => {
    userSavesBefore(1);
    const result = await append({ id: "Projects/Plan", markdown: "Model line." }, { mcpReq: {} });
    expect(result.isError).toBeFalsy();
    expect(updates).toBe(2);
    expect(readFileSync(file(), "utf8")).toMatch(/User save 1\.\n\nModel line\.\n$/);
  });

  it("a change before both writes: CONFLICT with the version on disk, the model's text never written", async () => {
    userSavesBefore(2);
    const result = await append({ id: "Projects/Plan", markdown: "Model line." }, { mcpReq: {} });
    expect(updates).toBe(2);
    expect((result.structuredContent?.error as { code: string }).code).toBe("CONFLICT");
    expect((result.structuredContent?.error as { currentUpdated: string | null }).currentUpdated).toBeTruthy();
    const text = readFileSync(file(), "utf8");
    expect(text).toContain("User save 2.");
    expect(text).not.toContain("Model line.");
  });
});
