import { chmod, mkdir, mkdtemp, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  refreshFromDisk: (scope: Scope) => Promise<boolean>;
  onWatchEvent: (dir: string, filename: string) => void;
  takePendingScope: () => Scope;
  scheduleRescan: () => void;
};
type Scope = { kind: "all" } | { kind: "paths"; paths: ReadonlySet<string> };

/** The store's watcher hooks, with the debounce timer switched off so a test drives each refresh. */
function watcherOf(store: VaultStore) {
  const internals = store as unknown as Internals;
  // These tests report watcher events by hand. init() doesn't start a watcher
  // here; stopping it anyway makes sure no real watcher (and so no sync-burst
  // check with its full refresh) can run in the middle of a test (#9a393rp5).
  // onWatchEvent still works with it stopped.
  store.stopWatching();
  internals.scheduleRescan = () => {};
  return {
    internals,
    /** Report watcher events, then refresh with what they add up to; returns the scope used. */
    async settle(events: Array<[dir: string, name: string]>): Promise<Scope> {
      for (const [eventDir, name] of events) internals.onWatchEvent(eventDir, name);
      const scope = internals.takePendingScope();
      await internals.refreshFromDisk(scope);
      return scope;
    },
  };
}

const backlinkIds = (store: VaultStore, id: string) => store.backlinks(id).map((item) => item.page.id).sort();

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

  describe("watcher-driven edge cases (@lead's list)", () => {
    for (const order of ["delete first", "create first"] as const) {
      it(`an outside rename (${order}) moves the page and keeps links working`, async () => {
        const store = await vaultOf(10);
        await writeFile(join(dir, "Keep.md"), "---\ntitle: Keeper\n---\nPoints at [[Hub]].\n");
        await writeFile(join(dir, "Fan.md"), "See [[Keeper]].\n");
        await store.rescan();
        await rename(join(dir, "Keep.md"), join(dir, "Renamed.md"));
        const events: Array<[string, string]> = [[dir, "Keep.md"], [dir, "Renamed.md"]];
        const { settle } = watcherOf(store);
        await settle(order === "delete first" ? events : events.reverse());
        expect(store.get("Keep").id).toBe("Renamed"); // The old URL follows.
        expect(backlinkIds(store, "Hub")).toEqual(["Renamed"]);
        expect(backlinkIds(store, "Renamed")).toEqual(["Fan"]);
      });
    }

    it("an outside rename split over two refreshes ends in the same index", async () => {
      const store = await vaultOf(10);
      await writeFile(join(dir, "Keep.md"), "Points at [[Hub]].\n");
      await store.rescan();
      await rename(join(dir, "Keep.md"), join(dir, "Renamed.md"));
      const { settle } = watcherOf(store);
      await settle([[dir, "Keep.md"]]);
      await settle([[dir, "Renamed.md"]]);
      expect(store.list().some((page) => page.id === "Keep")).toBe(false);
      expect(backlinkIds(store, "Hub")).toEqual(["Renamed"]);
    });

    for (const [from, to] of [["Area", "Zone"], ["v1.2", "v1.3"]] as const) {
      it(`a folder renamed outside (${from} → ${to}) is a full refresh, and its pages move`, async () => {
        const store = await vaultOf(10);
        await mkdir(join(dir, from));
        await writeFile(join(dir, from, "Inner.md"), "Points at [[Hub]].\n");
        await writeFile(join(dir, "Fan.md"), "See [[Inner]].\n");
        await store.rescan();
        await rename(join(dir, from), join(dir, to));
        const { settle } = watcherOf(store);
        // The parent reports the new name (the old one too, when it was watched),
        // and the moved folder's own watcher may still report under its old path.
        const scope = await settle([[dir, to], [join(dir, from), "Inner.md"]]);
        expect(scope.kind).toBe("all");
        expect(store.get(`${from}/Inner`).id).toBe(`${to}/Inner`);
        expect(backlinkIds(store, "Hub")).toEqual([`${to}/Inner`]);
        expect(backlinkIds(store, `${to}/Inner`)).toEqual(["Fan"]);
      });
    }

    for (const mid of [120, 250]) {
      it(`events arriving mid-refresh are kept (${mid} more, ${mid > 200 ? "over" : "under"} the 200-path line)`, async () => {
        const store = await vaultOf(300);
        const file = (i: number) => join(dir, `Note ${i}.md`);
        const { internals, settle } = watcherOf(store);
        const edit = async (i: number, mark: string) => {
          await writeFile(file(i), `Edit ${mark} of note ${i}, links to [[Hub]].\n`);
          internals.onWatchEvent(dir, `Note ${i}.md`);
        };
        for (let i = 0; i < 150; i++) await edit(i, "one");
        const first = internals.takePendingScope();
        expect(first.kind).toBe("paths");
        // Halfway through the first refresh's reads, more edits land, half of
        // them on notes this refresh has already read.
        const readRecord = internals.readRecord;
        let reads = 0;
        internals.readRecord = async function (this: unknown, ...args) {
          reads += 1;
          if (reads === 75) for (let i = 0; i < mid; i++) await edit(i, "two");
          return readRecord.apply(this, args as [string, string]);
        };
        try {
          await internals.refreshFromDisk(first);
        } finally {
          internals.readRecord = readRecord;
        }
        const second = await settle([]);
        expect(second.kind).toBe(mid > 200 ? "all" : "paths");
        for (let i = 0; i < 300; i++) {
          const want = i < mid ? "two" : i < 150 ? "one" : null;
          const content = store.get(`Note ${i}`).content;
          if (want) expect(content, `Note ${i}`).toContain(`Edit ${want} of note ${i}`);
          else expect(content, `Note ${i}`).not.toContain("Edit");
        }
        expect(backlinkIds(store, "Hub")).toHaveLength(Math.max(mid, 150));
        // 300 notes and up to 400 real writes: past vitest's 5 s default under
        // parallel load (#9a393rp5). A ceiling, not a wait: it ends when done.
      }, 30_000);
    }

    for (const when of ["before its stat", "between its stat and its read"] as const) {
      for (const kind of ["paths", "all"] as const) {
        it(`a file deleted after the scope was taken (${when}, ${kind}) drops out without failing the refresh`, async () => {
          const store = await vaultOf(10);
          await writeFile(join(dir, "Gone.md"), "Points at [[Hub]].\n");
          await store.rescan();
          const file = join(dir, "Gone.md");
          await writeFile(file, "Edited: points at [[Hub]] twice: [[Hub]].\n");
          const { internals } = watcherOf(store);
          internals.onWatchEvent(dir, "Gone.md");
          const scope: Scope = kind === "all" ? { kind: "all" } : internals.takePendingScope();
          if (when === "before its stat") await rm(file);
          const readRecord = internals.readRecord;
          internals.readRecord = async function (this: unknown, ...args) {
            if (args[0] === file) await rm(file, { force: true });
            return readRecord.apply(this, args as [string, string]);
          };
          try {
            await internals.refreshFromDisk(scope);
          } finally {
            internals.readRecord = readRecord;
          }
          expect(store.list().some((page) => page.id === "Gone")).toBe(false);
          expect(backlinkIds(store, "Hub")).toEqual([]);
        });
      }
    }
  });

  it("a conflict copy edited outside gets no links, and its original still does (D43)", async () => {
    const store = await vaultOf(10);
    const copy = "Note 3.sync-conflict-20261122-143005-ABCDEFG";
    await writeFile(join(dir, `${copy}.md`), "Theirs.\n");
    await store.rescan();
    await writeFile(join(dir, `${copy}.md`), "Theirs, now pointing at [[Hub]].\n");
    await writeFile(join(dir, "Note 3.md"), "Mine, pointing at [[Hub]] too.\n");
    const work = await counted(store, () => store.rescan());
    // Both files re-read; only the original's links recomputed (the copy is skipped).
    expect(work).toEqual({ reads: 2, edges: 1 });
    const edges = (store as unknown as { edgesBySource: Map<string, unknown> }).edgesBySource;
    expect(edges.has(copy)).toBe(false);
    expect(backlinkIds(store, "Hub")).toEqual(["Note 3"]);
  });

  describe("files and folders vanishing mid-rescan (a git checkout, @opus-hunter's P1)", () => {
    it("a folder removed between its parent's listing and its own drops out; the rescan completes", async () => {
      await mkdir(join(dir, "Sub"));
      await writeFile(join(dir, "Sub", "Inner.md"), "Points at [[Hub]].\n");
      const store = await vaultOf(5);
      const internals = store as unknown as { scan: (dir: string, ...rest: unknown[]) => Promise<string[]> };
      const scan = internals.scan;
      internals.scan = async function (this: unknown, folder: string, ...rest: unknown[]) {
        if (folder === join(dir, "Sub")) await rm(folder, { recursive: true, force: true });
        return scan.call(this, folder, ...rest);
      };
      try {
        await expect(store.rescan()).resolves.toBe(true);
      } finally {
        internals.scan = scan;
      }
      expect(store.list().some((page) => page.id === "Sub/Inner")).toBe(false);
      expect(backlinkIds(store, "Hub")).toEqual([]);
    });

    it("a file whose folder became a file mid-read (ENOTDIR) drops out; the rescan completes", async () => {
      await mkdir(join(dir, "Sub"));
      const file = join(dir, "Sub", "Inner.md");
      await writeFile(file, "Points at [[Hub]].\n");
      const store = await vaultOf(5);
      await writeFile(file, "Edited: points at [[Hub]] twice. [[Hub]]\n");
      const internals = store as unknown as Internals;
      const readRecord = internals.readRecord;
      internals.readRecord = async function (this: unknown, ...args) {
        if (args[0] === file) {
          await rm(join(dir, "Sub"), { recursive: true, force: true });
          await writeFile(join(dir, "Sub"), "now a file\n");
        }
        return readRecord.apply(this, args as [string, string]);
      };
      try {
        await expect(store.rescan()).resolves.toBe(true);
      } finally {
        internals.readRecord = readRecord;
      }
      expect(store.list().some((page) => page.id === "Sub/Inner")).toBe(false);
    });

    it("a watcher rescan that fails is logged and tried again, and never rejects unhandled", async () => {
      const store = await vaultOf(5);
      const internals = store as unknown as Internals;
      const refresh = internals.refreshFromDisk;
      let calls = 0;
      internals.refreshFromDisk = async function (this: unknown, scope) {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error("ENOENT: gone mid-scan"), { code: "EIO" });
        return refresh.call(this, scope);
      };
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await writeFile(join(dir, "Late.md"), "Points at [[Hub]].\n");
        internals.onWatchEvent(dir, "Late.md");
        // Vitest fails the run on an unhandled rejection; the retry settles the index.
        await expect.poll(() => backlinkIds(store, "Hub"), { timeout: 5000 }).toEqual(["Late"]);
        expect(calls).toBe(2);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("rescan after outside changes failed (1)"), expect.anything());
      } finally {
        warn.mockRestore();
        internals.refreshFromDisk = refresh;
      }
    });
  });

  describe("a file that can't be read (#35q6kt6e, @opus-hunter's P2)", () => {
    for (const code of ["EACCES", "EPERM", "EBUSY", "EISDIR"]) {
      it(`${code} on one file: it keeps its record, the rest of the rescan goes on, and it's logged once`, async () => {
        const store = await vaultOf(5);
        await writeFile(join(dir, "Locked.md"), "Locked, pointing at [[Hub]].\n");
        await store.rescan();
        const locked = join(dir, "Locked.md");
        await writeFile(locked, "Locked, edited: now points at [[Note 1]].\n");
        await writeFile(join(dir, "After.md"), "New, pointing at [[Hub]].\n");
        await writeFile(join(dir, "Note 2.md"), "Edited outside, pointing at [[Hub]].\n");
        const internals = store as unknown as Internals;
        const readRecord = internals.readRecord;
        let blocked = true;
        internals.readRecord = async function (this: unknown, ...args) {
          if (blocked && args[0] === locked) throw Object.assign(new Error(`${code}: can't read`), { code });
          return readRecord.apply(this, args as [string, string]);
        };
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
          await expect(store.rescan()).resolves.toBe(true);
          // The new note is listed, the outside edit is read...
          expect(backlinkIds(store, "Hub")).toEqual(["After", "Locked", "Note 2"]);
          expect(store.get("Note 2").content).toContain("Edited outside");
          // ...and the unreadable one keeps the record it had.
          expect(store.get("Locked").content).toContain("Locked, pointing at");
          expect(warn).toHaveBeenCalledTimes(1);
          expect(String(warn.mock.calls[0]![0])).toContain(`can't read Locked.md (${code})`);
          // A second rescan tries it again but logs nothing new.
          await store.rescan();
          expect(warn).toHaveBeenCalledTimes(1);
          // Readable again: its new text comes in.
          blocked = false;
          await store.rescan();
          expect(store.get("Locked").content).toContain("now points at [[Note 1]]");
          expect(backlinkIds(store, "Hub")).toEqual(["After", "Note 2"]);
        } finally {
          warn.mockRestore();
          internals.readRecord = readRecord;
        }
      });
    }

    it("a new file that can't be read is absent until it can be, and the rest still comes in", async () => {
      const store = await vaultOf(3);
      const locked = join(dir, "Fresh lock.md");
      await writeFile(locked, "Points at [[Hub]].\n");
      await writeFile(join(dir, "Also new.md"), "Points at [[Hub]].\n");
      const internals = store as unknown as Internals;
      const readRecord = internals.readRecord;
      internals.readRecord = async function (this: unknown, ...args) {
        if (args[0] === locked) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
        return readRecord.apply(this, args as [string, string]);
      };
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await store.rescan();
      } finally {
        warn.mockRestore();
        internals.readRecord = readRecord;
      }
      expect(backlinkIds(store, "Hub")).toEqual(["Also new"]);
      await store.rescan();
      expect(backlinkIds(store, "Hub")).toEqual(["Also new", "Fresh lock"]);
    });

    it("the watcher's scoped read keeps an unreadable file's record too", async () => {
      const store = await vaultOf(5);
      const file = join(dir, "Note 4.md");
      await writeFile(file, "Edited, pointing at [[Hub]].\n");
      const internals = store as unknown as Internals;
      const readRecord = internals.readRecord;
      internals.readRecord = async function (this: unknown, ...args) {
        if (args[0] === file) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
        return readRecord.apply(this, args as [string, string]);
      };
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await expect(internals.refreshFromDisk({ kind: "paths", paths: new Set([file]) })).resolves.toBe(false);
      } finally {
        warn.mockRestore();
        internals.readRecord = readRecord;
      }
      expect(store.get("Note 4").content).toContain("Links to [[Note 0]]");
    });

    it("running out of file handles (EMFILE) isn't per-file: the rescan fails, for the retry path", async () => {
      const store = await vaultOf(3);
      await writeFile(join(dir, "Note 1.md"), "Edited.\n");
      const internals = store as unknown as Internals;
      const readRecord = internals.readRecord;
      internals.readRecord = async function () {
        throw Object.assign(new Error("EMFILE: too many open files"), { code: "EMFILE" });
      };
      try {
        await expect(store.rescan()).rejects.toThrow("EMFILE");
      } finally {
        internals.readRecord = readRecord;
      }
    });

    it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a real mode-000 file doesn't stop an outside edit and a new note", async () => {
      const store = await vaultOf(3);
      const locked = join(dir, "Locked.md");
      await writeFile(locked, "Locked.\n");
      await store.rescan();
      await chmod(locked, 0o000);
      await writeFile(join(dir, "After.md"), "New, pointing at [[Hub]].\n");
      await writeFile(join(dir, "Note 0.md"), "Edited outside.\n");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await store.rescan();
        expect(backlinkIds(store, "Hub")).toEqual(["After"]);
        expect(store.get("Note 0").content).toContain("Edited outside");
        expect(store.get("Locked").content).toContain("Locked.");
      } finally {
        warn.mockRestore();
        await chmod(locked, 0o644);
      }
    });
  });

  describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a folder that can't be read (#35q6kt6e, @polish-dev's review)", () => {
    for (const [mode, what] of [[0o000, "can't be listed"], [0o444, "can be listed but not looked into"]] as const) {
      it(`a folder that ${what} keeps its pages and folder row; a new note and an edit elsewhere still come in`, async () => {
        await mkdir(join(dir, "Area"));
        await writeFile(join(dir, "Area", "Inner.md"), "Inside, pointing at [[Hub]].\n");
        const store = await vaultOf(3);
        expect(store.list().find((meta) => meta.id === "Area")?.kind).toBe("folder");
        await chmod(join(dir, "Area"), mode);
        await writeFile(join(dir, "After.md"), "New, pointing at [[Hub]].\n");
        await writeFile(join(dir, "Note 0.md"), "Edited outside.\n");
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
          await expect(store.rescan()).resolves.toBe(true);
          expect(store.get("Note 0").content).toContain("Edited outside");
          expect(backlinkIds(store, "Hub")).toEqual(["After", "Area/Inner"]);
          expect(store.list().find((meta) => meta.id === "Area")?.kind).toBe("folder");
          expect(store.list().find((meta) => meta.id === "Area/Inner")?.parentId).toBe("Area");
          const logged = warn.mock.calls.length;
          expect(logged).toBe(1);
          await store.rescan();
          expect(warn.mock.calls.length).toBe(logged);
        } finally {
          warn.mockRestore();
          await chmod(join(dir, "Area"), 0o755);
        }
        // Readable again: an edit inside comes in.
        await writeFile(join(dir, "Area", "Inner.md"), "Inside, edited.\n");
        await store.rescan();
        expect(store.get("Area/Inner").content).toContain("Inside, edited.");
        expect(backlinkIds(store, "Hub")).toEqual(["After"]);
      });
    }
  });

  describe("the check when a burst ends (#35q6kt6e)", () => {
    /**
     * A burst of `count` outside edits to known notes the watcher reports (so
     * its refreshes take the scoped path and walk nothing), plus new files in
     * `missed` it never hears of.
     */
    async function burst(count: number, missed: string[]) {
      const store = await vaultOf(count);
      const internals = store as unknown as Internals & { burstCheckWithoutWatchers: boolean };
      internals.burstCheckWithoutWatchers = true;
      const refresh = internals.refreshFromDisk;
      const fullAfterBurst: number[] = [];
      internals.refreshFromDisk = async function (this: unknown, scope) {
        if (scope.kind === "all" && !store.syncing) fullAfterBurst.push(Date.now());
        return refresh.call(this, scope);
      };
      for (let i = 0; i < count; i++) {
        await writeFile(join(dir, `Note ${i}.md`), `Synced edit ${i}.\n`);
        internals.onWatchEvent(dir, `Note ${i}.md`);
      }
      expect(store.syncing).toBe(true);
      for (const name of missed) await writeFile(join(dir, `${name}.md`), "No event was ever sent for this.\n");
      return { store, fullAfterBurst, restore: () => (internals.refreshFromDisk = refresh) };
    }

    it("a change the watcher missed is picked up, and logged by name", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { store, restore } = await burst(60, ["Missed"]);
      try {
        await expect.poll(() => store.list().some((meta) => meta.id === "Missed"), { timeout: 10_000, interval: 100 }).toBe(true);
        expect(store.get("Note 59").content).toContain("Synced edit 59");
        expect(warn).toHaveBeenCalledWith("[gumply] watcher missed 1 change: Missed");
      } finally {
        warn.mockRestore();
        restore();
        store.stopWatching();
      }
    }, 20_000);

    it("a burst the watcher saw completely: the check runs and logs nothing", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { store, fullAfterBurst, restore } = await burst(60, []);
      try {
        await expect.poll(() => fullAfterBurst.length, { timeout: 10_000, interval: 100 }).toBeGreaterThan(0);
        expect(store.get("Note 59").content).toContain("Synced edit 59");
        expect(warn.mock.calls.some((call) => String(call[0]).includes("watcher missed"))).toBe(false);
      } finally {
        warn.mockRestore();
        restore();
        store.stopWatching();
      }
    }, 20_000);
  });
});
