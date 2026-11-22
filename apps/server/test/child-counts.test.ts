import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VaultStore } from "../src/vault-store";

/**
 * #g95wkd9y: backlinks, mentions, search and the base index build one meta
 * per item, and each meta has a child count. Counting children per item
 * walked the whole vault per item (vault × results); they now count once per
 * call. Counted: every page and folder record a call walks. Never timed.
 */

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gumply-counts-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** `notes` notes that each link to Hub and mention it, in a folder page with children. */
async function vaultOf(notes: number): Promise<VaultStore> {
  await writeFile(join(dir, "Hub.md"), "The hub.\n");
  await writeFile(join(dir, "Area.md"), "A folder page.\n");
  await mkdir(join(dir, "Area"));
  for (let i = 0; i < notes; i++) {
    await writeFile(join(dir, "Area", `Note ${i}.md`), `Links to [[Hub]]. Also says Hub in passing.\n`);
  }
  const store = new VaultStore(dir);
  await store.init();
  return store;
}

/** Page and folder records walked (any iteration of the two maps) while `run` runs. */
async function walked(store: VaultStore, run: () => unknown): Promise<number> {
  const maps = store as unknown as { pages: Map<unknown, unknown>; folders: Map<unknown, unknown> };
  let count = 0;
  const counting = <T>(iterator: IterableIterator<T>): IterableIterator<T> => ({
    next() {
      const step = iterator.next();
      if (!step.done) count += 1;
      return step;
    },
    [Symbol.iterator]() {
      return this;
    },
  });
  const patched: Array<[Map<unknown, unknown>, string]> = [];
  for (const map of [maps.pages, maps.folders]) {
    for (const name of ["values", "keys", "entries", Symbol.iterator] as const) {
      const original = Map.prototype[name as "values"];
      Object.defineProperty(map, name, {
        configurable: true,
        writable: true,
        value(this: Map<unknown, unknown>) {
          return counting(original.call(this));
        },
      });
      patched.push([map, name as string]);
    }
  }
  try {
    await run();
  } finally {
    for (const map of [maps.pages, maps.folders]) {
      for (const name of ["values", "keys", "entries", Symbol.iterator]) delete (map as unknown as Record<PropertyKey, unknown>)[name];
    }
  }
  return count;
}

describe("child counts once per call (#g95wkd9y)", () => {
  const calls: Array<[string, (store: VaultStore) => unknown]> = [
    ["backlinks", (store) => store.backlinks("Hub")],
    ["mentions", (store) => store.mentions("Hub")],
    ["search", (store) => store.search("hub")],
    ["base index", (store) => store.baseIndex()],
  ];
  for (const [name, call] of calls) {
    it(`${name}: walks the vault a few times, not once per result`, async () => {
      for (const notes of [100, 800]) {
        await rm(dir, { recursive: true, force: true });
        dir = await mkdtemp(join(tmpdir(), "gumply-counts-"));
        const store = await vaultOf(notes);
        await call(store); // Warm caches (mention index, search text), then count.
        const records = notes + 2;
        const work = await walked(store, () => call(store));
        // Before: about records × results (800 notes: ~640,000). Now a few passes.
        expect(work, `${name} at ${notes}`).toBeLessThanOrEqual(4 * records);
      }
    });
  }

  it("the counts are still right: a folder page's children, a note's none", async () => {
    const store = await vaultOf(5);
    await writeFile(join(dir, "Linker.md"), "See [[Area]].\n");
    await store.rescan();
    expect(store.backlinks("Area").map((item) => [item.page.id, item.page.childCount])).toEqual([["Linker", 0]]);
    await writeFile(join(dir, "Hub.md"), "The hub. See [[Area]].\n");
    await store.rescan();
    expect(store.backlinks("Area").map((item) => [item.page.id, item.page.childCount])).toEqual([
      ["Hub", 0],
      ["Linker", 0],
    ]);
    const area = store.baseIndex().find((entry) => entry.meta.id === "Area");
    expect(area?.meta.childCount).toBe(5);
    expect(store.search("folder page")[0]?.page).toMatchObject({ id: "Area", childCount: 5 });
    expect(store.list().find((meta) => meta.id === "Area")?.childCount).toBe(5);
  });
});
