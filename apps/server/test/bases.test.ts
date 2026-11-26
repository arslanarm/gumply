import { existsSync } from "node:fs";
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

  it("picks up a base edited outside Gumply (Obsidian) on the next rescan", async () => {
    const { app, store, dir } = await vault(files);
    const before = await getJson<{ meta: PageMeta }>(app, `/api/bases/${encodeId("Projects/Tasks.base")}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(join(dir, "Projects/Tasks.base"), TASKS_BASE.replace("name: Open", "name: Still open"), "utf8");
    await store.rescan();
    const after = await getJson<{ meta: PageMeta; config: ReturnType<typeof parseBase> }>(app, `/api/bases/${encodeId("Projects/Tasks.base")}`);
    expect(after.config.views[0]!.name).toBe("Still open");
    expect(after.meta.updated > before.meta.updated).toBe(true);
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

  it("creates a database that owns its rows folder (#7prbquxu): People.base next to an empty People/", async () => {
    const { app, dir } = await vault({ ...files, "Team/People.md": "A page already named People\n" });
    const response = await jsonRequest(app, "POST", "/api/bases", { title: "People", parentId: "Projects", rows: true, source: { folder: "Elsewhere" } });
    expect(response.status).toBe(201);
    const created = (await response.json()) as { meta: PageMeta };
    expect(created.meta).toMatchObject({ id: "Projects/People.base", kind: "base", title: "People" });
    // The marker and the folder's own pages; `source` is ignored.
    expect(await readFile(join(dir, "Projects/People.base"), "utf8")).toBe(
      'gumply:\n  rows: Projects/People\nfilters:\n  and:\n    - file.folder == "Projects/People"\nviews:\n  - type: table\n    name: Table\n    order:\n      - file.name\n',
    );
    expect(await readdir(join(dir, "Projects/People"))).toEqual([]);
    // The empty folder is in the tree right away, under the base's parent.
    const listed = await getJson<PageMeta[]>(app, "/api/pages");
    expect(listed.find((meta) => meta.id === "Projects/People")).toMatchObject({ kind: "folder", parentId: "Projects" });

    // A name taken as a page (with its sub-page folder) or as a folder: both get the next free name.
    const second = (await (await jsonRequest(app, "POST", "/api/bases", { title: "People", parentId: "Projects", rows: true })).json()) as { meta: PageMeta };
    expect(second.meta.id).toBe("Projects/People 2.base");
    await mkdir(join(dir, "Team/People"), { recursive: true });
    const third = (await (await jsonRequest(app, "POST", "/api/bases", { title: "People", parentId: "Team", rows: true })).json()) as { meta: PageMeta };
    expect(third.meta.id).toBe("Team/People 2.base");
    expect(parseBase(await readFile(join(dir, "Team/People 2.base"), "utf8")).filters).toEqual({ and: ['file.folder == "Team/People 2"'] });

    // A new row made in the folder is in the table.
    await jsonRequest(app, "POST", "/api/pages", { title: "Ada", parentId: "Projects/People" });
    const view = await getJson<BaseViewResult>(app, `/api/bases/${encodeId("Projects/People.base")}/view`);
    expect(view.rows.map((row) => row.title)).toEqual(["Ada"]);
  });

  it("names the first view as the request says (the interface language), one trimmed line, else \"Table\" (#7prbquxu, @polish-dev)", async () => {
    const { app, dir } = await vault();
    await jsonRequest(app, "POST", "/api/bases", { title: "Люди", rows: true, viewName: "Таблица" });
    expect(await readFile(join(dir, "Люди.base"), "utf8")).toContain("    name: Таблица\n");
    await jsonRequest(app, "POST", "/api/bases", { title: "Plain", viewName: "  Two\nlines  " });
    expect(await readFile(join(dir, "Plain.base"), "utf8")).toContain("    name: Two lines\n");
    await jsonRequest(app, "POST", "/api/bases", { title: "Old client" });
    expect(await readFile(join(dir, "Old client.base"), "utf8")).toContain("    name: Table\n");
  });

  it("lists which database owns which rows folder, and whether it shows its rows (#7prbquxu phase 4)", async () => {
    const base = 'gumply:\n  rows: People\nfilters:\n  and:\n    - file.folder == "People"\nviews:\n  - type: table\n    name: Table\n';
    const { app, dir } = await vault({ "People.base": base, "People/Ann.md": "Ann\n", "Plain.base": "views:\n  - type: table\n    name: Table\n", "Other/Note.md": "Note\n" });
    let listed = await getJson<PageMeta[]>(app, "/api/pages");
    expect(listed.find((meta) => meta.id === "People.base")).toMatchObject({ rowsFolder: "People" });
    expect(listed.find((meta) => meta.id === "People.base")).not.toHaveProperty("showRows");
    expect(listed.find((meta) => meta.id === "People")).toMatchObject({ kind: "folder", ownedBy: "People.base" });
    expect(listed.find((meta) => meta.id === "Plain.base")).not.toHaveProperty("rowsFolder");
    expect(listed.find((meta) => meta.id === "Other")).not.toHaveProperty("ownedBy");
    // The marker's showRows is listed (written by "Show rows in the sidebar").
    await writeFile(join(dir, "People.base"), base.replace("  rows: People\n", "  rows: People\n  showRows: true\n"), "utf8");
    const store = new VaultStore(dir);
    await store.init();
    listed = store.list();
    expect(listed.find((meta) => meta.id === "People.base")).toMatchObject({ rowsFolder: "People", showRows: true });
  });

  it("deletes a database with its rows as one Trash item, and restores both together, at a name free for both (#7prbquxu phase 4)", async () => {
    const base = 'gumply:\n  rows: People\nfilters:\n  and:\n    - file.folder == "People"\nviews:\n  - type: table\n    name: Table\n';
    const { app, dir, store } = await vault({ "People.base": base, "People/Ann.md": "---\nrole: Cook\n---\nAnn\n", "People/Bo.md": "Bo\n" });
    const deleted = await jsonRequest(app, "DELETE", `/api/pages/${encodeId("People.base")}?withRows=1`);
    expect(deleted.status).toBe(200);
    const { deleted: ids, trashId } = (await deleted.json()) as { deleted: string[]; trashId: string };
    expect(ids.sort()).toEqual(["People", "People.base", "People/Ann", "People/Bo"]);
    expect(existsSync(join(dir, "People.base"))).toBe(false);
    expect(existsSync(join(dir, "People"))).toBe(false);
    // One Trash item: the database (its rows go with it).
    const items = await getJson<Array<{ trashId: string; title: string }>>(app, "/api/trash");
    expect(items.map((item) => item.trashId)).toEqual([trashId]);

    // A new "People" folder took the name meanwhile: both come back as "People 2", the base owning "People 2".
    await mkdir(join(dir, "People"), { recursive: true });
    await store.rescan();
    const restored = await jsonRequest(app, "POST", `/api/trash/${trashId}/restore`, {});
    expect(restored.status).toBe(200);
    expect(await readFile(join(dir, "People 2/Ann.md"), "utf8")).toBe("---\nrole: Cook\n---\nAnn\n");
    expect(await readFile(join(dir, "People 2.base"), "utf8")).toBe(base.replaceAll("People", "People 2"));
    const listed = await getJson<PageMeta[]>(app, "/api/pages");
    expect(listed.find((meta) => meta.id === "People 2.base")).toMatchObject({ rowsFolder: "People 2" });
    expect(await getJson<unknown[]>(app, "/api/trash")).toEqual([]);

    // Without withRows, only the base goes; the folder stays as a plain folder.
    await jsonRequest(app, "DELETE", `/api/pages/${encodeId("People 2.base")}`);
    expect(existsSync(join(dir, "People 2/Ann.md"))).toBe(true);
  });

  it("undoes a property delete byte for byte (rows and base), redoes it, and refuses as a whole when a row changed since (#7prbquxu phase 4b)", async () => {
    const base = 'gumply:\n  rows: People\nfilters:\n  and:\n    - file.folder == "People"\nviews:\n  - type: table\n    name: Table\n    order:\n      - file.name\n      - role\n';
    const ann = "---\nrole: Cook # head cook\nage: 30\n---\nAnn\n";
    const bo = "---\nrole: Pilot\n---\nBo\n";
    const { dir, store } = await vault({ "People.base": base, "People/Ann.md": ann, "People/Bo.md": bo });
    const read = (path: string) => readFile(join(dir, path), "utf8");
    // An edit just before (the History session would have coalesced it): the "database" reason keeps the bytes anyway.
    await store.update("People/Bo", { content: "Bo, edited\n", expectedUpdated: store.get("People/Bo").updated });
    const boBefore = await read("People/Bo.md");
    const done = await store.changeOwnedRowsProperty("People.base", { remove: "role" });
    expect(done.files.map((file) => file.id).sort()).toEqual(["People.base", "People/Ann", "People/Bo"]);

    const undo = await store.undoDatabaseChange("People.base", { files: done.files.map((file) => ({ id: file.id, from: file.after, to: file.before })) });
    expect(undo.refused).toEqual([]);
    expect(await read("People/Ann.md")).toBe(ann);
    expect(await read("People/Bo.md")).toBe(boBefore);
    expect(await read("People.base")).toBe(base);

    // Redo: the inverse from the undo's answer.
    const redo = await store.undoDatabaseChange("People.base", { files: undo.files.map((file) => ({ id: file.id, from: file.after, to: file.before })) });
    expect(redo.refused).toEqual([]);
    expect(await read("People/Ann.md")).not.toContain("role");
    expect(await read("People.base")).not.toContain("role");

    // A row edited since: the whole undo refuses, names it, and writes nothing.
    await store.update("People/Ann", { content: "Ann, edited\n", expectedUpdated: store.get("People/Ann").updated });
    const annNow = await read("People/Ann.md");
    const refused = await store.undoDatabaseChange("People.base", { files: redo.files.map((file) => ({ id: file.id, from: file.after, to: file.before })) });
    expect(refused.refused.map((row) => row.title)).toEqual(["Ann"]);
    expect(await read("People/Ann.md")).toBe(annNow);
    expect(await read("People.base")).not.toContain("role");
  });

  it("undoes a paste (new rows dropped, set rows back) and redoes it (the rows made again) (#7prbquxu phase 4b)", async () => {
    const base = 'gumply:\n  rows: People\nfilters:\n  and:\n    - file.folder == "People"\nviews:\n  - type: table\n    name: Table\n';
    const ann = "---\nrole: Cook\n---\nAnn\n";
    const { dir, store } = await vault({ "People.base": base, "People/Ann.md": ann });
    const pasted = await store.pasteIntoOwnedRows("People.base", {
      rows: [
        { id: "People/Ann", expectedUpdated: store.get("People/Ann").updated, set: { role: "Chef" } },
        { title: "Bo", set: { role: "Pilot" } },
      ],
    });
    const undo = await store.undoDatabaseChange("People.base", {
      files: pasted.files.map((file) => ({ id: file.id, from: file.after, to: file.before })),
      drop: pasted.made.map((row) => ({ id: row.id, from: row.after })),
    });
    expect(undo.refused).toEqual([]);
    expect(await readFile(join(dir, "People/Ann.md"), "utf8")).toBe(ann);
    expect(existsSync(join(dir, "People/Bo.md"))).toBe(false);
    const redo = await store.undoDatabaseChange("People.base", {
      files: undo.files.map((file) => ({ id: file.id, from: file.after, to: file.before })),
      create: undo.dropped.map((row) => ({ id: row.id, trashId: row.trashId })),
    });
    expect(redo.refused).toEqual([]);
    expect(await readFile(join(dir, "People/Bo.md"), "utf8")).toContain("role: Pilot");
    expect(await readFile(join(dir, "People/Ann.md"), "utf8")).toContain("role: Chef");
  });

  it("renaming a database that owns its rows folder takes the folder along (#7prbquxu)", async () => {
    const { app, dir, store } = await vault({ "Elsewhere/People.md": "Not in the way\n", "Ref.md": "See [[Untitled database/Ada]].\n" });
    await jsonRequest(app, "POST", "/api/bases", { title: "Untitled database", rows: true });
    await jsonRequest(app, "POST", "/api/pages", { title: "Ada", parentId: "Untitled database" });
    const before = store.getBase("Untitled database.base");

    const renamed = await jsonRequest(app, "PUT", `/api/bases/${encodeId("Untitled database.base")}`, { title: "People", expectedUpdated: before.meta.updated });
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as { meta: PageMeta }).meta.id).toBe("People.base");
    // Only the marker and the filter lines changed.
    expect(await readFile(join(dir, "People.base"), "utf8")).toBe(
      'gumply:\n  rows: People\nfilters:\n  and:\n    - file.folder == "People"\nviews:\n  - type: table\n    name: Table\n    order:\n      - file.name\n',
    );
    expect(await readdir(join(dir, "People"))).toEqual(["Ada.md"]);
    expect(await readdir(dir)).not.toContain("Untitled database");
    const view = await getJson<BaseViewResult>(app, `/api/bases/${encodeId("People.base")}/view`);
    expect(view.rows.map((row) => row.id)).toEqual(["People/Ada"]);
    // A path link into the folder follows it.
    expect(await readFile(join(dir, "Ref.md"), "utf8")).toBe("See [[People/Ada]].\n");

    // A name whose folder is taken (a folder "Team/" exists): both get the next free name.
    await mkdir(join(dir, "Team"), { recursive: true });
    await store.rescan();
    const again = store.getBase("People.base");
    const second = await jsonRequest(app, "PUT", `/api/bases/${encodeId("People.base")}`, { title: "Team", expectedUpdated: again.meta.updated });
    expect(((await second.json()) as { meta: PageMeta }).meta.id).toBe("Team 2.base");
    expect(await readdir(join(dir, "Team 2"))).toEqual(["Ada.md"]);
    expect(parseBase(await readFile(join(dir, "Team 2.base"), "utf8")).filters).toEqual({ and: ['file.folder == "Team 2"'] });
  });

  it("renames or deletes a property in every row of an owned database, all or nothing (#7prbquxu, @opus-hunter's review)", async () => {
    const { app, dir } = await vault({
      "People.base": 'gumply:\n  rows: People\nfilters:\n  and:\n    - file.folder == "People"\nviews:\n  - type: table\n    name: Table\n    limit: 1\n    order:\n      - file.name\n      - role\n',
      "People/Ann.md": "---\nrole: Cook\n---\nAnn\n",
      "People/Bo.md": "---\nrole: Pilot\n---\nBo\n",
      "People/Cy.md": "---\nrole:\nage: 7\n---\nCy\n",
      "People/Deep/Dee.md": "---\nrole: Not a row\n---\nIn a sub-folder\n",
      "Elsewhere.md": "---\nrole: Not a row\n---\nOutside\n",
    });
    const url = `/api/bases/${encodeId("People.base")}/rows-property`;
    const read = (path: string) => readFile(join(dir, path), "utf8");

    // Every row with the key (also an empty value; also rows the view's limit hides); not deeper, not outside.
    const renamed = (await (await jsonRequest(app, "POST", url, { rename: { from: "role", to: "job" } })).json()) as { changed: string[] };
    expect(renamed.changed.sort()).toEqual(["People/Ann", "People/Bo", "People/Cy"]);
    expect(await read("People/Bo.md")).toBe("---\njob: Pilot\n---\nBo\n");
    expect(await read("People/Cy.md")).toBe("---\njob:\nage: 7\n---\nCy\n");
    expect(await read("People/Deep/Dee.md")).toBe("---\nrole: Not a row\n---\nIn a sub-folder\n");
    expect(await read("Elsewhere.md")).toBe("---\nrole: Not a row\n---\nOutside\n");
    // The same request renamed the column in the base, only that line (@lead: one request changes both).
    expect(await read("People.base")).toBe(
      'gumply:\n  rows: People\nfilters:\n  and:\n    - file.folder == "People"\nviews:\n  - type: table\n    name: Table\n    limit: 1\n    order:\n      - file.name\n      - job\n',
    );

    // A name a row already has: nothing written.
    const clash = (await (await jsonRequest(app, "POST", url, { rename: { from: "job", to: "age" } })).json()) as { changed: string[]; clash: Array<{ title: string }> };
    expect(clash.changed).toEqual([]);
    expect(clash.clash.map((row) => row.title)).toEqual(["Cy"]);
    expect(await read("People/Ann.md")).toBe("---\njob: Cook\n---\nAnn\n");

    // Delete: every row loses the key.
    const removed = (await (await jsonRequest(app, "POST", url, { remove: "job" })).json()) as { changed: string[]; skipped: unknown[] };
    expect(removed.skipped).toEqual([]);
    expect(await read("People/Ann.md")).not.toContain("job");
    expect(await read("People/Ann.md")).toContain("Ann\n");
    expect(await read("People/Cy.md")).toBe("---\nage: 7\n---\nCy\n");
    expect(await read("People.base")).not.toContain("job");

    // Not an owned database: refused.
    await writeFile(join(dir, "Plain.base"), "views:\n  - type: table\n    name: Table\n", "utf8");
    const store = new VaultStore(dir);
    await store.init();
    await expect(store.changeOwnedRowsProperty("Plain.base", { remove: "age" })).rejects.toThrow("doesn't own");
  });

  it("any error on a row puts the renamed rows back, and the base stays as it was (#7prbquxu, @lead)", async () => {
    const base = 'gumply:\n  rows: People\nfilters:\n  and:\n    - file.folder == "People"\nviews:\n  - type: table\n    name: Table\n    order:\n      - file.name\n      - role\n';
    const { dir, store } = await vault({ "People.base": base, "People/Ann.md": "---\nrole: Cook\n---\nAnn\n", "People/Bo.md": "---\nrole: Pilot\n---\nBo\n" });
    const internals = store as unknown as { updateNow: (id: string, patch: unknown) => Promise<unknown> };
    const updateNow = internals.updateNow.bind(store);
    internals.updateNow = async (id, patch) => {
      if (id === "People/Bo") throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
      return updateNow(id, patch);
    };
    const result = await store.changeOwnedRowsProperty("People.base", { rename: { from: "role", to: "job" } });
    expect(result.changed).toEqual([]);
    expect(result.skipped.map((row) => row.title)).toEqual(["Bo"]);
    expect(result.stuck).toEqual([]);
    expect(await readFile(join(dir, "People/Ann.md"), "utf8")).toBe("---\nrole: Cook\n---\nAnn\n");
    expect(await readFile(join(dir, "People.base"), "utf8")).toBe(base);
  });

  it("a base changed since the caller read it refuses before any row is written (#7prbquxu)", async () => {
    const { dir, store } = await vault({
      "People.base": 'gumply:\n  rows: People\nfilters:\n  and:\n    - file.folder == "People"\nviews:\n  - type: table\n    name: Table\n',
      "People/Ann.md": "---\nrole: Cook\n---\nAnn\n",
    });
    await expect(store.changeOwnedRowsProperty("People.base", { rename: { from: "role", to: "job" } }, { expectedUpdated: "2000-01-01T00:00:00.000Z" })).rejects.toThrow("changed on disk");
    expect(await readFile(join(dir, "People/Ann.md"), "utf8")).toBe("---\nrole: Cook\n---\nAnn\n");
  });

  it("a paste sets existing rows and makes new ones in one request (#7prbquxu phase 2)", async () => {
    const { app, dir } = await vault({
      "People.base": 'gumply:\n  rows: People\nfilters:\n  and:\n    - file.folder == "People"\nviews:\n  - type: table\n    name: Table\n',
      "People/Ann.md": "---\nrole: Cook\n---\nAnn\n",
      "Elsewhere.md": "Not a row\n",
    });
    const url = `/api/bases/${encodeId("People.base")}/rows-paste`;
    const seen = (await getJson<{ updated: string }>(app, `/api/pages/${encodeId("People/Ann")}`)).updated;
    // An existing row without the version it was read at: refused (no blind overwrite through the API).
    expect((await jsonRequest(app, "POST", url, { rows: [{ id: "People/Ann", set: { role: "Chef" } }] })).status).toBe(400);
    const response = await jsonRequest(app, "POST", url, {
      rows: [
        { id: "People/Ann", expectedUpdated: seen, set: { role: "Chef", age: 30 } },
        { title: "Bo", set: { role: "Pilot", age: 41 } },
      ],
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as { changed: string[]; created: string[]; refused: unknown[] };
    expect(result).toMatchObject({ changed: ["People/Ann"], created: ["People/Bo"], refused: [] });
    expect(await readFile(join(dir, "People/Ann.md"), "utf8")).toContain("role: Chef\n");
    expect(await readFile(join(dir, "People/Ann.md"), "utf8")).toContain("age: 30\n");
    expect(await readFile(join(dir, "People/Bo.md"), "utf8")).toContain("role: Pilot\n");
    // Only rows of this database.
    expect((await jsonRequest(app, "POST", url, { rows: [{ id: "Elsewhere", expectedUpdated: seen, set: { role: "x" } }] })).status).toBe(400);
    expect((await jsonRequest(app, "POST", url, { rows: [{ title: "", set: {} }] })).status).toBe(400);
  });

  it("a paste's new columns join the view's order in the same request (#7prbquxu phase 2, step 3)", async () => {
    const base = 'gumply:\n  rows: People\nfilters:\n  and:\n    - file.folder == "People"\nviews:\n  - type: table\n    name: Table\n    order:\n      - file.name\n      - role\n';
    // The rows folder exists (one row in it): the base owns it.
    const { dir, store } = await vault({ "People.base": base, "People/Zed.md": "Zed\n" });
    const result = await store.pasteIntoOwnedRows("People.base", {
      rows: [
        { title: "Ann", set: { role: "Cook", age: 30 } },
        { title: "Bo", set: { role: "Pilot", age: 41 } },
      ],
      columns: { view: "Table", keys: ["role", "age"] },
    });
    expect(result.created.sort()).toEqual(["People/Ann", "People/Bo"]);
    // "role" was shown already; only "age" is added, in only that line.
    expect(await readFile(join(dir, "People.base"), "utf8")).toBe(base + "      - age\n");
  });

  it("a paste checks its columns and its rows before any write: a missing view or a row given twice is a 400 and nothing changes (#7prbquxu phase 2, @opus-hunter)", async () => {
    const base = 'gumply:\n  rows: People\nfilters:\n  and:\n    - file.folder == "People"\nviews:\n  - type: table\n    name: Table\n';
    const ann = "---\nrole: Cook\n---\nAnn\n";
    const { dir, store } = await vault({ "People.base": base, "People/Ann.md": ann });
    const seen = store.get("People/Ann").updated;
    // The view was renamed elsewhere while the preview was open.
    await expect(
      store.pasteIntoOwnedRows("People.base", {
        rows: [
          { id: "People/Ann", expectedUpdated: seen, set: { role: "Chef" } },
          { title: "Bo", set: { role: "Pilot" } },
        ],
        columns: { view: "Gone", keys: ["role"] },
      }),
    ).rejects.toThrow("no view named Gone");
    await expect(
      store.pasteIntoOwnedRows("People.base", {
        rows: [
          { id: "People/Ann", expectedUpdated: seen, set: { role: "Chef" } },
          { id: "People/Ann", expectedUpdated: seen, set: { role: "Baker" } },
        ],
      }),
    ).rejects.toThrow("People/Ann");
    expect(await readFile(join(dir, "People/Ann.md"), "utf8")).toBe(ann);
    expect((await readdir(join(dir, "People"))).sort()).toEqual(["Ann.md"]);
    expect(await readFile(join(dir, "People.base"), "utf8")).toBe(base);
  });

  it("a paste refuses a row another app changed at the same size and time, also after a rescan read it (#7prbquxu phase 2, #vqm6gqpu)", async () => {
    const { dir, store } = await vault({
      "People.base": 'gumply:\n  rows: People\nfilters:\n  and:\n    - file.folder == "People"\nviews:\n  - type: table\n    name: Table\n',
      "People/Ann.md": "---\nrole: Cook\n---\nAnn\n",
    });
    const { stat, utimes } = await import("node:fs/promises");
    const ann = join(dir, "People/Ann.md");
    // The table read Ann at this version; then another app changes only a property, same size, time put back.
    const seen = store.get("People/Ann").updated;
    const before = await stat(ann);
    await writeFile(ann, "---\nrole: Chef\n---\nAnn\n", "utf8");
    await utimes(ann, before.atime, before.mtime);
    await store.rescan();
    // The paste sends what the table saw: the row must refuse, and the other app's value stays.
    const result = await store.pasteIntoOwnedRows("People.base", { rows: [{ id: "People/Ann", set: { role: "Baker" }, expectedUpdated: seen }] });
    expect(result.refused.map((row) => row.title)).toEqual(["Ann"]);
    expect(await readFile(ann, "utf8")).toBe("---\nrole: Chef\n---\nAnn\n");
  });

  it("a paste that a row refuses puts the set rows back and leaves no new rows (#7prbquxu phase 2, @lead)", async () => {
    const { dir, store } = await vault({
      "People.base": 'gumply:\n  rows: People\nfilters:\n  and:\n    - file.folder == "People"\nviews:\n  - type: table\n    name: Table\n',
      "People/Ann.md": "---\nrole: Cook # head cook\nskills:\n  - bread\n  - pies\nstarted: 2026-01-05\n---\nAnn\n",
      "People/Bo.md": "---\nrole: Pilot\n---\nBo\n",
    });
    const internals = store as unknown as { updateNow: (id: string, patch: unknown) => Promise<unknown> };
    const updateNow = internals.updateNow.bind(store);
    internals.updateNow = async (id, patch) => {
      if (id === "People/Bo") throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
      return updateNow(id, patch);
    };
    const result = await store.pasteIntoOwnedRows("People.base", {
      rows: [
        { id: "People/Ann", expectedUpdated: store.get("People/Ann").updated, set: { role: "Chef", age: 30 } },
        { id: "People/Bo", expectedUpdated: store.get("People/Bo").updated, set: { role: "Baker" } },
        { title: "Cy", set: { role: "Diver" } },
      ],
    });
    expect(result.changed).toEqual([]);
    expect(result.created).toEqual([]);
    expect(result.refused.map((row) => row.title)).toEqual(["Bo"]);
    expect(result.stuck).toEqual([]);
    // Ann is back byte for byte (her old role, no age: she had none).
    // A comment, a list and a date included (D37, @lead).
    expect(await readFile(join(dir, "People/Ann.md"), "utf8")).toBe("---\nrole: Cook # head cook\nskills:\n  - bread\n  - pies\nstarted: 2026-01-05\n---\nAnn\n");
    expect(result.trashed).toEqual([]);
    // Cy was never made (the updates come first).
    expect((await readdir(join(dir, "People"))).sort()).toEqual(["Ann.md", "Bo.md"]);
  });

  it("a refused paste deletes the new rows it made outright: no Trash, no History (#7prbquxu phase 2, @lead)", async () => {
    const { dir, store } = await vault({
      "People.base": 'gumply:\n  rows: People\nfilters:\n  and:\n    - file.folder == "People"\nviews:\n  - type: table\n    name: Table\n',
      "People/Ann.md": "---\nrole: Cook\n---\nAnn\n",
    });
    // The second new row's values can't be written: the paste is refused after Cy was made.
    const internals = store as unknown as { updateNow: (id: string, patch: unknown) => Promise<unknown> };
    const updateNow = internals.updateNow.bind(store);
    internals.updateNow = async (id, patch) => {
      if (id === "People/Di") throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
      return updateNow(id, patch);
    };
    const result = await store.pasteIntoOwnedRows("People.base", {
      rows: [
        { title: "Cy", set: { role: "Diver" } },
        { title: "Di", set: { role: "Pilot" } },
      ],
    });
    expect(result.refused.map((row) => row.title)).toEqual(["Di"]);
    expect(result.trashed).toEqual([]);
    expect(result.stuck).toEqual([]);
    expect((await readdir(join(dir, "People"))).sort()).toEqual(["Ann.md"]);
    expect(store.list().some((meta) => meta.id === "People/Cy" || meta.id === "People/Di")).toBe(false);
    expect((await readdir(join(dir, ".trash")).catch(() => [])).length).toBe(0);
    const { historyDir } = await import("../src/history");
    expect(existsSync(historyDir(dir, "People/Cy"))).toBe(false);
  });

  it("renames and clears a Select option in every row and in the base's options, each row's value as it is now (#7prbquxu phase 3)", async () => {
    const base =
      'gumply:\n  rows: Team\nfilters:\n  and:\n    - file.folder == "Team"\nproperties:\n  note.skills:\n    gumplyType: multiselect\n    gumplyOptions:\n      - value: Go\n        color: blue\n      - value: Rust\n        color: orange\n  note.level:\n    gumplyType: select\n    gumplyOptions:\n      - value: Senior\n        color: green\nviews:\n  - type: table\n    name: Table\n';
    const { app, dir } = await vault({
      "Team.base": base,
      "Team/Ann.md": "---\nskills:\n  - Go\n  - Rust\nlevel: Senior\n---\nAnn\n",
      // Another app added "C" here before the rename: it's kept.
      "Team/Bo.md": "---\nskills:\n  - Rust\n  - Go\n  - C\n---\nBo\n",
      "Team/Cy.md": "---\nskills:\n  - Rust\n---\nCy\n",
    });
    const url = `/api/bases/${encodeId("Team.base")}/rows-option`;
    const read = (path: string) => readFile(join(dir, path), "utf8");

    const renamed = (await (await jsonRequest(app, "POST", url, { key: "skills", rename: { from: "Go", to: "Golang" } })).json()) as { changed: string[] };
    expect(renamed.changed.sort()).toEqual(["Team/Ann", "Team/Bo"]);
    expect(await read("Team/Bo.md")).toContain("  - Rust\n  - Golang\n  - C\n");
    expect(await read("Team/Cy.md")).toBe("---\nskills:\n  - Rust\n---\nCy\n");
    expect(await read("Team.base")).toBe(base.replace("      - value: Go\n", "      - value: Golang\n"));

    // A rename to the same name (after trimming) changes nothing at all.
    const before = await read("Team/Ann.md");
    const same = (await (await jsonRequest(app, "POST", url, { key: "skills", rename: { from: "Golang", to: " Golang " } })).json()) as { changed: string[] };
    expect(same.changed).toEqual([]);
    expect(await read("Team/Ann.md")).toBe(before);

    // A name another option has: refused before any write.
    expect((await jsonRequest(app, "POST", url, { key: "skills", rename: { from: "Golang", to: "Rust" } })).status).toBe(400);

    // Clear a Select's option: the rows lose the value, the base the option.
    await jsonRequest(app, "POST", url, { key: "level", clear: "Senior" });
    // The key stays, with an empty value (as Obsidian clears a property; @lead): the row keeps the property.
    expect(await read("Team/Ann.md")).toMatch(/\nlevel:\n/);
    expect(await read("Team.base")).not.toContain("value: Senior");
  });

  it("an option rename stops at the first refused row: no later row is written (#7prbquxu phase 3, @opus-hunter's note 1)", async () => {
    const base = 'gumply:\n  rows: Team\nfilters:\n  and:\n    - file.folder == "Team"\nproperties:\n  note.level:\n    gumplyType: select\n    gumplyOptions:\n      - value: Senior\n        color: green\nviews:\n  - type: table\n    name: Table\n';
    const { store } = await vault({ "Team.base": base, "Team/Ann.md": "---\nlevel: Senior\n---\nAnn\n", "Team/Bo.md": "---\nlevel: Senior\n---\nBo\n", "Team/Cy.md": "---\nlevel: Senior\n---\nCy\n" });
    const internals = store as unknown as { updateNow: (id: string, patch: unknown) => Promise<unknown> };
    const updateNow = internals.updateNow.bind(store);
    const tried: string[] = [];
    internals.updateNow = async (id, patch) => {
      tried.push(id);
      if (tried.length === 1) throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
      return updateNow(id, patch);
    };
    const result = await store.changeOwnedRowsOption("Team.base", { key: "level", rename: { from: "Senior", to: "Lead" } });
    expect(result.refused).toHaveLength(1);
    // One write tried (the refused one), none after it, so nothing to put back.
    expect(tried).toHaveLength(1);
  });

  it("an option rename that a row refuses puts every written row back byte for byte, and leaves the base (#7prbquxu phase 3, @lead)", async () => {
    const base = 'gumply:\n  rows: Team\nfilters:\n  and:\n    - file.folder == "Team"\nproperties:\n  note.level:\n    gumplyType: select\n    gumplyOptions:\n      - value: Senior\n        color: green\nviews:\n  - type: table\n    name: Table\n';
    const ann = "---\nlevel: Senior # since 2026\n---\nAnn\n";
    const { dir, store } = await vault({ "Team.base": base, "Team/Ann.md": ann, "Team/Bo.md": "---\nlevel: Senior\n---\nBo\n" });
    const internals = store as unknown as { updateNow: (id: string, patch: unknown) => Promise<unknown> };
    const updateNow = internals.updateNow.bind(store);
    internals.updateNow = async (id, patch) => {
      if (id === "Team/Bo") throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
      return updateNow(id, patch);
    };
    const result = await store.changeOwnedRowsOption("Team.base", { key: "level", rename: { from: "Senior", to: "Lead" } });
    expect(result.refused.map((row) => row.title)).toEqual(["Bo"]);
    expect(result.stuck).toEqual([]);
    expect(await readFile(join(dir, "Team/Ann.md"), "utf8")).toBe(ann);
    expect(await readFile(join(dir, "Team.base"), "utf8")).toBe(base);
  });

  it("a row that can't be put back is named with the key it's left with (#7prbquxu, @lead)", async () => {
    const { dir, store } = await vault({
      "People.base": 'gumply:\n  rows: People\nfilters:\n  and:\n    - file.folder == "People"\nviews:\n  - type: table\n    name: Table\n',
      "People/Ann.md": "---\nrole: Cook\n---\nAnn\n",
      "People/Bo.md": "---\nrole: Pilot\n---\nBo\n",
    });
    // Bo refuses the rename; Ann's way back is refused too (as if changed again, or locked, meanwhile).
    const internals = store as unknown as { updateNow: (id: string, patch: { properties?: { rename?: Array<{ from: string }> } }) => Promise<unknown> };
    const updateNow = internals.updateNow.bind(store);
    internals.updateNow = async (id, patch) => {
      if (id === "People/Bo" || patch.properties?.rename?.[0]?.from === "job") throw new (await import("../src/errors")).VaultError(409, "changed on disk");
      return updateNow(id, patch);
    };
    const result = await store.changeOwnedRowsProperty("People.base", { rename: { from: "role", to: "job" } });
    expect(result.skipped.map((row) => row.title)).toEqual(["Bo"]);
    expect(result.stuck).toEqual([{ id: "People/Ann", title: "Ann" }]);
    expect(await readFile(join(dir, "People/Ann.md"), "utf8")).toBe("---\njob: Cook\n---\nAnn\n");
  });

  it("a property type set only if absent keeps a type types.json has, even for a key no page uses (#7prbquxu, @opus-hunter)", async () => {
    const { app, dir } = await vault({ "Note.md": "---\nrole: Cook\n---\nNote\n" });
    await jsonRequest(app, "PUT", "/api/properties/priority", { type: "number" });
    await jsonRequest(app, "PUT", "/api/properties/priority", { type: "text", ifAbsent: true });
    await jsonRequest(app, "PUT", "/api/properties/budget", { type: "number", ifAbsent: true });
    const file = (await readdir(dir)).includes(".obsidian") ? ".obsidian/types.json" : ".gumply/types.json";
    const types = (JSON.parse(await readFile(join(dir, file), "utf8")) as { types: Record<string, string> }).types;
    expect(types.priority).toBe("number");
    expect(types.budget).toBe("number");
  });

  it("a database-wide rename that a row refuses puts the renamed rows back (#7prbquxu)", async () => {
    const { dir, store } = await vault({
      "People.base": 'gumply:\n  rows: People\nfilters:\n  and:\n    - file.folder == "People"\nviews:\n  - type: table\n    name: Table\n',
      "People/Ann.md": "---\nrole: Cook\n---\nAnn\n",
      "People/Bo.md": "---\nrole: Pilot\n---\nBo\n",
    });
    // Another app rewrites Bo with the same size and time after the store read it (#y5k39njn): Bo refuses.
    const bo = join(dir, "People/Bo.md");
    const { stat, utimes } = await import("node:fs/promises");
    const before = await stat(bo);
    await writeFile(bo, "---\nrole: Pilox\n---\nBo\n", "utf8");
    await utimes(bo, before.atime, before.mtime);
    const result = await store.changeOwnedRowsProperty("People.base", { rename: { from: "role", to: "job" } });
    expect(result.changed).toEqual([]);
    expect(result.skipped.map((row) => row.title)).toEqual(["Bo"]);
    expect(await readFile(join(dir, "People/Ann.md"), "utf8")).toBe("---\nrole: Cook\n---\nAnn\n");
    expect(await readFile(bo, "utf8")).toBe("---\nrole: Pilox\n---\nBo\n");
  });

  it("a base whose filter no longer reads its marked folder renames alone", async () => {
    const edited = 'gumply:\n  rows: Crew\nfilters:\n  and:\n    - file.inFolder("Crew")\nviews: []\n';
    const { app, dir, store } = await vault({ "Crew.base": edited, "Crew/Bo.md": "Bo\n" });
    const base = store.getBase("Crew.base");
    const renamed = await jsonRequest(app, "PUT", `/api/bases/${encodeId("Crew.base")}`, { title: "Staff", expectedUpdated: base.meta.updated });
    expect(((await renamed.json()) as { meta: PageMeta }).meta.id).toBe("Staff.base");
    expect(await readdir(join(dir, "Crew"))).toEqual(["Bo.md"]);
    expect(await readFile(join(dir, "Staff.base"), "utf8")).toBe(edited);
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

  it("moves with a renamed plain folder (D33): path links keep #View, and it isn't an other file", async () => {
    const { app, dir } = await vault({
      "Work/Tasks.base": TASKS_BASE,
      "Work/Note.md": "Note\n",
      "Home.md": "![[Work/Tasks.base#Board]]\n",
    });
    const pages = await getJson<PageMeta[]>(app, "/api/pages");
    expect(pages.find((page) => page.id === "Work")).toMatchObject({ kind: "folder", otherFiles: 0 });
    const response = await jsonRequest(app, "PUT", "/api/pages/Work", { title: "Office" });
    expect(response.status).toBe(200);
    expect(await readFile(join(dir, "Home.md"), "utf8")).toBe("![[Office/Tasks.base#Board]]\n");
    expect(await readFile(join(dir, "Office/Tasks.base"), "utf8")).toBe(TASKS_BASE);
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
