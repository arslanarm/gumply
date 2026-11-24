import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RENAME_JOURNAL } from "../src/rename-journal";
import { VaultStore } from "../src/vault-store";

/**
 * D47 (#xhdjpaev): a rename survives a crash. The link rewrite runs in batches
 * after the file moved (#xgnvipyd); a journal entry in .gumply/rename-pending.json
 * lets the next start finish it. A "crash" here is the rename stopping after its
 * first batch (an error thrown from the batch hook): the files and the journal
 * are left exactly as a killed process leaves them, and a new store on the same
 * folder starts as the app would.
 */
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const LINKERS = 450; // three batches (200 pages per batch)
const ME = "install-a";

async function vault() {
  const dir = await mkdtemp(join(tmpdir(), "gumply-rename-journal-"));
  dirs.push(dir);
  await writeFile(join(dir, "Hub.md"), "The hub.\n");
  await writeFile(join(dir, "Other.md"), "Other page, see [[Hub]].\n");
  await mkdir(join(dir, "L"));
  for (let i = 0; i < LINKERS; i++) await writeFile(join(dir, "L", `Linker ${i}.md`), `See [[Hub]] (${i}) and [[Other]].\n`);
  return dir;
}

async function open(dir: string, instanceId = ME) {
  const store = new VaultStore(dir, { instanceId });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  await store.init();
  await store.renamesResumed;
  return store;
}

/** A rename that "crashes" after `batches` batches: its files and journal stay as they are. */
async function crashedRename(dir: string, from: string, to: string, batches = 1) {
  const store = await open(dir);
  let run = 0;
  store.afterRenameBatch = async () => {
    run += 1;
    if (run >= batches) throw new Error("crash (test)");
  };
  await expect(store.update(from, { title: to })).rejects.toThrow("crash (test)");
  store.stopWatching?.();
}

/** Every Markdown file's bytes, by path (history and .gumply aside). */
async function markdown(dir: string) {
  const out: Record<string, string> = {};
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".md")) out[relative(dir, path)] = await readFile(path, "utf8");
    }
  };
  await walk(dir);
  return out;
}

/** The same vault with the rename done normally. */
async function completed(to = "Hub 2") {
  const dir = await vault();
  const store = await open(dir);
  await store.update("Hub", { title: to });
  return markdown(dir);
}

const journal = (dir: string) => readFile(join(dir, RENAME_JOURNAL), "utf8").then((text) => JSON.parse(text) as { version: number; renames: Array<Record<string, string>> });
const journalGone = (dir: string) => readFile(join(dir, RENAME_JOURNAL), "utf8").then(() => false, () => true);

