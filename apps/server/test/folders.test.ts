import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GraphData, PageMeta } from "@gumply/core";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupVaults, createPage, createTestServer, encodeId, getJson, jsonRequest } from "./helpers";

/** D33 (#mf397jyx): plain folders (no `<Folder>.md`) are tree items. */

afterEach(cleanupVaults);

async function obsidianVault() {
  const server = await createTestServer();
  const files: Record<string, string> = {
    "Work/Ideas.md": "Work ideas, see [[Home/Ideas]] and [[Work/Plan|the plan]].",
    "Work/Plan.md": "Plan body",
    "Home/Ideas.md": "Home ideas",
    "Recipes/Pancakes.md": "Pancakes",
    "Recipes/Soups/Tomato.md": "Tomato soup",
    "Projects.md": "A page with sub-pages",
    "Projects/Gumply.md": "Gumply",
    "Projects/Archive/Old.md": "Old",
    "Index.md": "Links: [[Work/Ideas]], [[Work/Plan#Steps|steps]], ![[Work/Board.canvas|300]] and [[Plan]]. `[[Work/Plan]]` in code.",
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(server.dir, path, ".."), { recursive: true });
    await writeFile(join(server.dir, path), content, "utf8");
  }
  await writeFile(join(server.dir, "Work/Board.canvas"), '{"nodes":[{"id":"t","type":"text","text":"See [[Work/Plan]]","x":0,"y":0,"width":200,"height":100}],"edges":[]}');
  await mkdir(join(server.dir, "Empty"), { recursive: true });
  await mkdir(join(server.dir, ".obsidian"), { recursive: true });
  await mkdir(join(server.dir, "attachments"), { recursive: true });
  await server.store.rescan();
  return server;
}

const byId = (list: PageMeta[]) => new Map(list.map((meta) => [meta.id, meta]));

