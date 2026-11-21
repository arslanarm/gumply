import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RestoreResult, TrashedDocument, TrashItem } from "@gumply/core";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupVaults, createPage, createTestServer, getJson, jsonRequest } from "./helpers";

// Files the containment tests put next to (outside) the vault.
const outsideFiles: string[] = [];
afterEach(async () => {
  await Promise.all(outsideFiles.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  await cleanupVaults();
});

const enc = encodeURIComponent;

async function remove(app: Awaited<ReturnType<typeof createTestServer>>["app"], id: string): Promise<string> {
  const response = await jsonRequest(app, "DELETE", `/api/pages/${enc(id)}`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { trashId: string }).trashId;
}

async function restore(app: Awaited<ReturnType<typeof createTestServer>>["app"], trashId: string) {
  const response = await jsonRequest(app, "POST", `/api/trash/${enc(trashId)}/restore`);
  expect(response.status).toBe(200);
  return (await response.json()) as RestoreResult;
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 15));

describe("GET /api/trash (#ppag3ugh)", () => {
  it("is empty for a new vault", async () => {
    const { app } = await createTestServer();
    expect(await getJson<TrashItem[]>(app, "/api/trash")).toEqual([]);
  });

  it("lists deleted pages and boards newest first, with sub-pages under their parent", async () => {
    const { app, store } = await createTestServer();
    const projects = await createPage(app, { title: "Projects", icon: "📁" });
    const plan = await createPage(app, { title: "Plan", parentId: projects.id as string, icon: "🗺️" });
    await createPage(app, { title: "Week 1", parentId: plan.id as string });
    await createPage(app, { title: "Notes", parentId: `${plan.id}/Week 1` });
    await store.createBoard({ title: "Map", parentId: plan.id as string });
    const loose = await createPage(app, { title: "Loose" });

    const first = await remove(app, plan.id as string);
    await pause();
    const second = await remove(app, loose.id as string);

    const items = await getJson<TrashItem[]>(app, "/api/trash");
    expect(items.map((item) => item.trashId)).toEqual([second, first]);
    expect(items[1]).toMatchObject({
      id: "Projects/Plan",
      kind: "page",
      title: "Plan",
      icon: "🗺️",
      parentId: null,
      originalParentId: "Projects",
      originalParentTitle: "Projects",
    });
    expect(Date.parse(items[1]!.deletedAt)).not.toBeNaN();
    expect(items[1]!.children).toEqual([
      { id: "Projects/Plan/Map.canvas", kind: "whiteboard", title: "Map", parentId: "Projects/Plan" },
      { id: "Projects/Plan/Week 1", kind: "page", title: "Week 1", parentId: "Projects/Plan" },
      { id: "Projects/Plan/Week 1/Notes", kind: "page", title: "Notes", parentId: "Projects/Plan/Week 1" },
    ]);
    expect(items[0]).toMatchObject({ id: "Loose", originalParentId: null, originalParentTitle: null, children: [] });

    // The tree, search and graph still never show trashed pages.
    const ids = (await getJson<Array<{ id: string }>>(app, "/api/pages")).map((page) => page.id);
    expect(ids).toEqual(["Projects"]);
  });

  it("names a missing original folder page with null", async () => {
    const { app } = await createTestServer();
    const a = await createPage(app, { title: "A" });
    const b = await createPage(app, { title: "B", parentId: a.id as string });
    await remove(app, b.id as string);
    await remove(app, a.id as string);
    const items = await getJson<TrashItem[]>(app, "/api/trash");
    const bItem = items.find((item) => item.id === "A/B");
    expect(bItem).toMatchObject({ originalParentId: "A", originalParentTitle: null });
  });
});

