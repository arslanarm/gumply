import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page, PropertyInfo } from "@gumply/core";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupVaults, createTestServer, getJson, jsonRequest } from "./helpers";

afterEach(cleanupVaults);

const enc = encodeURIComponent;

async function vaultWith(files: Record<string, string>) {
  const server = await createTestServer();
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(server.dir, name, ".."), { recursive: true });
    await writeFile(join(server.dir, name), text);
  }
  await server.store.rescan();
  return server;
}

async function put(app: Awaited<ReturnType<typeof createTestServer>>["app"], id: string, body: unknown) {
  return jsonRequest(app, "PUT", `/api/pages/${enc(id)}`, body);
}

const OBSIDIAN_NOTE = [
  "---",
  "status: todo # set by hand",
  "rank: 3",
  "done: false",
  "due: 2026-11-30",
  "people:",
  "  - Ann",
  "  - Bo",
  "tags: [work, q4]",
  "meta:",
  "  nested: true",
  "---",
  "",
  "Body text.",
  "",
].join("\n");

describe("GET /api/pages/:id properties (v1.12, D34)", () => {
  it("lists the frontmatter's properties in file order, typed, with header keys hidden", async () => {
    const { app } = await vaultWith({
      "Task.md": OBSIDIAN_NOTE.replace("---\nstatus", "---\ntitle: Task\nicon: ✅\ncreated: 2026-01-01T00:00:00.000Z\nstatus"),
    });
    const page = await getJson<Page>(app, "/api/pages/Task");
    expect(page.properties).toEqual([
      { key: "status", type: "text", value: "todo", editable: true },
      { key: "rank", type: "number", value: 3, editable: true },
      { key: "done", type: "checkbox", value: false, editable: true },
      { key: "due", type: "date", value: "2026-11-30", editable: true },
      { key: "people", type: "multitext", value: ["Ann", "Bo"], editable: true },
      { key: "tags", type: "tags", value: ["work", "q4"], editable: true },
      { key: "meta", type: "text", value: "nested: true", editable: false },
    ]);
  });

  it("a plain note has none; broken YAML gives none and the page still opens", async () => {
    const { app } = await vaultWith({ "Plain.md": "Just text.\n", "Broken.md": "---\na: [unclosed\n---\nBody\n" });
    expect((await getJson<Page>(app, "/api/pages/Plain")).properties).toEqual([]);
    const broken = await getJson<Page>(app, "/api/pages/Broken");
    expect(broken.properties).toEqual([]);
    expect(broken.content).toContain("Body");
  });
});

