import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prune, saveVersion } from "../src/history";
import { writeAtomic } from "../src/temp-files";
import { cleanupVaults, createTestServer, getJson, jsonRequest } from "./helpers";

/**
 * #e9hs2zgq: when the final rename of an atomic write fails (EACCES, EXDEV…),
 * the hidden temp is removed at once, not left for the day-old sweep, the
 * target keeps its old bytes, and the save reports the error.
 */

const failing = vi.hoisted(() => ({ code: null as string | null }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const rename: typeof actual.rename = async (from, to) => {
    if (failing.code) throw Object.assign(new Error(`${failing.code}: rename failed (test)`), { code: failing.code });
    return actual.rename(from, to);
  };
  return { ...actual, rename, default: { ...actual, rename } };
});

beforeEach(() => {
  failing.code = null;
});
afterEach(async () => {
  failing.code = null;
  await cleanupVaults();
});

async function tempsIn(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (at: string) => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".tmp")) out.push(relative(dir, path).split(sep).join("/"));
    }
  };
  await walk(dir);
  return out;
}

describe("a failed rename leaves no temp and reports the error (#e9hs2zgq)", () => {
  for (const code of ["EACCES", "EXDEV"]) {
    it(`writeAtomic (${code})`, async () => {
      const { dir } = await createTestServer();
      await writeFile(join(dir, "x.json"), "old\n", "utf8");
      failing.code = code;
      await expect(writeAtomic(join(dir, "x.json"), "new\n")).rejects.toMatchObject({ code });
      failing.code = null;
      expect(await tempsIn(dir)).toEqual([]);
      expect(await readFile(join(dir, "x.json"), "utf8")).toBe("old\n");
    });
  }

  it("a page save (the safe writer)", async () => {
    const { store, dir } = await createTestServer();
    await writeFile(join(dir, "Note.md"), "Old text.\n", "utf8");
    await store.rescan();
    failing.code = "EACCES";
    await expect(store.update("Note", { content: "New text.\n", expectedUpdated: store.get("Note").updated })).rejects.toMatchObject({ code: "EACCES" });
    failing.code = null;
    expect(await tempsIn(dir)).toEqual([]);
    expect(await readFile(join(dir, "Note.md"), "utf8")).toBe("Old text.\n");
  });

  it("a board save", async () => {
    const { store, dir } = await createTestServer();
    const before = '{"nodes":[],"edges":[]}\n';
    await writeFile(join(dir, "Map.canvas"), before, "utf8");
    await store.rescan();
    const loaded = store.getBoard("Map.canvas");
    failing.code = "EXDEV";
    await expect(
      store.updateBoard("Map.canvas", {
        board: { ...loaded.board, nodes: [{ id: "a", type: "text", text: "Hi", x: 0, y: 0, width: 100, height: 40 }] } as never,
        expectedUpdated: loaded.meta.updated,
      }),
    ).rejects.toMatchObject({ code: "EXDEV" });
    failing.code = null;
    expect(await tempsIn(dir)).toEqual([]);
    expect(await readFile(join(dir, "Map.canvas"), "utf8")).toBe(before);
  });

  it("a base save", async () => {
    const { app, dir } = await createTestServer();
    const created = (await (await jsonRequest(app, "POST", "/api/bases", { title: "Tasks", source: { folder: "" } })).json()) as { meta: { id: string } };
    const id = encodeURIComponent(created.meta.id);
    const before = await readFile(join(dir, "Tasks.base"), "utf8");
    const doc = await getJson<{ config: { views: Array<Record<string, unknown>> }; meta: { updated: string } }>(app, `/api/bases/${id}`);
    doc.config.views[0]!.sort = [{ property: "file.name", direction: "DESC" }];
    failing.code = "EACCES";
    const response = await jsonRequest(app, "PUT", `/api/bases/${id}`, { config: doc.config, expectedUpdated: doc.meta.updated });
    failing.code = null;
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await tempsIn(dir)).toEqual([]);
    expect(await readFile(join(dir, "Tasks.base"), "utf8")).toBe(before);
  });

  it("the version-history index (prune rewrites it)", async () => {
    const { dir } = await createTestServer();
    const day = 86_400_000;
    const start = Date.UTC(2026, 0, 1);
    for (let n = 0; n < 3; n += 1) {
      await saveVersion(dir, { id: "Note", ext: "md", bytes: Buffer.from(`v${n}`), version: `v${n}`, now: new Date(start + n * 1000) });
    }
    const historyDir = join(dir, ".gumply/history/Note");
    const before = await readFile(join(historyDir, "index.jsonl"), "utf8");
    failing.code = "EACCES";
    // 200 days later the older versions go, so the index is rewritten.
    await expect(prune(historyDir, start + 200 * day)).rejects.toMatchObject({ code: "EACCES" });
    failing.code = null;
    expect(await tempsIn(dir)).toEqual([]);
    expect(await readFile(join(historyDir, "index.jsonl"), "utf8")).toBe(before);
  });

  it("the settings writers (graph and AI-app settings)", async () => {
    const { app, dir } = await createTestServer();
    failing.code = "EACCES";
    expect((await jsonRequest(app, "PUT", "/api/graph/settings", { groups: [{ query: "a", color: "#00aa55" }] })).status).toBeGreaterThanOrEqual(400);
    expect((await jsonRequest(app, "PUT", "/api/mcp/settings", { access: "append" })).status).toBeGreaterThanOrEqual(400);
    failing.code = null;
    expect(await tempsIn(dir)).toEqual([]);
  });
});
