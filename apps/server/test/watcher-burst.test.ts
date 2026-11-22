import { writeFile } from "node:fs/promises";
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