describe("GET /api/trash/:trashId", () => {
  it("returns a trashed page read-only, its sub-pages by ?id=, and a board's canvas", async () => {
    const { app, store } = await createTestServer();
    const a = await createPage(app, { title: "A", content: "Top body" });
    await createPage(app, { title: "Child", parentId: a.id as string, content: "Child body" });
    await store.createBoard({ title: "Map", parentId: a.id as string });
    const trashId = await remove(app, a.id as string);

    const top = await getJson<TrashedDocument>(app, `/api/trash/${trashId}`);
    expect(top.page).toMatchObject({ id: "A", title: "A", content: "Top body", childCount: 2 });
    expect(top.item.trashId).toBe(trashId);
    expect(top.board).toBeUndefined();

    const child = await getJson<TrashedDocument>(app, `/api/trash/${trashId}?id=${enc("A/Child")}`);
    expect(child.page).toMatchObject({ id: "A/Child", content: "Child body", parentId: "A" });

    const board = await getJson<TrashedDocument>(app, `/api/trash/${trashId}?id=${enc("A/Map.canvas")}`);
    expect(board.page).toMatchObject({ kind: "whiteboard", content: "" });
    expect(board.board).toEqual({ nodes: [], edges: [] });

    // Only ids inside this entry.
    expect((await app.request(`/api/trash/${trashId}?id=${enc("Other")}`)).status).toBe(404);
    expect((await app.request(`/api/trash/${trashId}?id=${enc("../A")}`)).status).toBe(404);
  });
});

describe("POST /api/trash/:trashId/restore", () => {
  it("puts a page back where it was, with its sub-pages", async () => {
    const { app } = await createTestServer();
    const projects = await createPage(app, { title: "Projects" });
    const plan = await createPage(app, { title: "Plan", parentId: projects.id as string });
    await createPage(app, { title: "Week 1", parentId: plan.id as string });
    const trashId = await remove(app, plan.id as string);

    const result = await restore(app, trashId);
    expect(result).toMatchObject({ id: "Projects/Plan", movedToTopLevel: false, renamed: false });
    expect(result.restored.map((meta) => meta.id).sort()).toEqual(["Projects/Plan", "Projects/Plan/Week 1"]);
    expect(await getJson<TrashItem[]>(app, "/api/trash")).toEqual([]);
  });

  it("goes to the top level when its folder page is gone, and fixes attachment links (D23)", async () => {
    const { app, dir } = await createTestServer();
    await mkdir(join(dir, "attachments"), { recursive: true });
    await writeFile(join(dir, "attachments", "photo.png"), "png");
    const a = await createPage(app, { title: "A" });
    const b = await createPage(app, {
      title: "B",
      parentId: a.id as string,
      content: "![photo](../attachments/photo.png)",
    });
    await createPage(app, { title: "C", parentId: b.id as string, content: "![photo](../../attachments/photo.png)" });
    const trashB = await remove(app, b.id as string);
    await remove(app, a.id as string);

    const result = await restore(app, trashB);
    expect(result).toMatchObject({ id: "B", movedToTopLevel: true, renamed: false });
    expect(result.restored.map((meta) => meta.id).sort()).toEqual(["B", "B/C"]);
    expect(result.restored.find((meta) => meta.id === "B")?.parentId).toBeNull();
    expect((await getJson<{ content: string }>(app, "/api/pages/B")).content).toBe("![photo](attachments/photo.png)");
    expect((await getJson<{ content: string }>(app, `/api/pages/${enc("B/C")}`)).content).toBe(
      "![photo](../attachments/photo.png)",
    );
    expect(await readdir(dir)).not.toContain("A");
  });

  it("adds ` 2` when the name is taken, also at the top level and for boards", async () => {
    const { app, store } = await createTestServer();
    const a = await createPage(app, { title: "A" });
    const b = await createPage(app, { title: "Notes", parentId: a.id as string });
    await createPage(app, { title: "Child", parentId: b.id as string });
    const map = await store.createBoard({ title: "Map" });

    const trashNotes = await remove(app, b.id as string);
    const trashMap = await remove(app, map.meta.id);
    await remove(app, a.id as string);
    await createPage(app, { title: "Notes" });
    await store.createBoard({ title: "Map" });

    const notes = await restore(app, trashNotes);
    expect(notes).toMatchObject({ id: "Notes 2", movedToTopLevel: true, renamed: true });
    expect(notes.restored.map((meta) => meta.id).sort()).toEqual(["Notes 2", "Notes 2/Child"]);

    const board = await restore(app, trashMap);
    expect(board).toMatchObject({ id: "Map 2.canvas", movedToTopLevel: false, renamed: true });
    expect(board.restored[0]).toMatchObject({ kind: "whiteboard" });
  });

  it("board cards that pointed at a page follow it when it comes back somewhere else (D25)", async () => {
    const { app, store } = await createTestServer();
    const a = await createPage(app, { title: "A" });
    const b = await createPage(app, { title: "B", parentId: a.id as string });
    const map = await store.createBoard({ title: "Map" });
    await store.updateBoard(map.meta.id, {
      board: { nodes: [{ id: "n1", type: "file", file: "A/B.md", x: 0, y: 0, width: 200, height: 100 }], edges: [] },
    });
    const trashB = await remove(app, b.id as string);
    await remove(app, a.id as string);
    await restore(app, trashB);
    const saved = store.getBoard(map.meta.id).board;
    expect(saved.nodes[0]).toMatchObject({ file: "B.md" });
  });
});

