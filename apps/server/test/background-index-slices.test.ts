import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VaultStore } from "../src/vault-store";

/**
 * #rz3iukrp: the background link index after a cold open runs in short
 * slices and yields between them, so a request after a start isn't held
 * behind the whole index. The finished index must be exactly the one the
 * synchronous `reindexAll()` builds, whatever happens while it runs.
 */
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

type Internals = { edgesBySource: Map<string, unknown[]>; indexSliceMs: number; beforeIndex: () => Promise<void> };

async function vault(pages = 120) {
  const dir = await mkdtemp(join(tmpdir(), "gumply-index-slices-"));
  dirs.push(dir);
  for (let i = 0; i < pages; i++) {
    await writeFile(join(dir, `Note ${i}.md`), `See [[Note ${(i + 1) % pages}]], [[Note ${(i * 7) % pages}]] and [[Zeta]].\n`);
  }
  return dir;
}

/** A store started as the app starts it; `slice` 0 = one page per slice (the most interleaving). */
async function started(dir: string, slice = 0, hook?: () => void) {
  const store = new VaultStore(dir);
  const internals = store as unknown as Internals;
  internals.indexSliceMs = slice;
  if (hook) internals.beforeIndex = async () => hook();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  await store.init({ background: true });
  return store;
}

/** The whole link index, comparable: every source's edges, sorted. */
function indexOf(store: VaultStore) {
  const edges = (store as unknown as Internals).edgesBySource;
  return [...edges.entries()]
    .filter(([, list]) => list.length > 0)
    .map(([id, list]) => [id, [...list].map((edge) => JSON.stringify(edge)).sort()] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** What the synchronous index gives for the files as they are now. */
async function synchronousIndex(dir: string) {
  const store = new VaultStore(dir);
  await store.init();
  return { index: indexOf(store), store };
}

async function expectSameAsSynchronous(store: VaultStore, dir: string) {
  await store.whenIndexed();
  const fresh = await synchronousIndex(dir);
  expect(indexOf(store)).toEqual(fresh.index);
  const ids = store.list().filter((meta) => meta.kind === "page").map((meta) => meta.id);
  // Backlinks and the graph by what links where (a page's version time after a write isn't the index's business).
  const linksTo = (from: VaultStore, id: string) => from.backlinks(id).map((link) => `${link.page.id}|${link.snippet}`).sort();
  for (const id of ids) expect(linksTo(store, id), id).toEqual(linksTo(fresh.store, id));
  const shape = (from: VaultStore) => {
    const graph = from.graph();
    return {
      nodes: graph.nodes.map((node) => node.id).sort(),
      links: graph.links.map((link) => `${link.source}>${link.target}`).sort(),
      unresolved: graph.unresolved.map((link) => `${link.source}>${link.targetTitle}`).sort(),
    };
  };
  expect(shape(store)).toEqual(shape(fresh.store));
}

describe("the background link index runs in slices (#rz3iukrp)", () => {
  it("gives exactly the synchronous index: edges, backlinks, the graph", async () => {
    const dir = await vault();
    const store = await started(dir);
    await expectSameAsSynchronous(store, dir);
  });

  it("yields: work scheduled right after the index starts runs while it is still indexing", async () => {
    const dir = await vault(300);
    let sawIndexing: boolean | null = null;
    let indexedPages = -1;
    // Scheduled from inside the index's start: a synchronous index would finish before it runs.
    const store = await started(dir, 0, () =>
      setImmediate(() => {
        sawIndexing = store.indexing;
        indexedPages = (store as unknown as Internals).edgesBySource.size;
      }),
    );
    await store.whenIndexed();
    expect(sawIndexing).toBe(true);
    expect(indexedPages).toBeGreaterThan(0);
    expect(indexedPages).toBeLessThan(300);
    expect(store.indexing).toBe(false);
  });

  it("a save while it indexes: the final index has the saved links", async () => {
    const dir = await vault();
    let saving: Promise<unknown> = Promise.resolve();
    const store = await started(dir, 0, () =>
      setImmediate(() => {
        const page = store.get("Note 3");
        saving = store.update("Note 3", { content: "Now only [[Note 50]] and [[Nowhere]].", expectedUpdated: page.updated });
      }),
    );
    await store.whenIndexed();
    await saving;
    const targets = store.backlinks("Note 50").map((link) => link.page.id);
    expect(targets).toContain("Note 3");
    await expectSameAsSynchronous(store, dir);
  });

  it("a create while it indexes (a dangling link now resolves): stops for the full reindex, and the result is exact", async () => {
    const dir = await vault();
    let creating: Promise<unknown> = Promise.resolve();
    const store = await started(dir, 0, () =>
      setImmediate(() => {
        creating = store.create({ title: "Zeta", content: "The last letter." });
      }),
    );
    await store.whenIndexed();
    await creating;
    expect(store.backlinks("Zeta").length).toBe(120);
    await expectSameAsSynchronous(store, dir);
  });

  it("started while a rename's batches run: [[Old]] resolves to the renamed page, exactly as reindexAll() resolves it (N9's linkMetas)", async () => {
    // A rename of Old to New is mid-batches: New exists, its old title is an alias, and pages
    // not yet rewritten still say [[Old]]. The slices must resolve against linkMetas(), as
    // N9's reindexAll() does; resolving against pageMetas() alone left [[Old]] dangling.
    const dir = await mkdtemp(join(tmpdir(), "gumply-index-slices-alias-"));
    dirs.push(dir);
    await writeFile(join(dir, "New.md"), "The renamed page.\n");
    for (let i = 0; i < 30; i++) await writeFile(join(dir, `Linker ${i}.md`), `See [[Old]] and [[Linker ${(i + 1) % 30}]].\n`);
    type WithAliases = Internals & { renameAliases: Map<string, { fromId: string; fromTitle: string }>; reindexAll: () => void };
    let internals: WithAliases | null = null;
    const store = await started(dir, 0, () => {
      internals!.renameAliases.set("New", { fromId: "Old", fromTitle: "Old" });
    });
    internals = store as unknown as WithAliases;
    await store.whenIndexed();
    const sliced = indexOf(store);
    expect(store.backlinks("New").map((link) => link.page.id).sort()).toEqual(Array.from({ length: 30 }, (_, i) => `Linker ${i}`).sort());
    // Exactly what the synchronous full reindex gives with the same alias in place.
    internals.reindexAll();
    expect(sliced).toEqual(indexOf(store));
  });

  it("a rename while it indexes: the result is exact", async () => {
    const dir = await vault();
    let renaming: Promise<unknown> = Promise.resolve();
    const store = await started(dir, 0, () =>
      setImmediate(() => {
        const page = store.get("Note 10");
        renaming = store.update("Note 10", { title: "Note ten", expectedUpdated: page.updated });
      }),
    );
    await store.whenIndexed();
    await renaming;
    await expectSameAsSynchronous(store, dir);
  });
});

/** The perf vault (scripts/perf/make-vault.mjs): 2,000 notes always; 10k with GUMPLY_RZ3_10K=1. */
describe("equivalence on the perf vault (#rz3iukrp)", () => {
  const notes = process.env.GUMPLY_RZ3_10K === "1" ? 10_000 : 2_000;
  it(`${notes} notes, the default slice: exactly the synchronous index`, async () => {
    const parent = await mkdtemp(join(tmpdir(), "gumply-index-slices-perf-"));
    dirs.push(parent);
    const dir = join(parent, "vault");
    const script = fileURLToPath(new URL("../../../scripts/perf/make-vault.mjs", import.meta.url));
    execFileSync(process.execPath, [script, dir, "--notes", String(notes)], { stdio: "ignore" });
    const store = new VaultStore(dir);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await store.init({ background: true });
    await expectSameAsSynchronous(store, dir);
  }, 600_000);
});