describe("a rename survives a crash (D47, #xhdjpaev)", { timeout: 60_000 }, () => {
  it("crashed after its first batch: the journal names it, and the next start finishes it, byte for byte", async () => {
    const dir = await vault();
    await crashedRename(dir, "Hub", "Hub 2");
    const left = await journal(dir);
    expect(left.renames).toHaveLength(1);
    expect(left.renames[0]).toMatchObject({ oldId: "Hub", newId: "Hub 2", oldTitle: "Hub", newTitle: "Hub 2", instance: ME });
    const before = Object.values(await markdown(dir)).filter((text) => text.includes("[[Hub]]")).length;
    expect(before).toBeGreaterThan(100); // the crash left work to do

    const store = await open(dir);
    expect(await markdown(dir)).toEqual(await completed());
    expect(store.backlinks("Hub 2")).toHaveLength(LINKERS + 1);
    expect(await journalGone(dir)).toBe(true);
  });

  it("a crash while resuming: resumed again, the same bytes", async () => {
    const dir = await vault();
    await crashedRename(dir, "Hub", "Hub 2");
    // The first resume crashes too, after its first batch.
    const first = new VaultStore(dir, { instanceId: ME });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    first.afterRenameBatch = async () => {
      throw new Error("crash again (test)");
    };
    await first.init();
    await first.renamesResumed;
    expect((await journal(dir)).renames).toHaveLength(1);
    await open(dir);
    expect(await markdown(dir)).toEqual(await completed());
    expect(await journalGone(dir)).toBe(true);
  });

  it("a crash before the move (the page still at its old id): dropped, nothing rewritten", async () => {
    const dir = await vault();
    const files = await markdown(dir);
    await mkdir(join(dir, ".gumply"), { recursive: true });
    await writeFile(join(dir, RENAME_JOURNAL), JSON.stringify({ version: 1, renames: [{ oldId: "Hub", newId: "Hub 2", oldTitle: "Hub", newTitle: "Hub 2", instance: ME, startedAt: new Date().toISOString() }] }));
    await open(dir);
    expect(await markdown(dir)).toEqual(files);
    expect(await journalGone(dir)).toBe(true);
  });

  it("another page took the old name while the app was down: no rewrite, dropped", async () => {
    const dir = await vault();
    await crashedRename(dir, "Hub", "Hub 2");
    await writeFile(join(dir, "Hub.md"), "A new page called Hub.\n");
    const files = await markdown(dir);
    await open(dir);
    expect(await markdown(dir)).toEqual(files);
    expect(await journalGone(dir)).toBe(true);
  });

  it("two pending renames: both finished", async () => {
    const dir = await vault();
    // Both running at once in one app, which then crashes (a new start would finish the first one first).
    const crashing = await open(dir);
    crashing.afterRenameBatch = async () => {
      throw new Error("crash (test)");
    };
    const results = await Promise.allSettled([crashing.update("Hub", { title: "Hub 2" }), crashing.update("Other", { title: "Other 2" })]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect((await journal(dir)).renames.map((entry) => entry.newId).sort()).toEqual(["Hub 2", "Other 2"]);
    const store = await open(dir);
    const files = await markdown(dir);
    expect(Object.values(files).some((text) => text.includes("[[Hub]]") || text.includes("[[Other]]"))).toBe(false);
    expect(store.backlinks("Other 2")).toHaveLength(LINKERS);
    expect(await journalGone(dir)).toBe(true);
  });

  it("a journal this version can't read is left untouched, and nothing is rewritten", async () => {
    const dir = await vault();
    await crashedRename(dir, "Hub", "Hub 2");
    const future = `${JSON.stringify({ version: 2, renames: [{ oldId: "Hub", newId: "Hub 2", somethingNew: true }] })}\n`;
    await writeFile(join(dir, RENAME_JOURNAL), future);
    const files = await markdown(dir);
    await open(dir);
    expect(await markdown(dir)).toEqual(files);
    expect(await readFile(join(dir, RENAME_JOURNAL), "utf8")).toBe(future);
  });

  it("another installation's rename: left for it while recent, finished by anyone after 7 days", async () => {
    const dir = await vault();
    await crashedRename(dir, "Hub", "Hub 2");
    const files = await markdown(dir);
    // Another device (same synced vault) starts: a recent foreign entry is not its to finish, and it says so.
    await open(dir, "install-b");
    const warned = vi.mocked(console.warn).mock.calls.map((call) => String(call[0]));
    expect(warned.some((line) => line.includes("another installation started") && line.includes("“Hub” → “Hub 2”"))).toBe(true);
    expect(await markdown(dir)).toEqual(files);
    expect((await journal(dir)).renames).toHaveLength(1);
    // Eight days later the origin never came back: any installation finishes it.
    const stale = await journal(dir);
    stale.renames[0]!.startedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await writeFile(join(dir, RENAME_JOURNAL), JSON.stringify(stale));
    await open(dir, "install-b");
    expect(await markdown(dir)).toEqual(await completed());
    expect(await journalGone(dir)).toBe(true);
  });

  it("a rename that finishes normally leaves no journal", async () => {
    const dir = await vault();
    const store = await open(dir);
    await store.update("Hub", { title: "Hub 2" });
    expect(await journalGone(dir)).toBe(true);
  });

  it("a title-only rename (the file keeps its id): resumed, and every [[Old title]] rewritten", async () => {
    // As @opus-hunter's n9-3c: Hub.md is titled "Central" and linked as [[Central]]; renamed to "Hub", its file stays.
    const make = async () => {
      const dir = await mkdtemp(join(tmpdir(), "gumply-rename-journal-"));
      dirs.push(dir);
      await writeFile(join(dir, "Hub.md"), "---\ntitle: Central\n---\nThe hub.\n");
      await mkdir(join(dir, "L"));
      for (let i = 0; i < LINKERS; i++) await writeFile(join(dir, "L", `Linker ${i}.md`), `See [[Central]] (${i}).\n`);
      return dir;
    };
    const control = await make();
    await (await open(control)).update("Hub", { title: "Hub" });
    const expected = await markdown(control);
    expect(Object.values(expected).some((text) => text.includes("[[Central]]"))).toBe(false);

    const dir = await make();
    await crashedRename(dir, "Hub", "Hub");
    const left = await journal(dir);
    expect(left.renames[0]).toMatchObject({ oldId: "Hub", newId: "Hub", oldTitle: "Central", newTitle: "Hub" });
    expect(Object.values(await markdown(dir)).filter((text) => text.includes("[[Central]]")).length).toBeGreaterThan(100);
    await open(dir);
    expect(await markdown(dir)).toEqual(expected);
    expect(await journalGone(dir)).toBe(true);
  });
});