describe("delete forever and empty", () => {
  it("DELETE /api/trash/:trashId removes one entry for good", async () => {
    const { app, dir } = await createTestServer();
    const a = await createPage(app, { title: "A" });
    const keep = await createPage(app, { title: "Keep" });
    const trashA = await remove(app, a.id as string);
    const trashKeep = await remove(app, keep.id as string);

    expect((await jsonRequest(app, "DELETE", `/api/trash/${trashA}`)).status).toBe(200);
    expect(await readdir(join(dir, ".trash"))).toEqual([trashKeep]);
    expect((await getJson<TrashItem[]>(app, "/api/trash")).map((item) => item.trashId)).toEqual([trashKeep]);
    expect((await jsonRequest(app, "DELETE", `/api/trash/${trashA}`)).status).toBe(404);
    expect((await jsonRequest(app, "POST", `/api/trash/${trashA}/restore`)).status).toBe(404);
  });

  it("DELETE /api/trash empties Gumply's entries and leaves other files in .trash alone", async () => {
    const { app, dir } = await createTestServer();
    for (const title of ["A", "B", "C"]) await remove(app, (await createPage(app, { title })).id as string);
    // Obsidian's own trash puts plain files there.
    await writeFile(join(dir, ".trash", "Obsidian note.md"), "mine");

    const response = await jsonRequest(app, "DELETE", "/api/trash");
    expect(await response.json()).toEqual({ deleted: 3 });
    expect(await readdir(join(dir, ".trash"))).toEqual(["Obsidian note.md"]);
    expect(await getJson<TrashItem[]>(app, "/api/trash")).toEqual([]);
  });

  it("emptying a vault with no trash folder is fine", async () => {
    const { app } = await createTestServer();
    expect(await (await jsonRequest(app, "DELETE", "/api/trash")).json()).toEqual({ deleted: 0 });
  });
});

describe("path containment", () => {
  it("rejects trash ids that aren't plain ids", async () => {
    const { app } = await createTestServer();
    for (const bad of ["..", "../..", "a/b", "a.b", "%2e%2e"]) {
      const path = `/api/trash/${enc(bad)}`;
      for (const response of [
        await app.request(path),
        await jsonRequest(app, "DELETE", path),
        await jsonRequest(app, "POST", `${path}/restore`),
      ]) {
        expect([400, 404]).toContain(response.status);
      }
    }
    expect((await app.request("/api/trash/does-not-exist")).status).toBe(404);
  });

  it("ignores manifests that point outside their entry, and never follows symlinks", async () => {
    const { app, dir } = await createTestServer();
    const outside = join(dir, "..", `outside-${Date.now()}.md`);
    outsideFiles.push(outside);
    await writeFile(outside, "secret");
    await writeFile(join(dir, "Live.md"), "live");

    // 1. A manifest whose file escapes the entry.
    await mkdir(join(dir, ".trash", "escape"), { recursive: true });
    await writeFile(
      join(dir, ".trash", "escape", "meta.json"),
      JSON.stringify({ id: "X", trashId: "escape", deleted: ["X"], deletedAt: new Date().toISOString(), file: "../../Live.md" }),
    );
    // 2. A manifest with an id that escapes.
    await mkdir(join(dir, ".trash", "badid"), { recursive: true });
    await writeFile(
      join(dir, ".trash", "badid", "meta.json"),
      JSON.stringify({ id: "../Live", trashId: "badid", deleted: ["../Live"], deletedAt: new Date().toISOString() }),
    );
    // 3. A trashed "page" that is a symlink to a file outside the vault.
    await mkdir(join(dir, ".trash", "link"), { recursive: true });
    await writeFile(
      join(dir, ".trash", "link", "meta.json"),
      JSON.stringify({ id: "Y", trashId: "link", deleted: ["Y"], deletedAt: new Date().toISOString(), file: "Y.md" }),
    );
    await symlink(outside, join(dir, ".trash", "link", "Y.md"));
    // 4. An entry that is itself a symlink to a directory outside.
    await symlink(join(dir, ".."), join(dir, ".trash", "dirlink"));

    expect(await getJson<TrashItem[]>(app, "/api/trash")).toEqual([]);
    for (const trashId of ["escape", "badid", "link", "dirlink"]) {
      expect((await app.request(`/api/trash/${trashId}`)).status).toBe(404);
      expect((await jsonRequest(app, "POST", `/api/trash/${trashId}/restore`)).status).toBe(404);
    }
    expect((await jsonRequest(app, "DELETE", "/api/trash/dirlink")).status).toBe(404);
    expect((await jsonRequest(app, "DELETE", "/api/trash")).status).toBe(200);
    // Nothing outside the trash was read, moved or deleted.
    expect(await readFile(outside, "utf8")).toBe("secret");
    expect(await readFile(join(dir, "Live.md"), "utf8")).toBe("live");
    expect(await readdir(join(dir, ".."))).toContain(outside.split("/").pop());
  });
});

