import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SearchResult } from "@gumply/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { countWork } from "../../../packages/core/test/work-counter";
import { createApp } from "../src/app";
import { SEARCH_LIMIT, SEARCH_LIMIT_MAX, VaultStore } from "../src/vault-store";

/**
 * #g95wkd9y: a broad search scores every page but builds results (meta and
 * snippet) only for the page it returns. Work is counted, never timed.
 */

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gumply-search-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** `hits` notes that mention "roadmap" (some in the title), plus `others` that don't. */
async function vaultOf(hits: number, others = 0): Promise<VaultStore> {
  for (let i = 0; i < hits; i++) {
    const title = i % 10 === 0 ? `Roadmap ${i}` : `Note ${i}`;
    // Varying counts, so the ranking has real score differences and ties.
    await writeFile(join(dir, `${title}.md`), `${"The roadmap says more. ".repeat(1 + (i % 12))}\n`);
  }
  for (let i = 0; i < others; i++) await writeFile(join(dir, `Other ${i}.md`), "Nothing to see.\n");
  const store = new VaultStore(dir);
  await store.init();
  return store;
}

/** Results built (one meta each) while `run` runs. */
function built(store: VaultStore, run: () => void): number {
  const internals = store as unknown as { searchItem: (...args: unknown[]) => unknown };
  const original = internals.searchItem;
  let count = 0;
  internals.searchItem = function (this: unknown, ...args: unknown[]) {
    count += 1;
    return original.apply(this, args);
  };
  try {
    run();
  } finally {
    internals.searchItem = original;
  }
  return count;
}

describe("bounded search (#g95wkd9y)", () => {
  it("builds at most one page of results, however many pages match", async () => {
    for (const hits of [100, 800]) {
      await rm(dir, { recursive: true, force: true });
      dir = await mkdtemp(join(tmpdir(), "gumply-search-"));
      const store = await vaultOf(hits);
      store.search("roadmap"); // Fill the plain-text cache, so only the search itself is counted.
      let page: SearchResult[] = [];
      expect(built(store, () => (page = store.search("roadmap")))).toBe(SEARCH_LIMIT);
      expect(page).toHaveLength(SEARCH_LIMIT);
      expect(built(store, () => store.search("roadmap", { limit: 10_000 }))).toBe(Math.min(hits, SEARCH_LIMIT_MAX));
    }
  });

  it("the rest of the search grows with the vault, not faster", async () => {
    const work: number[] = [];
    for (const hits of [100, 800]) {
      await rm(dir, { recursive: true, force: true });
      dir = await mkdtemp(join(tmpdir(), "gumply-search-"));
      const store = await vaultOf(hits);
      store.search("roadmap");
      work.push(countWork(() => store.search("roadmap")));
    }
    // 8x the matching pages: scoring is linear, the sort n·log n (about 11x here).
    expect(work[1]! / work[0]!).toBeLessThan(16);
  });

  it("pages follow D13's ranking: concatenated, they are the whole ranked list", async () => {
    const store = await vaultOf(150, 20);
    const whole = store.searchPage("roadmap", { limit: SEARCH_LIMIT_MAX });
    expect(whole.nextCursor).toBeUndefined();
    expect(whole.items).toHaveLength(150);
    // Title matches first, then by score, then by title.
    for (let i = 1; i < whole.items.length; i++) {
      const [a, b] = [whole.items[i - 1]!, whole.items[i]!];
      expect(a.score > b.score || (a.score === b.score && a.page.title.localeCompare(b.page.title) <= 0)).toBe(true);
    }
    expect(whole.items.slice(0, 15).every((item) => item.page.title.startsWith("Roadmap"))).toBe(true);

    const paged: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = store.searchPage("roadmap", { limit: 7, ...(cursor ? { cursor } : {}) });
      paged.push(...page.items.map((item) => item.page.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(Math.ceil(150 / 7));
    expect(paged).toEqual(whole.items.map((item) => item.page.id));
  });

  it("limits are clamped: none or nonsense gives the default, too many the maximum", async () => {
    const store = await vaultOf(300);
    expect(store.search("roadmap")).toHaveLength(SEARCH_LIMIT);
    expect(store.search("roadmap", { limit: 0 })).toHaveLength(SEARCH_LIMIT);
    expect(store.search("roadmap", { limit: Number.NaN })).toHaveLength(SEARCH_LIMIT);
    expect(store.search("roadmap", { limit: 5000 })).toHaveLength(SEARCH_LIMIT_MAX);
    expect(store.search("roadmap", { cursor: "nonsense" })).toEqual(store.search("roadmap"));
    expect(store.search("roadmap", { cursor: "1000" })).toEqual([]);
  });

  it("a kind filter is applied before the page is cut", async () => {
    const store = await vaultOf(120);
    await writeFile(join(dir, "Plan.canvas"), JSON.stringify({ nodes: [{ id: "a", type: "text", text: "roadmap", x: 0, y: 0, width: 100, height: 60 }], edges: [] }));
    await store.rescan();
    expect(store.search("roadmap", { limit: 5, kinds: ["whiteboard"] }).map((item) => item.page.id)).toEqual(["Plan.canvas"]);
  });

  it("GET /search returns an array page and the next cursor in X-Next-Cursor", async () => {
    const store = await vaultOf(60);
    const app = createApp({ vaultPath: dir, store });
    const first = await app.request("http://127.0.0.1/api/search?q=roadmap&limit=40");
    const firstItems = (await first.json()) as SearchResult[];
    expect(firstItems).toHaveLength(40);
    const cursor = first.headers.get("x-next-cursor");
    expect(cursor).toBeTruthy();
    const second = await app.request(`http://127.0.0.1/api/search?q=roadmap&limit=40&cursor=${cursor}`);
    expect((await second.json()) as SearchResult[]).toHaveLength(20);
    expect(second.headers.get("x-next-cursor")).toBeNull();
    // No limit: the default page.
    const plain = await app.request("http://127.0.0.1/api/search?q=roadmap");
    expect((await plain.json()) as SearchResult[]).toHaveLength(SEARCH_LIMIT);
  });
});
