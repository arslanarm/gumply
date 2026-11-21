import { readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupVaults, createTestServer } from "./helpers";

afterEach(cleanupVaults);

describe("plain notes: our own saves never count as changed on disk (#d5e4mawv)", () => {
  it("the version of a re-read file matches the one our write returned, even with a sub-millisecond mtime >= .5", async () => {
    const { store, dir } = await createTestServer();
    await writeFile(join(dir, "Plain.md"), "Line one.\n");
    await store.rescan();
    const first = await store.update("Plain", { content: "Line one. A\n", expectedUpdated: store.get("Plain").updated });
    // Give the file the same millisecond with a .7 fraction (Node's stats.mtime
    // rounds that up; our write path truncated it), then let the store re-read it.
    const file = join(dir, "Plain.md");
    const ms = Math.floor((await stat(file)).mtimeMs);
    const at = new Date(ms);
    await utimes(file, at, (ms + 0.7) / 1000);
    // Any other change in the vault makes the store re-read every file.
    await writeFile(join(dir, "Other.md"), "Another note.\n");
    await store.rescan();
    expect(store.get("Plain").updated).toBe(first.updated);
    const second = await store.update("Plain", { content: "Line one. A\n\nLine two. B\n", expectedUpdated: first.updated });
    expect(second.content).toBe("Line one. A\n\nLine two. B\n");
  });

  it("two quick saves with the returned version both succeed, with the watcher running (x50)", async () => {
    const { store, dir } = await createTestServer();
    store.startWatching();
    let conflicts = 0;
    try {
      for (let round = 0; round < 50; round += 1) {
        const id = `Plain ${round}`;
        await writeFile(join(dir, `${id}.md`), "Line one.\n\nLine two.\n");
        await store.rescan();
        const loaded = store.get(id);
        const first = await store.update(id, { content: "Line one. A\n\nLine two.\n", expectedUpdated: loaded.updated });
        // Let the watcher see our own write.
        await new Promise((resolve) => setTimeout(resolve, 150 + (round % 5) * 40));
        try {
          await store.update(id, { content: "Line one. A\n\nLine two. B\n", expectedUpdated: first.updated });
        } catch (error) {
          if ((error as { status?: number }).status === 409) conflicts += 1;
          else throw error;
        }
      }
    } finally {
      store.stopWatching();
    }
    expect(conflicts).toBe(0);
  }, 60_000);
});

describe("a save sent while our previous one was in flight (#3t6v62cb exit save)", () => {
  it("the same editor may send the version its own last write replaced; nobody else may", async () => {
    const { store } = await createTestServer();
    const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
    const page = await store.create({ title: "Note", content: "v0" });
    await tick();
    const v1 = await store.update(page.id, { content: "v1", expectedUpdated: page.updated, writer: "tab-a" });
    await tick();
    // Tab A's exit save still holds the version before its in-flight write.
    const v2 = await store.update(page.id, { content: "v2", expectedUpdated: page.updated, writer: "tab-a" });
    expect(v2.content).toBe("v2");
    // Another tab (or no writer) with that old version is a real conflict.
    await expect(store.update(page.id, { content: "theirs", expectedUpdated: v1.updated, writer: "tab-b" })).rejects.toMatchObject({ status: 409 });
    await expect(store.update(page.id, { content: "theirs", expectedUpdated: page.updated })).rejects.toMatchObject({ status: 409 });
    // Only the version right before our last write: two writes back is a conflict.
    await expect(store.update(page.id, { content: "old", expectedUpdated: page.updated, writer: "tab-a" })).rejects.toMatchObject({ status: 409 });
    expect(store.get(page.id).content).toBe("v2");
  });

  it("an outside edit re-indexed after our write still wins: the old version gets a 409 (D22)", async () => {
    const { store, dir } = await createTestServer();
    await writeFile(join(dir, "Plain.md"), "v0\n");
    await store.rescan();
    const v0 = store.get("Plain");
    await store.update("Plain", { content: "v1\n", expectedUpdated: v0.updated, writer: "tab-a" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(join(dir, "Plain.md"), "outside edit\n");
    await store.rescan();
    await expect(store.update("Plain", { content: "exit save\n", expectedUpdated: v0.updated, writer: "tab-a" })).rejects.toMatchObject({ status: 409 });
    // `content` never carries the final newline (#5fv7c25w); the file keeps it.
    expect(store.get("Plain").content).toBe("outside edit");
    expect(await readFile(join(dir, "Plain.md"), "utf8")).toBe("outside edit\n");
  });

  it("boards follow the same rule", async () => {
    const { store } = await createTestServer();
    const created = await store.createBoard({ title: "Map" });
    const id = created.meta.id;
    const one = { nodes: [{ id: "a", type: "text", text: "one", x: 0, y: 0, width: 100, height: 50 }], edges: [] };
    const two = { nodes: [{ id: "a", type: "text", text: "two", x: 0, y: 0, width: 100, height: 50 }], edges: [] };
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.updateBoard(id, { board: one, expectedUpdated: created.meta.updated, writer: "tab-a" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const saved = await store.updateBoard(id, { board: two, expectedUpdated: created.meta.updated, writer: "tab-a" });
    expect(saved.board.nodes[0]).toMatchObject({ text: "two" });
    await expect(store.updateBoard(id, { board: one, expectedUpdated: created.meta.updated, writer: "tab-b" })).rejects.toMatchObject({ status: 409 });
  });
});