describe("plain folders (D33)", () => {
  it("lists folders with no page of their own, and hangs their pages under them", async () => {
    const { app } = await obsidianVault();
    const list = byId(await getJson<PageMeta[]>(app, "/api/pages"));
    const folders = [...list.values()].filter((meta) => meta.kind === "folder").map((meta) => meta.id);
    // Projects is a page with sub-pages; its Archive sub-directory has no page.
    expect(folders).toEqual(["Empty", "Home", "Projects/Archive", "Recipes", "Recipes/Soups", "Work"]);
    expect(list.get("Work")).toMatchObject({ kind: "folder", title: "Work", parentId: null, childCount: 3 });
    expect(list.get("Work/Ideas")?.parentId).toBe("Work");
    expect(list.get("Home/Ideas")?.parentId).toBe("Home");
    expect(list.get("Recipes/Soups")).toMatchObject({ parentId: "Recipes", childCount: 1 });
    expect(list.get("Recipes/Soups/Tomato")?.parentId).toBe("Recipes/Soups");
    expect(list.get("Projects/Archive")?.parentId).toBe("Projects");
    expect(list.get("Projects")?.childCount).toBe(2);
    expect(list.has(".obsidian")).toBe(false);
    expect(list.has("attachments")).toBe(false);
  });

  it("folders are never link targets, graph nodes or search results, and have no page", async () => {
    const { app } = await obsidianVault();
    await createPage(app, { title: "Linker", content: "[[Work]] and [[Recipes]]" });
    const graph = await getJson<GraphData>(app, "/api/graph");
    expect(graph.nodes.some((node) => node.kind === "folder")).toBe(false);
    expect(graph.unresolved.map((link) => link.targetTitle).sort()).toEqual(["Recipes", "Work"]);
    const results = await getJson<Array<{ id: string }>>(app, "/api/search?q=Recipes");
    expect(results.some((result) => result.id === "Recipes")).toBe(false);
    expect((await app.request(`/api/pages/${encodeId("Work")}`)).status).toBe(404);
  });

  it("creates pages and boards inside a folder; a new page never takes a folder's name", async () => {
    const { app, dir } = await obsidianVault();
    const page = await createPage(app, { title: "Draft", parentId: "Work" });
    expect(page).toMatchObject({ id: "Work/Draft", parentId: "Work" });
    expect(await readFile(join(dir, "Work/Draft.md"), "utf8")).toContain("title: Draft");
    const board = await jsonRequest(app, "POST", "/api/boards", { title: "Sketch", parentId: "Recipes" });
    expect(board.status).toBe(201);
    expect(((await board.json()) as { meta: PageMeta }).meta).toMatchObject({ id: "Recipes/Sketch.canvas", parentId: "Recipes" });
    // `Work.md` would turn the folder into a page's sub-page folder.
    expect((await createPage(app, { title: "Work" })).id).toBe("Work 2");
  });

  it("renaming a folder moves the directory and rewrites path links into it", async () => {
    const { app, dir } = await obsidianVault();
    const response = await jsonRequest(app, "PUT", `/api/pages/${encodeId("Work")}`, { title: "Office" });
    expect(response.status).toBe(200);
    const result = (await response.json()) as PageMeta & { rewrittenPages?: string[] };
    expect(result).toMatchObject({ id: "Office", kind: "folder", title: "Office" });
    expect(result.rewrittenPages).toEqual(["Index", "Office/Board.canvas", "Office/Ideas"]);

    const list = byId(await getJson<PageMeta[]>(app, "/api/pages"));
    expect(list.has("Work")).toBe(false);
    expect(list.get("Office/Ideas")?.parentId).toBe("Office");
    expect(await readFile(join(dir, "Office/Plan.md"), "utf8")).toBe("Plan body");
    expect(await readFile(join(dir, "Index.md"), "utf8")).toBe(
      "Links: [[Office/Ideas]], [[Office/Plan#Steps|steps]], ![[Office/Board.canvas|300]] and [[Plan]]. `[[Work/Plan]]` in code.",
    );
    expect(await readFile(join(dir, "Office/Ideas.md"), "utf8")).toBe(
      "Work ideas, see [[Home/Ideas]] and [[Office/Plan|the plan]].",
    );
    expect(await readFile(join(dir, "Office/Board.canvas"), "utf8")).toContain("See [[Office/Plan]]");
    // Old page ids still open (D20 redirects).
    expect((await getJson<PageMeta>(app, `/api/pages/${encodeId("Work/Plan")}`)).id).toBe("Office/Plan");
  });

  it("a rename onto a taken name gets a ` 2` suffix; a body edit is refused", async () => {
    const { app } = await obsidianVault();
    const renamed = await jsonRequest(app, "PUT", `/api/pages/${encodeId("Home")}`, { title: "Work" });
    expect(((await renamed.json()) as PageMeta).id).toBe("Work 2");
    const body = await jsonRequest(app, "PUT", `/api/pages/${encodeId("Recipes")}`, { content: "x" });
    expect(body.status).toBe(400);
  });

  it("moves folders and pages between folders", async () => {
    const { app, dir } = await obsidianVault();
    const moved = await jsonRequest(app, "POST", `/api/pages/${encodeId("Recipes")}/move`, { parentId: "Home" });
    expect(moved.status).toBe(200);
    expect(((await moved.json()) as PageMeta).id).toBe("Home/Recipes");
    expect(await readFile(join(dir, "Home/Recipes/Soups/Tomato.md"), "utf8")).toBe("Tomato soup");
    const list = byId(await getJson<PageMeta[]>(app, "/api/pages"));
    expect(list.get("Home/Recipes/Soups")?.parentId).toBe("Home/Recipes");

    const into = await jsonRequest(app, "POST", `/api/pages/${encodeId("Home")}/move`, { parentId: "Home/Recipes" });
    expect(into.status).toBe(400);
    const page = await jsonRequest(app, "POST", `/api/pages/${encodeId("Index")}/move`, { parentId: "Work" });
    expect(((await page.json()) as PageMeta)).toMatchObject({ id: "Work/Index", parentId: "Work" });
    const clash = await jsonRequest(app, "POST", `/api/pages/${encodeId("Home/Ideas")}/move`, { parentId: "Work" });
    expect(clash.status).toBe(409);
  });

  it("deletes a folder to the trash as a whole and Undo restores it", async () => {
    const { app, dir } = await obsidianVault();
    const response = await jsonRequest(app, "DELETE", `/api/pages/${encodeId("Recipes")}`);
    const result = (await response.json()) as { trashId: string; deleted: string[] };
    expect(result.deleted).toEqual(["Recipes", "Recipes/Pancakes", "Recipes/Soups", "Recipes/Soups/Tomato"]);
    const meta = JSON.parse(await readFile(join(dir, ".trash", result.trashId, "meta.json"), "utf8")) as Record<string, unknown>;
    expect(meta).toMatchObject({ id: "Recipes", file: "Recipes", kind: "folder" });
    expect(byId(await getJson<PageMeta[]>(app, "/api/pages")).has("Recipes/Pancakes")).toBe(false);

    const restore = await jsonRequest(app, "POST", `/api/trash/${result.trashId}/restore`);
    expect(restore.status).toBe(200);
    const list = byId(await getJson<PageMeta[]>(app, "/api/pages"));
    expect(list.get("Recipes")?.kind).toBe("folder");
    expect(list.get("Recipes/Soups/Tomato")?.parentId).toBe("Recipes/Soups");
  });

  it("picks up folders made outside Gumply", async () => {
    const { app, dir, store } = await obsidianVault();
    await mkdir(join(dir, "Later/Inner"), { recursive: true });
    await store.rescan();
    const list = byId(await getJson<PageMeta[]>(app, "/api/pages"));
    expect(list.get("Later/Inner")).toMatchObject({ kind: "folder", parentId: "Later" });
  });
});
