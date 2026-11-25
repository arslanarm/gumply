import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { createApp } from "../src/app";
import { VaultStore } from "../src/vault-store";

const createdDirs: string[] = [];
const createdStores: VaultStore[] = [];

/**
 * #inrd797i: `rm` options for a test vault. A store's queued work (a watcher refresh and the history
 * version it writes for an outside edit) can still be writing when a test ends; `rm` then fails with
 * ENOTEMPTY. Draining the store first (`cleanupVaults`) closes that; the retries are a backstop for
 * tests that make their own stores.
 */
export const RM_VAULT = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 } as const;

export interface TestServer {
  app: Hono;
  store: VaultStore;
  dir: string;
}

/** Fresh temp vault + app per test. Call `cleanupVaults()` in afterEach. */
export async function createTestServer(): Promise<TestServer> {
  const dir = await mkdtemp(join(tmpdir(), "gumply-test-"));
  createdDirs.push(dir);
  const store = new VaultStore(dir);
  await store.init();
  createdStores.push(store);
  return { app: createApp({ vaultPath: dir, store }), store, dir };
}

/** #inrd797i: a store a test builds itself; `cleanupVaults` (or `drainStores`) stops and drains it. */
export function trackStore<T extends VaultStore>(store: T): T {
  createdStores.push(store);
  return store;
}

/**
 * #inrd797i: stop each tracked store's watcher and wait for its queue to empty. Any queued call waits
 * for everything queued before it; listTrash only reads. Call before removing a vault's folder.
 */
export async function drainStores(): Promise<void> {
  for (const store of createdStores.splice(0)) {
    store.stopWatching();
    await store.listTrash().catch(() => undefined);
  }
}

export async function cleanupVaults(): Promise<void> {
  await drainStores();
  await Promise.all(createdDirs.splice(0).map((dir) => rm(dir, RM_VAULT)));
}

export function jsonRequest(
  app: Hono,
  method: "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

export async function createPage(
  app: Hono,
  input: { title: string; parentId?: string | null; content?: string; icon?: string },
): Promise<Record<string, unknown>> {
  const response = await jsonRequest(app, "POST", "/api/pages", input);
  if (response.status !== 201) {
    throw new Error(`create failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

export async function getJson<T>(app: Hono, path: string): Promise<T> {
  const response = await app.request(path);
  if (!response.ok) throw new Error(`GET ${path} failed: ${response.status}`);
  return (await response.json()) as T;
}

export function encodeId(id: string): string {
  return encodeURIComponent(id);
}
