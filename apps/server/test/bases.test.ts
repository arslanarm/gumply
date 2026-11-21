import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseBase, type BaseViewResult, type PageMeta } from "@gumply/core";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { VaultStore } from "../src/vault-store";
import { cleanupVaults, createTestServer, encodeId, getJson, jsonRequest } from "./helpers";

afterEach(cleanupVaults);

/** A vault with files written before the server starts. */
async function vault(files: Record<string, string> = {}) {
  const server = await createTestServer();
  for (const [path, body] of Object.entries(files)) {
    await mkdir(join(server.dir, path, ".."), { recursive: true });
    await writeFile(join(server.dir, path), body, "utf8");
  }
  const store = new VaultStore(server.dir);
  await store.init();
  return { dir: server.dir, store, app: createApp({ vaultPath: server.dir, store }) };
}

const TASKS_BASE = `# Tasks across the vault
filters:
  and:
    - file.inFolder("Projects")
views:
  - type: table
    name: Open
    filters:
      and:
        - 'status != "Done"'
    order:
      - file.name
      - status
      - due
    sort:
      - property: due
        direction: ASC
  - type: kanban
    name: Board
    groupBy:
      property: note.status
      direction: ASC
    groupOrder: [Todo, Doing, Done]
  - type: map
    name: Places
    mapSetting: { zoom: 3 }
`;

const files = {
  "Projects.md": "---\ntitle: Projects\n---\nThe folder page\n",
  "Projects/Alpha.md": "---\nstatus: Todo\ndue: 2026-12-01\nestimate: 3\n---\nAlpha links [[Beta]]\n",
  "Projects/Beta.md": "---\nstatus: Doing\ndue: 2026-11-25\n---\nBeta\n",
  "Projects/Gamma.md": "---\nstatus: Done\n---\nGamma\n",
  "Projects/Tasks.base": TASKS_BASE,
  "Elsewhere.md": "---\nstatus: Todo\n---\nNot in Projects\n",
};

