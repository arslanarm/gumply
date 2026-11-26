/**
 * #ddqd664r (data-safety hunt: MCP and API write paths): `trash_page` needs the version the model read. Its check
 * compares only that version and the file's time, then trashes without asking the store again. An outside edit at
 * the same size with its time put back (a sync tool, #y5k39njn's shape) is a change all the same: the model's read
 * is stale, so the call must be CONFLICT and the page must stay. Synthetic vault.
 */
import { existsSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codeOf, connect, makeVault, writeSettings, type Connection } from "./harness.js";

describe("trash_page with a version read before an outside edit that kept the file time (#ddqd664r)", () => {
  let vault: ReturnType<typeof makeVault>;
  let mcp: Connection;

  beforeEach(async () => {
    vault = makeVault();
    writeSettings(vault.dir, { enabled: true, access: "edit" });
    mcp = await connect(vault.dir, "modern", { name: "claude-test" });
  }, 30_000);

  afterEach(async () => {
    await mcp.close();
    vault.cleanup();
  });

  it("is CONFLICT, and the page with the outside text stays in place", async () => {
    const file = join(vault.dir, "Injection.md");
    const read = (await mcp.call("read", { id: "Injection" })).structuredContent!.updated as string;
    // Another app changes the text at the same size and puts the file time back.
    const before = readFileSync(file, "utf8");
    const { atime, mtime } = statSync(file);
    const after = before.replace(/[A-Za-z]/, (letter) => (letter === "Q" ? "R" : "Q"));
    expect(after).not.toBe(before);
    expect(Buffer.byteLength(after)).toBe(Buffer.byteLength(before));
    writeFileSync(file, after);
    utimesSync(file, atime, mtime);

    const result = await mcp.call("trash_page", { id: "Injection", expectedUpdated: read });
    expect(codeOf(result)).toBe("CONFLICT");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(after);
  });
});
