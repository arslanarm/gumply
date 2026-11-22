import { readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Backlink, GraphData, PageMentions } from "@gumply/core";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupVaults, createTestServer, getJson, jsonRequest } from "./helpers";

/**
 * #rpugpydh: a frontmatter value that is exactly one quoted `[[link]]` is a
 * link (graph edge, ghost, backlink), as Obsidian 1.14.4 indexes it
 * (@opus-hunter's `vault-c1obs/`). Unquoted `[[X]]`, text around a link and
 * embeds are not. Unlinked mentions (C1) don't change.
 */

afterEach(cleanupVaults);

async function vault(files: Record<string, string>) {
  const server = await createTestServer();
  for (const [name, text] of Object.entries(files)) await writeFile(join(server.dir, name), text);
  await server.store.rescan();
  const graph = (query = "") => getJson<GraphData>(server.app, `/api/graph${query}`);
  const targets = async (source: string) =>
    (await graph()).links.filter((link) => link.source === source).map((link) => link.target).sort();
  const backlinks = async (id: string) =>
    (await getJson<Backlink[]>(server.app, `/api/pages/${encodeURIComponent(id)}/backlinks`)).map((link) => [link.page.id, link.snippet]);
  return { ...server, graph, targets, backlinks };
}

const ALPHA = "# Alpha\n\nThe target.\n";

