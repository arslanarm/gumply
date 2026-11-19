import { describe, expect, it } from "vitest";
import type { GraphData, GraphNode } from "@gumply/core";
import {
  ariaSummary,
  buildGraphModel,
  filterGraph,
  ghostId,
  ghostTooltip,
  isGhostId,
  labelledNodeIds,
  maxReferenceCount,
  neighbourIds,
  nodeColor,
  nodeRadius,
  nodeTooltip,
} from "../src/graph/graph-model";

function page(id: string, title: string, tags: string[] = []): GraphNode {
  return {
    id,
    title,
    tags,
    parentId: id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : null,
    childCount: 0,
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-01T00:00:00.000Z",
    linkCount: 0,
  };
}

function graphData(overrides: Partial<GraphData> = {}): GraphData {
  return {
    nodes: [],
    links: [],
    tags: [],
    unresolved: [],
    ...overrides,
  };
}

describe("buildGraphModel", () => {
  it("groups ghost links case-insensitively and shows the most common spelling", () => {
    const model = buildGraphModel(
      graphData({
        nodes: [page("a", "A"), page("b", "B"), page("c", "C")],
        unresolved: [
          { source: "a", targetTitle: "Missing" },
          { source: "b", targetTitle: "missing" },
          { source: "c", targetTitle: "missing" },
        ],
      }),
    );

    expect(model.ghosts).toHaveLength(1);
    expect(model.ghosts[0]).toMatchObject({
      id: ghostId("missing"),
      key: "missing",
      title: "missing",
      refCount: 3,
      sources: ["a", "b", "c"],
    });
    expect(model.links).toEqual([
      { source: "a", target: ghostId("missing") },
      { source: "b", target: ghostId("missing") },
      { source: "c", target: ghostId("missing") },
    ]);
    expect(model.linkCount).toBe(3);
  });

  it("keeps one edge per source even if the same title repeats", () => {
    const model = buildGraphModel(
      graphData({
        nodes: [page("a", "A")],
        unresolved: [
          { source: "a", targetTitle: "Ghost" },
          { source: "a", targetTitle: "ghost" },
        ],
      }),
    );
    expect(model.ghosts[0]?.refCount).toBe(1);
    expect(model.links).toHaveLength(1);
  });

  it("counts resolved and ghost links in linkCount", () => {
    const model = buildGraphModel(
      graphData({
        nodes: [page("a", "A"), page("b", "B")],
        links: [{ source: "a", target: "b" }],
        unresolved: [{ source: "b", targetTitle: "Missing" }],
      }),
    );
    expect(model.linkCount).toBe(2);
    expect(maxReferenceCount(model)).toBeGreaterThanOrEqual(1);
  });

  it("skips blank titles", () => {
    const model = buildGraphModel(
      graphData({ unresolved: [{ source: "a", targetTitle: "   " }] }),
    );
    expect(model.ghosts).toEqual([]);
    expect(model.links).toEqual([]);
  });
});

describe("filterGraph", () => {
  const model = (): ReturnType<typeof buildGraphModel> =>
    buildGraphModel(
      graphData({
        nodes: [
          page("a", "Alpha", ["work"]),
          page("b", "Beta", ["home"]),
          page("c", "Gamma"),
        ],
        links: [{ source: "a", target: "b" }],
        tags: ["home", "work"],
        unresolved: [
          { source: "a", targetTitle: "Missing Work" },
          { source: "b", targetTitle: "Missing Home" },
        ],
      }),
    );

  it("filters pages and links by title", () => {
    const filtered = filterGraph(model(), { query: "alp" });
    expect(filtered.nodes.map((node) => node.id)).toEqual(["a"]);
    // Ghost titles do not match the query and their sources are hidden.
    expect(filtered.ghosts).toEqual([]);
    expect(filtered.links).toEqual([]);
  });

  it("hides ghosts whose source pages are excluded by a tag filter", () => {
    const filtered = filterGraph(model(), { tags: ["work"] });
    expect(filtered.nodes.map((node) => node.id)).toEqual(["a"]);
    expect(filtered.ghosts.map((ghost) => ghost.title)).toEqual(["Missing Work"]);
    expect(filtered.links.some((link) => isGhostId(link.target))).toBe(true);
    expect(filtered.tags).toEqual(["work"]);
  });

  it("returns an empty view when nothing matches", () => {
    const filtered = filterGraph(model(), { query: "zzz" });
    expect(filtered.nodes).toEqual([]);
    expect(filtered.ghosts).toEqual([]);
    expect(filtered.links).toEqual([]);
  });
});

