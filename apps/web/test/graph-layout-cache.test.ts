import { describe, expect, it } from "vitest";
import {
  cachedLayout,
  cachesLayout,
  keepLayout,
  LAYOUT_CACHE_MIN_NODES,
  layoutCacheKey,
  type CachedLayout,
  type LayoutStore,
} from "../src/graph/layout-cache";
import { chargeTheta, STREAM_MAX_NODES } from "../src/graph/layout-forces";

/** N6 (#9x4duwmg): θ above 5k nodes, and the settled-positions cache's key and safety. */
function mapStore(): LayoutStore & { map: Map<string, CachedLayout> } {
  const map = new Map<string, CachedLayout>();
  return {
    map,
    get: async (key) => map.get(key),
    put: async (key, layout) => {
      map.set(key, layout);
    },
  };
}

const ids = ["A", "B", "C"];
const links = Uint32Array.from([0, 1, 1, 2]);

describe("the charge's θ (N6)", () => {
  it("is d3's default up to the streaming limit, so smaller graphs look as before", () => {
    expect(chargeTheta(10)).toBe(0.9);
    expect(chargeTheta(STREAM_MAX_NODES)).toBe(0.9);
  });
  it("is coarser above it", () => {
    expect(chargeTheta(STREAM_MAX_NODES + 1)).toBe(1.2);
    expect(chargeTheta(10_000)).toBe(1.2);
  });
});

describe("the graph layout cache key (N6)", () => {
  it("only graphs above the streaming limit are cached", () => {
    expect(cachesLayout(STREAM_MAX_NODES)).toBe(false);
    expect(cachesLayout(LAYOUT_CACHE_MIN_NODES)).toBe(true);
  });

  it("is the same for the same graph", () => {
    expect(layoutCacheKey(ids, links, "|0")).toBe(layoutCacheKey([...ids], Uint32Array.from(links), "|0"));
  });

  it("changes with anything the layout depends on", () => {
    const base = layoutCacheKey(ids, links, "|0");
    const variants = [
      layoutCacheKey(["A", "B", "D"], links, "|0"), // a node renamed
      layoutCacheKey(["B", "A", "C"], links, "|0"), // the same nodes in another order (positions are by index)
      layoutCacheKey([...ids, "D"], links, "|0"), // a node added
      layoutCacheKey(ids, Uint32Array.from([0, 1, 0, 2]), "|0"), // a link moved
      layoutCacheKey(ids, Uint32Array.from([0, 1]), "|0"), // a link removed
      layoutCacheKey(ids, links, "A|0"), // a centre page
      layoutCacheKey(ids, links, "|1"), // reduced motion
      layoutCacheKey(["AB", "C"], Uint32Array.from([0, 1]), "|0"),
      layoutCacheKey(["A", "BC"], Uint32Array.from([0, 1]), "|0"), // ids aren't just concatenated
    ];
    const all = new Set([base, ...variants]);
    expect(all.size).toBe(variants.length + 1);
  });

  it("names the layout version, so a forces change never reuses old positions", () => {
    expect(layoutCacheKey(ids, links, "")).toMatch(/^v\d+:3:2:[0-9a-f]{16}$/);
  });
});

describe("reading and keeping cached layouts (N6)", () => {
  it("keeps a settled layout and gives it back", async () => {
    const store = mapStore();
    const x = Float32Array.from([1, 2, 3]);
    const y = Float32Array.from([4, 5, 6]);
    await keepLayout(store, "k", { x, y });
    x[0] = 99; // The caller's arrays may be reused: the cache holds a copy.
    const back = await cachedLayout(store, "k", 3);
    expect(back && [...back.x]).toEqual([1, 2, 3]);
    expect(back && [...back.y]).toEqual([4, 5, 6]);
  });

  it("ignores an entry of the wrong size or with a missing position", async () => {
    const store = mapStore();
    store.map.set("short", { x: Float32Array.from([1, 2]), y: Float32Array.from([1, 2]) });
    store.map.set("nan", { x: Float32Array.from([1, Number.NaN, 3]), y: Float32Array.from([1, 2, 3]) });
    expect(await cachedLayout(store, "short", 3)).toBeUndefined();
    expect(await cachedLayout(store, "nan", 3)).toBeUndefined();
    expect(await cachedLayout(store, "missing", 3)).toBeUndefined();
  });

  it("never throws: a broken or absent store just means no cache", async () => {
    const broken: LayoutStore = {
      get: async () => {
        throw new Error("blocked");
      },
      put: async () => {
        throw new Error("quota");
      },
    };
    expect(await cachedLayout(broken, "k", 3)).toBeUndefined();
    await expect(keepLayout(broken, "k", { x: new Float32Array(3), y: new Float32Array(3) })).resolves.toBeUndefined();
    expect(await cachedLayout(null, "k", 3)).toBeUndefined();
  });
});
