/**
 * N6 (#9x4duwmg): settled positions of big graphs, kept in the browser
 * (IndexedDB), so opening the same graph again shows it laid out at once
 * instead of arranging it for ~10–20 s. Nothing is written into the vault
 * (D37): this is a cache of the app's own drawing, keyed by exactly what the
 * layout depends on. Any change (a node, a link, the centre page, reduced
 * motion, the forces' version) is a different key, and lays out afresh.
 */
import type { ClusterInfo } from "./clusters.js";
import { STREAM_MAX_NODES } from "./layout-forces.js";

/**
 * Bumped whenever the forces or their settings change, so positions from an
 * older layout are never shown as this one's. 1: θ 1.2 above 5k nodes (N6).
 * 2: graph clusters (#xb4b54gr): the cluster force and links between clusters
 * relaxed, and the worker's clusters kept with the positions.
 */
export const LAYOUT_CACHE_VERSION = 2;

/** Graphs at least this big are cached; smaller ones lay out (and stream) quickly enough. */
export const LAYOUT_CACHE_MIN_NODES = STREAM_MAX_NODES + 1;

/** How many graphs' positions are kept (each ~80 KB at 10k nodes); the oldest go first. */
export const LAYOUT_CACHE_ENTRIES = 4;

/** #xb4b54gr: the clusters the worker found for this graph (links mode), kept with its positions. */
export interface CachedClusters {
  of: Int32Array;
  list: ClusterInfo[];
  modularity?: number;
}

export interface CachedLayout {
  x: Float32Array;
  y: Float32Array;
  /** The worker's clusters, when it computed them (a hit then needs no worker at all). */
  clusters?: CachedClusters;
}

/** Where cached layouts live: IndexedDB in the app, a Map in tests. */
export interface LayoutStore {
  get(key: string): Promise<CachedLayout | undefined>;
  put(key: string, layout: CachedLayout): Promise<void>;
}

/** Whether a graph of `count` nodes uses the cache. */
export function cachesLayout(count: number): boolean {
  return count >= LAYOUT_CACHE_MIN_NODES;
}

/**
 * The cache key: two FNV-1a 32-bit hashes (different seeds) over the version,
 * the variant (centre page, reduced motion, and later the cluster mode), the
 * node ids in order and the link index pairs. Node order matters: positions
 * are stored by index.
 */
export function layoutCacheKey(ids: readonly string[], links: Uint32Array, variant: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  const byte = (value: number) => {
    a = Math.imul(a ^ (value & 0xff), 0x01000193);
    b = Math.imul(b ^ (value & 0xff), 0x01000193) ^ (b >>> 13);
  };
  const text = (value: string) => {
    for (let i = 0; i < value.length; i += 1) {
      const code = value.charCodeAt(i);
      byte(code);
      byte(code >>> 8);
    }
    byte(0); // A separator, so ["ab", "c"] and ["a", "bc"] differ.
    byte(0xff);
  };
  const word = (value: number) => {
    byte(value);
    byte(value >>> 8);
    byte(value >>> 16);
    byte(value >>> 24);
  };
  word(LAYOUT_CACHE_VERSION);
  text(variant);
  word(ids.length);
  for (const id of ids) text(id);
  word(links.length);
  for (let i = 0; i < links.length; i += 1) word(links[i]!);
  const hex = (value: number) => (value >>> 0).toString(16).padStart(8, "0");
  return `v${LAYOUT_CACHE_VERSION}:${ids.length}:${links.length >> 1}:${hex(a)}${hex(b)}`;
}

/** A cached layout for this key, if it fits `count` nodes; never throws (a cache is optional). */
export async function cachedLayout(store: LayoutStore | null, key: string, count: number): Promise<CachedLayout | undefined> {
  if (!store) return undefined;
  try {
    const found = await store.get(key);
    if (!found || found.x.length !== count || found.y.length !== count) return undefined;
    for (let i = 0; i < count; i += 1) if (!Number.isFinite(found.x[i]) || !Number.isFinite(found.y[i])) return undefined;
    // Clusters that don't fit the graph are dropped (the caller then treats it as a miss if it needs them).
    if (found.clusters && (found.clusters.of.length !== count || !Array.isArray(found.clusters.list))) return { x: found.x, y: found.y };
    return found;
  } catch {
    return undefined;
  }
}

/** Keep a settled layout; never throws (a full or blocked IndexedDB just means no cache). */
export async function keepLayout(store: LayoutStore | null, key: string, layout: CachedLayout): Promise<void> {
  if (!store) return;
  try {
    await store.put(key, {
      x: Float32Array.from(layout.x),
      y: Float32Array.from(layout.y),
      ...(layout.clusters
        ? {
            clusters: {
              of: Int32Array.from(layout.clusters.of),
              list: layout.clusters.list.map((info) => ({ ...info })),
              ...(layout.clusters.modularity === undefined ? {} : { modularity: layout.clusters.modularity }),
            },
          }
        : {}),
    });
  } catch {
    // Nothing to do: the next open lays out again.
  }
}

const DB_NAME = "gumply-graph-layout";
const STORE = "layouts";
/** When each layout was kept, in a store of its own: eviction sorts these without reading any layout. */
const SAVED = "saved";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** The browser's store, or null where IndexedDB isn't available (tests, a locked-down profile). */
export function browserLayoutStore(): LayoutStore | null {
  if (typeof indexedDB === "undefined") return null;
  let opened: Promise<IDBDatabase> | null = null;
  const db = () => {
    opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, 2);
      open.onupgradeneeded = () => {
        const names = open.result.objectStoreNames;
        // Version 1 kept the time inside each layout: start the cache afresh (it's only a cache).
        if (names.contains(STORE)) open.result.deleteObjectStore(STORE);
        if (names.contains(SAVED)) open.result.deleteObjectStore(SAVED);
        open.result.createObjectStore(STORE);
        open.result.createObjectStore(SAVED);
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
      open.onblocked = () => reject(new Error("graph layout cache blocked"));
    });
    return opened;
  };
  return {
    async get(key) {
      const database = await db();
      const value = (await request(database.transaction(STORE, "readonly").objectStore(STORE).get(key))) as
        | { x: Float32Array; y: Float32Array; clusters?: CachedClusters }
        | undefined;
      if (!value) return undefined;
      // A hit counts as a use, so eviction drops the least recently used graph (best effort).
      try {
        database.transaction(SAVED, "readwrite").objectStore(SAVED).put(Date.now(), key);
      } catch {
        // Only the eviction order is affected.
      }
      return { x: value.x, y: value.y, ...(value.clusters ? { clusters: value.clusters } : {}) };
    },
    async put(key, layout) {
      const tx = (await db()).transaction([STORE, SAVED], "readwrite");
      const layouts = tx.objectStore(STORE);
      const saved = tx.objectStore(SAVED);
      await request(layouts.put({ x: layout.x, y: layout.y, ...(layout.clusters ? { clusters: layout.clusters } : {}) }, key));
      await request(saved.put(Date.now(), key));
      // Keep only the newest few graphs: sorted by the small "saved" entries alone.
      const keys = (await request(saved.getAllKeys())) as string[];
      if (keys.length <= LAYOUT_CACHE_ENTRIES) return;
      const times = (await request(saved.getAll())) as number[];
      const oldestFirst = keys.map((k, i) => ({ k, at: times[i] ?? 0 })).sort((p, q) => p.at - q.at);
      for (const { k } of oldestFirst.slice(0, oldestFirst.length - LAYOUT_CACHE_ENTRIES)) {
        layouts.delete(k);
        saved.delete(k);
      }
    },
  };
}