describe("PUT /api/pages/:id { properties } writes only the touched lines", () => {
  it("set, typed: numbers and booleans unquoted; every other byte kept", async () => {
    const { app, dir } = await vaultWith({ "Task.md": OBSIDIAN_NOTE });
    const response = await put(app, "Task", { properties: { set: { rank: "5", done: true, status: "doing" } } });
    expect(response.status).toBe(200);
    expect(await readFile(join(dir, "Task.md"), "utf8")).toBe(
      OBSIDIAN_NOTE.replace("status: todo # set by hand", "status: doing # set by hand")
        .replace("rank: 3", "rank: 5")
        .replace("done: false", "done: true"),
    );
    const page = (await response.json()) as Page;
    expect(page.properties?.find((p) => p.key === "rank")).toMatchObject({ type: "number", value: 5 });
  });

  it("an Obsidian note never gets title/created/updated from a property edit", async () => {
    const { app, dir } = await vaultWith({ "Task.md": OBSIDIAN_NOTE });
    await put(app, "Task", { properties: { set: { priority: "high" } } });
    const text = await readFile(join(dir, "Task.md"), "utf8");
    expect(text).toBe(OBSIDIAN_NOTE.replace("meta:\n  nested: true\n", "meta:\n  nested: true\npriority: high\n"));
    expect(text).not.toMatch(/^(title|created|updated):/m);
  });

  it("rename keeps the value bytes and position; remove drops the key's lines", async () => {
    const { app, dir } = await vaultWith({ "Task.md": OBSIDIAN_NOTE });
    await put(app, "Task", { properties: { rename: [{ from: "status", to: "state" }], remove: ["people"] } });
    expect(await readFile(join(dir, "Task.md"), "utf8")).toBe(
      OBSIDIAN_NOTE.replace("status: todo # set by hand", "state: todo # set by hand").replace("people:\n  - Ann\n  - Bo\n", ""),
    );
  });

  it("a plain note gets a block with only its first property; removing it makes it plain again", async () => {
    const { app, dir } = await vaultWith({ "Plain.md": "Just text.\n" });
    await put(app, "Plain", { properties: { set: { due: "2026-12-24" } } });
    expect(await readFile(join(dir, "Plain.md"), "utf8")).toBe("---\ndue: 2026-12-24\n---\n\nJust text.\n");
    await put(app, "Plain", { properties: { remove: ["due"] } });
    expect(await readFile(join(dir, "Plain.md"), "utf8")).toBe("Just text.\n");
  });

  it("an empty value is written as a bare key (YAML null), like Obsidian", async () => {
    const { app, dir } = await vaultWith({ "Task.md": "---\nstatus: todo\n---\nx\n" });
    await put(app, "Task", { properties: { set: { status: "" } } });
    expect(await readFile(join(dir, "Task.md"), "utf8")).toBe("---\nstatus:\n---\nx\n");
  });

  it("a new list starts as a bare key and grows as a block list (Obsidian's style)", async () => {
    const { app, dir } = await vaultWith({ "Task.md": "---\nstatus: todo\n---\nx\n" });
    await put(app, "Task", { properties: { set: { tags: null, people: null } } });
    expect(await readFile(join(dir, "Task.md"), "utf8")).toBe("---\nstatus: todo\ntags:\npeople:\n---\nx\n");
    await put(app, "Task", { properties: { set: { tags: ["launch"], people: ["Ann"] } } });
    expect(await readFile(join(dir, "Task.md"), "utf8")).toBe(
      "---\nstatus: todo\ntags:\n  - launch\npeople:\n  - Ann\n---\nx\n",
    );
  });

  it("tags set as a property feed the tag index", async () => {
    const { app, store } = await vaultWith({ "Task.md": "---\nstatus: todo\n---\nx\n" });
    await put(app, "Task", { properties: { set: { tags: ["#release", "q4"] } } });
    expect(store.list().find((page) => page.id === "Task")?.tags).toEqual(expect.arrayContaining(["release", "q4"]));
  });

  it("refuses header keys, bad names, wrong types, read-only YAML and name clashes (400)", async () => {
    const { app, dir } = await vaultWith({ "Task.md": OBSIDIAN_NOTE });
    for (const properties of [
      { set: { title: "x" } },
      { set: { updated: "x" } },
      // #8s94nyhn: "a:b" is a valid key now (quoted on write); a line break and a .base prefix stay refused.
      { set: { "two\nlines": "x" } },
      { set: { "note.x": "x" } },
      { set: { rank: "lots" } },
      { set: { done: "maybe" } },
      { set: { due: "soon" } },
      { set: { meta: "flat now" } },
      { rename: [{ from: "status", to: "rank" }] },
      { rename: [{ from: "missing", to: "x" }] },
      { rename: [{ from: "tags", to: "labels" }] },
      { remove: ["icon"] },
      { set: [] },
      "nope",
    ]) {
      const response = await put(app, "Task", { properties });
      expect(response.status, JSON.stringify(properties)).toBe(400);
    }
    expect(await readFile(join(dir, "Task.md"), "utf8")).toBe(OBSIDIAN_NOTE);
  });

  it("#8s94nyhn: punctuated keys are written so YAML reads them back, and the page reads them back too", async () => {
    const { app, dir } = await vaultWith({ "Plant.md": "---\nWater every (days): 7\n'Pot (cm)': 12\n---\n\nFern.\n" });
    const response = await put(app, "Plant", { properties: { set: { "Price ($)": "5", "a:b": "x", "Water every (days)": "9", "Pot (cm)": "14" } } });
    expect(response.status).toBe(200);
    const text = await readFile(join(dir, "Plant.md"), "utf8");
    // The file's own spellings stay; a key YAML would split is quoted.
    expect(text).toBe('---\nWater every (days): 9\n\'Pot (cm)\': 14\nPrice ($): "5"\n"a:b": x\n---\n\nFern.\n');
    const page = await getJson<Page>(app, "/api/pages/Plant");
    expect(Object.fromEntries(page.properties!.map((property) => [property.key, property.value]))).toMatchObject({ "Water every (days)": 9, "Pot (cm)": 14, "Price ($)": "5", "a:b": "x" });
  });

  it("is conditional like any save (D22): a stale version gets 409", async () => {
    const { app } = await vaultWith({ "Task.md": OBSIDIAN_NOTE });
    const page = await getJson<Page>(app, "/api/pages/Task");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await put(app, "Task", { properties: { set: { status: "a" } }, expectedUpdated: page.updated });
    expect((await put(app, "Task", { properties: { set: { status: "b" } }, expectedUpdated: page.updated })).status).toBe(409);
  });
});

