import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ConflictDiff, ConflictResolveResult, ConflictsList, GraphData, PageMeta, SearchResult } from "@gumply/core";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { historyDir, readHistory } from "../src/history";
import { VaultStore } from "../src/vault-store";
import { cleanupVaults, createTestServer, getJson, jsonRequest } from "./helpers";

/** spec/sync-conflicts (D43, spec/api v1.29): the server side, on §2's fixture vault. */

afterEach(cleanupVaults);

const enc = encodeURIComponent;
const SYNCTHING = "Note.sync-conflict-20261122-143005-ABCDEFG";
const DROPBOX = "Note (Ann's conflicted copy 2026-11-22)";
const note = (extra: string) => `---\ntags: [project]\n---\nAbout [[Other]] and ![[Board.canvas]]. zebraword ${extra}\n`;
const board = (text: string) =>
  `${JSON.stringify({ nodes: [{ id: "a", type: "text", text, x: 0, y: 0, width: 200, height: 80 }, { id: "b", type: "file", file: "Other.md", x: 300, y: 0, width: 200, height: 80 }], edges: [] })}\n`;

const FIXTURE: Record<string, string> = {
  "Note.md": note("mine"),
  "Other.md": "Other page.\n",
  "Ref.md": "See [[Note]].\n",
  [`${SYNCTHING}.md`]: note("syncthing"),
  [`${DROPBOX}.md`]: note("dropbox"),
  "Note (conflicted copy 2026-11-22 143005).md": note("nextcloud"),
  "Note 2.md": note("icloud"),
  "Board.canvas": board("mine"),
  "Board.sync-conflict-20261122-143005-ABCDEFG.canvas": board("theirs"),
  "Folder/Sub.md": "Sub [[Other]].\n",
  "Folder/Sub.sync-conflict-20261122-143005-ABCDEFG.md": "Sub [[Other]] theirs.\n",
  "Gone.sync-conflict-20261122-143005-ABCDEFG.md": "The original was deleted elsewhere.\n",
  "attachments/photo.png": "png",
  "attachments/photo.sync-conflict-20261122-143005-ABCDEFG.png": "png2",
};

async function vault(files: Record<string, string> = FIXTURE) {
  const { dir } = await createTestServer();
  for (const [path, body] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), body, "utf8");
  }
  const store = new VaultStore(dir);
  await store.init();
  return { dir, store, app: createApp({ vaultPath: dir, store }) };
}

/** Every vault file with its bytes (version history aside). */
async function snapshot(dir: string, prefix = ""): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (path === ".gumply/history") continue;
    if (entry.isDirectory()) for (const [key, value] of await snapshot(dir, path)) out.set(key, value);
    else out.set(path, await readFile(join(dir, path), "base64"));
  }
  return out;
}

const resolve = (app: ReturnType<typeof createApp>, id: string, body: unknown) => jsonRequest(app, "POST", `/api/conflicts/${enc(id)}/resolve`, body);