describe("watcher and .trash", () => {
  it("changes inside .trash never reach the page index", async () => {
    const { app, store, dir } = await createTestServer();
    store.startWatching();
    try {
      const a = await createPage(app, { title: "A" });
      const trashId = await remove(app, a.id as string);
      // Edit, add and remove files in the trash like another tool might.
      await writeFile(join(dir, ".trash", trashId, "A.md"), "edited in trash");
      await writeFile(join(dir, ".trash", "Stray.md"), "stray");
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(store.list()).toEqual([]);
      expect(await store.rescan()).toBe(false);

      // Delete forever and empty don't make the watcher see pages either.
      await jsonRequest(app, "DELETE", `/api/trash/${trashId}`);
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(store.list()).toEqual([]);

      // A restore while watching shows the page exactly once, with the trash edit.
      const b = await createPage(app, { title: "B" });
      const trashB = await remove(app, b.id as string);
      await restore(app, trashB);
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(store.list().map((meta) => meta.id)).toEqual(["B"]);
    } finally {
      store.stopWatching();
    }
  });
});

describe("a .trash that is a symlink", () => {
  it("is never listed, read, restored or emptied", async () => {
    const { app, dir } = await createTestServer();
    const elsewhere = join(dir, "..", `elsewhere-${Date.now()}`);
    outsideFiles.push(elsewhere);
    await mkdir(join(elsewhere, "abc"), { recursive: true });
    await writeFile(join(elsewhere, "abc", "meta.json"), JSON.stringify({ id: "Z", deleted: ["Z"], file: "Z.md" }));
    await writeFile(join(elsewhere, "abc", "Z.md"), "outside");
    await symlink(elsewhere, join(dir, ".trash"));
    expect(await getJson<TrashItem[]>(app, "/api/trash")).toEqual([]);
    expect((await app.request("/api/trash/abc")).status).toBe(404);
    expect((await jsonRequest(app, "POST", "/api/trash/abc/restore")).status).toBe(404);
    expect(await (await jsonRequest(app, "DELETE", "/api/trash")).json()).toEqual({ deleted: 0 });
    expect(await readFile(join(elsewhere, "abc", "Z.md"), "utf8")).toBe("outside");
  });
});

