import { mkdir, readFile, writeFile } from "node:fs/promises";
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
