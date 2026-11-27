import { readFile, stat as realStat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { historyDir, readHistory } from "../src/history";
import { cleanupVaults, createTestServer } from "./helpers";

/**
 * #rwgtaffe: a full rescan reuses a file's cached record while its stat key (mtime, size, inode, ctime) is the same.
 * The kernel stamps ctime from a coarse clock (one tick), and vfat/exFAT keep it in 2 s steps, so a same-size edit
 * that keeps the mtime (FAT, a sync tool) can leave every field as it was: the rescan kept the old record and the
 * page's version didn't move (outside-edit-mtime's FAT case failed about 1 run in 6). Here every `.md` file's ctime
 * is held still, as such a file system would show it, so the miss happens every time, not by timing. A cache entry
 * stat'ed within RACY_STAT_MS of its ctime is now re-read, as git does with a "racily clean" index entry.
 * Synthetic vault.
 */

const held = vi.hoisted(() => ({ ctimeMs: null as number | null, reads: new Map<string, number>() }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const stat = (async (path: Parameters<typeof actual.stat>[0], options?: Parameters<typeof actual.stat>[1]) => {
    const stats = await actual.stat(path, options as never);
    if (held.ctimeMs !== null && String(path).endsWith(".md") && typeof stats.ctimeMs === "number") {
      Object.assign(stats, { ctimeMs: held.ctimeMs, ctime: new Date(held.ctimeMs) });
    }
    return stats;
  }) as typeof actual.stat;
  // The store reads a page through an open handle (readConsistent): count those opens per path.
  const open = (async (path: Parameters<typeof actual.open>[0], ...rest: unknown[]) => {
    held.reads.set(String(path), (held.reads.get(String(path)) ?? 0) + 1);
    return (actual.open as (...args: unknown[]) => ReturnType<typeof actual.open>)(path, ...rest);
  }) as typeof actual.open;
  return { ...actual, stat, open, default: { ...actual, stat, open } };
});

beforeEach(() => {
  held.ctimeMs = null;
  held.reads.clear();
});
afterEach(async () => {
  held.ctimeMs = null;
  await cleanupVaults();
});

describe("a same-size edit that keeps mtime and (coarse) ctime is still seen by a rescan (#rwgtaffe)", () => {
  it("the version moves on, and a save from before it is a conflict; the outside text stays", async () => {
    const { store, dir } = await createTestServer();
    const page = await store.create({ title: "Ledger", content: "Balance: ten." });
    const result = await store.update(page.id, { content: "Balance: ten. Saved." });
    const file = join(dir, `${result.id}.md`);
    const bytes = await readFile(file, "utf8");
    const { mtime } = await realStat(file);
    // A whole-millisecond mtime first, so restoring it after the edit (utimes takes a Date) leaves it exactly as
    // the cache saw it; from here the file system shows one ctime for this file, as a coarse clock or vfat would.
    await utimes(file, mtime, mtime);
    held.ctimeMs = Date.now();
    await store.rescan();
    const before = store.get(result.id).updated;
    await writeFile(file, bytes.replace("Saved.", "Other."));
    await utimes(file, mtime, mtime);
    await store.rescan();
    expect(store.get(result.id).updated > before).toBe(true);
    await expect(store.update(result.id, { content: "Mine.", expectedUpdated: before })).rejects.toThrow(/changed on disk/);
    expect(await readFile(file, "utf8")).toContain("Other.");
  });

  it("a file whose ctime is long past is trusted from the cache: rescans don't read it again", async () => {
    const { store, dir } = await createTestServer();
    const page = await store.create({ title: "Old", content: "Settled." });
    const file = join(dir, `${page.id}.md`);
    held.ctimeMs = Date.now() - 60_000;
    await store.rescan();
    const reads = held.reads.get(file) ?? 0;
    await store.rescan();
    await store.rescan();
    expect(held.reads.get(file) ?? 0).toBe(reads);
  });

  it("a file changed just now is read again by the next rescan, with no change to the page (same bytes)", async () => {
    const { store, dir } = await createTestServer();
    const page = await store.create({ title: "Fresh", content: "Just written." });
    const file = join(dir, `${page.id}.md`);
    held.ctimeMs = Date.now();
    await store.rescan();
    const version = store.get(page.id).updated;
    const reads = held.reads.get(file) ?? 0;
    const versions = async () => (await readHistory(historyDir(dir, page.id)).catch(() => ({ entries: [] as unknown[] }))).entries.length;
    const kept = await versions();
    // A silent read (@graph-dev's review): the rescan reports no change (so nothing is announced to clients or
    // reindexed), the version stays, and no History version is added.
    expect(await store.rescan()).toBe(false);
    expect(held.reads.get(file) ?? 0).toBeGreaterThan(reads);
    expect(store.get(page.id).updated).toBe(version);
    expect(await versions()).toBe(kept);
  });
});
