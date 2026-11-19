import { afterEach, describe, expect, it } from "vitest";
import type { Backlink, GraphData, PageMeta, SearchResult } from "@gumply/core";
import { cleanupVaults, createPage, createTestServer, getJson, jsonRequest } from "./helpers";

afterEach(cleanupVaults);

describe("backlinks", () => {
  it("lists source pages with a snippet around the link", async () => {
    const { app } = await createTestServer();
    await createPage(app, { title: "Target" });
    await createPage(app, { title: "Source", content: "Some intro. See [[Target]] for details." });
    await createPage(app, { title: "Other", content: "No links here." });

    const links = await getJson<Backlink[]>(app, "/api/pages/target/backlinks");
    expect(links).toHaveLength(1);
    expect(links[0]?.page.id).toBe("source");
    expect(links[0]?.snippet).toContain("[[Target]]");
  });

  it("keeps backlinks stable across a target rename", async () => {
    const { app } = await createTestServer();
    await createPage(app, { title: "Old Name" });
    await createPage(app, { title: "Source", content: "See [[Old Name]]." });

    expect(await getJson<Backlink[]>(app, "/api/pages/old-name/backlinks")).toHaveLength(1);

    // The id stays `old-name`, so D4's id/file-name fallback keeps the old
    // wikilink resolving; links to the new title resolve as well.
    await jsonRequest(app, "PUT", "/api/pages/old-name", { title: "New Name" });
    expect(await getJson<Backlink[]>(app, "/api/pages/old-name/backlinks")).toHaveLength(1);

    await jsonRequest(app, "PUT", "/api/pages/source", { content: "See [[New Name]]." });
    const links = await getJson<Backlink[]>(app, "/api/pages/old-name/backlinks");
    expect(links).toHaveLength(1);
    expect(links[0]?.page.id).toBe("source");
  });

  it("drops backlinks when a link no longer resolves", async () => {
    const { app } = await createTestServer();
    await createPage(app, { title: "Target" });
    await createPage(app, { title: "Source", content: "See [[Target]]." });

    await jsonRequest(app, "PUT", "/api/pages/source", { content: "See [[Something Else]]." });
    expect(await getJson<Backlink[]>(app, "/api/pages/target/backlinks")).toEqual([]);
  });

  it("resolves links case-insensitively", async () => {
    const { app } = await createTestServer();
    await createPage(app, { title: "Gumply" });
    await createPage(app, { title: "Source", content: "[[gumply]]" });

    const links = await getJson<Backlink[]>(app, "/api/pages/gumply/backlinks");
    expect(links.map((link) => link.page.id)).toEqual(["source"]);
  });

  it("404s for unknown pages and ignores links inside code", async () => {
    const { app } = await createTestServer();
    await createPage(app, { title: "Target" });
    await createPage(app, { title: "Code", content: "`[[Target]]` and [[Target]]" });

    expect((await app.request("/api/pages/nope/backlinks")).status).toBe(404);

    const links = await getJson<Backlink[]>(app, "/api/pages/target/backlinks");
    expect(links).toHaveLength(1);
    expect(links[0]?.snippet).toContain("[[Target]]");
    expect(links[0]?.snippet).toContain("and");
  });
});

