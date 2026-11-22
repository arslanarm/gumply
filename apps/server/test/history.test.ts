import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { historyDir, readHistory } from "../src/history";
import type { HistoryList, HistoryOrphan } from "../src/vault-store";
import { VaultStore } from "../src/vault-store";
import { cleanupVaults, createTestServer, getJson, jsonRequest } from "./helpers";

/** spec/version-history (D41): the store's versions, restore and the §7 API. */

afterEach(async () => {
  vi.useRealTimers();
  await cleanupVaults();
});

const enc = encodeURIComponent;
const MINUTE = 60_000;

/** Fake only the clock (timers stay real), so coalescing can be stepped over. */
function clock(start = Date.parse("2026-11-22T10:00:00.000Z")) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(start);
  return { advance: (ms: number) => vi.setSystemTime(Date.now() + ms) };
}

async function entries(dir: string, id: string) {
  return (await readHistory(historyDir(dir, id))).entries;
}

/** Every file under the vault except `.gumply/history`, with its bytes. */
async function vaultFiles(dir: string, prefix = ""): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (path === ".gumply/history") continue;
    if (entry.isDirectory()) for (const [key, value] of await vaultFiles(dir, path)) out.set(key, value);
    else out.set(path, await readFile(join(dir, path), "base64"));
  }
  return out;
}

describe("versions on save (§3)", () => {
  it("saves the bytes a save replaces, at most one app version per 5 min", async () => {
    const time = clock();
    const { store, dir } = await createTestServer();
    await writeFile(join(dir, "Note.md"), "first\n");
    await store.rescan();

    await store.update("Note", { content: "second" });
    await store.update("Note", { content: "third" });
    let list = await entries(dir, "Note");
    expect(list.map((entry) => [entry.source, entry.reason])).toEqual([["app", "edit"]]);
    expect(await readFile(join(historyDir(dir, "Note"), list[0]!.file), "utf8")).toBe("first\n");

    time.advance(6 * MINUTE);
    await store.update("Note", { content: "fourth" });
    list = await entries(dir, "Note");
    expect(list).toHaveLength(2);
    expect(await readFile(join(historyDir(dir, "Note"), list[1]!.file), "utf8")).toBe("third\n");
  });

  it("a checkpoint (page closed) keeps an edited page's current bytes as a session version, once", async () => {
    const { store, dir } = await createTestServer();
    await writeFile(join(dir, "Note.md"), "one\n");
    await store.rescan();
    // Only viewed: closing it starts no history.
    expect(await store.checkpoint("Note")).toBe(false);
    expect(await entries(dir, "Note")).toEqual([]);
    await store.update("Note", { content: "two" });
    expect(await store.checkpoint("Note")).toBe(true);
    expect(await store.checkpoint("Note")).toBe(false);
    const list = await entries(dir, "Note");
    expect(list.at(-1)).toMatchObject({ source: "app", reason: "session" });
    expect(await readFile(join(historyDir(dir, "Note"), list.at(-1)!.file), "utf8")).toBe("two\n");
  });

  it("boards get .canvas versions; .base files never get history (D41)", async () => {
    const { store, dir } = await createTestServer();
    const board = await store.createBoard({ title: "Map" });
    await store.updateBoard(board.meta.id, { board: { nodes: [{ id: "a", type: "text", text: "A", x: 0, y: 0, width: 100, height: 50 }], edges: [] } });
    const list = await entries(dir, board.meta.id);
    expect(list).toHaveLength(1);
    expect(list[0]!.file).toMatch(/\.canvas$/);

    await writeFile(join(dir, "View.base"), "views:\n  - type: table\n    name: T\n");
    await store.rescan();
    await writeFile(join(dir, "View.base"), "views:\n  - type: table\n    name: U\n");
    await store.rescan();
    expect(await readdir(join(dir, ".gumply", "history")).catch(() => [])).not.toContain("View.base");
  });

  it("an outside edit is an external version of the new bytes", async () => {
    const { store, dir } = await createTestServer();
    await writeFile(join(dir, "Note.md"), "mine\n");
    await store.rescan();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(join(dir, "Note.md"), "theirs\n");
    await store.rescan();
    const list = await entries(dir, "Note");
    expect(list.at(-1)).toMatchObject({ source: "external" });
    expect(await readFile(join(historyDir(dir, "Note"), list.at(-1)!.file), "utf8")).toBe("theirs\n");
  });

  it("an AI app's own store labels what it replaces as mcp", async () => {
    const { dir } = await createTestServer();
    await writeFile(join(dir, "Note.md"), "before\n");
    const mcp = new VaultStore(dir, { historySource: "mcp" });
    await mcp.init();
    await mcp.update("Note", { content: "after" });
    expect((await entries(dir, "Note")).map((entry) => entry.source)).toEqual(["mcp"]);
  });
});

