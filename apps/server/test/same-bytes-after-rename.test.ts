import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VaultStore } from "../src/vault-store";

/**
 * #rfgpvrdb: #2wjvk3br's same-bytes rule keeps the hash of a file's bytes per file path. Gumply's own
 * rename moved the page to a new path but left those hashes under the old one, so until the next save a
 * touch or a same-bytes rewrite of the renamed file (a sync tool, Obsidian, git) made that save a false
 * "changed on disk". Pages, a sub-page moved with its parent, boards and bases; a real outside edit after
 * a rename is still refused (D22).
 */
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function vault(files: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "gumply-same-bytes-rename-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
  const store = new VaultStore(dir);
  await store.init();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  return { dir, store };
}

let tick = 0;
/** Another program: the same bytes written again (a new mtime), or only the time moved. */
async function sameBytes(file: string, how: "rewrite" | "touch") {
  tick += 10;
  if (how === "rewrite") await writeFile(file, await readFile(file));
  const later = new Date(Date.now() + 5_000 + tick * 1000);
  await utimes(file, later, later);
}

describe("a same-bytes rewrite or a touch after Gumply's own rename is never a conflict (#rfgpvrdb)", () => {
  for (const how of ["rewrite", "touch"] as const) {
    for (const refresh of [false, true]) {
      it(`a page, ${how}, ${refresh ? "after" : "before"} the refresh: the next save goes through`, async () => {
        const { dir, store } = await vault();
        const page = await store.create({ title: "Notes", content: "One." });
        const saved = await store.update(page.id, { content: "One.\n\nTwo.", expectedUpdated: page.updated });
        const renamed = await store.update(page.id, { title: "Notes renamed", expectedUpdated: saved.updated });
        expect(renamed.id).toBe("Notes renamed");
        await sameBytes(join(dir, "Notes renamed.md"), how);
        if (refresh) await store.rescan();
        const next = await store.update(renamed.id, { content: "One.\n\nThree.", expectedUpdated: renamed.updated });
        expect(next.content).toBe("One.\n\nThree.");
        expect(await readFile(join(dir, "Notes renamed.md"), "utf8")).toContain("Three.");
      });
    }
  }

  it("a sub-page moved with its renamed parent", async () => {
    const { dir, store } = await vault();
    const parent = await store.create({ title: "Projects", content: "Parent." });
    const child = await store.create({ title: "Plan", parentId: parent.id, content: "Child." });
    expect(child.id).toBe("Projects/Plan");
    await store.update(parent.id, { title: "Work", expectedUpdated: parent.updated });
    const moved = await store.get("Work/Plan");
    await sameBytes(join(dir, "Work", "Plan.md"), "touch");
    await store.rescan();
    const next = await store.update(moved.id, { content: "Child, edited.", expectedUpdated: moved.updated });
    expect(next.content).toBe("Child, edited.");
  });

  it("a page inside a renamed plain folder (no folder page)", async () => {
    const { dir, store } = await vault();
    await mkdir(join(dir, "Inbox"));
    await writeFile(join(dir, "Inbox", "Note.md"), "Inside.\n");
    await store.rescan();
    const note = store.get("Inbox/Note");
    await store.update(note.id, { content: "Inside, saved.", expectedUpdated: note.updated });
    await store.update("Inbox", { title: "Archive" });
    const moved = store.get("Archive/Note");
    await sameBytes(join(dir, "Archive", "Note.md"), "rewrite");
    await store.rescan();
    const next = await store.update(moved.id, { content: "Inside, edited.", expectedUpdated: moved.updated });
    expect(next.content).toBe("Inside, edited.");
  });

  it("a board and a base", async () => {
    const { dir, store } = await vault({
      "Map.canvas": '{"nodes":[{"id":"aaaaaaaaaaaaaaaa","type":"text","text":"Hi","x":0,"y":0,"width":100,"height":60}],"edges":[]}',
      "Tasks.base": "views:\n  - type: table\n    name: Table\n",
    });
    const board = store.getBoard("Map.canvas");
    const renamedBoard = await store.updateBoard("Map.canvas", { title: "Plan", expectedUpdated: board.meta.updated });
    expect(renamedBoard.meta.id).toBe("Plan.canvas");
    await sameBytes(join(dir, "Plan.canvas"), "touch");
    await store.rescan();
    const savedBoard = await store.updateBoard("Plan.canvas", { board: { ...renamedBoard.board, nodes: [] }, expectedUpdated: renamedBoard.meta.updated });
    expect(savedBoard.board.nodes).toEqual([]);

    const base = store.getBase("Tasks.base");
    const renamedBase = await store.updateBase("Tasks.base", { title: "Jobs", expectedUpdated: base.meta.updated });
    expect(renamedBase.meta.id).toBe("Jobs.base");
    await sameBytes(join(dir, "Jobs.base"), "rewrite");
    await store.rescan();
    const savedBase = await store.updateBase("Jobs.base", { config: renamedBase.config, expectedUpdated: renamedBase.meta.updated });
    expect(savedBase.meta.id).toBe("Jobs.base");
  });

  it("a real outside edit after a rename is still refused, and its bytes stay (D22)", async () => {
    for (const refresh of [false, true]) {
      const { dir, store } = await vault();
      const page = await store.create({ title: "Notes", content: "One." });
      const renamed = await store.update(page.id, { title: "Notes renamed", expectedUpdated: page.updated });
      const file = join(dir, "Notes renamed.md");
      const theirs = (await readFile(file, "utf8")).replace("One.", "Theirs.");
      await writeFile(file, theirs);
      const later = new Date(Date.now() + 9_000);
      await utimes(file, later, later);
      if (refresh) await store.rescan();
      await expect(store.update(renamed.id, { content: "Mine.", expectedUpdated: renamed.updated }), `refresh=${refresh}`).rejects.toMatchObject({ status: 409 });
      expect(await readFile(file, "utf8")).toBe(theirs);
    }
  });
});
