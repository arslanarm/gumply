import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Backlink, GraphData } from "@gumply/core";
import { cleanupVaults, createPage, createTestServer, getJson, jsonRequest } from "./helpers";

afterEach(cleanupVaults);

const pagePath = (id: string): string => `/api/pages/${encodeURIComponent(id)}`;

/**
 * #idmfvvkg (Obsidian parity): a Markdown link to a page, `[x](Note.md)`, is a
 * link like `[[Note]]`: a graph edge and a backlink. Resolved as D23 resolves
 * attachment links (note-relative first, then from the vault root). An
 * unresolved `.md` path makes no ghost (a path isn't a title).
 */
describe("Markdown links to pages", () => {
  it("are backlinks and graph edges, note-relative first, then from the vault root", async () => {
    const { app } = await createTestServer();
    await createPage(app, { title: "Home" });
    await createPage(app, { title: "Projects" });
    await createPage(app, { title: "Plan", parentId: "Projects" });
    await createPage(app, { title: "Q1 notes", parentId: "Projects", content: "See [the plan](Plan.md) and [home](../Home.md#Start)." });
    await createPage(app, { title: "Journal", content: "Read [Q1](Projects/Q1%20notes.md) today." });

    const toPlan = await getJson<Backlink[]>(app, `${pagePath("Projects/Plan")}/backlinks`);
    expect(toPlan.map((link) => link.page.id)).toEqual(["Projects/Q1 notes"]);
    const toHome = await getJson<Backlink[]>(app, `${pagePath("Home")}/backlinks`);
    expect(toHome.map((link) => link.page.id)).toEqual(["Projects/Q1 notes"]);
    const toQ1 = await getJson<Backlink[]>(app, `${pagePath("Projects/Q1 notes")}/backlinks`);
    expect(toQ1.map((link) => link.page.id)).toEqual(["Journal"]);

    const graph = await getJson<GraphData>(app, "/api/graph");
    expect(graph.links).toEqual(
      expect.arrayContaining([
        { source: "Projects/Q1 notes", target: "Projects/Plan" },
        { source: "Projects/Q1 notes", target: "Home" },
        { source: "Journal", target: "Projects/Q1 notes" },
      ]),
    );
  });

  it("are one edge with a [[link]] to the same page; no ghost for a missing .md path; URLs and code are not links", async () => {
    const { app } = await createTestServer();
    await createPage(app, { title: "Target" });
    await createPage(app, {
      title: "Source",
      content: "[[Target]] and [again](Target.md). [gone](Missing.md) [web](https://example.com/Target.md) `[code](Target.md)`",
    });

    const graph = await getJson<GraphData>(app, "/api/graph");
    expect(graph.links).toEqual([{ source: "Source", target: "Target" }]);
    expect(graph.nodes.map((node: GraphData["nodes"][number]) => node.id).sort()).toEqual(["Source", "Target"]);
    expect(await getJson<Backlink[]>(app, `${pagePath("Target")}/backlinks`)).toHaveLength(1);
  });

  it("follow edits: a link added, and a target created later, count at once", async () => {
    const { app } = await createTestServer();
    const source = await createPage(app, { title: "Source", content: "Nothing yet." });
    await createPage(app, { title: "Target" });
    await jsonRequest(app, "PUT", pagePath(source.id as string), { content: "Now [t](Target.md) and [l](Later.md)." });
    expect((await getJson<Backlink[]>(app, `${pagePath("Target")}/backlinks`)).map((link) => link.page.id)).toEqual(["Source"]);

    await createPage(app, { title: "Later" });
    expect((await getJson<Backlink[]>(app, `${pagePath("Later")}/backlinks`)).map((link) => link.page.id)).toEqual(["Source"]);
  });

  it("follow a rename: [x](Note.md) is rewritten in its own form in the rename's batches, and the backlink follows", async () => {
    const { app, dir } = await createTestServer();
    await createPage(app, { title: "Projects" });
    await createPage(app, { title: "Plan", parentId: "Projects" });
    await createPage(app, { title: "Q1 notes", parentId: "Projects", content: "Read [the plan](Plan.md#Goals) and [it](<Plan.md>). [[Home]]" });
    await createPage(app, { title: "Journal", content: "See [p](Projects/Plan.md \"P\"). Untouched: [web](https://example.com/Plan.md)." });

    const renamed = await jsonRequest(app, "PUT", pagePath("Projects/Plan"), { title: "Road map" });
    expect(renamed.status).toBe(200);

    expect(await readFile(join(dir, "Projects", "Q1 notes.md"), "utf8")).toContain("Read [the plan](Road%20map.md#Goals) and [it](<Road map.md>). [[Home]]");
    // The body changes only in the link's path (the rewrite also moves `updated:`, as for [[links]]).
    expect(await readFile(join(dir, "Journal.md"), "utf8")).toContain('See [p](Projects/Road%20map.md "P"). Untouched: [web](https://example.com/Plan.md).');
    const links = await getJson<Backlink[]>(app, `${pagePath("Projects/Road map")}/backlinks`);
    expect(links.map((link) => link.page.id).sort()).toEqual(["Journal", "Projects/Q1 notes"]);
  });

  it("follow a move: the path is rebuilt in the link's own form", async () => {
    const { app, dir } = await createTestServer();
    await createPage(app, { title: "Projects" });
    await createPage(app, { title: "Archive" });
    await createPage(app, { title: "Plan", parentId: "Projects", content: "Back to [me](Plan.md#Top)." });
    await createPage(app, { title: "Q1 notes", parentId: "Projects", content: "Read [the plan](Plan.md)." });
    await createPage(app, { title: "Journal", content: "See [p](Projects/Plan.md)." });

    const moved = await jsonRequest(app, "POST", `${pagePath("Projects/Plan")}/move`, { parentId: "Archive" });
    expect(moved.status).toBe(200);

    expect(await readFile(join(dir, "Projects", "Q1 notes.md"), "utf8")).toContain("Read [the plan](../Archive/Plan.md).");
    expect(await readFile(join(dir, "Journal.md"), "utf8")).toContain("See [p](Archive/Plan.md).");
    const links = await getJson<Backlink[]>(app, `${pagePath("Archive/Plan")}/backlinks`);
    expect(links.map((link) => link.page.id).sort()).toEqual(["Journal", "Projects/Q1 notes"]);
    // @polish-dev's check: the moved page's own self-link is left as written; next to its file it still means itself
    // (and a self-link is no edge).
    expect(await readFile(join(dir, "Archive", "Plan.md"), "utf8")).toContain("Back to [me](Plan.md#Top).");
  });
});