describe("history follows the page (D20)", () => {
  it("a rename moves the directory; the old version knows its old title", async () => {
    const { app, store, dir } = await createTestServer();
    await writeFile(join(dir, "Old.md"), "text\n");
    await store.rescan();
    await store.update("Old", { content: "edited" });
    await store.update("Old", { title: "New" });
    expect(await entries(dir, "Old")).toEqual([]);
    const list = await getJson<HistoryList>(app, `/api/history/${enc("New")}`);
    expect(list.items.at(-1)).toMatchObject({ title: "Old" });
    expect(list.moves.map((move) => [move.event, move.from, move.id])).toEqual([["rename", "Old", "New"]]);
  });

  it("a move into a folder carries sub-pages' histories, and a stale history at the target is set aside", async () => {
    const { store, dir } = await createTestServer();
    await mkdir(join(dir, "Area"));
    await writeFile(join(dir, "Area", "Note.md"), "an earlier, deleted Note\n");
    await writeFile(join(dir, "Note.md"), "top\n");
    await store.rescan();
    await store.update("Area/Note", { content: "x" });
    await store.remove("Area/Note");
    await store.update("Note", { content: "edited" });
    await store.move("Note", "Area");
    const keys = await readdir(join(dir, ".gumply", "history"));
    expect(keys.some((key) => key.startsWith("Area%2FNote~"))).toBe(true);
    expect(await readFile(join(historyDir(dir, "Area/Note"), (await entries(dir, "Area/Note"))[0]!.file), "utf8")).toBe("top\n");
  });

  it("an outside rename keeps the history; a page deleted outside leaves an orphan that can come back", async () => {
    const { app, store, dir } = await createTestServer();
    await writeFile(join(dir, "Plan.md"), "---\ntitle: Plan\n---\nv1\n");
    await store.rescan();
    await store.update("Plan", { content: "v2" });
    const { rename } = await import("node:fs/promises");
    await rename(join(dir, "Plan.md"), join(dir, "Plan B.md"));
    await store.rescan();
    expect((await entries(dir, "Plan B")).length).toBeGreaterThan(0);

    await rm(join(dir, "Plan B.md"));
    await store.rescan();
    const orphans = await getJson<HistoryOrphan[]>(app, "/api/history-orphans");
    expect(orphans.map((orphan) => orphan.title)).toEqual(["Plan B"]);
    const response = await jsonRequest(app, "POST", `/api/history-orphans/${enc(orphans[0]!.key)}/restore`, {});
    expect(response.status).toBe(201);
    expect(((await response.json()) as { id: string }).id).toBe("Plan B");
    expect(await getJson<HistoryOrphan[]>(app, "/api/history-orphans")).toEqual([]);
  });

  it("a trashed page's history isn't an orphan, and comes back with Trash → Restore (D41)", async () => {
    const { app, store, dir } = await createTestServer();
    await writeFile(join(dir, "Gone.md"), "keep me\n");
    await store.rescan();
    const { trashId } = await store.remove("Gone");
    expect((await entries(dir, "Gone")).at(-1)).toMatchObject({ reason: "trash" });
    expect(await getJson<HistoryOrphan[]>(app, "/api/history-orphans")).toEqual([]);
    expect((await app.request(`/api/history/${enc("Gone")}`)).status).toBe(404);
    await store.restore(trashId);
    expect((await getJson<HistoryList>(app, `/api/history/${enc("Gone")}`)).items).toHaveLength(1);
  });
});

describe("a new page never adopts an old page's history", () => {
  it("creating a page where a deleted one had history sets that history aside as an orphan", async () => {
    const { app, store, dir } = await createTestServer();
    await writeFile(join(dir, "Ideas.md"), "old\n");
    await store.rescan();
    await store.update("Ideas", { content: "older still" });
    await store.remove("Ideas");
    await store.emptyTrash();
    expect((await getJson<HistoryOrphan[]>(app, "/api/history-orphans")).map((orphan) => orphan.title)).toEqual(["Ideas"]);

    await store.create({ title: "Ideas", content: "brand new" });
    expect((await getJson<HistoryList>(app, `/api/history/${enc("Ideas")}`)).items).toEqual([]);
    expect((await getJson<HistoryOrphan[]>(app, "/api/history-orphans")).map((orphan) => orphan.title)).toEqual(["Ideas"]);
  });
});