describe("conflict copies are recognised and kept out of the vault's indexes (§3, §5)", () => {
  it("marks copies and originals; graph, backlinks, tags, mentions and bases leave copies out; search keeps them, after the page", async () => {
    const { app } = await vault();
    const pages = await getJson<PageMeta[]>(app, "/api/pages");
    const byId = new Map(pages.map((page) => [page.id, page]));
    expect(byId.get(SYNCTHING)?.conflictOf).toBe("Note");
    expect(byId.get(DROPBOX)?.conflictOf).toBe("Note");
    expect(byId.get("Board.sync-conflict-20261122-143005-ABCDEFG.canvas")?.conflictOf).toBe("Board.canvas");
    expect(byId.get("Gone.sync-conflict-20261122-143005-ABCDEFG")?.conflictOf).toBeNull();
    expect(byId.get("Note")?.conflicts).toBe(3);
    expect(byId.get("Board.canvas")?.conflicts).toBe(1);
    // A possible copy is a real page until the user says otherwise.
    expect(byId.get("Note 2")?.conflictOf).toBeUndefined();

    const graph = await getJson<GraphData>(app, "/api/graph");
    const nodeIds = graph.nodes.map((node) => node.id);
    for (const copy of [SYNCTHING, DROPBOX, "Board.sync-conflict-20261122-143005-ABCDEFG.canvas", "Folder/Sub.sync-conflict-20261122-143005-ABCDEFG"]) {
      expect(nodeIds).not.toContain(copy);
      expect(graph.links.some((link) => link.source === copy || link.target === copy)).toBe(false);
    }
    // The orphan copy is the only version left: an ordinary page.
    expect(nodeIds).toContain("Gone.sync-conflict-20261122-143005-ABCDEFG");

    const backlinks = await getJson<Array<{ page: { id: string } }>>(app, `/api/pages/${enc("Other")}/backlinks`);
    expect(backlinks.map((item) => item.page.id).sort()).toEqual(["Board.canvas", "Folder/Sub", "Note", "Note 2"]);

    const tags = await getJson<Array<{ tag: string; pages: string[] }>>(app, "/api/tags");
    expect(tags.find((entry) => entry.tag === "project")?.pages.sort()).toEqual(["Note", "Note 2"]);

    const search = await getJson<SearchResult[]>(app, "/api/search?q=zebraword");
    const ids = search.map((hit) => hit.page.id);
    expect(ids).toContain(SYNCTHING);
    expect(search.find((hit) => hit.page.id === SYNCTHING)?.page.conflictOf).toBe("Note");
    const at = ids.indexOf("Note");
    expect(ids.slice(at + 1, at + 4).sort()).toEqual([DROPBOX, "Note (conflicted copy 2026-11-22 143005)", SYNCTHING].sort());

    // [[Note]] is the page; a copy is never a link target by title.
    const ref = await getJson<Array<{ page: { id: string } }>>(app, `/api/pages/${enc("Note")}/backlinks`);
    expect(ref.map((item) => item.page.id)).toEqual(["Ref"]);
  });

  it("unlinked mentions never come from a copy", async () => {
    const { app } = await vault({ "Alpha.md": "Alpha.\n", "Text.md": "About Alpha today.\n", "Text.sync-conflict-20261122-143005-ABCDEFG.md": "About Alpha yesterday.\n" });
    const mentions = await getJson<Array<{ page: { id: string } }>>(app, `/api/pages/${enc("Alpha")}/mentions`);
    expect(mentions.map((entry) => entry.page.id)).toEqual(["Text"]);
  });

  it("lists copies, orphans, attachment copies and possible copies; reading writes nothing (D37)", async () => {
    const { app, dir } = await vault();
    const before = await snapshot(dir);
    const list = await getJson<ConflictsList>(app, "/api/conflicts");
    expect(list.copies.map((copy) => [copy.copyId, copy.originalId, copy.tool])).toEqual([
      ["Board.sync-conflict-20261122-143005-ABCDEFG.canvas", "Board.canvas", "syncthing"],
      ["Folder/Sub.sync-conflict-20261122-143005-ABCDEFG", "Folder/Sub", "syncthing"],
      ["Gone.sync-conflict-20261122-143005-ABCDEFG", null, "syncthing"],
      [DROPBOX, "Note", "dropbox"],
      ["Note (conflicted copy 2026-11-22 143005)", "Note", "nextcloud"],
      [SYNCTHING, "Note", "syncthing"],
    ]);
    expect(list.copies.find((copy) => copy.copyId === SYNCTHING)).toMatchObject({ device: "ABCDEFG", at: "2026-11-22T14:30:05", same: false, kind: "page" });
    expect(list.attachments).toEqual([{ path: "attachments/photo.sync-conflict-20261122-143005-ABCDEFG.png", originalPath: "attachments/photo.png", tool: "syncthing", device: "ABCDEFG", at: "2026-11-22T14:30:05" }]);
    // Note 2 shares 3 of 4 lines with Note.
    expect(list.possible).toEqual([{ copyId: "Note 2", originalId: "Note", similarity: 0.75 }]);

    const diff = await getJson<ConflictDiff>(app, `/api/conflicts/${enc(SYNCTHING)}/diff`);
    expect(diff.kind).toBe("text");
    if (diff.kind === "text") {
      expect(diff.lines.filter((line) => line.op !== "same").map((line) => `${line.op} ${line.text}`)).toEqual([
        "remove About [[Other]] and ![[Board.canvas]]. zebraword mine",
        "add About [[Other]] and ![[Board.canvas]]. zebraword syncthing",
      ]);
    }
    const boardDiff = await getJson<ConflictDiff>(app, `/api/conflicts/${enc("Board.sync-conflict-20261122-143005-ABCDEFG.canvas")}/diff`);
    expect(boardDiff).toMatchObject({ kind: "board", changed: ["a"] });
    expect(await snapshot(dir)).toEqual(before);
  });

  it("a rename and a tag rename never write into a copy (the D37 bug, §2; heading rewrites go through the same rewriteEach skip)", async () => {
    const { app, dir, store } = await vault();
    const copies = [`${SYNCTHING}.md`, `${DROPBOX}.md`, "Board.sync-conflict-20261122-143005-ABCDEFG.canvas", "Folder/Sub.sync-conflict-20261122-143005-ABCDEFG.md"];
    const before = new Map(await Promise.all(copies.map(async (file) => [file, await readFile(join(dir, file), "utf8")] as const)));
    const other = store.get("Other");
    expect((await jsonRequest(app, "PUT", `/api/pages/${enc("Other")}`, { title: "Renamed", expectedUpdated: other.updated })).status).toBe(200);
    expect(await readFile(join(dir, "Note.md"), "utf8")).toContain("[[Renamed]]");
    expect((await jsonRequest(app, "POST", "/api/tags/rename", { from: "project", to: "work" })).status).toBe(200);
    expect(await readFile(join(dir, "Note.md"), "utf8")).toContain("work");
    for (const file of copies) expect(await readFile(join(dir, file), "utf8"), file).toBe(before.get(file));
  });
});

