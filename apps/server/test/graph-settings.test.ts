import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GraphData, GraphSettingsResponse } from "@gumply/core";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { VaultStore } from "../src/vault-store";
import { cleanupVaults, createTestServer, getJson, jsonRequest } from "./helpers";

/** v0.8 E1 (spec/api-graph-groups, v1.19): graph settings and attachment edges. */

afterEach(cleanupVaults);

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

const OBSIDIAN_GRAPH = JSON.stringify(
  {
    "collapse-filter": true,
    search: "",
    showTags: true,
    showAttachments: false,
    hideUnresolved: false,
    showOrphans: true,
    colorGroups: [{ query: "tag:#work", color: { a: 1, rgb: 14701138 } }],
    "collapse-display": true,
    scale: 1,
  },
  null,
  2,
);

describe("GET/PUT /api/graph/settings", () => {
  it("defaults with no settings anywhere", async () => {
    const { app } = await vault();
    expect(await getJson<GraphSettingsResponse>(app, "/api/graph/settings")).toEqual({
      groups: [],
      filters: { search: "", showTags: false, showAttachments: false, hideUnresolved: false, showOrphans: true },
      // #xb4b54gr: grouped by links unless set.
      clusterBy: "links",
      source: "default",
    });
  });

  it("starts from .obsidian/graph.json, then saves only to .gumply/graph.json; .obsidian stays byte-identical", async () => {
    const { app, dir } = await vault({ ".obsidian/graph.json": OBSIDIAN_GRAPH, "Note.md": "x\n" });
    const first = await getJson<GraphSettingsResponse>(app, "/api/graph/settings");
    expect(first).toMatchObject({ source: "obsidian", groups: [{ query: "tag:#work", color: "#e05252" }], filters: { showTags: true } });

    const put = await jsonRequest(app, "PUT", "/api/graph/settings", { ...first, groups: [...first.groups, { query: "path:Daily", color: "#00aa55" }] });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ source: "gumply", groups: [{ query: "tag:#work" }, { query: "path:Daily", color: "#00aa55" }] });
    expect(JSON.parse(await readFile(join(dir, ".gumply/graph.json"), "utf8"))).toMatchObject({ groups: [{}, { query: "path:Daily" }] });
    expect(await readFile(join(dir, ".obsidian/graph.json"), "utf8")).toBe(OBSIDIAN_GRAPH);
    // From now on, Gumply's own file wins.
    expect((await getJson<GraphSettingsResponse>(app, "/api/graph/settings")).source).toBe("gumply");
  });

  it("an invalid .gumply/graph.json falls back; bad bodies are 400; bad values are normalised", async () => {
    const { app } = await vault({ ".gumply/graph.json": "{ not json" });
    expect((await getJson<GraphSettingsResponse>(app, "/api/graph/settings")).source).toBe("default");
    expect((await jsonRequest(app, "PUT", "/api/graph/settings", { groups: "nope" })).status).toBe(400);
    expect((await jsonRequest(app, "PUT", "/api/graph/settings", { filters: [] })).status).toBe(400);
    const put = await jsonRequest(app, "PUT", "/api/graph/settings", { groups: [{ query: "a", color: "blue" }], filters: { showTags: 1 } });
    expect(await put.json()).toMatchObject({ groups: [], filters: { showTags: false } });
  });

  it("#reynggre: a save keeps keys Gumply doesn't know (top level, filters, groups), in the file's order", async () => {
    const onDisk = {
      future: { layout: "radial" },
      groups: [
        { query: "tag:#work", color: "#112233", weight: 3 },
        { query: "path:Daily", color: "#445566", note: "hand edit" },
      ],
      filters: { depth: 2, search: "x", showTags: true, showAttachments: false, hideUnresolved: false, showOrphans: true },
      zoom: 1.5,
    };
    const { app, dir } = await vault({ ".gumply/graph.json": JSON.stringify(onDisk, null, 2) });
    const settings = await getJson<GraphSettingsResponse>(app, "/api/graph/settings");
    // The user drops the Daily group, recolours work, adds one, and turns tags off.
    const put = await jsonRequest(app, "PUT", "/api/graph/settings", {
      groups: [{ query: "tag:#work", color: "#aabbcc" }, { query: "tag:#home", color: "#00ff00" }],
      filters: { ...settings.filters, showTags: false },
    });
    expect(put.status).toBe(200);
    const saved = JSON.parse(await readFile(join(dir, ".gumply/graph.json"), "utf8")) as Record<string, unknown>;
    // #xb4b54gr: a PUT without clusterBy (the user didn't change it) adds no key.
    expect(Object.keys(saved)).toEqual(["future", "groups", "filters", "zoom"]);
    expect(saved).toEqual({
      future: { layout: "radial" },
      groups: [
        { query: "tag:#work", color: "#aabbcc", weight: 3 },
        { query: "tag:#home", color: "#00ff00" },
      ],
      filters: { depth: 2, search: "x", showTags: false, showAttachments: false, hideUnresolved: false, showOrphans: true },
      zoom: 1.5,
    });
    // What the app reads back is unchanged by the extra keys.
    expect(await getJson<GraphSettingsResponse>(app, "/api/graph/settings")).toMatchObject({
      source: "gumply",
      groups: [{ query: "tag:#work", color: "#aabbcc" }, { query: "tag:#home", color: "#00ff00" }],
    });
  });

  it("#xb4b54gr: \"Group by\" is saved when set; a value this Gumply doesn't know reads as links and stays in the file", async () => {
    const { app, dir } = await vault();
    const file = join(dir, ".gumply/graph.json");
    const settings = await getJson<GraphSettingsResponse>(app, "/api/graph/settings");
    const put = await jsonRequest(app, "PUT", "/api/graph/settings", { groups: settings.groups, filters: settings.filters, clusterBy: "folder" });
    expect(put.status).toBe(200);
    expect(await getJson<GraphSettingsResponse>(app, "/api/graph/settings")).toMatchObject({ clusterBy: "folder", source: "gumply" });
    // A newer Gumply's mode: read as the default…
    await writeFile(file, JSON.stringify({ groups: [], filters: {}, clusterBy: "property" }));
    expect(await getJson<GraphSettingsResponse>(app, "/api/graph/settings")).toMatchObject({ clusterBy: "links" });
    // …and kept by a save that doesn't change the mode (a colour group, a filter).
    const kept = await jsonRequest(app, "PUT", "/api/graph/settings", { groups: [{ query: "tag:#x", color: "#112233" }], filters: settings.filters });
    expect(kept.status).toBe(200);
    expect(JSON.parse(await readFile(file, "utf8")).clusterBy).toBe("property");
    // The user picking a mode does replace it.
    await jsonRequest(app, "PUT", "/api/graph/settings", { groups: [], filters: settings.filters, clusterBy: "tag" });
    expect(JSON.parse(await readFile(file, "utf8")).clusterBy).toBe("tag");
  });

  it("#reynggre: a hand-edited invalid file is kept aside, not replaced silently", async () => {
    const broken = '{ "groups": [ { "query": "tag:#work", "color": "#112233" }, ]  // oops\n';
    const { app, dir } = await vault({ ".gumply/graph.json": broken });
    const put = await jsonRequest(app, "PUT", "/api/graph/settings", { groups: [], filters: {} });
    expect(put.status).toBe(200);
    const names = await readdir(join(dir, ".gumply"));
    const aside = names.filter((name) => /^graph\.json\.invalid-\d+$/.test(name));
    expect(aside).toHaveLength(1);
    expect(await readFile(join(dir, ".gumply", aside[0]!), "utf8")).toBe(broken);
    expect(JSON.parse(await readFile(join(dir, ".gumply/graph.json"), "utf8"))).toMatchObject({ groups: [] });
    // A JSON array is just as invalid; a valid file is never moved aside.
    await writeFile(join(dir, ".gumply/graph.json"), "[1, 2]");
    await jsonRequest(app, "PUT", "/api/graph/settings", { groups: [] });
    await jsonRequest(app, "PUT", "/api/graph/settings", { groups: [] });
    expect((await readdir(join(dir, ".gumply"))).filter((name) => name.startsWith("graph.json.invalid-"))).toHaveLength(2);
  });

  it("writes need the app's origin", async () => {
    const { app } = await vault();
    const response = await app.request("http://localhost/api/graph/settings", {
      method: "PUT",
      headers: { Origin: "https://evil.example", Host: "localhost:8787", "content-type": "application/json" },
      body: JSON.stringify({ groups: [] }),
    });
    expect(response.status).toBe(403);
  });
});

describe("GET /api/graph?include=attachments", () => {
  const PNG = "\x89PNG\r\n\x1a\n";

  it("lists each page's resolved attachment links; the default payload is unchanged", async () => {
    const { app } = await vault({
      "att/pic.png": PNG,
      "Docs/report.pdf": "%PDF-1.4",
      "Home.md": "![[pic.png]] and [[report.pdf]] and ![[missing.png]]\n",
      "Other.md": "![](att/pic.png) `![[pic.png]]` in code\n",
      "Plain.md": "[[Home]]\n",
    });
    const plain = await getJson<GraphData>(app, "/api/graph");
    expect(plain.attachments).toBeUndefined();
    const graph = await getJson<GraphData>(app, "/api/graph?include=attachments");
    expect(graph.attachments).toEqual([
      { source: "Home", path: "att/pic.png" },
      { source: "Home", path: "Docs/report.pdf" },
      { source: "Other", path: "att/pic.png" },
    ]);
    const local = await getJson<GraphData>(app, "/api/graph?center=Plain&depth=1&include=attachments");
    expect(local.attachments).toEqual([
      { source: "Home", path: "att/pic.png" },
      { source: "Home", path: "Docs/report.pdf" },
    ]);
  });
});
