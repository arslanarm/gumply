import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GraphData, PageMeta } from "@gumply/core";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupVaults, createTestServer, encodeId, getJson, jsonRequest } from "./helpers";

/** #bayuasqq: a plain note's title is its file name, verbatim, as in Obsidian. */

afterEach(cleanupVaults);

async function obsidianVault() {
  const server = await createTestServer();
  await writeFile(join(server.dir, "meeting-notes.md"), "Notes body\n");
  await writeFile(join(server.dir, "my_page.md"), "Page body\n");
  await writeFile(join(server.dir, "README.md"), "Read me\n");
  await writeFile(join(server.dir, "Links.md"), "[[meeting-notes]] and [[Meeting notes]] and [[my_page]]\n");
  await server.store.rescan();
  return server;
}

describe("plain note titles (#bayuasqq)", () => {
  it("are the file names, verbatim (hyphens, underscores, case)", async () => {
    const { app } = await obsidianVault();
    const titles = (await getJson<PageMeta[]>(app, "/api/pages")).map((meta) => meta.title).sort();
    expect(titles).toEqual(["Links", "README", "meeting-notes", "my_page"]);
  });

  it("a body edit keeps the file name and adds no frontmatter", async () => {
    const { app, dir } = await obsidianVault();
    const page = await getJson<{ content: string; updated: string }>(app, `/api/pages/${encodeId("meeting-notes")}`);
    const saved = await jsonRequest(app, "PUT", `/api/pages/${encodeId("meeting-notes")}`, {
      content: `${page.content} edited`,
      expectedUpdated: page.updated,
    });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as PageMeta).id).toBe("meeting-notes");
    expect(await readFile(join(dir, "meeting-notes.md"), "utf8")).toBe("Notes body edited\n");
    expect((await readdir(dir)).filter((name) => name.endsWith(".md")).sort()).toEqual([
      "Links.md",
      "README.md",
      "meeting-notes.md",
      "my_page.md",
    ]);
  });

  it("links by file name and by the old readable title both resolve; search finds it with spaces", async () => {
    const { app } = await obsidianVault();
    const graph = await getJson<GraphData>(app, "/api/graph");
    // `[[meeting-notes]]` (Obsidian) and `[[Meeting notes]]` (older Gumply) both land on the note:
    // one edge to it (#rpugpydh: one edge per target page).
    const targets = graph.links.filter((link) => link.source === "Links").map((link) => link.target).sort();
    expect(targets).toEqual(["meeting-notes", "my_page"]);
    expect(graph.unresolved.filter((link) => link.source === "Links")).toEqual([]);
    const results = await getJson<Array<{ page: PageMeta; score: number }>>(app, "/api/search?q=meeting%20notes");
    expect(results[0]?.page.id).toBe("meeting-notes");
    expect(results[0]?.score).toBeGreaterThanOrEqual(100);
  });
});