describe("database views in the tree (D34, spec/api-bases)", () => {
  it("lists a .base file as kind base; its id keeps the extension", async () => {
    const { app } = await vault(files);
    const pages = await getJson<PageMeta[]>(app, "/api/pages");
    expect(pages.find((page) => page.id === "Projects/Tasks.base")).toMatchObject({
      kind: "base",
      title: "Tasks",
      parentId: "Projects",
      childCount: 0,
    });
    // Never a page document.
    expect((await app.request(`/api/pages/${encodeId("Projects/Tasks.base")}`)).status).toBe(404);
  });

  it("reads the config, keeping views Gumply doesn't render", async () => {
    const { app } = await vault(files);
    const doc = await getJson<{ meta: PageMeta; config: ReturnType<typeof parseBase> }>(
      app,
      `/api/bases/${encodeId("Projects/Tasks.base")}`,
    );
    expect(doc.config.views.map((view) => view.type)).toEqual(["table", "kanban", "map"]);
    expect(doc.config.views[2]!.mapSetting).toEqual({ zoom: 3 });
  });

  it("runs a view on the server: filters, sort and columns with values", async () => {
    const { app } = await vault(files);
    const result = await getJson<BaseViewResult>(app, `/api/bases/${encodeId("Projects/Tasks.base")}/view`);
    expect(result.view).toBe("Open");
    expect(result.rows.map((row) => row.id)).toEqual(["Projects/Beta", "Projects/Alpha"]);
    expect(result.columns.map((column) => [column.id, column.type])).toEqual([
      ["file.name", "file"],
      ["note.status", "text"],
      ["note.due", "date"],
    ]);
    expect(result.rows[1]!.values).toEqual({ "file.name": "Alpha.md", "note.status": "Todo", "note.due": "2026-12-01" });

    const board = await getJson<BaseViewResult>(app, `/api/bases/${encodeId("Projects/Tasks.base")}/view?name=Board`);
    expect(board.groups!.map((group) => [group.label, group.rows.map((i) => board.rows[i]!.title)])).toEqual([
      ["Todo", ["Alpha"]],
      ["Doing", ["Beta"]],
      ["Done", ["Gamma"]],
    ]);
  });

  it("sees frontmatter changes made outside Gumply", async () => {
    const { app, store, dir } = await vault(files);
    await writeFile(join(dir, "Projects/Gamma.md"), "---\nstatus: Todo\n---\nGamma\n", "utf8");
    await store.rescan();
    const result = await getJson<BaseViewResult>(app, `/api/bases/${encodeId("Projects/Tasks.base")}/view`);
    expect(result.rows.map((row) => row.title)).toContain("Gamma");
  });

  it("knows this: the page a base is embedded in", async () => {
    const { app } = await vault({
      ...files,
      "Links.base": "filters: 'file.hasLink(this.file)'\nviews:\n  - type: list\n    name: Linking here\n",
    });
    const result = await getJson<BaseViewResult>(app, `/api/bases/Links.base/view?this=${encodeId("Projects/Beta")}`);
    expect(result.rows.map((row) => row.title)).toEqual(["Alpha"]);
  });

  it("uses Obsidian's types.json for property types", async () => {
    const { app } = await vault({
      ...files,
      ".obsidian/types.json": JSON.stringify({ types: { due: "text", estimate: "number" } }),
    });
    const result = await getJson<BaseViewResult>(app, `/api/bases/${encodeId("Projects/Tasks.base")}/view`);
    expect(result.columns.find((column) => column.id === "note.due")!.type).toBe("text");
  });

  it("creates a base sourced from a folder or a tag, with a collision suffix", async () => {
    const { app, dir } = await vault(files);
    const response = await jsonRequest(app, "POST", "/api/bases", {
      title: "Tasks",
      parentId: "Projects",
      source: { folder: "Projects" },
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as { meta: PageMeta };
    expect(created.meta).toMatchObject({ id: "Projects/Tasks 2.base", kind: "base", title: "Tasks 2" });
    expect(await readFile(join(dir, "Projects/Tasks 2.base"), "utf8")).toBe(
      'filters:\n  and:\n    - file.inFolder("Projects")\nviews:\n  - type: table\n    name: Table\n    order:\n      - file.name\n',
    );
    const byTag = await jsonRequest(app, "POST", "/api/bases", { title: "Work", source: { tag: "#work" } });
    expect(parseBase(await readFile(join(dir, "Work.base"), "utf8")).filters).toEqual({ and: ['file.hasTag("work")'] });
    expect(byTag.status).toBe(201);
    // A page can't take a base's name, nor the other way round.
    const page = await jsonRequest(app, "POST", "/api/pages", { title: "Work" });
    expect(((await page.json()) as PageMeta).id).toBe("Work 2");
  });

  it("saves only what changed, conditionally", async () => {
    const { app, dir } = await vault(files);
    const id = encodeId("Projects/Tasks.base");
    const doc = await getJson<{ meta: PageMeta; config: ReturnType<typeof parseBase> }>(app, `/api/bases/${id}`);

    // Unchanged: the file isn't written at all.
    const same = await jsonRequest(app, "PUT", `/api/bases/${id}`, { config: doc.config, expectedUpdated: doc.meta.updated });
    expect(same.status).toBe(200);
    expect(((await same.json()) as { meta: PageMeta }).meta.updated).toBe(doc.meta.updated);

    doc.config.views[0]!.sort = [{ property: "due", direction: "DESC" }];
    const saved = await jsonRequest(app, "PUT", `/api/bases/${id}`, { config: doc.config, expectedUpdated: doc.meta.updated });
    expect(saved.status).toBe(200);
    expect(await readFile(join(dir, "Projects/Tasks.base"), "utf8")).toBe(
      TASKS_BASE.replace("direction: ASC\n  - type: kanban", "direction: DESC\n  - type: kanban"),
    );

    // A stale version is a conflict.
    const stale = await jsonRequest(app, "PUT", `/api/bases/${id}`, { config: doc.config, expectedUpdated: "2000-01-01T00:00:00.000Z" });
    expect(stale.status).toBe(409);
    const bad = await jsonRequest(app, "PUT", `/api/bases/${id}`, { config: { views: "nope" }, force: true });
    expect(bad.status).toBe(400);
  });

  it("renames the file with its title and rewrites embeds, keeping #View", async () => {
    const { app, dir } = await vault({
      ...files,
      "Home.md": "See ![[Tasks.base#Board]] and [[Tasks.base|the tasks]].\n",
    });
    const response = await jsonRequest(app, "PUT", `/api/bases/${encodeId("Projects/Tasks.base")}`, { title: "Work items", force: true });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { meta: PageMeta; rewrittenPages?: string[] };
    expect(body.meta).toMatchObject({ id: "Projects/Work items.base", title: "Work items" });
    expect(body.rewrittenPages).toEqual(["Home"]);
    expect(await readFile(join(dir, "Home.md"), "utf8")).toBe(
      "See ![[Work items.base#Board]] and [[Work items.base|the tasks]].\n",
    );
    expect(await readFile(join(dir, "Projects/Work items.base"), "utf8")).toBe(TASKS_BASE);
  });

  it("goes to the trash and comes back like any item", async () => {
    const { app, dir } = await vault(files);
    const removed = await jsonRequest(app, "DELETE", `/api/pages/${encodeId("Projects/Tasks.base")}`);
    expect(removed.status).toBe(200);
    const { trashId } = (await removed.json()) as { trashId: string };
    expect(await readdir(join(dir, "Projects"))).not.toContain("Tasks.base");
    const restored = await jsonRequest(app, "POST", `/api/trash/${trashId}/restore`);
    expect(restored.status).toBe(200);
    expect(await readFile(join(dir, "Projects/Tasks.base"), "utf8")).toBe(TASKS_BASE);
  });

  it("can't hold sub-pages", async () => {
    const { app } = await vault(files);
    const response = await jsonRequest(app, "POST", "/api/pages", { title: "Child", parentId: "Projects/Tasks.base" });
    expect(response.status).toBe(400);
  });

  it("shows a base whose YAML is broken, and never writes it", async () => {
    const { app, dir } = await vault({ "Broken.base": "views: [\n" });
    const doc = await getJson<{ config: unknown; error?: string }>(app, "/api/bases/Broken.base");
    expect(doc.error).toBeTruthy();
    const response = await jsonRequest(app, "PUT", "/api/bases/Broken.base", { config: { views: [] }, force: true });
    expect(response.status).toBe(400);
    expect(await readFile(join(dir, "Broken.base"), "utf8")).toBe("views: [\n");
  });
});