describe("rename rewrites links", () => {
  it("rewrites plain, aliased and heading links in other pages", async () => {
    const { app } = await createTestServer();
    await createPage(app, { title: "Old Name" });
    await createPage(app, { title: "Other" });
    await createPage(app, {
      title: "Source",
      content: [
        "A [[Old Name]]",
        "B [[Old Name|alias]]",
        "C [[Old Name#Q1]]",
        "D [[Old Name#Q1|read this]]",
        "E `[[Old Name]]`",
        "F [[Other]]",
      ].join("\n"),
    });

    const response = await jsonRequest(app, "PUT", "/api/pages/old-name", { title: "New Name" });
    expect(response.status).toBe(200);
    const updated = (await response.json()) as Record<string, unknown>;
    expect(updated.title).toBe("New Name");
    expect(updated.id).toBe("old-name");
    expect(updated.rewrittenPages).toEqual(["source"]);

    const source = await getJson<Record<string, unknown>>(app, "/api/pages/source");
    expect(source.content).toBe(
      [
        "A [[New Name]]",
        "B [[New Name|alias]]",
        "C [[New Name#Q1]]",
        "D [[New Name#Q1|read this]]",
        "E `[[Old Name]]`",
        "F [[Other]]",
      ].join("\n"),
    );

    const backlinks = await getJson<Backlink[]>(app, "/api/pages/old-name/backlinks");
    expect(backlinks.map((link) => link.page.id)).toEqual(["source"]);
  });

  it("matches link targets case-insensitively", async () => {
    const { app } = await createTestServer();
    await createPage(app, { title: "Old Name" });
    await createPage(app, { title: "Source", content: "[[old name]] and [[OLD NAME|a]]" });

    const updated = (await (
      await jsonRequest(app, "PUT", "/api/pages/old-name", { title: "New Name" })
    ).json()) as Record<string, unknown>;
    expect(updated.rewrittenPages).toEqual(["source"]);
    expect((await getJson<Record<string, unknown>>(app, "/api/pages/source")).content).toBe(
      "[[New Name]] and [[New Name|a]]",
    );
  });

  it("omits rewrittenPages when the title does not change", async () => {
    const { app } = await createTestServer();
    await createPage(app, { title: "Same" });

    const updated = (await (
      await jsonRequest(app, "PUT", "/api/pages/same", { content: "body" })
    ).json()) as Record<string, unknown>;
    expect(updated.rewrittenPages).toBeUndefined();
  });
});

