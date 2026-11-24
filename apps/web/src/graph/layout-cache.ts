/**
 * N6 (#9x4duwmg): settled positions of big graphs, kept in the browser
 * (IndexedDB), so opening the same graph again shows it laid out at once
 * instead of arranging it for ~10–20 s. Nothing is written into the vault
 * (D37): this is a cache of the app's own drawing, keyed by exactly what the
 * layout depends on. Any change (a node, a link, the centre page, reduced
 * motion, the forces' version) is a different key, and lays out afresh.
 */
import { STREAM_MAX_NODES } from "./layout-forces.js";

/**
 * Bumped whenever the forces or their settings change, so positions from an
 * older layout are never shown as this one's. 1: θ 1.2 above 5k nodes (N6).
 */
export const LAYOUT_CACHE_VERSION = 1;

/** Graphs at least this big are cached; smaller ones lay out (and stream) quickly enough. */
export const LAYOUT_CACHE_MIN_NODES = STREAM_MAX_NODES + 1;

/** How many graphs' positions are kept (each ~80 KB at 10k nodes); the oldest go first. */
export const LAYOUT_CACHE_ENTRIES = 4;

export interface CachedLayout {
  x: Float32Array;
  y: Float32Array;
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
    return found;
  } catch {
    return undefined;
  }
}

/** Keep a settled layout; never throws (a full or blocked IndexedDB just means no cache). */
export async function keepLayout(store: LayoutStore | null, key: string, layout: CachedLayout): Promise<void> {
  if (!store) return;
  try {
    await store.put(key, { x: Float32Array.from(layout.x), y: Float32Array.from(layout.y) });
  } catch {
    // Nothing to do: the next open lays out again.
  }
}

const DB_NAME = "gumply-graph-layout";
const STORE = "layouts";

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
      const open = indexedDB.open(DB_NAME, 1);
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE);
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
      open.onblocked = () => reject(new Error("graph layout cache blocked"));
    });
    return opened;
  };
  return {
    async get(key) {
      const value = (await request((await db()).transaction(STORE, "readonly").objectStore(STORE).get(key))) as
        | { x: Float32Array; y: Float32Array; at: number }
        | undefined;
      return value ? { x: value.x, y: value.y } : undefined;
    },
    async put(key, layout) {
      const store = (await db()).transaction(STORE, "readwrite").objectStore(STORE);
      await request(store.put({ x: layout.x, y: layout.y, at: Date.now() }, key));
      // Keep only the newest few graphs.
      const keys = (await request(store.getAllKeys())) as string[];
      if (keys.length <= LAYOUT_CACHE_ENTRIES) return;
      const entries = await Promise.all(keys.map(async (k) => ({ k, at: ((await request(store.get(k))) as { at?: number } | undefined)?.at ?? 0 })));
      entries.sort((p, q) => p.at - q.at);
      for (const { k } of entries.slice(0, entries.length - LAYOUT_CACHE_ENTRIES)) store.delete(k);
    },
  };
}