describe("restore (§4)", () => {
  it("writes the version's exact bytes, never renames, and is undoable", async () => {
    const { app, store, dir } = await createTestServer();
    const original = "---\r\n# a comment\r\nstatus: draft\r\n---\r\nLine one\r\n";
    await writeFile(join(dir, "Doc.md"), original);
    await store.rescan();
    await store.update("Doc", { content: "Rewritten" });
    await store.update("Doc", { title: "Renamed" });
    const edited = await readFile(join(dir, "Renamed.md"));

    let list = await getJson<HistoryList>(app, `/api/history/${enc("Renamed")}`);
    const first = list.items.at(-1)!;
    expect(first.title).toBe("Doc");
    const page = await getJson<{ updated: string }>(app, `/api/pages/${enc("Renamed")}`);
    const response = await jsonRequest(app, "POST", `/api/history/${enc("Renamed")}/${first.file}/restore`, { expectedUpdated: page.updated });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { id: string }).id).toBe("Renamed");
    expect(await readFile(join(dir, "Renamed.md"), "utf8")).toBe(original);

    list = await getJson<HistoryList>(app, `/api/history/${enc("Renamed")}`);
    expect(list.items[0]).toMatchObject({ source: "app", restoredFrom: first.file });
    const before = list.items.find((item) => item.reason === "before-restore")!;
    const now = await getJson<{ updated: string }>(app, `/api/pages/${enc("Renamed")}`);
    await jsonRequest(app, "POST", `/api/history/${enc("Renamed")}/${before.file}/restore`, { expectedUpdated: now.updated });
    expect((await readFile(join(dir, "Renamed.md"))).equals(edited)).toBe(true);
  });

  it("409 when the file changed since the panel opened", async () => {
    const { app, store, dir } = await createTestServer();
    await writeFile(join(dir, "Doc.md"), "one\n");
    await store.rescan();
    await store.update("Doc", { content: "two" });
    const list = await getJson<HistoryList>(app, `/api/history/${enc("Doc")}`);
    const response = await jsonRequest(app, "POST", `/api/history/${enc("Doc")}/${list.items[0]!.file}/restore`, { expectedUpdated: "2000-01-01T00:00:00.000Z" });
    expect(response.status).toBe(409);
    expect(await readFile(join(dir, "Doc.md"), "utf8")).toBe("two\n");
  });

  it("serves bytes, diffs and pins by exact file name only", async () => {
    const { app, store, dir } = await createTestServer();
    await writeFile(join(dir, "Doc.md"), "a\nb\n");
    await store.rescan();
    await store.update("Doc", { content: "a\nc\n" });
    const { items } = await getJson<HistoryList>(app, `/api/history/${enc("Doc")}`);
    const file = items[0]!.file;
    expect(await (await app.request(`/api/history/${enc("Doc")}/${file}`)).text()).toBe("a\nb\n");
    const diff = await getJson<{ kind: string; lines: Array<{ op: string; text: string }> }>(app, `/api/history/${enc("Doc")}/${file}/diff`);
    expect(diff.lines.filter((line) => line.op !== "same")).toEqual([
      { op: "remove", text: "b" },
      { op: "add", text: "c" },
    ]);
    expect((await app.request(`/api/history/${enc("Doc")}/${enc("../../Doc.md")}`)).status).toBe(404);
    expect((await app.request(`/api/history/${enc("Doc")}/index.jsonl`)).status).toBe(404);

    const pinned = await jsonRequest(app, "PUT", `/api/history/${enc("Doc")}/${file}/pin`, { pinned: true });
    expect(await pinned.json()).toMatchObject({ file, pinned: true });
    expect((await getJson<HistoryList>(app, `/api/history/${enc("Doc")}`)).items[0]!.pinned).toBe(true);
  });
});

describe("D37: history never touches page files", () => {
  it("listing, diffing, pinning and checkpoints leave every vault file byte-identical; .stignore is never written", async () => {
    const { app, store, dir } = await createTestServer();
    await writeFile(join(dir, ".stignore"), "// mine\n");
    await writeFile(join(dir, "Doc.md"), "x\r\n");
    await store.rescan();
    await store.update("Doc", { content: "y" });
    const before = await vaultFiles(dir);
    const { items } = await getJson<HistoryList>(app, `/api/history/${enc("Doc")}`);
    await app.request(`/api/history/${enc("Doc")}/${items[0]!.file}/diff`);
    await jsonRequest(app, "PUT", `/api/history/${enc("Doc")}/${items[0]!.file}/pin`, { pinned: true });
    await jsonRequest(app, "POST", `/api/history/${enc("Doc")}/checkpoint`);
    await getJson(app, "/api/history-usage");
    await getJson(app, "/api/history-orphans");
    expect(await vaultFiles(dir)).toEqual(before);
    expect(await readFile(join(dir, ".stignore"), "utf8")).toBe("// mine\n");
    expect((await stat(join(dir, ".gumply", "history"))).isDirectory()).toBe(true);
  });
});