describe("frontmatter [[links]] are links (#rpugpydh)", () => {
  it("a quoted value or list item is a graph edge and a backlink with a `key: text` snippet", async () => {
    const { targets, backlinks, graph } = await vault({
      "Alpha.md": ALPHA,
      "Beta.md": "Beta.\n",
      "Prop.md": '---\nrelated: "[[Alpha|the a]]"\nrefs:\n  - \'[[Beta]]\'\n  - "[[Missing]]"\n---\n\nNo links in the body.\n',
    });
    expect(await targets("Prop")).toEqual(["Alpha", "Beta"]);
    expect((await graph()).unresolved).toEqual([{ source: "Prop", targetTitle: "Missing" }]);
    expect(await backlinks("Alpha")).toEqual([["Prop", "related: [[Alpha|the a]]"]]);
    expect(await backlinks("Beta")).toEqual([["Prop", "refs: [[Beta]]"]]);
    // The graph payload stays `{ source, target }` (no `via`).
    expect(Object.keys((await graph()).links[0]!).sort()).toEqual(["source", "target"]);
  });

  it("unquoted `[[X]]`, text around a link, two links, spaces and embeds are not links", async () => {
    const { targets, graph } = await vault({
      "Alpha.md": ALPHA,
      "Beta.md": "Beta.\n",
      "Not.md":
        "---\nup: [[Alpha]]\nrefs:\n  - [[Alpha]]\np: see [[Alpha]] here\ndq: \"see [[Alpha]] here\"\n" +
        "two: \"[[Alpha]] and [[Beta]]\"\nsp: \" [[Alpha]] \"\nem: \"![[Alpha]]\"\nesc: \"\\\\[[Alpha]]\"\nblock: |\n  [[Alpha]]\n---\n\nBody.\n",
    });
    expect(await targets("Not")).toEqual([]);
    expect((await graph()).unresolved.filter((link) => link.source === "Not")).toEqual([]);
  });

  it("a page linked in the body and in a property is one edge, with the body's snippet", async () => {
    const { targets, backlinks } = await vault({
      "Alpha.md": ALPHA,
      "Both.md": '---\nrelated: "[[Alpha]]"\n---\n\nSee [[alpha]] and [[Alpha]] here.\n',
    });
    expect(await targets("Both")).toEqual(["Alpha"]);
    expect(await backlinks("Alpha")).toEqual([["Both", "See [[alpha]] and Alpha here."]]);
  });

  it("resolves from its own note, like the body (same-name pages in two folders)", async () => {
    const server = await createTestServer();
    const { mkdir } = await import("node:fs/promises");
    for (const folder of ["Projects/Sub", "Other"]) await mkdir(join(server.dir, folder), { recursive: true });
    await writeFile(join(server.dir, "Projects/Sub/Three.md"), "Three.\n");
    await writeFile(join(server.dir, "Other/Three.md"), "Other three.\n");
    await writeFile(join(server.dir, "Projects/A.md"), '---\nnext: "[[Three]]"\n---\n\nA.\n');
    await server.store.rescan();
    const graph = await getJson<GraphData>(server.app, "/api/graph");
    expect(graph.links.filter((link) => link.source === "Projects/A")).toEqual([{ source: "Projects/A", target: "Projects/Sub/Three" }]);
  });

  it("re-indexes a properties-only edit, through the API and from outside (watcher)", async () => {
    const { app, dir, store, targets } = await vault({ "Alpha.md": ALPHA, "Beta.md": "Beta.\n", "Note.md": "Body.\n" });
    expect(await targets("Note")).toEqual([]);
    const response = await jsonRequest(app, "PUT", "/api/pages/Note", { properties: { set: { related: "[[Alpha]]" } } });
    expect(response.status).toBe(200);
    expect(await targets("Note")).toEqual(["Alpha"]);

    store.startWatching();
    try {
      const text = await readFile(join(dir, "Note.md"), "utf8");
      await writeFile(join(dir, "Note.md"), text.replace("[[Alpha]]", "[[Beta]]"));
      await expect.poll(() => targets("Note"), { timeout: 3000 }).toEqual(["Beta"]);
    } finally {
      store.stopWatching();
    }
  });

  it("a rename rewrites the property link and the edge follows", async () => {
    const { app, read, targets, backlinks } = await (async () => {
      const server = await vault({ "Alpha.md": ALPHA, "Prop.md": '---\nrelated: "[[Alpha]]"\n---\n\nBody.\n' });
      return { ...server, read: (name: string) => readFile(join(server.dir, name), "utf8") };
    })();
    const response = await jsonRequest(app, "PUT", "/api/pages/Alpha", { title: "Gamma" });
    expect(response.status).toBe(200);
    expect(await read("Prop.md")).toBe('---\nrelated: "[[Gamma]]"\n---\n\nBody.\n');
    expect(await targets("Prop")).toEqual(["Gamma"]);
    expect(await backlinks("Gamma")).toEqual([["Prop", "related: [[Gamma]]"]]);
  });

  it("C1 is unchanged: a note linking through a property still lists its plain mention (Obsidian 1.14.4)", async () => {
    const { app } = await vault({
      "Alpha.md": ALPHA,
      "PropLink.md": '---\nrelated: "[[Alpha]]"\n---\n\nAlpha is mentioned here.\n',
    });
    const mentions = await getJson<PageMentions[]>(app, "/api/pages/Alpha/mentions");
    expect(mentions.map((entry) => entry.page.id)).toEqual(["PropLink"]);
  });

  it("a whole-value file link is an attachment edge under include=attachments only; the default graph is byte-identical", async () => {
    // Two vaults, the same note with and without file links in its properties
    // (one a duplicate of the body's). Dates are pinned so only the links differ.
    const pinned = new Date("2026-01-02T03:04:05Z");
    const files = { "a.pdf": "%PDF-1.4", "a.png": "png", "b.png": "png" };
    const body = "Body with ![[b.png]] and [[a.pdf]].\n";
    const header = "---\ncreated: 2026-01-01T00:00:00.000Z\n";
    const pinnedVault = async (note: string) => {
      const server = await createTestServer();
      for (const [name, text] of Object.entries({ ...files, "Files.md": note })) await writeFile(join(server.dir, name), text);
      await utimes(join(server.dir, "Files.md"), pinned, pinned);
      await server.store.rescan();
      return server;
    };
    const without = await pinnedVault(`${header}---\n${body}`);
    const withLinks = await pinnedVault(`${header}pdf: "[[a.pdf]]"\nimg: "[[a.png]]"\nemb: "![[b.png]]"\nnot: "see [[a.png]]"\n---\n${body}`);
    const graphText = async (server: { app: { request: (path: string) => Response | Promise<Response> } }) =>
      (await server.app.request("/api/graph")).text();
    expect(await graphText(withLinks)).toBe(await graphText(without));
    const { dir, store, app } = withLinks;
    const graph = (query: string) => getJson<GraphData>(app, `/api/graph${query}`);
    const file = join(dir, "Files.md");
    expect((await graph("?include=attachments")).attachments).toEqual([
      { source: "Files", path: "a.pdf" },
      { source: "Files", path: "a.png" },
      { source: "Files", path: "b.png" },
    ]);

    // An image embed in a property gives no edge.
    await writeFile(file, '---\nemb: "![[a.png]]"\n---\nNothing.\n');
    await store.rescan();
    expect((await graph("?include=attachments")).attachments).toEqual([]);
  });
});
