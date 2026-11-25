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

  it("boards get .canvas versions; database views get .base versions too (D41 + N1, #kw8th869)", async () => {
    const { store, dir } = await createTestServer();
    const board = await store.createBoard({ title: "Map" });
    await store.updateBoard(board.meta.id, { board: { nodes: [{ id: "a", type: "text", text: "A", x: 0, y: 0, width: 100, height: 50 }], edges: [] } });
    const list = await entries(dir, board.meta.id);
    expect(list).toHaveLength(1);
    expect(list[0]!.file).toMatch(/\.canvas$/);

    await writeFile(join(dir, "View.base"), "views:\n  - type: table\n    name: T\n");
    await store.rescan();
    // A different mtime (same size): the rescan must see the second write.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(join(dir, "View.base"), "views:\n  - type: table\n    name: U\n");
    await store.rescan();
    // An outside edit of a view is an "Outside edit" version, with the new bytes, as for a page.
    const views = await entries(dir, "View.base");
    expect(views.length).toBeGreaterThanOrEqual(1);
    expect(views.at(-1)!.file).toMatch(/\.base$/);
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

describe("the user's last save survives an outside change or delete (#yikrbg7h)", () => {
  it("an outside overwrite within the session: Mine. Me. stays in history, byte-exact, before Theirs. Me.", async () => {
    const { store, dir } = await createTestServer();
    await writeFile(join(dir, "Journal.md"), "Mine.\n");
    await store.rescan();
    await store.update("Journal", { content: "Mine. Me." });
    const saved = await readFile(join(dir, "Journal.md"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(join(dir, "Journal.md"), "Theirs. Me.\n");
    await store.rescan();

    const list = await entries(dir, "Journal");
    const bytes = await Promise.all(list.map((entry) => readFile(join(historyDir(dir, "Journal"), entry.file))));
    expect(list.map((entry) => [entry.source, entry.reason])).toEqual([
      ["app", "edit"],
      ["app", "session"],
      ["external", undefined],
    ]);
    expect(bytes.map((value) => value.toString("utf8"))).toEqual(["Mine.\n", saved.toString("utf8"), "Theirs. Me.\n"]);
    expect(bytes[1]!.equals(saved)).toBe(true);
    // D37: the page file is the other program's, untouched by history.
    expect(await readFile(join(dir, "Journal.md"), "utf8")).toBe("Theirs. Me.\n");
  });

  it("an outside delete within the session: the orphan's newest version is the user's last save", async () => {
    const { app, store, dir } = await createTestServer();
    await writeFile(join(dir, "Gone.md"), "before\n");
    await store.rescan();
    await store.update("Gone", { content: "my edit" });
    const saved = await readFile(join(dir, "Gone.md"));
    await rm(join(dir, "Gone.md"));
    await store.rescan();

    const list = await entries(dir, "Gone");
    expect(list.at(-1)).toMatchObject({ source: "app", reason: "session" });
    expect((await readFile(join(historyDir(dir, "Gone"), list.at(-1)!.file))).equals(saved)).toBe(true);
    const orphans = await getJson<HistoryOrphan[]>(app, "/api/history-orphans");
    expect(orphans.map((orphan) => orphan.title)).toEqual(["Gone"]);
    const response = await jsonRequest(app, "POST", `/api/history-orphans/${enc(orphans[0]!.key)}/restore`, {});
    expect(response.status).toBe(201);
    expect((await readFile(join(dir, "Gone.md"))).equals(saved)).toBe(true);
  });

  it("a page only viewed in Gumply gets no version before an outside change (by spec)", async () => {
    const { store, dir } = await createTestServer();
    await writeFile(join(dir, "Viewed.md"), "theirs 1\n");
    await store.rescan();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(join(dir, "Viewed.md"), "theirs 2\n");
    await store.rescan();
    expect((await entries(dir, "Viewed")).map((entry) => entry.source)).toEqual(["external"]);
  });

  it("the kept bytes are capped: past the cap, the page written longest ago is saved as a session version early", async () => {
    const { dir } = await createTestServer();
    await writeFile(join(dir, "A.md"), "a0\n");
    await writeFile(join(dir, "B.md"), "b0\n");
    const store = new VaultStore(dir, { sessionBytesCap: 100 });
    await store.init();
    await store.update("A", { content: "a".repeat(60) });
    expect((await entries(dir, "A")).map((entry) => entry.reason)).toEqual(["edit"]);
    await store.update("B", { content: "b".repeat(60) });
    // A's last save went to history early (byte-exact); B's is still only kept.
    const a = await entries(dir, "A");
    expect(a.map((entry) => [entry.source, entry.reason])).toEqual([
      ["app", "edit"],
      ["app", "session"],
    ]);
    expect(await readFile(join(historyDir(dir, "A"), a[1]!.file), "utf8")).toBe(await readFile(join(dir, "A.md"), "utf8"));
    expect((await entries(dir, "B")).map((entry) => entry.reason)).toEqual(["edit"]);
    // A's session is over: an outside change now adds only the external version.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(join(dir, "A.md"), "theirs\n");
    await store.rescan();
    expect((await entries(dir, "A")).map((entry) => entry.source)).toEqual(["app", "app", "external"]);
  });

  it("a session already ended (checkpoint) isn't saved twice", async () => {
    const { store, dir } = await createTestServer();
    await writeFile(join(dir, "Note.md"), "a\n");
    await store.rescan();
    await store.update("Note", { content: "b" });
    expect(await store.checkpoint("Note")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(join(dir, "Note.md"), "c\n");
    await store.rescan();
    expect((await entries(dir, "Note")).map((entry) => [entry.source, entry.reason])).toEqual([
      ["app", "edit"],
      ["app", "session"],
      ["external", undefined],
    ]);
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

describe("delete forever (D41 follow-up)", () => {
  it("Delete forever and Empty trash remove the pages' history; it never becomes an orphan", async () => {
    const { app, store, dir } = await createTestServer();
    await writeFile(join(dir, "Secret.md"), "one\n");
    await writeFile(join(dir, "Other.md"), "a\n");
    await store.rescan();
    await store.update("Secret", { content: "two" });
    await store.update("Other", { content: "b" });
    const { trashId } = await store.remove("Secret");
    expect((await entries(dir, "Secret")).length).toBeGreaterThan(0);
    await store.deleteTrashed(trashId);
    expect(await entries(dir, "Secret")).toEqual([]);
    await store.remove("Other");
    await store.emptyTrash();
    expect(await entries(dir, "Other")).toEqual([]);
    expect(await getJson<HistoryOrphan[]>(app, "/api/history-orphans")).toEqual([]);
  });

  it("keeps the history of a live page that has the same id now", async () => {
    const { store, dir } = await createTestServer();
    await writeFile(join(dir, "Note.md"), "old\n");
    await store.rescan();
    const { trashId } = await store.remove("Note");
    await store.create({ title: "Note", content: "new" });
    await store.update("Note", { content: "newer" });
    await store.deleteTrashed(trashId);
    expect((await entries(dir, "Note")).length).toBeGreaterThan(0);
  });
});

describe("a new page never adopts an old page's history", () => {
  it("creating a page where one deleted outside had history sets that history aside as an orphan", async () => {
    const { app, store, dir } = await createTestServer();
    await writeFile(join(dir, "Ideas.md"), "old\n");
    await store.rescan();
    await store.update("Ideas", { content: "older still" });
    // Deleted outside Gumply (Delete forever would remove the history itself).
    await rm(join(dir, "Ideas.md"));
    await store.rescan();
    expect((await getJson<HistoryOrphan[]>(app, "/api/history-orphans")).map((orphan) => orphan.title)).toEqual(["Ideas"]);

    await store.create({ title: "Ideas", content: "brand new" });
    expect((await getJson<HistoryList>(app, `/api/history/${enc("Ideas")}`)).items).toEqual([]);
    expect((await getJson<HistoryOrphan[]>(app, "/api/history-orphans")).map((orphan) => orphan.title)).toEqual(["Ideas"]);
  });
});

describe("a page that appears outside Gumply where history is", () => {
  it("keeps that history with a `recreated` marker, so the panel can show which versions came before", async () => {
    const { app, store, dir } = await createTestServer();
    await writeFile(join(dir, "Draft.md"), "one\n");
    await store.rescan();
    await store.update("Draft", { content: "two" });
    await rm(join(dir, "Draft.md"));
    await store.rescan();
    await writeFile(join(dir, "Draft.md"), "a different page\n");
    await store.rescan();
    const list = await getJson<HistoryList>(app, `/api/history/${enc("Draft")}`);
    expect(list.items.length).toBeGreaterThan(0);
    expect(list.moves.map((move) => move.event)).toEqual(["recreated"]);
    expect(list.items.every((item) => item.at <= list.moves[0]!.at)).toBe(true);
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

  it("Restore writes the version's exact bytes, its own updated: included (Changes only hides it, #h4tyk92t)", async () => {
    const { app, store, dir } = await createTestServer();
    const version = "---\ncreated: 2026-11-01T10:00:00.000Z\nupdated: 2026-11-20T09:00:00.000Z\n---\nBody.\n";
    await writeFile(join(dir, "Doc.md"), version);
    await store.rescan();
    await store.update("Doc", { content: "Body." });
    const now = await readFile(join(dir, "Doc.md"), "utf8");
    expect(now).not.toContain("updated: 2026-11-20T09:00:00.000Z");
    const list = await getJson<HistoryList>(app, `/api/history/${enc("Doc")}`);
    const original = list.items.at(-1)!;
    const page = await getJson<{ updated: string }>(app, `/api/pages/${enc("Doc")}`);
    const response = await jsonRequest(app, "POST", `/api/history/${enc("Doc")}/${original.file}/restore`, { expectedUpdated: page.updated });
    expect(response.status).toBe(200);
    expect(await readFile(join(dir, "Doc.md"), "utf8")).toBe(version);
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

describe("#eq2ug2vr: a restore keeps the item's place; a new board doesn't take a trashed board's history", () => {
  it("restoring a version of a nested page or board keeps its parent (the sidebar doesn't move it)", async () => {
    const { app, store, dir } = await createTestServer();
    await mkdir(join(dir, "Projects"), { recursive: true });
    await writeFile(join(dir, "Projects.md"), "Parent\n");
    await writeFile(join(dir, "Projects", "Plan.md"), "One\n");
    await store.rescan();
    await store.update("Projects/Plan", { content: "Two" });
    const board = await store.createBoard({ title: "Map", parentId: "Projects" });
    await store.updateBoard(board.meta.id, { board: { nodes: [{ id: "a", type: "text", text: "A", x: 0, y: 0, width: 100, height: 50 }], edges: [] } });
    await store.updateBoard(board.meta.id, { board: { nodes: [], edges: [] } });

    for (const id of ["Projects/Plan", board.meta.id]) {
      const list = await getJson<HistoryList>(app, `/api/history/${enc(id)}`);
      const meta = store.pageMetas().find((item) => item.id === id)!;
      expect(meta.parentId).toBe("Projects");
      const response = await jsonRequest(app, "POST", `/api/history/${enc(id)}/${list.items.at(-1)!.file}/restore`, { expectedUpdated: meta.updated });
      expect(response.status).toBe(200);
      expect(store.pageMetas().find((item) => item.id === id)!.parentId).toBe("Projects");
    }
  });

  it("a new board with a trashed board's name starts its own history; the old one is set aside", async () => {
    const { app, store, dir } = await createTestServer();
    const old = await store.createBoard({ title: "Map" });
    await store.updateBoard(old.meta.id, { board: { nodes: [{ id: "a", type: "text", text: "Old", x: 0, y: 0, width: 100, height: 50 }], edges: [] } });
    await store.remove(old.meta.id);
    expect((await entries(dir, old.meta.id)).length).toBeGreaterThan(0);

    const fresh = await store.createBoard({ title: "Map" });
    expect(fresh.meta.id).toBe(old.meta.id);
    await store.updateBoard(fresh.meta.id, { board: { nodes: [{ id: "b", type: "text", text: "New", x: 0, y: 0, width: 100, height: 50 }], edges: [] } });
    const list = await getJson<HistoryList>(app, `/api/history/${enc(fresh.meta.id)}`);
    // Only the new board's own versions: none of them holds the old board's card.
    for (const item of list.items) {
      expect(await readFile(join(historyDir(dir, fresh.meta.id), item.file), "utf8")).not.toContain('"Old"');
    }
    const keys = await readdir(join(dir, ".gumply", "history"));
    expect(keys.some((key) => key.startsWith("Map.canvas~"))).toBe(true);
  });
});

describe("#4n2j4irt: an item restored from the Trash under a new name gets its own history back", () => {
  /** Every version's text in `id`'s history. */
  async function texts(dir: string, id: string): Promise<string[]> {
    return Promise.all((await entries(dir, id)).map((entry) => readFile(join(historyDir(dir, id), entry.file), "utf8")));
  }

  it("a page: Trash it, make a new page of that name, restore the old one → each lists only its own versions", async () => {
    const { store, dir } = await createTestServer();
    await writeFile(join(dir, "Gone.md"), "old one\n");
    await store.rescan();
    await store.update("Gone", { content: "old two" });
    const { trashId } = await store.remove("Gone");

    await store.create({ title: "Gone" });
    await store.update("Gone", { content: "new one" });
    const restored = await store.restore(trashId);
    expect(restored.id).toBe("Gone 2");

    expect((await texts(dir, "Gone 2")).join("\n")).toContain("old");
    expect((await texts(dir, "Gone 2")).join("\n")).not.toContain("new one");
    expect((await texts(dir, "Gone")).join("\n")).not.toContain("old");
  });

  it("a board: the same", async () => {
    const { store, dir } = await createTestServer();
    const card = (text: string) => ({ nodes: [{ id: "a", type: "text" as const, text, x: 0, y: 0, width: 100, height: 50 }], edges: [] });
    const old = await store.createBoard({ title: "Map" });
    await store.updateBoard(old.meta.id, { board: card("Old card") });
    const { trashId } = await store.remove(old.meta.id);

    const fresh = await store.createBoard({ title: "Map" });
    await store.updateBoard(fresh.meta.id, { board: card("New card") });
    const restored = await store.restore(trashId);
    expect(restored.id).toBe("Map 2.canvas");

    expect((await texts(dir, "Map 2.canvas")).join("\n")).toContain("Old card");
    expect((await texts(dir, "Map 2.canvas")).join("\n")).not.toContain("New card");
    expect((await texts(dir, "Map.canvas")).join("\n")).not.toContain("Old card");
  });

  it("a Trash restore to its own place (nobody took the name) is unchanged", async () => {
    const { store, dir } = await createTestServer();
    await writeFile(join(dir, "Solo.md"), "solo\n");
    await store.rescan();
    await store.update("Solo", { content: "solo two" });
    const { trashId } = await store.remove("Solo");
    expect((await store.restore(trashId)).id).toBe("Solo");
    expect((await texts(dir, "Solo")).join("\n")).toContain("solo");
  });
});
