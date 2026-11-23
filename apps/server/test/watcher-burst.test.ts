import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { VaultStore } from "../src/vault-store";
import { cleanupVaults, createTestServer } from "./helpers";

/**
 * spec/sync-conflicts §8 (D43): during a sync tool's burst the watcher still
 * refreshes at least every 2 s, says "syncing", and a rescan it scheduled
 * never makes a waiting save wait.
 */

afterEach(cleanupVaults);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Internals {
  refreshFromDisk: () => Promise<boolean>;
  runScheduledRescan: () => Promise<boolean>;
  enqueue: <T>(task: () => Promise<T>) => Promise<T>;
}

describe("the watcher during a sync burst (§8)", () => {
  it("a long burst (an event every 60 ms, under the 120 ms quiet gap) still refreshes within ~2 s", async () => {
    const { dir } = await createTestServer();
    const store = new VaultStore(dir);
    await store.init();
    store.startWatching();
    try {
      const started = Date.now();
      let seenAt: number | null = null;
      for (let i = 0; i < 60 && Date.now() - started < 3500; i++) {
        await writeFile(join(dir, `Burst ${i}.md`), `Page ${i}.\n`, "utf8");
        if (seenAt === null && store.list().some((page) => page.id === "Burst 0")) seenAt = Date.now() - started;
        await sleep(60);
      }
      // Before §8 the debounce kept moving and nothing was indexed until the burst stopped.
      expect(seenAt, "the first page was indexed while the burst was still going").not.toBeNull();
      expect(seenAt!).toBeLessThan(3000);
    } finally {
      store.stopWatching();
    }
  }, 20_000);

  it("over 50 events in 2 s is \"syncing\": GET /api/pages says so, and it ends once the vault is quiet", async () => {
    const { dir } = await createTestServer();
    const store = new VaultStore(dir);
    await store.init();
    const app = createApp({ vaultPath: dir, store });
    store.startWatching();
    try {
      expect(store.syncing).toBe(false);
      await Promise.all(Array.from({ length: 80 }, (_, i) => writeFile(join(dir, `Synced ${i}.md`), `Note ${i}.\n`, "utf8")));
      await expect.poll(() => store.syncing, { timeout: 5000 }).toBe(true);
      expect((await app.request("/api/pages")).headers.get("X-Gumply-Syncing")).toBe("1");
      await expect.poll(() => store.syncing, { timeout: 6000, interval: 200 }).toBe(false);
      expect((await app.request("/api/pages")).headers.get("X-Gumply-Syncing")).toBeNull();
    } finally {
      store.stopWatching();
    }
  }, 20_000);

  it("#im3em6tq: our own rename's link rewrites (80 pages) are never \"syncing\"; outside writes still are", async () => {
    const { dir } = await createTestServer();
    await writeFile(join(dir, "Hub.md"), "The hub.\n", "utf8");
    for (let i = 0; i < 80; i++) await writeFile(join(dir, `Linker ${i}.md`), `See [[Hub]] (${i}).\n`, "utf8");
    const store = new VaultStore(dir);
    await store.init();
    store.startWatching();
    try {
      let seen = false;
      const watch = setInterval(() => (seen ||= store.syncing), 25);
      const renamed = await store.update("Hub", { title: "Hub renamed" });
      expect(renamed.rewrittenPages).toHaveLength(80);
      expect(await readFile(join(dir, "Linker 7.md"), "utf8")).toContain("[[Hub renamed]]");
      // The watcher's events for those 80 writes (and the move) arrive meanwhile and after.
      await sleep(2500);
      clearInterval(watch);
      expect(seen, "Syncing changes… for our own rewrites").toBe(false);
      // The flag itself still works: 80 outside writes are a sync. (Other files: the
      // ones we just wrote are ours for a few seconds, OWN_WRITE_MS.)
      await Promise.all(Array.from({ length: 80 }, (_, i) => writeFile(join(dir, `Outside ${i}.md`), `Synced in ${i}.\n`, "utf8")));
      await expect.poll(() => store.syncing, { timeout: 5000 }).toBe(true);
    } finally {
      store.stopWatching();
    }
  }, 20_000);

  it("a save during a burst on the same file: written once, never interleaved with a running rescan, D22 intact", async () => {
    const { dir } = await createTestServer();
    await writeFile(join(dir, "Note.md"), "Before.\n", "utf8");
    const store = new VaultStore(dir);
    await store.init();
    store.startWatching();
    try {
      // Outside writes to the same file and others keep coming…
      const burst = (async () => {
        for (let i = 0; i < 30; i++) {
          await writeFile(join(dir, `Other ${i}.md`), `Other ${i}.\n`, "utf8");
          await sleep(30);
        }
      })();
      await sleep(100);
      // …the app saves the version it loaded: it lands, and the rescan that follows keeps it.
      const loaded = store.get("Note").updated;
      await store.update("Note", { content: "Mine.\n", expectedUpdated: loaded });
      expect(await readFile(join(dir, "Note.md"), "utf8")).toBe("Mine.\n");
      // An outside change to that file mid-burst: the next save with the old version is a 409 (D22), nothing overwritten.
      const mine = store.get("Note").updated;
      await writeFile(join(dir, "Note.md"), "Theirs.\n", "utf8");
      await expect.poll(() => store.get("Note").content, { timeout: 5000 }).toContain("Theirs.");
      await expect(store.update("Note", { content: "Stale.\n", expectedUpdated: mine })).rejects.toMatchObject({ status: 409 });
      expect(await readFile(join(dir, "Note.md"), "utf8")).toBe("Theirs.\n");
      await burst;
    } finally {
      store.stopWatching();
    }
  }, 20_000);

  it("a scheduled rescan waits for a save that is already waiting (save priority)", async () => {
    const { dir } = await createTestServer();
    await writeFile(join(dir, "Mine.md"), "Draft.\n", "utf8");
    const store = new VaultStore(dir);
    await store.init();
    const internal = store as unknown as Internals;
    const order: string[] = [];
    const original = internal.refreshFromDisk.bind(store);
    internal.refreshFromDisk = async () => {
      order.push("rescan");
      return original();
    };

    // Something holds the queue (a save in progress)…
    let release!: () => void;
    const held = internal.enqueue(() => new Promise<void>((resolve) => (release = resolve)));
    // …the watcher's rescan comes due, then a save is handed in behind it.
    const rescan = internal.runScheduledRescan();
    const save = store.update("Mine", { content: "Saved first.\n", expectedUpdated: store.get("Mine").updated }).then(() => order.push("save"));
    await sleep(20);
    release();
    await Promise.all([held, rescan, save]);
    expect(order).toEqual(["save", "rescan"]);
  });
});
