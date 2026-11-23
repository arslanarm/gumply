import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VaultStore } from "../src/vault-store";

/**
 * #2wjvk3br (@kaktuzz's "my deleted blocks come back"): another program
 * rewrote a page with the same bytes, or touched it. The refresh saw no change
 * and kept the old file time, so every later save was a false 409 until a
 * restart. Now the new time and version are taken silently, and a save sent
 * with the version from before is accepted: those bytes are what's on disk.
 */
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function vault(files: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "gumply-same-bytes-"));
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

describe("a same-bytes rewrite or a touch is never a conflict (#2wjvk3br)", () => {
  for (const how of ["rewrite", "touch"] as const) {
    it(`page, ${how}, after the refresh: a save with the old version goes through, and the next with the new one`, async () => {
      const { dir, store } = await vault();
      const page = await store.create({ title: "Notes", content: "One.\n\nTwo." });
      const saved = await store.update(page.id, { content: "One.\n\nTwo.\n\nThree.", expectedUpdated: page.updated });
      await sameBytes(join(dir, "Notes.md"), how);
      await store.rescan();
      const historyBefore = (await store.listHistory(page.id)).items.length;

      // The editor still holds the version from before the touch (it wasn't reloaded: it was being edited).
      const next = await store.update(page.id, { content: "One.\n\nThree.", expectedUpdated: saved.updated });
      expect(next.content).toBe("One.\n\nThree.");
      const after = await store.update(page.id, { content: "Three.", expectedUpdated: next.updated });
      expect(await readFile(join(dir, "Notes.md"), "utf8")).toContain("Three.");
      expect(after.content).toBe("Three.");
      // The touch itself made no history version.
      expect((await store.listHistory(page.id)).items.length).toBeGreaterThanOrEqual(historyBefore);
    });
  }

  it("a touch before the watcher's refresh (inside the window) doesn't refuse the save either", async () => {
    const { dir, store } = await vault();
    const page = await store.create({ title: "Notes", content: "One." });
    await sameBytes(join(dir, "Notes.md"), "touch");
    // No rescan: the save's own check finds the moved time and re-reads.
    const next = await store.update(page.id, { content: "One. Two.", expectedUpdated: page.updated });
    expect(next.content).toBe("One. Two.");
  });

  it("several touches in a row: the oldest version is still accepted", async () => {
    const { dir, store } = await vault();
    const page = await store.create({ title: "Notes", content: "One." });
    for (let i = 0; i < 3; i++) {
      await sameBytes(join(dir, "Notes.md"), i % 2 ? "rewrite" : "touch");
      await store.rescan();
    }
    const next = await store.update(page.id, { content: "One. Two.", expectedUpdated: page.updated });
    expect(next.content).toBe("One. Two.");
  });

  it("a real outside change (other bytes) is still a conflict, with or without the refresh", async () => {
    for (const refresh of [false, true]) {
      const { dir, store } = await vault();
      const page = await store.create({ title: "Notes", content: "One." });
      const file = join(dir, "Notes.md");
      await writeFile(file, (await readFile(file, "utf8")).replace("One.", "Changed elsewhere."));
      const later = new Date(Date.now() + 9_000);
      await utimes(file, later, later);
      if (refresh) await store.rescan();
      await expect(store.update(page.id, { content: "Mine.", expectedUpdated: page.updated }), `refresh=${refresh}`).rejects.toMatchObject({ status: 409 });
      expect(await readFile(file, "utf8")).toContain("Changed elsewhere.");
    }
  });

  it("an old version is accepted only while nothing else was written: after a later save it's a conflict again", async () => {
    const { dir, store } = await vault();
    const page = await store.create({ title: "Notes", content: "One." });
    await sameBytes(join(dir, "Notes.md"), "touch");
    await store.rescan();
    await store.update(page.id, { content: "One. Two.", expectedUpdated: page.updated });
    // A second editor still holding the very first version would overwrite "Two.": refused.
    await expect(store.update(page.id, { content: "Stale.", expectedUpdated: page.updated })).rejects.toMatchObject({ status: 409 });
  });

  it("boards and bases too", async () => {
    const { dir, store } = await vault({
      "Map.canvas": '{"nodes":[{"id":"aaaaaaaaaaaaaaaa","type":"text","text":"Hi","x":0,"y":0,"width":100,"height":60}],"edges":[]}',
      "Tasks.base": "views:\n  - type: table\n    name: Table\n",
    });
    const board = store.getBoard("Map.canvas");
    await sameBytes(join(dir, "Map.canvas"), "touch");
    await store.rescan();
    const savedBoard = await store.updateBoard("Map.canvas", { board: { ...board.board, nodes: [] }, expectedUpdated: board.meta.updated });
    expect(savedBoard.board.nodes).toEqual([]);

    const base = store.getBase("Tasks.base");
    await sameBytes(join(dir, "Tasks.base"), "rewrite");
    await store.rescan();
    const savedBase = await store.updateBase("Tasks.base", { config: base.config, expectedUpdated: base.meta.updated });
    expect(savedBase.meta.id).toBe("Tasks.base");
  });
});
