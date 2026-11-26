import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TrashItem } from "@gumply/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { VaultStore } from "../src/vault-store";
import { cleanupVaults, createTestServer, encodeId, getJson, jsonRequest } from "./helpers";

/**
 * #7prbquxu phase 4a (@opus-hunter's notes a and c, @lead): a database deleted with its rows is one Trash item.
 * Its manifests are only ever replaced whole (temp + rename), the item says how many rows it holds, and
 * Empty Trash counts the items the list shows, not the entries on disk.
 */

const written = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const writeFile: typeof actual.writeFile = async (file, ...rest) => {
    if (typeof file === "string") written.paths.push(file);
    return actual.writeFile(file, ...rest);
  };
  return { ...actual, writeFile, default: { ...actual, writeFile } };
});

afterEach(cleanupVaults);

const BASE = 'gumply:\n  rows: People\nfilters:\n  and:\n    - file.folder == "People"\nviews:\n  - type: table\n    name: Table\n';

async function vault(files: Record<string, string>) {
  const server = await createTestServer();
  for (const [path, body] of Object.entries(files)) {
    await mkdir(join(server.dir, path, ".."), { recursive: true });
    await writeFile(join(server.dir, path), body, "utf8");
  }
  const store = new VaultStore(server.dir);
  await store.init();
  return { dir: server.dir, store, app: createApp({ vaultPath: server.dir, store }) };
}

describe("a database in the Trash with its rows (#7prbquxu phase 4a)", () => {
  it("writes every Trash manifest through a temp file and a rename, never in place (note a)", async () => {
    const { app } = await vault({ "People.base": BASE, "People/Ann.md": "Ann\n", "People/Bo.md": "Bo\n" });
    written.paths.length = 0;
    expect((await jsonRequest(app, "DELETE", `/api/pages/${encodeId("People.base")}?withRows=1`)).status).toBe(200);
    expect(written.paths.filter((path) => path.endsWith("meta.json"))).toEqual([]);
    expect(written.paths.filter((path) => path.endsWith(".tmp")).length).toBeGreaterThanOrEqual(2);
  });

  it("the database's item counts its rows and other files, and Empty Trash counts listed items (note c)", async () => {
    const { app } = await vault({ "People.base": BASE, "People/Ann.md": "Ann\n", "People/Bo.md": "Bo\n", "People/photo.png": "png" });
    await jsonRequest(app, "DELETE", `/api/pages/${encodeId("People.base")}?withRows=1`);
    const items = await getJson<TrashItem[]>(app, "/api/trash");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "People.base", rows: 2, otherFiles: 1 });
    expect(await (await jsonRequest(app, "DELETE", "/api/trash")).json()).toEqual({ deleted: 1 });
  });
});
