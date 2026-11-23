import type { SearchResult } from "@gumply/core";
import { describe, expect, it } from "vitest";
import type { SearchOptions } from "../../server/src/vault-store.js";
import { MAX_SEARCH_PAGES, searchHits } from "../src/tools/read.js";

/** A store whose ranking has `total` hits, counting the pages asked for. */
function storeOf(total: number) {
  const calls: SearchOptions[] = [];
  return {
    calls,
    searchPage(_query: string, options: SearchOptions = {}) {
      calls.push(options);
      const start = Number(options.cursor ?? 0);
      const limit = options.limit ?? 50;
      const items = Array.from({ length: Math.max(0, Math.min(limit, total - start)) }, (_, i) => ({
        page: { id: `Note ${start + i}` },
        snippet: "",
        score: 1,
      })) as unknown as SearchResult[];
      return start + limit < total ? { items, nextCursor: String(start + limit) } : { items };
    },
  };
}

describe("MCP search paging (#g95wkd9y)", () => {
  it("asks for pages only as the tool reads on", () => {
    const store = storeOf(10_000);
    const hits = searchHits(store, "roadmap", ["page"]);
    for (let i = 0; i < 5; i++) hits.next();
    expect(store.calls).toHaveLength(1);
    expect(store.calls[0]).toMatchObject({ limit: 200, kinds: ["page"] });
  });

  it("stops after 20 pages, even when every hit is filtered out", () => {
    const store = storeOf(100_000);
    const seen = [...searchHits(store, "roadmap", ["page", "whiteboard"])].length;
    expect(store.calls).toHaveLength(MAX_SEARCH_PAGES);
    expect(seen).toBe(MAX_SEARCH_PAGES * 200);
  });

  it("ends at the last page of a short ranking", () => {
    const store = storeOf(450);
    expect([...searchHits(store, "roadmap", ["page"])].map((hit) => hit.page.id)).toHaveLength(450);
    expect(store.calls.map((call) => call.cursor)).toEqual([undefined, "200", "400"]);
  });
});
