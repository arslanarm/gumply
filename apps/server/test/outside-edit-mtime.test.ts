import { chmod, readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { historyDir, readHistory } from "../src/history";
import { cleanupVaults, createTestServer } from "./helpers";

/**
 * #y5k39njn (found by the #yy35bfac hunt): a page's version is the newer of
 * its frontmatter `updated:` and its file time. An outside edit that keeps the
 * frontmatter and has an older or equal file time (a sync tool keeping another
 * device's mtime, a clock behind, FAT/exFAT's 2 s times) used to keep the
 * version, so a save from before it passed the check and overwrote it (D22).
 * Now new content always gets a newer version, and a save also checks the
 * file's bytes when its time hasn't moved. Synthetic vault.
 */

afterEach(cleanupVaults);

async function saved(writer?: string) {
  const { store, dir } = await createTestServer();
  const page = await store.create({ title: "Ledger", content: "Balance: ten." });
  const result = await store.update(page.id, { content: "Balance: ten. Saved.", writer });
  const file = join(dir, `${result.id}.md`);
  return { store, dir, id: result.id, file, version: result.updated, bytes: await readFile(file, "utf8"), mtime: (await stat(file)).mtime };
}

/** A save from `version`: "accepted", or the error's message. */
async function saveFrom(store: Awaited<ReturnType<typeof saved>>["store"], id: string, version: string, writer?: string): Promise<string> {
  try {
    await store.update(id, { content: "Balance: ten. Saved. Mine.", expectedUpdated: version, writer });
    return "accepted";
  } catch (error) {
    return (error as Error).message;
  }
}

describe("an outside edit whose file time doesn't move the version (#y5k39njn)", () => {
  const cases: Array<{ name: string; edit: (bytes: string) => string; time: (mtime: Date) => Date }> = [
    { name: "the same size and the same file time", edit: (b) => b.replace("Saved.", "Other."), time: (m) => m },
    { name: "another size, the same file time", edit: (b) => b.replace("Saved.", "Other device, longer."), time: (m) => m },
    { name: "dated 10 minutes earlier (a clock behind)", edit: (b) => b.replace("Saved.", "Older-dated edit."), time: (m) => new Date(m.getTime() - 10 * 60_000) },
  ];
  for (const { name, edit, time } of cases) {
    for (const writer of [undefined, "editor-1"]) {
      it(`${name}${writer ? ", from an editor" : ""}: the version moves on, and a save from before it is a conflict; the outside text stays`, async () => {
        const { store, id, file, version, bytes, mtime } = await saved(writer);
        await writeFile(file, edit(bytes));
        await utimes(file, time(mtime), time(mtime));
        await store.rescan();
        expect(store.get(id).updated > version).toBe(true);
        expect(await saveFrom(store, id, version, writer)).toMatch(/changed on disk/);
        expect(await readFile(file, "utf8")).toBe(edit(bytes));
      });
    }
  }

  it("before the refresh has read it (the watcher hasn't run yet), a save still checks the bytes: a conflict", async () => {
    const { store, id, file, version, bytes, mtime } = await saved("editor-1");
    await writeFile(file, bytes.replace("Saved.", "Other."));
    await utimes(file, mtime, mtime);
    expect(await saveFrom(store, id, version, "editor-1")).toMatch(/changed on disk/);
    expect(await readFile(file, "utf8")).toContain("Other.");
  });

  it("FAT/exFAT 2 s file times: an outside edit in the same 2 s window as our write is a conflict too", async () => {
    const { store, id, file, bytes, mtime } = await saved();
    const floor2 = new Date(Math.floor(mtime.getTime() / 2000) * 2000);
    await utimes(file, floor2, floor2);
    await store.rescan();
    const before = store.get(id).updated;
    await writeFile(file, bytes.replace("Saved.", "Other."));
    await utimes(file, floor2, floor2);
    await store.rescan();
    expect(store.get(id).updated > before).toBe(true);
    expect(await saveFrom(store, id, before)).toMatch(/changed on disk/);
  });

  it("frontmatter `updated:` an hour ahead (a device clock ahead), then an edit that keeps it: the version still moves on", async () => {
    const { store, id, file, bytes } = await saved();
    const ahead = bytes.replace(/updated: .*\n/, `updated: ${new Date(Date.now() + 3_600_000).toISOString()}\n`);
    await writeFile(file, ahead);
    await store.rescan();
    const v1 = store.get(id).updated;
    await writeFile(file, ahead.replace("Saved.", "Edited elsewhere."));
    await store.rescan();
    expect(store.get(id).updated > v1).toBe(true);
    expect(await saveFrom(store, id, v1)).toMatch(/changed on disk/);
    expect(await readFile(file, "utf8")).toContain("Edited elsewhere.");
  });

  // @graph-dev's review: every kind of our own write, re-read by a full rescan, is never taken for an
  // outside edit (no moved-on version, so no false conflict, and no "external" History version).
  const externals = async (dir: string, id: string) =>
    (await readHistory(historyDir(dir, id)).catch(() => ({ entries: [] as Array<{ source?: string }> }))).entries.filter((entry) => entry.source === "external").length;
  it("our own writes of every kind, then a rescan, then a save from the answer's version: never a conflict, never an outside version", async () => {
    const { store, dir } = await createTestServer();
    const other = await store.create({ title: "Index", content: "See [[Ledger]]." });
    const page = await store.create({ title: "Ledger", content: "Balance: ten." });
    let id = page.id;
    let version = (await store.update(id, { content: "Balance: ten. A.", writer: "w" })).updated;
    const step = async (label: string, write: () => Promise<{ id?: string; updated: string }>) => {
      const answer = await write();
      if (answer.id) id = answer.id;
      version = answer.updated;
      await store.rescan();
      const next = await store.update(id, { content: `Balance: ten. After ${label}.`, expectedUpdated: version, writer: "w" }).catch((error: Error) => error);
      expect(next instanceof Error ? `${label}: ${next.message}` : "ok", label).toBe("ok");
      version = (next as { updated: string }).updated;
    };
    await step("a body save", () => store.update(id, { content: "Balance: ten. Body.", expectedUpdated: version, writer: "w" }));
    await step("an icon set", () => store.update(id, { icon: "  📒 ", expectedUpdated: version, writer: "w" }));
    await step("an icon cleared", () => store.update(id, { icon: null, expectedUpdated: version, writer: "w" }));
    await step("tags", () => store.update(id, { tags: ["  money ", "Money"], expectedUpdated: version, writer: "w" }));
    await step("a properties patch", () =>
      store.update(id, { properties: { set: { status: "open", related: "[[Index]]" } }, expectedUpdated: version, writer: "w" }),
    );
    await step("a title rename (rewrites Index's link)", () => store.update(id, { title: "  Ledger 2026 ", expectedUpdated: version, writer: "w" }));
    // The page whose link the rename rewrote saves from its version too.
    await store.rescan();
    const index = store.get(other.id);
    expect(await store.update(other.id, { content: `${index.content} More.`, expectedUpdated: index.updated }).then(() => "ok", (error: Error) => error.message)).toBe("ok");
    const { entries } = await readHistory(historyDir(dir, id));
    const restorable = entries.find((entry) => entry.source === "app");
    if (restorable) await step("a restore", () => store.restoreVersion(id, restorable.file, { expectedUpdated: version, writer: "w" }) as Promise<{ updated: string }>);
    expect(await externals(dir, id)).toBe(0);
    expect(await externals(dir, other.id)).toBe(0);

    // A board and a base, saved, rescanned and saved again.
    const board = await store.createBoard({ title: "Map" });
    let boardVersion = (await store.updateBoard(board.meta.id, { board: { nodes: [{ id: "a", type: "text", text: "Hi", x: 0, y: 0, width: 100, height: 40 }], edges: [] }, expectedUpdated: board.meta.updated })).meta.updated;
    await store.rescan();
    boardVersion = (await store.updateBoard(board.meta.id, { board: { nodes: [], edges: [] }, expectedUpdated: boardVersion })).meta.updated;
    expect(boardVersion).toBeTruthy();
    const base = await store.createBase({ title: "Accounts" });
    await store.rescan();
    const fresh = store.list().find((meta) => meta.id === base.meta.id)!;
    expect(await store.updateBase(base.meta.id, { config: base.config, expectedUpdated: fresh.updated }).then(() => "ok", (error: Error) => error.message)).toBe("ok");

    // The mentions "link" write rewrites a *source* page server-side (@lead): it saves from the version we hold.
    const budget = await store.create({ title: "Budget", content: "Numbers." });
    const notes = await store.create({ title: "Notes", content: "We went over the Budget today." });
    await store.linkMentions(budget.id, { source: notes.id, all: true, expectedUpdated: notes.updated });
    const held = store.get(notes.id).updated;
    expect(store.get(notes.id).content).toContain("[[Budget]]");
    await store.rescan();
    expect(await store.update(notes.id, { content: "We went over the [[Budget]] today. Agreed.", expectedUpdated: held }).then(() => "ok", (error: Error) => error.message)).toBe("ok");
    expect(await externals(dir, notes.id)).toBe(0);
    expect(await externals(dir, board.meta.id)).toBe(0);
    expect(await externals(dir, base.meta.id)).toBe(0);
  });

  it("the outside text is kept in History as an outside version", async () => {
    const { store, dir, id, file, bytes, mtime } = await saved();
    await writeFile(file, bytes.replace("Saved.", "Other."));
    await utimes(file, mtime, mtime);
    await store.rescan();
    const { entries } = await readHistory(historyDir(dir, id));
    expect(entries.some((entry) => entry.source === "external")).toBe(true);
  });
});

/** Main: a rename's link rewrite of other pages runs in batches (N9); wait for them. */
const settled = (store: { settleRenames?: (ms: number) => Promise<boolean> }) => store.settleRenames?.(10_000);

describe("the other writers check the bytes too (#y5k39njn, @graph-dev's grep)", () => {
  /** An outside edit of `name`'s file that keeps its file time; no refresh has read it yet. */
  async function sameTimeEdit(dir: string, name: string, edit: (text: string) => string): Promise<string> {
    const file = join(dir, `${name}.md`);
    const { mtime } = await stat(file);
    const next = edit(await readFile(file, "utf8"));
    await writeFile(file, next);
    await utimes(file, mtime, mtime);
    return next;
  }

  it("Link (mentions): an outside edit of the source at the same file time is a conflict, and the outside text stays", async () => {
    const { store, dir } = await createTestServer();
    const budget = await store.create({ title: "Budget", content: "Numbers." });
    const notes = await store.create({ title: "Notes", content: "We went over the Budget today." });
    const outside = await sameTimeEdit(dir, notes.id, (text) => text.replace("today.", "today. Outside line."));
    const result = await store.linkMentions(budget.id, { source: notes.id, all: true, expectedUpdated: notes.updated }).then(() => "accepted", (error: Error) => error.message);
    expect(result).toMatch(/changed on disk/);
    expect(await readFile(join(dir, `${notes.id}.md`), "utf8")).toBe(outside);
  });

  it("a rename's link rewrite of another page (0.9.x: rewriteEach) re-reads it when its bytes changed at the same file time: the edit stays, the link is rewritten", async () => {
    const { store, dir } = await createTestServer();
    const hub = await store.create({ title: "Hub", content: "Centre." });
    const linker = await store.create({ title: "Linker", content: "See [[Hub]]." });
    await sameTimeEdit(dir, linker.id, (text) => text.replace("See [[Hub]].", "See [[Hub]]. Outside line."));
    // 0.9.x: the rename rewrites the linking pages inside the update itself (no N9 batches to settle).
    await store.update(hub.id, { title: "Hub 2" });
    const text = await readFile(join(dir, `${linker.id}.md`), "utf8");
    expect(text).toContain("Outside line.");
    expect(text).toContain("[[Hub 2]]");
  });

  it("a rename's link rewrite of a board re-reads it when its bytes changed at the same file time: the edit stays, the link is rewritten (@graph-dev)", async () => {
    const { store, dir } = await createTestServer();
    const hub = await store.create({ title: "Hub", content: "Centre." });
    const board = await store.createBoard({ title: "Map" });
    await store.updateBoard(board.meta.id, {
      board: { nodes: [{ id: "a", type: "text", text: "See [[Hub]].", x: 0, y: 0, width: 200, height: 60 }], edges: [] },
      expectedUpdated: board.meta.updated,
    });
    const file = join(dir, board.meta.id);
    const { mtime } = await stat(file);
    await writeFile(file, (await readFile(file, "utf8")).replace("See [[Hub]].", "See [[Hub]]. Outside line."));
    await utimes(file, mtime, mtime);
    await store.update(hub.id, { title: "Hub 2" });
    await settled(store);
    const text = await readFile(file, "utf8");
    expect(text).toContain("Outside line.");
    expect(text).toContain("[[Hub 2]]");
  });

  it("a tag rename never writes over an outside edit at the same file time", async () => {
    const { store, dir } = await createTestServer();
    const page = await store.create({ title: "Wallet", content: "Spent #money today." });
    const outside = await sameTimeEdit(dir, page.id, (text) => text.replace("today.", "today. Outside line."));
    await store.renameTag("money", "cash");
    const text = await readFile(join(dir, `${page.id}.md`), "utf8");
    expect(text).toContain("Outside line.");
    // Either left as it is (skipped), or rewritten from the file as it is now: never from the stale body.
    expect(text === outside || text.includes("#cash")).toBe(true);
  });

  it("the properties index follows an outside edit at the same file time (no stale cache)", async () => {
    const { store, dir } = await createTestServer();
    const page = await store.create({ title: "Task", content: "Work." });
    await store.update(page.id, { properties: { set: { status: "open" } } });
    expect((await store.pageProperties(page.id))?.find((p) => p.key === "status")?.value).toBe("open");
    await sameTimeEdit(dir, page.id, (text) => text.replace("status: open", "status: done"));
    await store.rescan();
    expect((await store.pageProperties(page.id))?.find((p) => p.key === "status")?.value).toBe("done");
  });
});

describe("clocks and permissions that already work (#yy35bfac, kept as guards)", () => {
  it("a read-only folder: the save fails, no temp file is left, and it saves once the folder is writable", async () => {
    const { store, dir, id, version } = await saved();
    await chmod(dir, 0o555);
    let failed = false;
    try {
      await store.update(id, { content: "Balance: ten. Saved. Blocked.", expectedUpdated: version });
    } catch {
      failed = true;
    } finally {
      await chmod(dir, 0o755);
    }
    expect(failed).toBe(true);
    expect((await readdir(dir)).filter((name) => name.startsWith(".~gumply") || name.endsWith(".tmp"))).toEqual([]);
    await store.update(id, { content: "Balance: ten. Saved. Blocked. Retried.", expectedUpdated: store.get(id).updated });
    expect(await readFile(join(dir, `${id}.md`), "utf8")).toContain("Retried.");
  });

  it("a file time a day ahead: our own save works and moves the version back to now; a later outside edit still moves it", async () => {
    const { store, id, file, bytes } = await saved();
    await writeFile(file, bytes.replace("Saved.", "From a clock ahead."));
    const tomorrow = new Date(Date.now() + 24 * 3_600_000);
    await utimes(file, tomorrow, tomorrow);
    await store.rescan();
    const ahead = store.get(id).updated;
    const mine = await store.update(id, { content: "Balance: ten. From a clock ahead. Mine.", expectedUpdated: ahead });
    expect(mine.updated < ahead).toBe(true);
    await writeFile(file, (await readFile(file, "utf8")).replace("Mine.", "Theirs."));
    await store.rescan();
    expect(store.get(id).updated).not.toBe(mine.updated);
    expect(await saveFrom(store, id, mine.updated)).toMatch(/changed on disk/);
  });
});
