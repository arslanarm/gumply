import { copyFile, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { historyDir, readHistory } from "../src/history";
import { cleanupVaults, createTestServer } from "./helpers";

/**
 * #3c444g85: a page renamed outside Gumply (Obsidian, a file manager) is
 * paired with its new name, so the old id redirects and its history follows
 * (D20), also for a plain note, whose title is its file name.
 */

afterEach(cleanupVaults);

const pause = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("outside renames are followed (#3c444g85)", () => {
  it("a plain note renamed in place: same inode, so the old id redirects and its history follows", async () => {
    const { store, dir } = await createTestServer();
    await writeFile(join(dir, "Target.md"), "Some text.\n");
    await store.rescan();
    await store.update("Target", { content: "Some text, edited." });
    const before = (await readHistory(historyDir(dir, "Target"))).entries.length;
    expect(before).toBeGreaterThan(0);

    await rename(join(dir, "Target.md"), join(dir, "Renamed Target.md"));
    await store.rescan();
    expect(store.get("Target").id).toBe("Renamed Target");
    expect((await readHistory(historyDir(dir, "Renamed Target"))).entries.length).toBeGreaterThanOrEqual(before);
    expect((await readHistory(historyDir(dir, "Target"))).entries).toEqual([]);
  });

  it("copy-then-delete with identical bytes (a new inode) still pairs, by content", async () => {
    const { store, dir } = await createTestServer();
    await writeFile(join(dir, "Old name.md"), "Unique words here.\n");
    await store.rescan();
    await pause();
    await copyFile(join(dir, "Old name.md"), join(dir, "New name.md"));
    await rm(join(dir, "Old name.md"));
    await store.rescan();
    expect(store.get("Old name").id).toBe("New name");
  });

  it("two identical empty notes never pair: deleting one and creating another empty one isn't a rename", async () => {
    const { store, dir } = await createTestServer();
    await writeFile(join(dir, "Empty A.md"), "");
    await writeFile(join(dir, "Empty B.md"), "");
    await store.rescan();
    await pause();
    await rm(join(dir, "Empty A.md"));
    await writeFile(join(dir, "Empty C.md"), "");
    await store.rescan();
    expect(() => store.get("Empty A")).toThrow();
    expect(store.get("Empty B").id).toBe("Empty B");
  });

  it("a reused inode alone isn't a rename: the mtime must match too", async () => {
    const { store, dir } = await createTestServer();
    await writeFile(join(dir, "Gone.md"), "first text\n");
    await store.rescan();
    await rm(join(dir, "Gone.md"));
    await writeFile(join(dir, "Fresh.md"), "other text\n");
    // Whether or not the file system reused the inode, a new file has a new mtime.
    await utimes(join(dir, "Fresh.md"), new Date(), new Date(Date.now() + 5_000));
    await store.rescan();
    expect(() => store.get("Gone")).toThrow();
  });

  it("a renamed note keeps its frontmatter-title pairing, and a board is matched by content", async () => {
    const { store, dir } = await createTestServer();
    await writeFile(join(dir, "Plan.md"), "---\ntitle: Plan\n---\nBody\n");
    const board = await store.createBoard({ title: "Map" });
    await store.rescan();
    await pause();
    await writeFile(join(dir, "Plan B.md"), "---\ntitle: Plan\n---\nBody, edited elsewhere\n");
    await rm(join(dir, "Plan.md"));
    await copyFile(join(dir, board.meta.id), join(dir, "Map 2.canvas"));
    await rm(join(dir, board.meta.id));
    await store.rescan();
    expect(store.get("Plan").id).toBe("Plan B");
    expect(store.getBoard(board.meta.id).meta.id).toBe("Map 2.canvas");
    expect(await readFile(join(dir, "Plan B.md"), "utf8")).toContain("edited elsewhere");
  });
});
