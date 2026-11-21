import { afterEach, describe, expect, it } from "vitest";
import type { Backlink, GraphData, PageMeta, SearchResult } from "@gumply/core";
import { cleanupVaults, createPage, createTestServer, getJson, jsonRequest } from "./helpers";

afterEach(cleanupVaults);

const pagePath = (id: string): string => `/api/pages/${encodeURIComponent(id)}`;

describe("backlinks", () => {
  it("lists source pages with a snippet around the link", async () => {
    const { app } = await createTestServer();
    const target = await createPage(app, { title: "Target" });
    const source = await createPage(app, {
      title: "Source",
      content: "Some intro. See [[Target]] for details.",
    });
    await createPage(app, { title: "Other", content: "No links here." });

    const links = await getJson<Backlink[]>(app, `${pagePath(target.id)}/backlinks`);
    expect(links).toHaveLength(1);
    expect(links[0]?.page.id).toBe(source.id);
    expect(links[0]?.snippet).toContain("[[Target]]");
  });

  it("shows plain text around the link, like search snippets (#zrxjbn6e)", async () => {
    const { app } = await createTestServer();
    const target = await createPage(app, { title: "Budget" });
    await createPage(app, {
      title: "Trip",
      content: "# Packing\n\n- passport\n- [ ] book the hotel\n\nSee [[Budget|the budget]] for `costs`. #travel\n",
    });

    const links = await getJson<Backlink[]>(app, `${pagePath(target.id)}/backlinks`);
    expect(links[0]?.snippet).toBe("Packing passport book the hotel See [[Budget|the budget]] for costs. #travel");
  });

  it("keeps backlinks stable across a target rename", async () => {
    const { app } = await createTestServer();
    const target = await createPage(app, { title: "Old Name" });
    const source = await createPage(app, { title: "Source", content: "See [[Old Name]]." });

    expect(await getJson<Backlink[]>(app, `${pagePath(target.id)}/backlinks`)).toHaveLength(1);

    // D20: the id and file follow the title; the old id redirects this session.
    const updated = (await (
      await jsonRequest(app, "PUT", pagePath(target.id), { title: "New Name" })
    ).json()) as Record<string, unknown>;
    expect(updated.id).toBe("New Name");
    expect(await getJson<Backlink[]>(app, `${pagePath(target.id)}/backlinks`)).toHaveLength(1);

    await jsonRequest(app, "PUT", pagePath(source.id), { content: "See [[New Name]]." });
    const links = await getJson<Backlink[]>(app, `${pagePath("New Name")}/backlinks`);
    expect(links).toHaveLength(1);
    expect(links[0]?.page.id).toBe(source.id);
  });

  it("drops backlinks when a link no longer resolves", async () => {
    const { app } = await createTestServer();
    const target = await createPage(app, { title: "Target" });
    const source = await createPage(app, { title: "Source", content: "See [[Target]]." });

    await jsonRequest(app, "PUT", pagePath(source.id), { content: "See [[Something Else]]." });
    expect(await getJson<Backlink[]>(app, `${pagePath(target.id)}/backlinks`)).toEqual([]);
  });

  it("resolves links case-insensitively", async () => {
    const { app } = await createTestServer();
    const target = await createPage(app, { title: "Gumply" });
    const source = await createPage(app, { title: "Source", content: "[[gumply]]" });

    const links = await getJson<Backlink[]>(app, `${pagePath(target.id)}/backlinks`);
    expect(links.map((link) => link.page.id)).toEqual([source.id]);
  });

  it("404s for unknown pages and ignores links inside code", async () => {
    const { app } = await createTestServer();
    const target = await createPage(app, { title: "Target" });
    const code = await createPage(app, {
      title: "Code",
      content: "`[[Target]]` and [[Target]]",
    });

    expect((await app.request(pagePath("nope"))).status).toBe(404);

    const links = await getJson<Backlink[]>(app, `${pagePath(target.id)}/backlinks`);
    expect(links).toHaveLength(1);
    expect(links[0]?.page.id).toBe(code.id);
    expect(links[0]?.snippet).toContain("[[Target]]");
    expect(links[0]?.snippet).toContain("and");
  });
});