describe("resolving a copy (§4.4)", () => {
  async function fresh(app: ReturnType<typeof createApp>, copyId: string) {
    const list = await getJson<ConflictsList>(app, "/api/conflicts");
    const copy = list.copies.find((item) => item.copyId === copyId)!;
    return { copy: copy.copyUpdated, page: copy.originalUpdated };
  }

  it("Keep page: the copy goes to the Trash, its bytes into the page's history; Undo restores it", async () => {
    const { app, dir } = await vault();
    const response = await resolve(app, SYNCTHING, { keep: "page", expected: await fresh(app, SYNCTHING) });
    expect(response.status).toBe(200);
    const result = (await response.json()) as ConflictResolveResult;
    expect(result.trashId).toBeTruthy();
    expect(await readFile(join(dir, "Note.md"), "utf8")).toBe(note("mine"));
    await expect(readFile(join(dir, `${SYNCTHING}.md`), "utf8")).rejects.toThrow();
    const history = await readHistory(historyDir(dir, "Note"));
    const kept = history.entries.find((entry) => entry.reason === "conflict");
    expect(kept).toMatchObject({ source: "external", client: "syncthing ABCDEFG" });
    expect(await readFile(join(historyDir(dir, "Note"), kept!.file), "utf8")).toBe(note("syncthing"));
    expect((await jsonRequest(app, "POST", `/api/trash/${result.trashId}/restore`)).status).toBe(200);
    expect(await readFile(join(dir, `${SYNCTHING}.md`), "utf8")).toBe(note("syncthing"));
  });

  it("Keep copy: the page gets the copy's bytes exactly (CRLF, frontmatter as is), never renamed; undoable from history", async () => {
    const copyBytes = "---\ntags: [project]   # theirs\r\n---\r\nTheir text.\r\n";
    const { app, dir } = await vault({ "Note.md": "Mine.\n", [`${SYNCTHING}.md`]: copyBytes });
    const response = await resolve(app, SYNCTHING, { keep: "copy", expected: await fresh(app, SYNCTHING) });
    expect(response.status).toBe(200);
    const result = (await response.json()) as ConflictResolveResult;
    expect(result.page?.id).toBe("Note");
    expect(await readFile(join(dir, "Note.md"), "utf8")).toBe(copyBytes);
    await expect(readFile(join(dir, `${SYNCTHING}.md`), "utf8")).rejects.toThrow();
    // Undo: the page's own bytes are the before-restore version.
    expect(result.beforeVersion).toBeTruthy();
    const note = (await getJson<PageMeta>(app, `/api/pages/${enc("Note")}`)) as PageMeta & { updated: string };
    expect((await jsonRequest(app, "POST", `/api/history/${enc("Note")}/${enc(result.beforeVersion!)}/restore`, { expectedUpdated: note.updated })).status).toBe(200);
    expect(await readFile(join(dir, "Note.md"), "utf8")).toBe("Mine.\n");
  });

  it("Keep both: the copy becomes `<title> (copy <date>)`, bytes untouched, and no longer a copy; Undo renames it back", async () => {
    const { app, dir } = await vault({ "Note.md": "Mine.\n", [`${DROPBOX}.md`]: "Theirs.\n" });
    const result = (await (await resolve(app, DROPBOX, { keep: "both", expected: await fresh(app, DROPBOX) })).json()) as ConflictResolveResult;
    expect(result.renamedTo).toBe("Note (copy 2026-11-22)");
    expect(await readFile(join(dir, "Note (copy 2026-11-22).md"), "utf8")).toBe("Theirs.\n");
    expect((await getJson<ConflictsList>(app, "/api/conflicts")).copies).toEqual([]);
    const back = await jsonRequest(app, "POST", `/api/conflicts/${enc("Note (copy 2026-11-22)")}/rename-back`, { to: DROPBOX });
    expect(back.status).toBe(200);
    expect(await readFile(join(dir, `${DROPBOX}.md`), "utf8")).toBe("Theirs.\n");
    // Only back to a conflict-copy name.
    expect((await jsonRequest(app, "POST", `/api/conflicts/${enc(DROPBOX)}/rename-back`, { to: "Elsewhere" })).status).toBe(400);
  });

  it("a board: Keep copy writes the copy's JSON exactly", async () => {
    const { app, dir } = await vault();
    const copy = "Board.sync-conflict-20261122-143005-ABCDEFG.canvas";
    expect((await resolve(app, copy, { keep: "copy", expected: await fresh(app, copy) })).status).toBe(200);
    expect(await readFile(join(dir, "Board.canvas"), "utf8")).toBe(board("theirs"));
  });

  it("409 when either file changed since Compare; nothing is written", async () => {
    const { app, dir, store } = await vault();
    const expected = await fresh(app, SYNCTHING);
    await writeFile(join(dir, `${SYNCTHING}.md`), "The sync tool is still writing.\n", "utf8");
    await store.rescan();
    const before = await snapshot(dir);
    expect((await resolve(app, SYNCTHING, { keep: "copy", expected })).status).toBe(409);
    expect((await resolve(app, SYNCTHING, { keep: "page", expected: { copy: "stale", page: expected.page } })).status).toBe(409);
    expect(await snapshot(dir)).toEqual(before);
  });

  it("Delete copy only for an identical or orphan copy; Keep as original for an orphan", async () => {
    const { app, dir } = await vault({ "Note.md": "Same.\n", [`${SYNCTHING}.md`]: "Same.\n", [`${DROPBOX}.md`]: "Different.\n", "Gone.sync-conflict-20261122-143005-ABCDEFG.md": "Last copy.\n" });
    const list = await getJson<ConflictsList>(app, "/api/conflicts");
    expect(list.copies.find((copy) => copy.copyId === SYNCTHING)?.same).toBe(true);
    expect((await resolve(app, DROPBOX, { keep: "delete", expected: await fresh(app, DROPBOX) })).status).toBe(400);
    expect((await resolve(app, SYNCTHING, { keep: "delete", expected: await fresh(app, SYNCTHING) })).status).toBe(200);
    const orphan = "Gone.sync-conflict-20261122-143005-ABCDEFG";
    const kept = (await (await resolve(app, orphan, { keep: "as-original", expected: await fresh(app, orphan) })).json()) as ConflictResolveResult;
    expect(kept.renamedTo).toBe("Gone");
    expect(await readFile(join(dir, "Gone.md"), "utf8")).toBe("Last copy.\n");
  });

  it("possible copies: Compare works; Not a copy dismisses (in .gumply/sync-dismissed.json) and can be undone", async () => {
    const { app, dir } = await vault();
    const diff = await getJson<ConflictDiff>(app, `/api/conflicts/${enc("Note 2")}/diff`);
    expect(diff.kind).toBe("text");
    expect((await jsonRequest(app, "POST", `/api/conflicts/${enc("Note 2")}/dismiss`)).status).toBe(200);
    expect((await getJson<ConflictsList>(app, "/api/conflicts")).possible).toEqual([]);
    expect(JSON.parse(await readFile(join(dir, ".gumply/sync-dismissed.json"), "utf8"))).toEqual({ notACopy: ["Note 2"] });
    expect((await jsonRequest(app, "DELETE", `/api/conflicts/${enc("Note 2")}/dismiss`)).status).toBe(200);
    expect((await getJson<ConflictsList>(app, "/api/conflicts")).possible).toHaveLength(1);
    // A possible copy can't be resolved like a certain one.
    expect((await resolve(app, "Note 2", { keep: "page", expected: { copy: "x", page: "y" } })).status).toBe(400);
  });
});
