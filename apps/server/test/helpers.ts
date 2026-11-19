import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { createApp } from "../src/app";
import { VaultStore } from "../src/vault-store";

const createdDirs: string[] = [];

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
  return { app: createApp({ vaultPath: dir, store }), store, dir };
}

export async function cleanupVaults(): Promise<void> {
  await Promise.all(createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
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