describe("rename rewrites links", () => {
  it("rewrites plain, aliased and heading links in other pages", async () => {
    const { app } = await createTestServer();
    const target = await createPage(app, { title: "Old Name" });
    await createPage(app, { title: "Other" });
    const source = await createPage(app, {
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

    const response = await jsonRequest(app, "PUT", pagePath(target.id), { title: "New Name" });
    expect(response.status).toBe(200);
    const updated = (await response.json()) as Record<string, unknown>;
    expect(updated.title).toBe("New Name");
    expect(updated.id).toBe("New Name");
    expect(updated.rewrittenPages).toEqual([source.id]);

    const sourcePage = await getJson<Record<string, unknown>>(app, pagePath(source.id));
    expect(sourcePage.content).toBe(
      [
        "A [[New Name]]",
        "B [[New Name|alias]]",
        "C [[New Name#Q1]]",
        "D [[New Name#Q1|read this]]",
        "E `[[Old Name]]`",
        "F [[Other]]",
      ].join("\n"),
    );

    const backlinks = await getJson<Backlink[]>(app, `${pagePath("New Name")}/backlinks`);
    expect(backlinks.map((link) => link.page.id)).toEqual([source.id]);
  });

  it("matches link targets case-insensitively", async () => {
    const { app } = await createTestServer();
    const target = await createPage(app, { title: "Old Name" });
    const source = await createPage(app, {
      title: "Source",
      content: "[[old name]] and [[OLD NAME|a]]",
    });

    const updated = (await (
      await jsonRequest(app, "PUT", pagePath(target.id), { title: "New Name" })
    ).json()) as Record<string, unknown>;
    expect(updated.rewrittenPages).toEqual([source.id]);
    expect((await getJson<Record<string, unknown>>(app, pagePath(source.id))).content).toBe(
      "[[New Name]] and [[New Name|a]]",
    );
  });

  it("omits rewrittenPages when the title does not change", async () => {
    const { app } = await createTestServer();
    const page = await createPage(app, { title: "Same" });

    const updated = (await (
      await jsonRequest(app, "PUT", pagePath(page.id), { content: "body" })
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
        { source: "A", target: "B" },
        { source: "B", target: "C" },
      ]),
    );
    expect(graph.links).toHaveLength(2);

    const counts = Object.fromEntries(
      graph.nodes.map((node: GraphData["nodes"][number]) => [node.id, node.linkCount]),
    );
    expect(counts).toEqual({ A: 1, B: 2, C: 1, D: 0 });
    expect(graph.tags).toEqual(["alpha", "beta"]);
  });

  it("limits the graph to a BFS radius around a center", async () => {
    const { app } = await createTestServer();
    await createPage(app, { title: "A", content: "[[B]]" });
    const b = await createPage(app, { title: "B", content: "[[C]]" });
    await createPage(app, { title: "C" });
    const d = await createPage(app, { title: "D" });

    const local = await getJson<GraphData>(
      app,
      `/api/graph?center=${encodeURIComponent(b.id)}&depth=1`,
    );
    expect(local.nodes.map((node: PageMeta) => node.id).sort()).toEqual(["A", "B", "C"]);
    expect(local.links).toHaveLength(2);

    const isolated = await getJson<GraphData>(
      app,
      `/api/graph?center=${encodeURIComponent(d.id)}&depth=1`,
    );
    expect(isolated.nodes.map((node: PageMeta) => node.id)).toEqual(["D"]);
    expect(isolated.links).toEqual([]);
  });

  it("validates center and depth", async () => {
    const { app } = await createTestServer();
    const a = await createPage(app, { title: "A" });

    expect((await app.request("/api/graph?center=missing")).status).toBe(404);
    expect(
      (await app.request(`/api/graph?center=${encodeURIComponent(a.id)}&depth=0`)).status,
    ).toBe(400);
    expect(
      (await app.request(`/api/graph?center=${encodeURIComponent(a.id)}&depth=nope`)).status,
    ).toBe(400);
    expect((await app.request("/api/graph?depth=2")).status).toBe(400);
    expect((await app.request("/api/graph?center=")).status).toBe(400);
  });
  it("exposes unresolved links as source/title pairs for ghost nodes", async () => {
    const { app } = await createTestServer();
    await createPage(app, { title: "A", content: "[[Missing]] and [[A]]" });
    await createPage(app, { title: "B", content: "[[Missing]] and [[missing]]" });

    const graph = await getJson<GraphData>(app, "/api/graph");
    expect(graph.nodes.map((node) => node.id).sort()).toEqual(["A", "B"]);
    expect(graph.links).toEqual([]);
    // One pair per source page + missing title (case-insensitive), self-links ignored.
    expect(graph.unresolved).toEqual([
      { source: "A", targetTitle: "Missing" },
      { source: "B", targetTitle: "Missing" },
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
    expect(graph.unresolved).toEqual([{ source: "Source", targetTitle: "Ghost" }]);
  });

  it("filters unresolved links by the local graph view", async () => {
    const { app } = await createTestServer();
    await createPage(app, { title: "A", content: "[[B]] [[Ghost of A]]" });
    const b = await createPage(app, { title: "B" });
    await createPage(app, { title: "C", content: "[[Ghost of C]]" });

    const local = await getJson<GraphData>(
      app,
      `/api/graph?center=${encodeURIComponent(b.id)}&depth=1`,
    );
    expect(local.unresolved).toEqual([{ source: "A", targetTitle: "Ghost of A" }]);
  });

  it("leaves .trash out of the graph after a delete", async () => {
    const { app } = await createTestServer();
    const a = await createPage(app, { title: "A", content: "[[Missing]]" });
    const b = await createPage(app, { title: "B", content: "No links here" });

    await jsonRequest(app, "DELETE", pagePath(a.id));
    const graph = await getJson<GraphData>(app, "/api/graph");
    expect(graph.nodes.map((node) => node.id)).toEqual([b.id]);
    expect(graph.unresolved).toEqual([]);
  });
});

describe("search", () => {
  it("ranks title matches before body matches", async () => {
    const { app } = await createTestServer();
    await createPage(app, { title: "Gumply", content: "The app." });
    await createPage(app, { title: "Roadmap", content: "Plan for the gumply launch." });

    const results = await getJson<SearchResult[]>(app, "/api/search?q=gump");
    expect(results.map((result) => result.page.id)).toEqual(["Gumply", "Roadmap"]);
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

  it("finds phrases across formatting and links, with plain snippets (#6zifz7da)", async () => {
    const { app } = await createTestServer();
    await createPage(app, { title: "Getting started", content: "Start here." });
    await createPage(app, {
      title: "Formatted",
      content: "Plain **bold** text. See [[Getting started]] end. Ask [[Ideas Q3|the ideas page]] or [the docs](https://example.com/x_y).",
    });

    for (const phrase of ["bold text", "Plain bold", "See Getting started end", "Ask the ideas page", "or the docs"]) {
      const results = await getJson<SearchResult[]>(app, `/api/search?q=${encodeURIComponent(phrase)}`);
      expect(results.map((result) => result.page.id), phrase).toEqual(["Formatted"]);
    }
    const [hit] = await getJson<SearchResult[]>(app, "/api/search?q=bold%20text");
    expect(hit!.snippet).toContain("Plain bold text");
    expect(hit!.snippet).not.toMatch(/\*\*|\[\[|\]\(/);
    // Pasted URLs stay searchable; the snippet shows the link text, not markup.
    const [byUrl] = await getJson<SearchResult[]>(app, "/api/search?q=example.com");
    expect(byUrl?.page.id).toBe("Formatted");
    expect(byUrl!.snippet).toContain("the docs");
    expect(byUrl!.snippet).not.toMatch(/\]\(|https?:/);
    // A link target behind an alias too.
    const [byTarget] = await getJson<SearchResult[]>(app, "/api/search?q=Ideas%20Q3");
    expect(byTarget?.page.id).toBe("Formatted");
    expect(byTarget!.snippet).toContain("the ideas page");
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
