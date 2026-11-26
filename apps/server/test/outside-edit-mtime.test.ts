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

  it("our own saves are unaffected: save after save from the editor, with the refresh in between, never a conflict", async () => {
    const { store, id, version } = await saved("editor-1");
    let current = version;
    for (let n = 0; n < 5; n += 1) {
      await store.rescan();
      const next = await store.update(id, { content: `Balance: ten. Saved ${n}.`, expectedUpdated: current, writer: "editor-1" });
      current = next.updated;
    }
    expect(store.get(id).content).toContain("Saved 4.");
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
