import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VaultStore } from "../src/vault-store";

/**
 * #g95wkd9y: a refresh re-reads only what changed, and reindexes only the
 * pages whose own links changed when no link target moved. Work is counted
 * (file reads, edge recomputations), never timed.
 */

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gumply-refresh-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

type Internals = {
  readRecord: (absolute: string, id: string) => Promise<unknown>;
  edgesFor: (...args: unknown[]) => unknown;
  refreshFromDisk: (scope: { kind: "all" } | { kind: "paths"; paths: ReadonlySet<string> }) => Promise<boolean>;
};

/** Count `readRecord` and `edgesFor` calls on this store while `run` runs. */
async function counted(store: VaultStore, run: () => Promise<unknown>): Promise<{ reads: number; edges: number }> {
  const internals = store as unknown as Internals;
  const readRecord = internals.readRecord;
  const edgesFor = internals.edgesFor;
  const counts = { reads: 0, edges: 0 };
  internals.readRecord = function (this: unknown, ...args) {
    counts.reads += 1;
    return readRecord.apply(this, args);
  };
  internals.edgesFor = function (this: unknown, ...args) {
    counts.edges += 1;
    return edgesFor.apply(this, args);
  };
  try {
    await run();
  } finally {
    internals.readRecord = readRecord;
    internals.edgesFor = edgesFor;
  }
  return counts;
}

async function vaultOf(notes: number): Promise<VaultStore> {
  for (let i = 0; i < notes; i++) await writeFile(join(dir, `Note ${i}.md`), `Links to [[Note ${(i + 1) % notes}]].\n`);
  await writeFile(join(dir, "Hub.md"), "The hub.\n");
  const store = new VaultStore(dir);
  await store.init();
  return store;
}

describe("refresh after outside changes (#g95wkd9y)", () => {
  it("nothing changed: no file is read and no links are recomputed, at any vault size", async () => {
    for (const size of [20, 160]) {
      await rm(dir, { recursive: true, force: true });
      dir = await mkdtemp(join(tmpdir(), "gumply-refresh-"));
      const store = await vaultOf(size);
      const work = await counted(store, () => store.rescan());
      expect(work).toEqual({ reads: 0, edges: 0 });
    }
  });

  it("one note's text changed: one file read, one page's links recomputed (not the vault's)", async () => {
    const store = await vaultOf(160);
    await writeFile(join(dir, "Note 5.md"), "Now links to [[Hub]] instead.\n");
    const work = await counted(store, () => store.rescan());
    expect(work).toEqual({ reads: 1, edges: 1 });
    // And the index is right: Hub gained a backlink, Note 6 lost one.
    expect(store.backlinks("Hub").map((item) => item.page.id)).toEqual(["Note 5"]);
    expect(store.backlinks("Note 6").map((item) => item.page.id)).toEqual([]);
  });

  it("an edit the watcher names is re-read without walking the vault", async () => {
    const store = await vaultOf(160);
    const file = join(dir, "Note 7.md");
    await writeFile(file, "Now links to [[Hub]].\n");
    const internals = store as unknown as Internals & { scan: (...args: unknown[]) => Promise<string[]> };
    const scan = internals.scan;
    let walks = 0;
    internals.scan = function (this: unknown, ...args) {
      walks += 1;
      return scan.apply(this, args);
    };
    try {
      const work = await counted(store, () => internals.refreshFromDisk({ kind: "paths", paths: new Set([file]) }));
      expect(work).toEqual({ reads: 1, edges: 1 });
      expect(walks).toBe(0);
    } finally {
      internals.scan = scan;
    }
    expect(store.backlinks("Hub").map((item) => item.page.id)).toEqual(["Note 7"]);
  });

  it("a path the index doesn't know (a new file) falls back to a walk", async () => {
    const store = await vaultOf(10);
    const file = join(dir, "Brand new.md");
    await writeFile(file, "See [[Hub]].\n");
    const internals = store as unknown as Internals;
    await internals.refreshFromDisk({ kind: "paths", paths: new Set([file]) });
    expect(store.backlinks("Hub").map((item) => item.page.id)).toEqual(["Brand new"]);
  });

  it("the watcher's paths are read again even when the stat looks unchanged", async () => {
    const store = await vaultOf(20);
    const file = join(dir, "Note 3.md");
    const before = await stat(file);
    const internals = store as unknown as Internals;
    const work = await counted(store, () => internals.refreshFromDisk({ kind: "paths", paths: new Set([file]) }));
    expect(work.reads).toBe(1);
    expect(before.size).toBeGreaterThan(0);
  });

  it("a same-size rewrite with the old mtime is picked up by a full rescan and by a path refresh", async () => {
    for (const scope of ["all", "paths"] as const) {
      await rm(dir, { recursive: true, force: true });
      dir = await mkdtemp(join(tmpdir(), "gumply-refresh-"));
      const store = await vaultOf(10);
      const file = join(dir, "Note 2.md");
      // A whole-second mtime, so it can be set back exactly; the store reads it once.
      const second = 1_700_000_000;
      await utimes(file, second, second);
      await store.rescan();
      const old = await stat(file);
      // Same length, other text; then the old mtime forced back (FAT, sync mounts).
      await writeFile(file, "Links to [[Note 9]].\n".padEnd(old.size, " ").slice(0, old.size));
      await utimes(file, second, second);
      const now = await stat(file);
      expect([now.size, now.mtimeMs]).toEqual([old.size, old.mtimeMs]);
      const internals = store as unknown as Internals;
      if (scope === "all") await store.rescan();
      else await internals.refreshFromDisk({ kind: "paths", paths: new Set([file]) });
      expect(store.backlinks("Note 9").map((item) => item.page.id).sort(), scope).toEqual(["Note 2", "Note 8"]);
    }
  });

  it("a title changed outside: every page's links are re-resolved (a target moved)", async () => {
    const store = await vaultOf(10);
    await writeFile(join(dir, "Elsewhere.md"), "Points at [[New name]].\n");
    await store.rescan();
    expect(store.backlinks("Hub").map((item) => item.page.id)).toEqual([]);
    await writeFile(join(dir, "Hub.md"), "---\ntitle: New name\n---\nThe hub.\n");
    const work = await counted(store, () => store.rescan());
    expect(work.reads).toBe(1);
    expect(work.edges).toBeGreaterThan(10);
    expect(store.backlinks("Hub").map((item) => item.page.id)).toEqual(["Elsewhere"]);
  });

  it("a note added or removed outside: links to it resolve, and stop resolving", async () => {
    const store = await vaultOf(10);
    await writeFile(join(dir, "Linker.md"), "See [[Fresh]].\n");
    await store.rescan();
    await writeFile(join(dir, "Fresh.md"), "New.\n");
    await store.rescan();
    expect(store.backlinks("Fresh").map((item) => item.page.id)).toEqual(["Linker"]);
    await rm(join(dir, "Fresh.md"));
    await store.rescan();
    expect(store.graph().unresolved).toContainEqual({ source: "Linker", targetTitle: "Fresh" });
  });
});