describe("plain-folder entries (D33, the shape #mf397jyx writes)", () => {
  /** What deleting the plain folder `Work` writes: the directory, as it was. */
  async function trashFolder(dir: string, trashId = "f0lder") {
    const entry = join(dir, ".trash", trashId);
    await mkdir(join(entry, "Work", "Sub"), { recursive: true });
    await writeFile(join(entry, "Work", "Plan.md"), "---\ntitle: Plan\nicon: 🗺️\n---\nThe plan\n");
    await writeFile(join(entry, "Work", "Sub", "Notes.md"), "Notes body\n");
    await writeFile(join(entry, "Work", "Map.canvas"), '{"nodes":[],"edges":[]}\n');
    await writeFile(join(entry, "Work", "report.pdf"), "%PDF");
    await writeFile(join(entry, "Work", "Sub", "photo.png"), "png");
    await writeFile(
      join(entry, "meta.json"),
      JSON.stringify({
        id: "Work",
        kind: "folder",
        file: "Work",
        trashId,
        deleted: ["Work", "Work/Plan", "Work/Sub/Notes", "Work/Map.canvas"],
        deletedAt: new Date().toISOString(),
      }),
    );
    return trashId;
  }

  it("lists a folder with its pages and boards and counts the other files", async () => {
    const { app, dir } = await createTestServer();
    const trashId = await trashFolder(dir);
    const [item] = await getJson<TrashItem[]>(app, "/api/trash");
    expect(item).toMatchObject({ trashId, id: "Work", kind: "folder", title: "Work", otherFiles: 2, originalParentId: null });
    expect(item!.children.map((child) => [child.id, child.kind, child.title])).toEqual([
      ["Work/Map.canvas", "whiteboard", "Map"],
      ["Work/Plan", "page", "Plan"],
      ["Work/Sub/Notes", "page", "Notes"],
    ]);
    // No document of its own; its pages read like any trashed page.
    expect(await getJson<TrashedDocument>(app, `/api/trash/${trashId}`)).toMatchObject({ page: null });
    const plan = await getJson<TrashedDocument>(app, `/api/trash/${trashId}?id=${enc("Work/Plan")}`);
    expect(plan.page).toMatchObject({ title: "Plan", icon: "🗺️" });
    expect(plan.page?.content).toContain("The plan");
  });

  it("restores the whole directory, with ` 2` when the name is taken", async () => {
    const { app, dir } = await createTestServer();
    await trashFolder(dir, "one");
    let result = await restore(app, "one");
    expect(result).toMatchObject({ id: "Work", renamed: false, movedToTopLevel: false });
    expect(result.restored.map((meta) => meta.id).sort()).toEqual(["Work/Map.canvas", "Work/Plan", "Work/Sub/Notes"]);
    expect((await readdir(join(dir, "Work"))).sort()).toEqual(["Map.canvas", "Plan.md", "Sub", "report.pdf"]);
    expect(await readdir(join(dir, "Work", "Sub"))).toContain("photo.png");

    // Trash another "Work" while one is back: it lands next to it as "Work 2".
    await trashFolder(dir, "two");
    result = await restore(app, "two");
    expect(result).toMatchObject({ id: "Work 2", renamed: true });
    expect(result.restored.map((meta) => meta.id).sort()).toEqual(["Work 2/Map.canvas", "Work 2/Plan", "Work 2/Sub/Notes"]);
  });

  it("a page deleted from a plain folder goes back into that folder while it exists", async () => {
    const { app, dir, store } = await createTestServer();
    await mkdir(join(dir, "Area"), { recursive: true });
    await writeFile(join(dir, "Area", "Note.md"), "x\n");
    await writeFile(join(dir, "Area", "Keep.md"), "keep\n");
    await store.rescan();
    const trashId = await remove(app, "Area/Note");
    const [item] = await getJson<TrashItem[]>(app, "/api/trash");
    expect(item).toMatchObject({ originalParentId: "Area", originalParentTitle: "Area" });
    expect(await restore(app, trashId)).toMatchObject({ id: "Area/Note", movedToTopLevel: false });
  });

  it("a folder entry that is a symlink, or a file, is never listed or restored", async () => {
    const { app, dir } = await createTestServer();
    const outside = join(dir, "..", `outside-dir-${Date.now()}`);
    outsideFiles.push(outside);
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "secret.md"), "secret");
    await mkdir(join(dir, ".trash", "lnk"), { recursive: true });
    await symlink(outside, join(dir, ".trash", "lnk", "Work"));
    await writeFile(join(dir, ".trash", "lnk", "meta.json"), JSON.stringify({ id: "Work", kind: "folder", file: "Work", deleted: ["Work"] }));
    expect(await getJson<TrashItem[]>(app, "/api/trash")).toEqual([]);
    expect((await jsonRequest(app, "POST", "/api/trash/lnk/restore")).status).toBe(404);
    expect(await readdir(dir)).not.toContain("Work");
    expect(await readFile(join(outside, "secret.md"), "utf8")).toBe("secret");
  });

  it("delete forever and empty remove folder entries too", async () => {
    const { app, dir } = await createTestServer();
    await trashFolder(dir, "aaa");
    await trashFolder(dir, "bbb");
    expect((await jsonRequest(app, "DELETE", "/api/trash/aaa")).status).toBe(200);
    expect(await (await jsonRequest(app, "DELETE", "/api/trash")).json()).toEqual({ deleted: 1 });
    expect(await readdir(join(dir, ".trash"))).toEqual([]);
  });
});

