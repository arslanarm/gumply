import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { VaultStore } from "../src/vault-store";
import { drainStores, RM_VAULT, trackStore } from "./helpers";

/**
 * #g95wkd9y (offenders 3+4): a cold open answers once the files are read;
 * the links are indexed next, in the background. Whatever reads links waits,
 * so an answer is never partial; nothing that happens meanwhile is lost; a
 * failure never leaves the status stuck.
 */
let dir: string;
let store: VaultStore | null = null;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gumply-bgindex-"));
});
afterEach(async () => {
  store?.stopWatching();
  store = null;
  await drainStores();
  await rm(dir, RM_VAULT);
});

type Internals = { beforeIndex: (() => Promise<void>) | undefined; mentionWordsOf: (...args: unknown[]) => void };

async function vault(): Promise<void> {
  await writeFile(join(dir, "Hub.md"), "The hub.\n");
  for (let i = 0; i < 30; i++) await writeFile(join(dir, `Note ${i}.md`), `Note ${i} links [[Hub]] and mentions Hub in text.\n`);
}

/** A store opened in the background, with its link index held until `release()`. */
async function heldOpen(): Promise<{ store: VaultStore; release: () => void }> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const opened = trackStore(new VaultStore(dir));
  (opened as unknown as Internals).beforeIndex = () => gate;
  await opened.init({ background: true });
  store = opened;
  return { store: opened, release };
}

describe("cold open: answer first, index links in the background (#g95wkd9y)", () => {
  it("pages answer while indexing; the graph and backlinks wait and are complete", async () => {
    await vault();
    const { store, release } = await heldOpen();
    const app = createApp({ vaultPath: dir, store });
    expect(store.indexing).toBe(true);
    const pages = await app.request("http://127.0.0.1/api/pages");
    expect(pages.headers.get("x-gumply-indexing")).toBe("1");
    expect(((await pages.json()) as unknown[]).length).toBe(31);
    expect((await app.request("http://127.0.0.1/api/pages/Hub")).status).toBe(200);

    let graphDone = false;
    const graph = app.request("http://127.0.0.1/api/graph").then(async (response) => {
      graphDone = true;
      return (await response.json()) as { links: unknown[] };
    });
    const backlinks = app.request("http://127.0.0.1/api/pages/Hub/backlinks").then((response) => response.json() as Promise<unknown[]>);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(graphDone).toBe(false); // Waiting, not answering with no links.
    release();
    expect((await graph).links).toHaveLength(30);
    expect(await backlinks).toHaveLength(30);
    expect(store.indexing).toBe(false);
    expect((await app.request("http://127.0.0.1/api/pages")).headers.get("x-gumply-indexing")).toBeNull();
  });

  it("an outside edit while the index is held isn't lost: the graph has it once indexing ends", async () => {
    await vault();
    const { store, release } = await heldOpen();
    store.startWatching();
    await writeFile(join(dir, "Late.md"), "Written while indexing, links [[Note 3]].\n");
    await writeFile(join(dir, "Note 5.md"), "Edited while indexing: now links [[Late]].\n");
    await new Promise((resolve) => setTimeout(resolve, 300)); // The watcher's rescan queues behind the index.
    release();
    await store.whenIndexed();
    await expect
      .poll(() => {
        const links = store.graph().links.map((link) => `${link.source}>${link.target}`);
        return [links.includes("Late>Note 3"), links.includes("Note 5>Late"), links.includes("Note 5>Hub")];
      }, { timeout: 5000 })
      .toEqual([true, true, false]);
  });

  it("an index that fails is logged and never leaves the status stuck", async () => {
    await vault();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const opened = trackStore(new VaultStore(dir));
      (opened as unknown as Internals).beforeIndex = async () => {
        throw new Error("boom");
      };
      await opened.init({ background: true });
      store = opened;
      await opened.whenIndexed();
      expect(opened.indexing).toBe(false);
      expect(error).toHaveBeenCalledWith("[gumply] indexing the vault's links failed:", expect.any(Error));
      // The next change still indexes its links.
      await writeFile(join(dir, "After.md"), "Links [[Hub]].\n");
      await opened.rescan();
      expect(opened.backlinks("Hub").map((item) => item.page.id)).toContain("After");
    } finally {
      error.mockRestore();
    }
  });

  it("the mention index is warm after it: the first mentions request tokenizes nothing", async () => {
    await vault();
    const { store, release } = await heldOpen();
    release();
    await store.warmed;
    const internals = store as unknown as Internals;
    const original = internals.mentionWordsOf;
    let tokenized = 0;
    internals.mentionWordsOf = function (this: unknown, ...args: unknown[]) {
      const record = args[0] as { id: string; content: string };
      const cache = (this as { mentionWordsByPage: Map<string, { content: string }> }).mentionWordsByPage.get(record.id);
      if (!cache || cache.content !== record.content) tokenized += 1;
      return original.apply(this, args);
    };
    try {
      expect((await store.mentions("Hub")).length).toBe(30);
    } finally {
      internals.mentionWordsOf = original;
    }
    expect(tokenized).toBe(0);
  });

  it("init() without background is unchanged: indexed before it returns", async () => {
    await vault();
    const opened = trackStore(new VaultStore(dir));
    await opened.init();
    store = opened;
    expect(opened.indexing).toBe(false);
    expect(opened.backlinks("Hub")).toHaveLength(30);
  });
});
