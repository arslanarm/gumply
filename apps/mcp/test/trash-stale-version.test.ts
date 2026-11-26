/**
 * #ddqd664r (data-safety hunt: MCP and API write paths): `trash_page` needs the version the model read. Its check
 * compared only that version and the file's time, then trashed without asking the store again. An outside edit at
 * the same size with its time put back (a sync tool, #y5k39njn's shape) is a change all the same: the model's read
 * is stale, so the call must be CONFLICT and the page must stay.
 *
 * In-process and deterministic (@lead): the MCP vault's watcher is stopped, as when the outside edit lands inside
 * its quiet gap, so nothing re-reads the file before the call. Synthetic vault.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RateLimiter } from "../src/limits.js";
import { registerWriteTools } from "../src/tools/write.js";
import { Vault } from "../src/vault.js";

type Handler = (args: Record<string, unknown>, ctx: { mcpReq: { envelope?: unknown } }) => Promise<{
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}>;

describe("trash_page with a version read before an outside edit that kept the file time (#ddqd664r)", () => {
  let dir = "";
  let vault: Vault;
  const handlers = new Map<string, Handler>();

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "gumply-mcp-trash-"));
    writeFileSync(join(dir, "Plan.md"), "---\nrole: Cook\n---\nShift notes for the week.\n");
    mkdirSync(join(dir, ".gumply"), { recursive: true });
    writeFileSync(join(dir, ".gumply/mcp.json"), JSON.stringify({ enabled: true, access: "edit" }));
    vault = new Vault(dir);
    await vault.open();
    // The watcher hasn't caught up (the edit lands inside its quiet gap): stopped, so it never does here.
    vault.close();
    const server = { registerTool: (name: string, _config: unknown, handler: Handler) => handlers.set(name, handler) };
    registerWriteTools(server as never, { vault, readOnly: false, limiter: new RateLimiter(), logMaxBytes: 1_000_000, clientName: () => "test" }, "edit");
  });

  afterEach(() => {
    handlers.clear();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is CONFLICT, and the page with the outside text stays in place", async () => {
    const file = join(dir, "Plan.md");
    const read = vault.store.get("Plan").updated;
    // Another app changes the text at the same size and puts the file time back.
    const before = readFileSync(file, "utf8");
    const { atime, mtime } = statSync(file);
    const after = before.replace("Cook", "Chef");
    expect(Buffer.byteLength(after)).toBe(Buffer.byteLength(before));
    writeFileSync(file, after);
    utimesSync(file, atime, mtime);

    const result = await handlers.get("trash_page")!({ id: "Plan", expectedUpdated: read }, { mcpReq: {} });
    expect(result.isError).toBe(true);
    expect((result.structuredContent?.error as { code?: string } | undefined)?.code).toBe("CONFLICT");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(after);
  });

  it("with the version read and no change since, it still trashes (a guard)", async () => {
    const read = vault.store.get("Plan").updated;
    const result = await handlers.get("trash_page")!({ id: "Plan", expectedUpdated: read }, { mcpReq: {} });
    expect(result.isError).toBeFalsy();
    expect(existsSync(join(dir, "Plan.md"))).toBe(false);
  });
});
