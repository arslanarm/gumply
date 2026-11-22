/**
 * #gmcx5pfp A2: the write tools at `edit`, under both protocol revisions.
 * Each write: exact bytes on disk, nothing else in the vault changed, one
 * history entry holding the replaced bytes, one audit line without page text.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pageKey, readIndex } from "../src/history.js";
import { codeOf, connect, ERAS, makeVault, vaultHash, writeSettings, type Connection } from "./harness.js";

const WRITE_TOOLS = ["add_to_board", "append_to_page", "create_page", "trash_page", "update_page"];

describe.each(ERAS)("write tools (%s client)", (era) => {
  let vault: ReturnType<typeof makeVault>;
  let mcp: Connection;

  const file = (path: string) => readFileSync(join(vault.dir, path), "utf8");
  const historyOf = (id: string) => readIndex(join(vault.dir, ".gumply/history", pageKey(id)));
  const auditLines = () =>
    readFileSync(join(vault.dir, ".gumply/mcp-log.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  /** Every file but these (and `.gumply/`) is byte-identical to `before`. */
  const onlyChanged = (before: Record<string, string>, changed: string[]) => {
    const after = vaultHash(vault.dir);
    for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (changed.includes(path)) continue;
      expect(after[path], path).toBe(before[path]);
    }
  };
  const version = async (id: string) => (await mcp.call("read", { id })).structuredContent!.updated as string;

  beforeEach(async () => {
    vault = makeVault();
    writeSettings(vault.dir, { enabled: true, access: "edit" });
    mcp = await connect(vault.dir, era, { name: "claude-test" });
  }, 30_000);

  afterEach(async () => {
    await mcp.close();
    vault.cleanup();
  });

  it("lists the read and write tools at edit, with honest annotations", async () => {
    const { tools } = await mcp.client.listTools();
    const writes = tools.filter((tool) => WRITE_TOOLS.includes(tool.name));
    expect(writes.map((tool) => tool.name).sort()).toEqual(WRITE_TOOLS);
    for (const tool of writes) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: false, destructiveHint: ["update_page", "trash_page"].includes(tool.name) });
    }
  });

  it("create_page: D20 names, parent, exact bytes, history and audit", async () => {
    const before = vaultHash(vault.dir);
    const created = await mcp.call("create_page", { title: "Fresh idea", parentId: "Projects", content: "Body line.\n" });
    expect(created.isError).toBeFalsy();
    expect(created.structuredContent).toMatchObject({ id: "Projects/Fresh idea", title: "Fresh idea", link: "[[Fresh idea]]" });
    expect(created.content[0]!.text).toContain("Not idempotent");
    expect(file("Projects/Fresh idea.md")).toContain("Body line.\n");
    onlyChanged(before, ["Projects/Fresh idea.md"]);

    const again = await mcp.call("create_page", { title: "Fresh idea", parentId: "Projects" });
    expect(again.structuredContent!.id).toBe("Projects/Fresh idea 2");

    const history = await historyOf("Projects/Fresh idea");
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ source: "mcp", tool: "create_page", client: "claude-test", id: "Projects/Fresh idea" });
    const saved = readFileSync(join(vault.dir, ".gumply/history", pageKey("Projects/Fresh idea"), history[0]!.file), "utf8");
    expect(saved).toBe(file("Projects/Fresh idea.md"));
    expect(auditLines()[0]).toEqual({ at: expect.any(String), tool: "create_page", id: "Projects/Fresh idea", before: null, after: created.structuredContent!.updated, client: "claude-test" });

    expect(codeOf(await mcp.call("create_page", { title: "X", parentId: "Map.canvas" }))).toBe("UNSUPPORTED");
    expect(codeOf(await mcp.call("create_page", { title: "X", parentId: "Nope" }))).toBe("NOT_FOUND");
    expect(codeOf(await mcp.call("create_page", { title: "Big", content: "x".repeat(1024 * 1024 + 1) }))).toBe("TOO_LARGE");
  });

  it("append_to_page: at the end and into a section; Obsidian notes keep every byte", async () => {
    const before = vaultHash(vault.dir);
    const original = file("Plain note.md");
    const result = await mcp.call("append_to_page", { id: "Plain note", markdown: "Added by the model." });
    expect(result.isError).toBeFalsy();
    // No frontmatter added (no `updated:`), the old bytes untouched, the addition after a blank line.
    expect(file("Plain note.md")).toBe(`${original}\nAdded by the model.\n`);
    onlyChanged(before, ["Plain note.md"]);
    const [entry] = await historyOf("Plain note");
    expect(readFileSync(join(vault.dir, ".gumply/history", pageKey("Plain note"), entry!.file), "utf8")).toBe(original);

    // A section runs to the next heading of the same or a higher level: ### Detail belongs to ## Goals.
    await mcp.call("append_to_page", { id: "Projects/Plan", markdown: "- Third goal", underHeading: "Goals" });
    expect(file("Projects/Plan.md")).toContain("Deeper text under goals.\n\n- Third goal\n\n## Risks");
    const missing = await mcp.call("append_to_page", { id: "Projects/Plan", markdown: "x", underHeading: "Nope" });
    expect(codeOf(missing)).toBe("INVALID_INPUT");
    expect((missing.structuredContent!.error as { headings: string[] }).headings).toEqual(["Plan", "Goals", "Detail", "Risks"]);

    await mcp.call("append_to_page", { id: "Crlf", markdown: "Line three" });
    expect(file("Crlf.md")).toBe("---\r\ntags: [crlf]\r\n---\r\nLine one\r\nLine two\r\n\r\nLine three\r\n");

    expect(codeOf(await mcp.call("append_to_page", { id: "Map.canvas", markdown: "x" }))).toBe("UNSUPPORTED");
    expect(codeOf(await mcp.call("append_to_page", { id: "Welcome", markdown: "x".repeat(100 * 1024 + 1) }))).toBe("TOO_LARGE");
  });

  it("update_page: needs the version read; a stale one writes nothing", async () => {
    const read = await version("Welcome");
    const before = vaultHash(vault.dir);
    const original = file("Welcome.md");
    const stale = await mcp.call("update_page", { id: "Welcome", expectedUpdated: "2001-01-01T00:00:00.000Z", content: "lost" });
    expect(codeOf(stale)).toBe("CONFLICT");
    expect((stale.structuredContent!.error as { currentUpdated: string }).currentUpdated).toBe(read);
    expect(vaultHash(vault.dir)).toEqual(before);

    const result = await mcp.call("update_page", { id: "Welcome", expectedUpdated: read, content: "# Welcome\n\nNew body.\n" });
    expect(result.isError).toBeFalsy();
    const text = file("Welcome.md");
    // Frontmatter (with its comments) stays; the body is replaced.
    expect(text).toContain("# A comment Obsidian keeps\n");
    expect(text).toContain("status: active # inline comment\n");
    expect(text).toContain("New body.");

    // Restoring the history entry by copy gives back the old file byte for byte.
    const [entry] = await historyOf("Welcome");
    const saved = readFileSync(join(vault.dir, ".gumply/history", pageKey("Welcome"), entry!.file));
    expect(saved.toString("utf8")).toBe(original);
    expect(entry).toMatchObject({ version: read, bytes: saved.length, tool: "update_page" });

    expect(codeOf(await mcp.call("update_page", { id: "Welcome", expectedUpdated: "x" }))).toBe("INVALID_INPUT");
    expect(codeOf(await mcp.call("update_page", { id: "Map.canvas", expectedUpdated: "x", content: "y" }))).toBe("UNSUPPORTED");
  });

  it("update_page: tags on a `Tags:` note land on that one key, keeping its spelling (#ippqkgus)", async () => {
    // The server reads the vault on connect: write the note, then reconnect.
    await mcp.close();
    writeFileSync(join(vault.dir, "Caps.md"), "---\nTags: [capT]\nstatus: draft # mine\n---\n\nBody.\n");
    mcp = await connect(vault.dir, era, { name: "claude-test" });
    const read = await version("Caps");
    const result = await mcp.call("update_page", { id: "Caps", expectedUpdated: read, properties: { set: { tags: ["capT", "more"] } } });
    expect(result.isError).toBeFalsy();
    const text = file("Caps.md");
    expect(text.match(/^tags:/gim)).toHaveLength(1);
    expect(text).toContain("Tags: [capT, more]");
    expect(text).toContain("status: draft # mine");
  });

  it("update_page: a new title renames the file and rewrites links (D12/D20)", async () => {
    const read = await version("Projects/Plan");
    const result = await mcp.call("update_page", { id: "Projects/Plan", expectedUpdated: read, title: "Roadmap" });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent!.id).toBe("Projects/Roadmap");
    expect(result.structuredContent!.rewrittenPages).toEqual(expect.arrayContaining(["Welcome"]));
    expect(existsSync(join(vault.dir, "Projects/Plan.md"))).toBe(false);
    // The link is rewritten the way the app writes it: the shortest unique form.
    expect(file("Welcome.md")).toContain("See [[Roadmap]] and [[Missing page]].");
    // The linking page's old version is in history too.
    expect((await historyOf("Welcome"))[0]).toMatchObject({ tool: "update_page" });
  });

  it("trash_page: to the Trash only, with the version read", async () => {
    const read = await version("Injection");
    expect(codeOf(await mcp.call("trash_page", { id: "Injection", expectedUpdated: "2001-01-01T00:00:00.000Z" }))).toBe("CONFLICT");
    expect(existsSync(join(vault.dir, "Injection.md"))).toBe(true);
    const result = await mcp.call("trash_page", { id: "Injection", expectedUpdated: read });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ deleted: ["Injection"] });
    expect(existsSync(join(vault.dir, "Injection.md"))).toBe(false);
    expect(readdirSync(join(vault.dir, ".trash")).length).toBeGreaterThan(0);
    expect(codeOf(await mcp.call("read", { id: "Injection" }))).toBe("NOT_FOUND");
    expect(codeOf(await mcp.call("trash_page", { id: "Projects", expectedUpdated: "x" }))).toBe("UNSUPPORTED");
  });

  it("add_to_board: sticky beside a card, page card, http links only; unknown keys kept", async () => {
    const before = vaultHash(vault.dir);
    const sticky = await mcp.call("add_to_board", { boardId: "Map.canvas", item: { type: "sticky", text: "From the model", color: "4" }, near: "n1" });
    expect(sticky.isError).toBeFalsy();
    const nodeId = sticky.structuredContent!.nodeId as string;
    let board = JSON.parse(file("Map.canvas")) as { nodes: Array<Record<string, unknown>>; pluginKey: unknown };
    expect(board.pluginKey).toEqual({ kept: true });
    expect(board.nodes.find((node) => node.id === nodeId)).toMatchObject({ type: "text", text: "From the model", color: "4", x: 260, y: 0, gumply: { kind: "sticky" } });
    onlyChanged(before, ["Map.canvas"]);

    await mcp.call("add_to_board", { boardId: "Map.canvas", item: { type: "page", pageId: "Welcome" } });
    await mcp.call("add_to_board", { boardId: "Map.canvas", item: { type: "link", url: "https://example.org/a" } });
    board = JSON.parse(file("Map.canvas"));
    expect(board.nodes.slice(-2)).toEqual([
      expect.objectContaining({ type: "file", file: "Welcome.md", x: 0, y: 580 }),
      expect.objectContaining({ type: "link", url: "https://example.org/a" }),
    ]);
    expect(codeOf(await mcp.call("add_to_board", { boardId: "Map.canvas", item: { type: "link", url: "file:///etc/passwd" } }))).toBe("INVALID_INPUT");
    expect(codeOf(await mcp.call("add_to_board", { boardId: "Map.canvas", item: { type: "text", text: "x" }, near: "nope" }))).toBe("NOT_FOUND");
    expect(codeOf(await mcp.call("add_to_board", { boardId: "Welcome", item: { type: "text", text: "x" } }))).toBe("UNSUPPORTED");
    expect(await historyOf("Map.canvas")).toHaveLength(3);
  });

  it("the audit log holds versions and ids, never page text", async () => {
    await mcp.call("append_to_page", { id: "Welcome", markdown: "SECRET-PHRASE-IN-BODY" });
    await mcp.call("create_page", { title: "Other", content: "ANOTHER-SECRET-PHRASE" });
    const log = readFileSync(join(vault.dir, ".gumply/mcp-log.jsonl"), "utf8");
    expect(log).not.toContain("SECRET-PHRASE");
    for (const line of auditLines()) expect(Object.keys(line).sort()).toEqual(["after", "at", "before", "client", "id", "tool"]);
  });

  it("the replaced version is saved before the write: a change on disk in between is CONFLICT, the user's text stays", async () => {
    const read = await version("Welcome");
    writeFileSync(join(vault.dir, "Welcome.md"), "The user's newer text.\n");
    const result = await mcp.call("update_page", { id: "Welcome", expectedUpdated: read, content: "model text" });
    expect(codeOf(result)).toBe("CONFLICT");
    expect(file("Welcome.md")).toBe("The user's newer text.\n");
  });
});
