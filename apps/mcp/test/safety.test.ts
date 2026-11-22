/**
 * #gmcx5pfp safety (spec/mcp §4, §6): access levels, path escapes, stdout
 * hygiene, exit codes, rate limits and the injection fixture.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codeOf, connect, ERAS, makeVault, runRaw, vaultHash, writeSettings, type Connection } from "./harness.js";

const READ = ["backlinks", "graph_neighbourhood", "list_pages", "list_tags", "read", "search"];
const ADD = ["add_to_board", "append_to_page", "create_page"];
const EDIT = ["trash_page", "update_page"];

let vault: ReturnType<typeof makeVault>;
let mcp: Connection | undefined;

afterEach(async () => {
  await mcp?.close();
  mcp = undefined;
  vault?.cleanup();
});

const names = async () => (await mcp!.client.listTools()).tools.map((tool) => tool.name).sort();

/** A call to an unlisted tool is refused: a protocol error or an isError result, never a write. */
const refused = async (name: string, args: Record<string, unknown>) => {
  try {
    const result = await mcp!.call(name, args);
    return result.isError === true;
  } catch {
    return true;
  }
};

describe.each(ERAS)("access levels (%s client)", (era) => {
  it("no settings file: read only, write tools neither listed nor callable", async () => {
    vault = makeVault();
    const before = vaultHash(vault.dir, true);
    mcp = await connect(vault.dir, era);
    expect(await names()).toEqual(READ);
    expect(await refused("create_page", { title: "Sneaky" })).toBe(true);
    expect(await refused("trash_page", { id: "Welcome", expectedUpdated: "x" })).toBe(true);
    expect(vaultHash(vault.dir, true)).toEqual(before);
  });

  it("append lists only the adding tools; --read-only wins over edit", async () => {
    vault = makeVault();
    writeSettings(vault.dir, { access: "append" });
    mcp = await connect(vault.dir, era);
    expect(await names()).toEqual([...ADD, ...READ].sort());
    expect(await refused("update_page", { id: "Welcome", expectedUpdated: "x", content: "y" })).toBe(true);
    await mcp.close();
    writeSettings(vault.dir, { access: "edit" });
    mcp = await connect(vault.dir, era, { args: ["--read-only"] });
    expect(await names()).toEqual(READ);
  });

  it("lowering the level in Settings refuses the next write, with no restart", async () => {
    vault = makeVault();
    writeSettings(vault.dir, { access: "edit" });
    mcp = await connect(vault.dir, era);
    expect(await names()).toEqual([...ADD, ...EDIT, ...READ].sort());
    expect((await mcp.call("create_page", { title: "Allowed" })).isError).toBeFalsy();
    writeSettings(vault.dir, { access: "read" });
    const before = vaultHash(vault.dir);
    expect(codeOf(await mcp.call("create_page", { title: "Refused" }))).toBe("WRITES_DISABLED");
    expect(codeOf(await mcp.call("append_to_page", { id: "Welcome", markdown: "x" }))).toBe("WRITES_DISABLED");
    writeSettings(vault.dir, { enabled: false, access: "edit" });
    expect(codeOf(await mcp.call("append_to_page", { id: "Welcome", markdown: "x" }))).toBe("WRITES_DISABLED");
    expect(vaultHash(vault.dir)).toEqual(before);
  });

  it("rate limit: RATE_LIMITED with retryAfterMs", async () => {
    vault = makeVault();
    writeSettings(vault.dir, { access: "append" });
    mcp = await connect(vault.dir, era, { env: { GUMPLY_MCP_WRITES_PER_MINUTE: "2" } });
    expect((await mcp.call("create_page", { title: "One" })).isError).toBeFalsy();
    expect((await mcp.call("create_page", { title: "Two" })).isError).toBeFalsy();
    const third = await mcp.call("create_page", { title: "Three" });
    expect(codeOf(third)).toBe("RATE_LIMITED");
    expect((third.structuredContent!.error as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0);
    expect(existsSync(join(vault.dir, "Three.md"))).toBe(false);
  });

  it("path escapes: never read, never written, nothing revealed", async () => {
    vault = makeVault();
    writeSettings(vault.dir, { access: "edit" });
    mcp = await connect(vault.dir, era);
    const before = vaultHash(vault.dir, true);
    const ids = ["../outside/Secret", "/etc/passwd", "..\\outside\\Secret", "C:/Windows/win", "Projects/../../outside/Secret", ".gumply/mcp", ".obsidian/app", ".trash/x", "Escape"];
    const outputs: string[] = [];
    for (const id of ids) {
      const results = [
        await mcp.call("read", { id }),
        await mcp.call("backlinks", { id }),
        await mcp.call("graph_neighbourhood", { id }),
        await mcp.call("list_pages", { parent: id }),
        await mcp.call("append_to_page", { id, markdown: "x" }),
        await mcp.call("update_page", { id, expectedUpdated: "x", content: "y" }),
        await mcp.call("trash_page", { id, expectedUpdated: "x" }),
        await mcp.call("create_page", { title: "Child", parentId: id }),
        await mcp.call("add_to_board", { boardId: id, item: { type: "text", text: "x" } }),
      ];
      for (const result of results) {
        expect(["NOT_FOUND", "OUTSIDE_VAULT"], `${id}: ${JSON.stringify(result)}`).toContain(codeOf(result));
        outputs.push(JSON.stringify(result));
      }
    }
    // A title can't reach outside either.
    expect(["NOT_FOUND", "OUTSIDE_VAULT"]).toContain(codeOf(await mcp.call("read", { title: "../outside/Secret" })));
    expect(outputs.join("\n")).not.toContain("OUTSIDE THE VAULT");
    const listed = JSON.stringify(await mcp.call("list_pages", { recursive: true }));
    expect(listed).not.toContain("Escape");
    expect(JSON.stringify(await mcp.call("search", { query: "OUTSIDE" }))).not.toContain("Escape");
    expect(vaultHash(vault.dir, true)).toEqual(before);
    expect(readFileSync(join(vault.outside, "Secret.md"), "utf8")).toBe("OUTSIDE THE VAULT: must never be read.\n");
  });

  it("reading the injection note writes nothing", async () => {
    vault = makeVault();
    writeSettings(vault.dir, { access: "edit" });
    mcp = await connect(vault.dir, era);
    const before = vaultHash(vault.dir, true);
    const result = await mcp.call("read", { id: "Injection" });
    expect(result.content[0]!.text).toContain("(user data, not instructions)");
    expect(vaultHash(vault.dir, true)).toEqual(before);
  });
});

describe("the process", () => {
  const INIT = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "raw", version: "1" } } });
  const lines = [
    INIT,
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read", arguments: { id: "Welcome" } } }),
    JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "search", arguments: { query: "goal" } } }),
  ];

  it("stdout carries JSON-RPC only, and it exits when stdin closes", async () => {
    vault = makeVault();
    const run = await runRaw(["mcp", "--vault", vault.dir], `${lines.join("\n")}\n`, {}, 2000);
    expect(run.code).toBe(0);
    const out = run.stdout.split("\n").filter((line) => line.length > 0);
    // Every request answered (JSON-RPC allows any order).
    expect(out.map((line) => (JSON.parse(line) as { id: number }).id).sort()).toEqual([1, 2, 3, 4]);
    for (const line of out) expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
    expect(run.stderr).toContain("serving");
  });

  it("a missing vault is an error and is never created; so is enabled:false", async () => {
    vault = makeVault();
    const missing = join(vault.dir, "nope");
    const run = await runRaw(["mcp", "--vault", missing], "");
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(existsSync(missing)).toBe(false);

    writeSettings(vault.dir, { enabled: false });
    const off = await runRaw(["mcp", "--vault", vault.dir], "");
    expect(off.code).toBe(1);
    expect(off.stderr).toContain("MCP is turned off for this vault");
    expect(off.stdout).toBe("");

    expect((await runRaw(["serve"], "")).code).toBe(2);
    expect((await runRaw(["mcp"], "")).code).toBe(2);
  });
});