describe("GET/PUT /api/properties: vault-wide keys and types", () => {
  it("lists keys by how many pages use them, with inferred types", async () => {
    const { app } = await vaultWith({
      "A.md": "---\nstatus: todo\nrank: 1\n---\n",
      "B.md": "---\nstatus: done\n---\n",
      "C.md": "---\nrank: 2\ndue: 2026-01-02\n---\n",
    });
    expect(await getJson<PropertyInfo[]>(app, "/api/properties")).toEqual([
      { key: "rank", type: "number", count: 2 },
      { key: "status", type: "text", count: 2 },
      { key: "due", type: "date", count: 1 },
    ]);
  });

  it("without .obsidian/, types go to .gumply/types.json and win over inference", async () => {
    const { app, dir } = await vaultWith({ "A.md": "---\ncode: 7\n---\n" });
    const response = await jsonRequest(app, "PUT", "/api/properties/code", { type: "text" });
    expect(response.status).toBe(200);
    expect(JSON.parse(await readFile(join(dir, ".gumply", "types.json"), "utf8"))).toEqual({ types: { code: "text" } });
    expect(await readdir(dir)).not.toContain(".obsidian");
    expect((await getJson<Page>(app, "/api/pages/A")).properties?.[0]).toMatchObject({ key: "code", type: "text" });
  });

  it("an Obsidian vault shares .obsidian/types.json: one entry changes, the rest and the tab indent stay", async () => {
    const { app, dir } = await vaultWith({ "A.md": "---\ndue: 2026-01-01\n---\n" });
    await mkdir(join(dir, ".obsidian"));
    const original = '{\n\t"types": {\n\t\t"aliases": "aliases",\n\t\t"cssclasses": "multitext"\n\t},\n\t"other": 1\n}';
    await writeFile(join(dir, ".obsidian", "types.json"), original);
    await jsonRequest(app, "PUT", "/api/properties/due", { type: "datetime" });
    const text = await readFile(join(dir, ".obsidian", "types.json"), "utf8");
    expect(JSON.parse(text)).toEqual({ types: { aliases: "aliases", cssclasses: "multitext", due: "datetime" }, other: 1 });
    expect(text.startsWith('{\n\t"types"')).toBe(true);
    expect(text.endsWith("}")).toBe(true); // no final newline added
    expect(await readdir(join(dir, ".gumply")).catch(() => [])).not.toContain("types.json");
  });

  it("never clobbers a change another app made to types.json meanwhile", async () => {
    const { app, dir } = await vaultWith({ "A.md": "---\nx: 1\ny: 2\n---\n" });
    await mkdir(join(dir, ".obsidian"));
    const file = join(dir, ".obsidian", "types.json");
    await writeFile(file, JSON.stringify({ types: { x: "number" } }, null, 2));
    expect((await getJson<PropertyInfo[]>(app, "/api/properties")).find((p) => p.key === "x")?.type).toBe("number");
    // Obsidian changes the file after Gumply read (and cached) it.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(file, JSON.stringify({ types: { x: "text", fromObsidian: "date" } }, null, 2));
    await jsonRequest(app, "PUT", "/api/properties/y", { type: "checkbox" });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ types: { x: "text", fromObsidian: "date", y: "checkbox" } });
  });

  it("refuses unknown types, header keys and a damaged types.json", async () => {
    const { app, dir } = await vaultWith({ "A.md": "---\nx: 1\n---\n" });
    expect((await jsonRequest(app, "PUT", "/api/properties/x", { type: "rainbow" })).status).toBe(400);
    expect((await jsonRequest(app, "PUT", "/api/properties/title", { type: "text" })).status).toBe(400);
    await mkdir(join(dir, ".gumply"), { recursive: true });
    await writeFile(join(dir, ".gumply", "types.json"), "{ not json");
    expect((await jsonRequest(app, "PUT", "/api/properties/x", { type: "text" })).status).toBeGreaterThanOrEqual(400);
    expect(await readFile(join(dir, ".gumply", "types.json"), "utf8")).toBe("{ not json");
  });
});

describe("GET /api/pages?include=properties", () => {
  it("adds properties per page only when asked; boards and folders have none", async () => {
    const { app, store } = await vaultWith({ "A.md": "---\nstatus: todo\n---\n", "Work/B.md": "plain\n" });
    await store.createBoard({ title: "Map" });
    const light = await getJson<Array<Record<string, unknown>>>(app, "/api/pages");
    expect(light.every((page) => !("properties" in page))).toBe(true);
    const full = await getJson<Array<{ id: string; properties?: unknown }>>(app, "/api/pages?include=properties");
    expect(full.find((page) => page.id === "A")?.properties).toEqual([{ key: "status", type: "text", value: "todo", editable: true }]);
    expect(full.find((page) => page.id === "Work/B")?.properties).toEqual([]);
    expect(full.find((page) => page.id === "Map.canvas")?.properties).toBeUndefined();
  });
});

describe("a warm properties query is an in-memory walk (no fs per page)", () => {
  it("serves every page's properties from the cache once warm, even with the files gone", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 50; index += 1) files[`P${index}.md`] = `---\nn: ${index}\nstatus: s${index % 3}\n---\nx\n`;
    const { store, dir } = await vaultWith(files);
    const first = await store.listWithProperties();
    // Behind the store's back (no watcher): a second query can't read any file.
    const { rm } = await import("node:fs/promises");
    for (const name of Object.keys(files)) await rm(join(dir, name));
    const warm = await store.listWithProperties();
    expect(warm).toEqual(first);
    expect(warm.find((page) => page.id === "P7")?.properties).toEqual([
      { key: "n", type: "number", value: 7, editable: true },
      { key: "status", type: "text", value: "s1", editable: true },
    ]);
    expect((await store.propertyTypeMap()).get("n")).toBe("number");
  });
});