describe("labels and sizing", () => {
  it("finds direct neighbours in both directions", () => {
    const links = [
      { source: "a", target: "b" },
      { source: "c", target: "a" },
      { source: "a", target: "d" },
    ];
    expect([...neighbourIds(links, "a")].sort()).toEqual(["b", "c", "d"]);
    expect([...neighbourIds(links, "b")]).toEqual(["a"]);
    expect([...neighbourIds(links, "z")]).toEqual([]);
  });

  it("labels every node when there are at most 30", () => {
    const nodes = Array.from({ length: 30 }, (_, index) =>
      page(`n${index}`, `N${index}`),
    );
    const model = buildGraphModel(graphData({ nodes }));
    expect(labelledNodeIds(model, null).size).toBe(30);
  });

  it("labels the top 15 by links plus hovered and neighbours above 30", () => {
    const nodes = Array.from({ length: 40 }, (_, index) => {
      const node = page(`n${index}`, `N${index}`);
      return { ...node, linkCount: index };
    });
    const model = buildGraphModel(graphData({ nodes }));

    const labelled = labelledNodeIds(model, "n0", ["n1"]);
    expect(labelled.has("n0")).toBe(true);
    expect(labelled.has("n1")).toBe(true);
    expect(labelled.has("n39")).toBe(true);
    // n39..n25 are the top 15 by count; n24 must not be there.
    expect(labelled.has("n25")).toBe(true);
    expect(labelled.has("n24")).toBe(false);
  });

  it("sizes from 6 to 24 px on a sqrt scale, isolated pages at 6", () => {
    expect(nodeRadius(0, 10)).toBe(6);
    expect(nodeRadius(10, 10)).toBe(24);
    expect(nodeRadius(1, 10)).toBeGreaterThan(6);
    expect(nodeRadius(1, 10)).toBeLessThan(24);
    expect(nodeRadius(2, 10)).toBeGreaterThan(nodeRadius(1, 10));
  });
});

describe("accessible copy", () => {
  it("summarises pages, links and missing pages", () => {
    const model = buildGraphModel(
      graphData({
        nodes: [
          { ...page("a", "A"), linkCount: 1 },
          { ...page("b", "B"), linkCount: 1 },
        ],
        links: [{ source: "a", target: "b" }],
        unresolved: [{ source: "a", targetTitle: "Ghost" }],
      }),
    );
    expect(ariaSummary(model)).toBe("2 pages, 2 links, 1 missing");

    const empty = buildGraphModel(graphData());
    expect(ariaSummary(empty)).toBe("0 pages, 0 links, 0 missing");
  });

  it("describes real pages and ghosts with the exact tooltip copy", () => {
    const node = { ...page("a", "Alpha", ["work"]), linkCount: 1 };
    expect(nodeTooltip(node)).toBe("Alpha · 1 link · #work");
    expect(nodeTooltip({ ...page("b", "Beta"), linkCount: 0 })).toBe("Beta · 0 links");

    const ghost = buildGraphModel(
      graphData({ unresolved: [{ source: "a", targetTitle: "Missing Page" }] }),
    ).ghosts[0]!;
    expect(ghostTooltip(ghost)).toBe("“Missing Page” — not created yet · 1 link · Click to create");
  });
});

describe("colours", () => {
  it("uses the first tag and falls back to the top-level folder", () => {
    const tagged = page("projects/a", "A", ["work"]);
    expect(nodeColor(tagged)).toBe(nodeColor(page("b", "B", ["work"])));

    const untagged = page("projects/c", "C");
    const otherFolder = page("notes/d", "D");
    expect(nodeColor(untagged)).not.toBe(nodeColor(otherFolder));
  });

  it("builds stable synthetic ghost ids", () => {
    expect(ghostId("  Missing Page ")).toBe("ghost:missing page");
    expect(isGhostId(ghostId("x"))).toBe(true);
    expect(isGhostId("a")).toBe(false);
  });
});