describe("restoring into a taken name: the title follows the new name (D20, #ppag3ugh review)", () => {
  it("a page with a title gets the new name as its title; its sub-pages keep theirs", async () => {
    const { app, store } = await createTestServer();
    const alpha = await createPage(app, { title: "Alpha", content: "old" });
    await createPage(app, { title: "Notes", parentId: alpha.id as string });
    const trashId = await remove(app, alpha.id as string);
    await createPage(app, { title: "Alpha" });

    const result = await restore(app, trashId);
    expect(result).toMatchObject({ id: "Alpha 2", renamed: true });
    expect(store.get("Alpha 2")).toMatchObject({ title: "Alpha 2", content: "old" });
    expect(store.get("Alpha 2/Notes").title).toBe("Notes");
    const titles = (await getJson<Array<{ title: string }>>(app, "/api/pages")).map((page) => page.title).sort();
    expect(titles).toEqual(["Alpha", "Alpha 2", "Notes"]);
  });

  it("a plain note stays plain (its file name is its title)", async () => {
    const { app, dir, store } = await createTestServer();
    await writeFile(join(dir, "Plain.md"), "plain body\n");
    await store.rescan();
    const trashId = await remove(app, "Plain");
    await writeFile(join(dir, "Plain.md"), "another\n");
    await store.rescan();
    expect(await restore(app, trashId)).toMatchObject({ id: "Plain 2", renamed: true });
    expect(await readFile(join(dir, "Plain 2.md"), "utf8")).toBe("plain body\n");
    expect(store.get("Plain 2").title).toBe("Plain 2");
  });

  it("a board's stored title gives way to its new name", async () => {
    const { app, store, dir } = await createTestServer();
    const board = await store.createBoard({ title: "Map" });
    const trashId = await remove(app, board.meta.id);
    await store.createBoard({ title: "Map" });
    expect(await restore(app, trashId)).toMatchObject({ id: "Map 2.canvas", renamed: true });
    expect(store.getBoard("Map 2.canvas").meta.title).toBe("Map 2");
    expect(JSON.parse(await readFile(join(dir, "Map 2.canvas"), "utf8")).gumply?.title).toBeUndefined();
  });

  it("never stacks suffixes: a trashed \"Alpha 2\" comes back as \"Alpha 3\"", async () => {
    const { app } = await createTestServer();
    await createPage(app, { title: "Alpha" });
    const second = await createPage(app, { title: "Alpha" });
    expect(second.id).toBe("Alpha 2");
    const trashId = await remove(app, "Alpha 2");
    await createPage(app, { title: "Alpha" }); // takes "Alpha 2" again
    const result = await restore(app, trashId);
    expect(result).toMatchObject({ id: "Alpha 3", renamed: true });
    expect(result.restored[0]?.title).toBe("Alpha 3");
  });

  it("a name that just ends in a number keeps it (\"Sprint 12\" → \"Sprint 12 2\", not \"Sprint 2\")", async () => {
    const { app } = await createTestServer();
    await createPage(app, { title: "Sprint 12" });
    const trashId = await remove(app, "Sprint 12");
    await createPage(app, { title: "Sprint 12" });
    expect(await restore(app, trashId)).toMatchObject({ id: "Sprint 12 2", renamed: true });
  });

  it("a folder entry follows the same rules; what's inside keeps its names", async () => {
    const { app, dir, store } = await createTestServer();
    await mkdir(join(dir, "Work"), { recursive: true });
    await mkdir(join(dir, "Work 2"), { recursive: true });
    await writeFile(join(dir, "Work 2", "x.md"), "x\n");
    await store.rescan();
    const entry = join(dir, ".trash", "fold2");
    await mkdir(join(entry, "Work 2"), { recursive: true });
    await writeFile(join(entry, "Work 2", "Plan.md"), "plan\n");
    await writeFile(
      join(entry, "meta.json"),
      JSON.stringify({ id: "Work 2", kind: "folder", file: "Work 2", deleted: ["Work 2", "Work 2/Plan"] }),
    );
    const result = await restore(app, "fold2");
    expect(result).toMatchObject({ id: "Work 3", renamed: true });
    expect(result.restored.map((meta) => [meta.id, meta.title])).toEqual([["Work 3/Plan", "Plan"]]);
  });
});
