import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RENAME_JOURNAL } from "../src/rename-journal";
import { VaultStore } from "../src/vault-store";

/**
 * #ber4hvce: renaming a page that has sub-pages moves its folder too (`Hub/` → `Hub 2/`), and other
 * pages' links into it follow (#ekp8ns58): `[[Hub/Sub]]`, `![[Hub/a.png]]`, `![](Hub/a.png)`. That pass
 * runs in the rename's own batches (N9), so saves get through between them, and the rename journal
 * (D47) finishes it after a crash. A "crash" is the rename stopping in its batch hook, as in
 * rename-journal.test.ts.
 */
const dirs: string[] = [];
const stores: VaultStore[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.stopWatching?.();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
});

const LINKERS = 450; // three batches (200 pages per batch)
const ME = "install-a";
const linker = (i: number) => `See [[Hub]] (${i}), its [[Hub/Sub]], ![[Hub/a.png]] and ![pic](Hub/a.png).\n`;

async function vault() {
  const dir = await mkdtemp(join(tmpdir(), "gumply-rename-folder-"));
  dirs.push(dir);
  await writeFile(join(dir, "Hub.md"), "The hub. Its own sub-page: [[Hub/Sub]].\n");
  await mkdir(join(dir, "Hub"));
  await writeFile(join(dir, "Hub", "Sub.md"), "A sub-page.\n");
  await writeFile(join(dir, "Hub", "a.png"), "png");
  await mkdir(join(dir, "L"));
  for (let i = 0; i < LINKERS; i++) await writeFile(join(dir, "L", `Linker ${i}.md`), linker(i));
  return dir;
}

async function open(dir: string) {
  const store = new VaultStore(dir, { instanceId: ME });
  stores.push(store);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  await store.init();
  await store.renamesResumed;
  return store;
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

const stillOld = (files: Record<string, string>) => Object.values(files).filter((text) => text.includes("Hub/")).length;
const expected = (i: number) => `See [[Hub 2]] (${i}), its [[Hub 2/Sub]], ![[Hub 2/a.png]] and ![pic](Hub%202/a.png).\n`;

describe("a renamed parent's folder links follow in the rename's batches (#ber4hvce)", { timeout: 60_000 }, () => {
  it("runs in the batches, not all at once before them; every link and the page's own follow, other bytes kept", async () => {
    const dir = await vault();
    const store = await open(dir);
    const leftAtFirstBatch: number[] = [];
    store.afterRenameBatch = async () => {
      leftAtFirstBatch.push(stillOld(await markdown(dir)));
    };
    await store.update("Hub", { title: "Hub 2" });

    // After the first batch, links into the old folder were still waiting for their batches.
    expect(leftAtFirstBatch.length).toBeGreaterThan(1);
    expect(leftAtFirstBatch[0]).toBeGreaterThan(100);

    const files = await markdown(dir);
    expect(stillOld(files)).toBe(0);
    expect(files["Hub 2.md"]).toBe("The hub. Its own sub-page: [[Hub 2/Sub]].\n");
    expect(files[join("Hub 2", "Sub.md")]).toBe("A sub-page.\n");
    for (const i of [0, 199, 200, 449]) expect(files[join("L", `Linker ${i}.md`)]).toBe(expected(i));
  });

  it("a crash after the first batch: the next start finishes the folder links too, byte for byte", async () => {
    const dir = await vault();
    const crashing = await open(dir);
    let run = 0;
    crashing.afterRenameBatch = async () => {
      run += 1;
      if (run >= 1) throw new Error("crash (test)");
    };
    await expect(crashing.update("Hub", { title: "Hub 2" })).rejects.toThrow("crash (test)");
    crashing.stopWatching?.();
    expect(stillOld(await markdown(dir))).toBeGreaterThan(100); // the crash left work to do
    const journal = JSON.parse(await readFile(join(dir, RENAME_JOURNAL), "utf8")) as { renames: unknown[] };
    expect(journal.renames).toHaveLength(1);

    await open(dir); // the next start resumes it
    const files = await markdown(dir);
    expect(stillOld(files)).toBe(0);
    expect(files["Hub 2.md"]).toBe("The hub. Its own sub-page: [[Hub 2/Sub]].\n");
    for (const i of [0, 199, 200, 449]) expect(files[join("L", `Linker ${i}.md`)]).toBe(expected(i));
  });
});
