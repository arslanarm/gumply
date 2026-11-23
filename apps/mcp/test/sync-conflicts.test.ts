/**
 * D43 (spec/sync-conflicts §5): a sync tool's conflict copy beside its page
 * isn't offered to the AI app: not in list_pages, not in search. Resolving one
 * is a person's decision.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, makeVault, type Connection } from "./harness.js";

const COPY = "Plain note.sync-conflict-20261122-143005-ABCDEFG";

describe("conflict copies and MCP (D43)", () => {
  let vault: ReturnType<typeof makeVault>;
  let mcp: Connection;

  beforeAll(async () => {
    vault = makeVault();
    writeFileSync(join(vault.dir, `${COPY}.md`), readFileSync(join(vault.dir, "Plain note.md"), "utf8"));
    mcp = await connect(vault.dir, "modern");
  }, 30_000);

  afterAll(async () => {
    await mcp?.close();
    vault.cleanup();
  });

  it("list_pages and search leave the copy out; the page is still there", async () => {
    const all = (await mcp.call("list_pages", { recursive: true })).structuredContent!.items as Array<{ id: string }>;
    expect(all.map((item) => item.id)).toContain("Plain note");
    expect(all.map((item) => item.id)).not.toContain(COPY);
    const hits = (await mcp.call("search", { query: "lighthouse" })).structuredContent!.results as Array<{ id: string }>;
    expect(hits.map((hit) => hit.id)).toEqual(["Plain note"]);
  });
});
