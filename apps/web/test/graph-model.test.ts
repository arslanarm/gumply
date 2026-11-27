import { describe, expect, it } from "vitest";
import { parseGraphQuery, type GraphData, type GraphNode } from "@gumply/core";
import {
  ariaSummary,
  buildGraphModel,
  FALLBACK_GRAPH_PALETTE,
  filterGraph,
  ghostId,
  ghostDetail,
  ghostTooltip,
  graphCounts,
  graphSubtitle,
  isGhostId,
  labelledIds,
  labelledNodeIds,
  maxReferenceCount,
  neighbourIds,
  nodeColor,
  nodeRadius,
  nodeDetail,
  nodeTooltip,
  queryHasTag,
  toggleQueryTag,
  PAGE_NODE_COLOR,
  paletteIndex,
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

function rgbDistance(a: string, b: string): number {
  const rgb = (hex: string) => [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
  const [ar, ag, ab] = rgb(a);
  const [br, bg, bb] = rgb(b);
  return Math.hypot((ar ?? 0) - (br ?? 0), (ag ?? 0) - (bg ?? 0), (ab ?? 0) - (bb ?? 0));
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

  it("matches ghost titles even when no source page title matches", () => {
    const filtered = filterGraph(model(), { query: "missing home" });
    expect(filtered.nodes).toEqual([]);
    expect(filtered.ghosts.map((ghost) => ghost.title)).toEqual(["Missing Home"]);
    // No visible source, so no edge is drawn to the isolated ghost.
    expect(filtered.links).toEqual([]);
  });

  it("hides ghosts whose source pages are excluded by a tag filter", () => {
    const filtered = filterGraph(model(), { tags: ["work"] });
    expect(filtered.nodes.map((node) => node.id)).toEqual(["a"]);
    expect(filtered.ghosts.map((ghost) => ghost.title)).toEqual(["Missing Work"]);
    expect(filtered.links.some((link) => isGhostId(link.target))).toBe(true);
    expect(filtered.tags).toEqual(["work"]);
  });

  it("#yy347xgi (3): a typed tag: query gives the chip's graph: the not-created pages its pages link to stay", () => {
    const chip = filterGraph(model(), { tags: ["work"] });
    const typed = filterGraph(model(), { query: "tag:#work" });
    expect(typed.nodes.map((node) => node.id)).toEqual(chip.nodes.map((node) => node.id));
    expect(typed.ghosts.map((ghost) => ghost.title)).toEqual(["Missing Work"]);
    expect(typed.links).toEqual(chip.links);
    // @lead: one that only #work pages link to belongs to #work, so -tag:#work drops it.
    expect(filterGraph(model(), { query: "-tag:#work" }).ghosts.map((ghost) => ghost.title)).toEqual(["Missing Home"]);
    // A title search still matches a not-created page by its own title only.
    expect(filterGraph(model(), { query: "work" }).ghosts.map((ghost) => ghost.title)).toEqual(["Missing Work"]);
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
    const items = Array.from({ length: 40 }, (_, index) => ({ id: `n${index}`, count: index }));

    const labelled = labelledIds(items, "n0", new Set(["n1"]));
    expect(labelled.has("n0")).toBe(true);
    expect(labelled.has("n1")).toBe(true);
    expect(labelled.has("n39")).toBe(true);
    // n39..n25 are the top 15 by count; n24 must not be there.
    expect(labelled.has("n25")).toBe(true);
    expect(labelled.has("n24")).toBe(false);
  });

  it("counts distinct neighbours, so a two-way link is one connection (#z5abndiz)", () => {
    const model = buildGraphModel(
      graphData({
        nodes: [
          { ...page("a", "A"), linkCount: 4 },
          { ...page("b", "B"), linkCount: 2 },
          { ...page("c", "C"), linkCount: 1 },
        ],
        links: [
          { source: "a", target: "b" },
          { source: "b", target: "a" },
          { source: "a", target: "c" },
        ],
        unresolved: [{ source: "a", targetTitle: "Missing" }],
      }),
    );
    const count = (id: string) => model.nodes.find((node) => node.id === id)!.linkCount;
    expect(count("a")).toBe(3); // b, c and the ghost
    expect(count("b")).toBe(1);
    expect(count("c")).toBe(1);
  });

  it("sizes from 4 to 9 px on a sqrt scale, isolated pages at 4 (Q1b)", () => {
    expect(nodeRadius(0, 10)).toBe(4);
    expect(nodeRadius(10, 10)).toBe(9);
    expect(nodeRadius(1, 10)).toBeGreaterThan(4);
    expect(nodeRadius(1, 10)).toBeLessThan(9);
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
    expect(ariaSummary(model)).toBe("2 pages, 2 links, 1 not created yet");

    const empty = buildGraphModel(graphData());
    expect(ariaSummary(empty)).toBe("0 pages, 0 links, 0 not created yet");
  });

  it("subtitle and aria agree and both pluralise 1 correctly", () => {
    const one = buildGraphModel(
      graphData({
        nodes: [{ ...page("a", "A"), linkCount: 1 }],
        links: [],
        unresolved: [{ source: "a", targetTitle: "Ghost" }],
      }),
    );
    const counted = graphCounts(one);
    expect(counted).toEqual({ pages: 1, links: 1, missing: 1 });
    expect(graphSubtitle(one)).toBe("1 page · 1 link · 1 not created yet");
    expect(ariaSummary(one)).toBe("1 page, 1 link, 1 not created yet");

    const two = buildGraphModel(
      graphData({
        nodes: [
          { ...page("a", "A"), linkCount: 1 },
          { ...page("b", "B"), linkCount: 1 },
        ],
        links: [{ source: "a", target: "b" }],
        unresolved: [{ source: "a", targetTitle: "Ghost" }],
      }),
    );
    expect(graphSubtitle(two)).toBe("2 pages · 2 links · 1 not created yet");
    expect(ariaSummary(two)).toBe("2 pages, 2 links, 1 not created yet");

    const single = buildGraphModel(graphData({ nodes: [{ ...page("a", "A"), linkCount: 0 }] }));
    expect(graphSubtitle(single)).toBe("1 page · 0 links");
    expect(ariaSummary(single)).toBe("1 page, 0 links, 0 not created yet");
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

  it("hover details don't repeat the title shown by the label (#z5abndiz)", () => {
    expect(nodeDetail({ ...page("a", "Alpha", ["work"]), linkCount: 3 })).toBe("3 links · #work");
    expect(nodeDetail({ ...page("b", "Beta"), linkCount: 1 })).toBe("1 link");
    expect(nodeDetail({ ...page("m.canvas", "Map"), kind: "whiteboard", linkCount: 2 })).toBe("Whiteboard · 2 links");
    const ghost = buildGraphModel(
      graphData({ nodes: [page("a", "A")], unresolved: [{ source: "a", targetTitle: "Missing Page" }] }),
    ).ghosts[0]!;
    expect(ghostDetail(ghost)).toBe("Not created yet · 1 link · Click to create");
  });
});

describe("colours", () => {
  it("uses the first tag; untagged pages share the legend's page colour (#z5abndiz)", () => {
    const tagged = page("projects/a", "A", ["work"]);
    expect(nodeColor(tagged)).toBe(nodeColor(page("b", "B", ["work"])));
    expect(nodeColor(tagged)).not.toBe(PAGE_NODE_COLOR);

    // No folder-hash colours the legend can't explain.
    expect(nodeColor(page("projects/c", "C"))).toBe(PAGE_NODE_COLOR);
    expect(nodeColor(page("notes/d", "D"))).toBe(PAGE_NODE_COLOR);
    expect(nodeColor(page("e", "E"), undefined, "#123456")).toBe("#123456");
  });

  it("no tag colour looks like the neutral page colour", () => {
    expect(FALLBACK_GRAPH_PALETTE).not.toContain(PAGE_NODE_COLOR);
  });

  it("builds stable synthetic ghost ids", () => {
    expect(ghostId("  Missing Page ")).toBe("ghost:missing page");
    expect(isGhostId(ghostId("x"))).toBe(true);
    expect(isGhostId("a")).toBe(false);
  });

  it("maps a tag to a stable --graph-N slot and uses the current theme palette", () => {
    const palette = Array.from({ length: 10 }, (_, index) => `#theme-${index}`);
    expect(paletteIndex("WORK")).toBe(paletteIndex("work"));
    expect(paletteIndex("work")).toBeGreaterThanOrEqual(0);
    expect(paletteIndex("work")).toBeLessThan(10);
    expect(nodeColor(page("a", "A", ["work"]), palette)).toBe(palette[paletteIndex("work")]);
  });

  it("keeps tag colours distinct, including the #idea/#project pair", () => {
    expect(new Set(FALLBACK_GRAPH_PALETTE).size).toBe(FALLBACK_GRAPH_PALETTE.length);
    const idea = nodeColor(page("a", "A", ["idea"]));
    const project = nodeColor(page("b", "B", ["project"]));
    expect(idea).not.toBe(project);
    expect(rgbDistance(idea, project)).toBeGreaterThan(60);
  });
});

describe("tag chips as query terms (#yy347xgi (3))", () => {
  it("a chip is pressed when the query has its positive tag: term, in any case and with or without #", () => {
    expect(queryHasTag("tag:#work", "work")).toBe(true);
    expect(queryHasTag("basil TAG:Work", "work")).toBe(true);
    expect(queryHasTag("-tag:#work", "work")).toBe(false);
    expect(queryHasTag("tag:#workshop", "work")).toBe(false);
    expect(queryHasTag("", "work")).toBe(false);
  });

  it("toggling adds the term, and takes every positive term for that tag back out (a hand edit un-presses it)", () => {
    expect(toggleQueryTag("", "work")).toBe("tag:#work");
    expect(toggleQueryTag("basil", "work")).toBe("basil tag:#work");
    expect(toggleQueryTag("basil tag:#work", "work")).toBe("basil");
    expect(toggleQueryTag("tag:#Work tag:work", "work")).toBe("");
    expect(toggleQueryTag("tag:#home OR tag:#work", "work")).toBe("tag:#home");
    expect(queryHasTag("tag:#workshop", "work")).toBe(false);
  });

  it("two chips mean either tag (OR, @lead), and taking one out keeps the query valid", () => {
    const both = toggleQueryTag(toggleQueryTag("", "work"), "home");
    expect(both).toBe("tag:#work OR tag:#home");
    expect(queryHasTag(both, "work") && queryHasTag(both, "home")).toBe(true);
    // Two alternatives, one tag term each: either tag.
    expect(parseGraphQuery(both)).toEqual([
      [{ op: "tag", value: "work", negate: false }],
      [{ op: "tag", value: "home", negate: false }],
    ]);
    // Out with the first: its OR goes too; out with the second: the same.
    expect(toggleQueryTag(both, "work")).toBe("tag:#home");
    expect(toggleQueryTag(both, "home")).toBe("tag:#work");
    expect(toggleQueryTag("basil tag:#work OR tag:#home", "work")).toBe("basil tag:#home");
  });
});
