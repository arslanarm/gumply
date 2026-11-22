import type { GraphData, GraphNode } from "@gumply/core";
import { describe, expect, it } from "vitest";
import {
  attachmentNodeId,
  buildGraphModel,
  filterGraph,
  graphCounts,
  groupColorer,
  isAttachmentNodeId,
  isTagNodeId,
  tagNodeId,
} from "../src/graph/graph-model.js";
import { nextGroupColor } from "../src/graph/graph-settings.js";

/** v0.8 E1: search queries, tag and attachment nodes, ghost and orphan filters, colour groups. */

function node(id: string, tags: string[] = [], kind: GraphNode["kind"] = "page"): GraphNode {
  const title = id.split("/").pop()!.replace(/\.canvas$/, "");
  return { id, kind, title, tags, parentId: null, childCount: 0, created: "", updated: "", linkCount: 0 };
}

const DATA: GraphData = {
  nodes: [node("Work/Plan", ["work"]), node("Work/Notes", ["work/client"]), node("Home/Diary", ["home"]), node("Lonely"), node("Map.canvas", [], "whiteboard")],
  links: [
    { source: "Work/Plan", target: "Work/Notes" },
    { source: "Home/Diary", target: "Work/Plan" },
  ],
  tags: ["home", "work", "work/client"],
  unresolved: [{ source: "Home/Diary", targetTitle: "Someday" }],
  attachments: [
    { source: "Work/Plan", path: "att/chart.png" },
    { source: "Home/Diary", path: "att/chart.png" },
    { source: "Lonely", path: "att/scan.pdf" },
  ],
};

const ids = (graph: { nodes: GraphNode[]; extras: GraphNode[] }) => [...graph.nodes, ...graph.extras].map((item) => item.id);

describe("filterGraph (E1)", () => {
  const model = buildGraphModel(DATA);

  it("the search box takes graph queries; plain words still match titles", () => {
    expect(filterGraph(model, { query: "tag:#work" }).nodes.map((item) => item.id)).toEqual(["Work/Plan", "Work/Notes"]);
    expect(filterGraph(model, { query: "path:Home" }).nodes.map((item) => item.id)).toEqual(["Home/Diary"]);
    expect(filterGraph(model, { query: "plan" }).nodes.map((item) => item.id)).toEqual(["Work/Plan"]);
    expect(filterGraph(model, { query: "file:.canvas" }).nodes.map((item) => item.id)).toEqual(["Map.canvas"]);
    expect(filterGraph(model, { query: "-tag:#work -path:Home" }).nodes.map((item) => item.id)).toEqual(["Lonely", "Map.canvas"]);
  });

  it("existing files only hides ghosts; orphans off hides nodes with no links in view", () => {
    expect(filterGraph(model).ghosts).toHaveLength(1);
    expect(filterGraph(model, { hideUnresolved: true }).ghosts).toEqual([]);
    const noOrphans = filterGraph(model, { showOrphans: false });
    expect(noOrphans.nodes.map((item) => item.id)).toEqual(["Work/Plan", "Work/Notes", "Home/Diary"]);
    // A page linked only to a ghost is an orphan once ghosts are hidden.
    const both = filterGraph(buildGraphModel({ ...DATA, links: [] }), { showOrphans: false, hideUnresolved: true });
    expect(both.nodes).toEqual([]);
  });

  it("tag nodes link to the visible pages carrying each tag (nested tags their own node)", () => {
    const graph = filterGraph(model, { showTags: true });
    const tags = graph.extras.filter((item) => isTagNodeId(item.id));
    expect(tags.map((item) => item.title)).toEqual(["#home", "#work", "#work/client"]);
    expect(graph.links).toEqual(expect.arrayContaining([{ source: "Work/Plan", target: tagNodeId("work") }, { source: "Work/Notes", target: tagNodeId("work/client") }]));
    expect(tags.find((item) => item.title === "#work")!.linkCount).toBe(1);
    // Tags of hidden pages aren't drawn.
    expect(filterGraph(model, { showTags: true, query: "path:Home" }).extras.map((item) => item.title)).toEqual(["#home"]);
    // Pages counts don't include tag nodes.
    expect(graphCounts(graph).pages).toBe(5);
  });

  it("attachment nodes, one per file, linked to the visible pages that use it; tags and attachments keep pages from being orphans", () => {
    const graph = filterGraph(model, { attachments: DATA.attachments, showOrphans: false });
    const files = graph.extras.filter((item) => isAttachmentNodeId(item.id));
    expect(files.map((item) => item.title)).toEqual(["chart.png", "scan.pdf"]);
    expect(files[0]!.linkCount).toBe(2);
    expect(ids(graph)).toContain("Lonely");
    expect(graph.links).toEqual(expect.arrayContaining([{ source: "Lonely", target: attachmentNodeId("att/scan.pdf") }]));
    expect(filterGraph(model, { attachments: undefined }).extras).toEqual([]);
  });
});

describe("groupColorer (E1)", () => {
  it("the first matching group wins; nothing matches → null (default colouring)", () => {
    const color = groupColorer([
      { query: "tag:#work/client", color: "#111111" },
      { query: "tag:#work", color: "#222222" },
      { query: "", color: "#333333" },
      { query: "file:.png", color: "#444444" },
    ]);
    expect(color(node("Work/Notes", ["work/client"]))).toBe("#111111");
    expect(color(node("Work/Plan", ["work"]))).toBe("#222222");
    expect(color(node("Lonely"))).toBeNull();
    // Attachments match by their vault path.
    expect(color({ ...node(attachmentNodeId("att/chart.png")), title: "chart.png" })).toBe("#444444");
    expect(color({ ...node(attachmentNodeId("att/scan.pdf")), title: "scan.pdf" })).toBeNull();
    expect(color(node(tagNodeId("work"), ["work"]))).toBeNull();
    expect(groupColorer([])(node("Work/Plan", ["work"]))).toBeNull();
  });

  it("new groups take the first theme colour not used yet", () => {
    expect(nextGroupColor([], ["#a00000", "#00b000"])).toBe("#a00000");
    expect(nextGroupColor(["#A00000"], ["#a00000", "#00b000"])).toBe("#00b000");
    expect(nextGroupColor(["#a00000", "#00b000"], ["#a00000", "#00b000"])).toBe("#a00000");
  });
});