describe("graph", () => {
  it("returns nodes, resolved links, link counts and tags", async () => {
    const { app } = await createTestServer();
    await createPage(app, { title: "A", content: "[[B]] #alpha" });
    await createPage(app, { title: "B", content: "[[C]]" });
    await createPage(app, { title: "C", content: "end #beta" });
    await createPage(app, { title: "D", content: "[[Missing]]" });

    const graph = await getJson<GraphData>(app, "/api/graph");
    expect(graph.nodes).toHaveLength(4);
    expect(graph.links).toEqual(
      expect.arrayContaining([
        { source: "a", target: "b" },
        { source: "b", target: "c" },
      ]),
    );
    expect(graph.links).toHaveLength(2);

    const counts = Object.fromEntries(graph.nodes.map((node: GraphData["nodes"][number]) => [node.id, node.linkCount]));
    expect(counts).toEqual({ a: 1, b: 2, c: 1, d: 0 });
    expect(graph.tags).toEqual(["alpha", "beta"]);
  });

  it("limits the graph to a BFS radius around a center", async () => {
    const { app } = await createTestServer();
    await createPage(app, { title: "A", content: "[[B]]" });
    await createPage(app, { title: "B", content: "[[C]]" });
    await createPage(app, { title: "C" });
    await createPage(app, { title: "D" });

    const local = await getJson<GraphData>(app, "/api/graph?center=b&depth=1");
    expect(local.nodes.map((node: PageMeta) => node.id).sort()).toEqual(["a", "b", "c"]);
    expect(local.links).toHaveLength(2);

    const isolated = await getJson<GraphData>(app, "/api/graph?center=d&depth=1");
    expect(isolated.nodes.map((node: PageMeta) => node.id)).toEqual(["d"]);
    expect(isolated.links).toEqual([]);
  });

  it("validates center and depth", async () => {
    const { app } = await createTestServer();
    await createPage(app, { title: "A" });

    expect((await app.request("/api/graph?center=missing")).status).toBe(404);
    expect((await app.request("/api/graph?center=a&depth=0")).status).toBe(400);
    expect((await app.request("/api/graph?center=a&depth=nope")).status).toBe(400);
    expect((await app.request("/api/graph?depth=2")).status).toBe(400);
    expect((await app.request("/api/graph?center=")).status).toBe(400);
  });
  it("exposes unresolved links as source/title pairs for ghost nodes", async () => {
    const { app } = await createTestServer();
    await createPage(app, { title: "A", content: "[[Missing]] and [[A]]" });
    await createPage(app, { title: "B", content: "[[Missing]] and [[missing]]" });

    const graph = await getJson<GraphData>(app, "/api/graph");
    expect(graph.nodes.map((node) => node.id).sort()).toEqual(["a", "b"]);
    expect(graph.links).toEqual([]);
    // One pair per source page + missing title (case-insensitive), self-links ignored.
    expect(graph.unresolved).toEqual([
      { source: "a", targetTitle: "Missing" },
      { source: "b", targetTitle: "Missing" },
    ]);
  });

  it("does not report code-masked or resolved links as unresolved", async () => {
    const { app } = await createTestServer();
    await createPage(app, { title: "Target" });
    await createPage(app, {
      title: "Source",
      content: "`[[CodeGhost]]` [[Target]] [[Ghost]]",
    });

    const graph = await getJson<GraphData>(app, "/api/graph");
    expect(graph.unresolved).toEqual([{ source: "source", targetTitle: "Ghost" }]);
  });

  it("filters unresolved links by the local graph view", async () => {
    const { app } = await createTestServer();
    await createPage(app, { title: "A", content: "[[B]] [[Ghost of A]]" });
    await createPage(app, { title: "B" });
    await createPage(app, { title: "C", content: "[[Ghost of C]]" });

    const local = await getJson<GraphData>(app, "/api/graph?center=b&depth=1");
    expect(local.unresolved).toEqual([{ source: "a", targetTitle: "Ghost of A" }]);
  });

  it("leaves .trash out of the graph after a delete", async () => {
    const { app } = await createTestServer();
    await createPage(app, { title: "A", content: "[[Missing]]" });
    await createPage(app, { title: "B", content: "No links here" });

    await jsonRequest(app, "DELETE", "/api/pages/a");
    const graph = await getJson<GraphData>(app, "/api/graph");
    expect(graph.nodes.map((node) => node.id)).toEqual(["b"]);
    expect(graph.unresolved).toEqual([]);
  });
});

describe("search", () => {
  it("ranks title matches before body matches", async () => {
    const { app } = await createTestServer();
    await createPage(app, { title: "Gumply", content: "The app." });
    await createPage(app, { title: "Roadmap", content: "Plan for the gumply launch." });

    const results = await getJson<SearchResult[]>(app, "/api/search?q=gump");
    expect(results.map((result) => result.page.id)).toEqual(["gumply", "roadmap"]);
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });

  it("returns body snippets around the hit", async () => {
    const { app } = await createTestServer();
    await createPage(app, {
      title: "Notes",
      content: `${"filler ".repeat(30)}needle in the hay${" tail".repeat(30)}`,
    });

    const results = await getJson<SearchResult[]>(app, "/api/search?q=needle");
    expect(results).toHaveLength(1);
    expect(results[0]?.snippet).toContain("needle");
  });

  it("is case-insensitive and empty for a blank query", async () => {
    const { app } = await createTestServer();
    await createPage(app, { title: "Alpha", content: "BETA" });

    expect(await getJson<SearchResult[]>(app, "/api/search?q=beta")).toHaveLength(1);
    expect(await getJson<SearchResult[]>(app, "/api/search?q=")).toEqual([]);
    expect((await app.request("/api/search")).status).toBe(200);
    expect(await getJson<SearchResult[]>(app, "/api/search")).toEqual([]);
  });

  it("includes tags in search results metadata", async () => {
    const { app } = await createTestServer();
    await createPage(app, { title: "Tagged", content: "body #project" });

    const [result] = await getJson<SearchResult[]>(app, "/api/search?q=tagged");
    expect(result?.page.tags).toEqual(["project"]);
  });
});
