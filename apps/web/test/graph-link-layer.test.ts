import { describe, expect, it } from "vitest";
import { buildLinkIndex, GHOST_LINK_DASH, linkColorFor, linkDashFor, linkLayerKey, linkLayerStyle, paintRestingLinks, visibleGraphRect, type LinkColors, type LinkLayerInputs, type LinkPainter } from "../src/graph/link-layer";
import { linkWidthFor, restingLinkWidth } from "../src/graph/link-width";

/** #pifuz5zs: the cached link picture's key and its drawing (as force-graph strokes resting links). */

const base: LinkLayerInputs = {
  transform: { a: 0.5, b: 0, c: 0, d: 0.5, e: 400, f: 300 },
  width: 1600,
  height: 900,
  positions: 3,
  data: "1",
  style: "rgba(1,1,1,0.32)|rgba(1,1,1,0.08)|1",
};

function recorder() {
  const calls: string[] = [];
  const dashes: number[][] = [];
  const painter: LinkPainter & { widths: number[] } = {
    widths: [],
    strokeStyle: "",
    lineWidth: 1,
    beginPath: () => calls.push("begin"),
    moveTo: () => calls.push("move"),
    lineTo: () => calls.push("line"),
    stroke() {
      calls.push("stroke");
      painter.widths.push(painter.lineWidth);
    },
    setLineDash: (segments) => dashes.push(segments),
  };
  return { painter, calls, dashes };
}

describe("the cached link picture (#pifuz5zs)", () => {
  // Every input the resting links' look depends on (GraphCanvas: linkColor = linkPaint + hoveredId, linkWidth =
  // hoveredId + DPR, linkLineDash = the link's target (data)). Selection, search dimming and group colours style
  // nodes only; a filter, a search or the local graph's depth make new graph data. Each must give a new key.
  const cases: Array<[string, LinkLayerInputs]> = [
    ["a zoom", { ...base, transform: { ...base.transform, a: 0.6, d: 0.6 } }],
    ["a pan across", { ...base, transform: { ...base.transform, e: 401 } }],
    ["a pan down", { ...base, transform: { ...base.transform, f: 299 } }],
    ["a resize (width)", { ...base, width: 1601 }],
    ["a resize (height)", { ...base, height: 901 }],
    ["the worker moving nodes, or a node dragged", { ...base, positions: 4 }],
    ["new data: a filter, a search, the local graph's depth, a new page or link", { ...base, data: "2" }],
    ["a theme change (the idle colour)", { ...base, style: "rgba(9,9,9,0.32)|rgba(1,1,1,0.08)|1" }],
    ["a theme change (the faded colour)", { ...base, style: "rgba(1,1,1,0.32)|rgba(9,9,9,0.08)|1" }],
    ["a device pixel ratio change (the hairline width)", { ...base, style: "rgba(1,1,1,0.32)|rgba(1,1,1,0.08)|2" }],
  ];
  for (const [what, inputs] of cases) {
    it(`a new key for ${what}`, () => {
      expect(linkLayerKey(inputs)).not.toBe(linkLayerKey(base));
    });
  }

  it("the same key when nothing changed (a hover alone picks the other picture, it doesn't redraw it)", () => {
    expect(linkLayerKey({ ...base, transform: { ...base.transform } })).toBe(linkLayerKey(base));
  });

  const dashedByTarget = (link: { target: unknown }) => String((link.target as { id: string }).id).startsWith("?");

  it("draws every placed link once: plain ones in one path, links to a page not created yet in a dashed one", () => {
    const a = { id: "A", x: 0, y: 0 };
    const b = { id: "B", x: 10, y: 0 };
    const ghost = { id: "?Ghost", x: 5, y: 5 };
    const unplaced = { id: "C" };
    const nodes = [a, b, ghost, unplaced];
    const links = [
      { source: a, target: b },
      { source: b, target: a },
      { source: a, target: ghost },
      { source: a, target: unplaced },
    ];
    const { painter, calls, dashes } = recorder();
    paintRestingLinks(painter, buildLinkIndex(nodes, links, dashedByTarget), { color: "#123", widthCss: 0.99, scale: 0.5, dash: [4, 3] });
    expect(calls.filter((call) => call === "line")).toHaveLength(3);
    expect(calls.filter((call) => call === "stroke")).toHaveLength(2);
    expect(dashes).toEqual([[], [4, 3], []]);
    // force-graph's width: the CSS width over the zoom.
    expect(painter.widths).toEqual([1.98, 1.98]);
    expect(painter.strokeStyle).toBe("#123");
  });

  it("with nothing placed it draws nothing (and leaves no dash behind)", () => {
    const nodes = [{ id: "A", x: Number.NaN, y: 0 }, { id: "B", x: 1, y: 1 }];
    const { painter, calls, dashes } = recorder();
    paintRestingLinks(painter, buildLinkIndex(nodes, [{ source: nodes[0], target: nodes[1] }], () => false), { color: "#000", widthCss: 1, scale: 1, dash: [4, 3] });
    expect(calls).toEqual([]);
    expect(dashes).toEqual([[]]);
  });

  it("the index finds a link's ends by node or by id (before force-graph has bound them), and drops links to nodes not drawn", () => {
    const nodes = [{ id: "A", x: 0, y: 0 }, { id: "B", x: 1, y: 0 }];
    const index = buildLinkIndex(nodes, [{ source: nodes[0], target: nodes[1] }, { source: "B", target: "A" }, { source: "A", target: "Gone" }], () => false);
    expect(index.count).toBe(2);
    expect([...index.source.subarray(0, 2)]).toEqual([0, 1]);
    expect([...index.target.subarray(0, 2)]).toEqual([1, 0]);
  });

  // #znabmb8n: zoomed in, links wholly outside the view are not pathed (they cost Skia's stroke, clip and dash work).
  describe("culling to the view", () => {
    const view = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    const lines = (segments: Array<[[number, number], [number, number]]>, widthCss = 1, scale = 1) => {
      const nodes = segments.flatMap(([p, q], i) => [{ id: `s${i}`, x: p[0], y: p[1] }, { id: `t${i}`, x: q[0], y: q[1] }]);
      const links = segments.map((_, i) => ({ source: nodes[i * 2], target: nodes[i * 2 + 1] }));
      const { painter, calls } = recorder();
      paintRestingLinks(painter, buildLinkIndex(nodes, links, () => false), { color: "#000", widthCss, scale, dash: [4, 3], view });
      return calls.filter((call) => call === "line").length;
    };

    it("a link inside is drawn; one wholly left, right, above or below is not", () => {
      expect(lines([[[10, 10], [20, 20]]])).toBe(1);
      expect(lines([[[-50, 10], [-20, 90]]])).toBe(0);
      expect(lines([[[150, 10], [120, 90]]])).toBe(0);
      expect(lines([[[10, -50], [90, -20]]])).toBe(0);
      expect(lines([[[10, 150], [90, 120]]])).toBe(0);
    });

    it("a link crossing the view is kept, even with both ends outside (nothing visible goes missing)", () => {
      expect(lines([[[-50, 50], [150, 50]]])).toBe(1);
      expect(lines([[[50, -50], [50, 150]]])).toBe(1);
      expect(lines([[[-10, 50], [50, -10]]])).toBe(1);
    });

    it("a link just outside, within one line width, is kept (its stroke can still touch the edge)", () => {
      expect(lines([[[-0.5, 10], [-0.4, 90]]], 1, 1)).toBe(1);
      expect(lines([[[-3, 10], [-2, 90]]], 1, 1)).toBe(0);
    });

    it("without a view every placed link is drawn (as before)", () => {
      const nodes = [{ id: "A", x: -500, y: -500 }, { id: "B", x: -400, y: -400 }];
      const { painter, calls } = recorder();
      paintRestingLinks(painter, buildLinkIndex(nodes, [{ source: nodes[0], target: nodes[1] }], () => false), { color: "#000", widthCss: 1, scale: 1, dash: [] });
      expect(calls.filter((call) => call === "line")).toHaveLength(1);
    });

    it("the visible rectangle comes from the canvas transform (device px)", () => {
      // Zoom 2 at DPR 1, the graph's origin at (400, 300): the 800×600 canvas shows x -200…200, y -150…150.
      expect(visibleGraphRect({ a: 2, d: 2, e: 400, f: 300 }, 800, 600)).toEqual({ minX: -200, maxX: 200, minY: -150, maxY: 150 });
    });
  });

  // The pin (@opus-editor, @lead): a resting link's look comes only from what the key holds. If a link's colour,
  // width or dash ever read something more (a selection, a group's colour, a search), these functions would need
  // a new parameter, and the key a new part; this test is where that shows.
  describe("a link's look depends on the hover, the theme's colours, the DPR and the data, and nothing else", () => {
    const colors: LinkColors = { idle: "rgba(1,1,1,0.32)", faded: "rgba(1,1,1,0.08)", active: "rgba(2,2,2,0.85)" };

    it("colour: idle at rest; while hovering, active on the hovered node's links and faded elsewhere", () => {
      expect(linkColorFor("A", "B", null, colors)).toBe(colors.idle);
      expect(linkColorFor("A", "B", "A", colors)).toBe(colors.active);
      expect(linkColorFor("A", "B", "B", colors)).toBe(colors.active);
      expect(linkColorFor("A", "B", "C", colors)).toBe(colors.faded);
      // Four parameters, no more: a new input would be a new parameter (and a new part of the key).
      expect(linkColorFor.length).toBe(4);
    });

    it("width: every resting link (at rest or faded) has the resting hairline width for the DPR; only the hovered node's are wider", () => {
      for (const dpr of [1, 1.5, 2, 3]) {
        expect(linkWidthFor("A", "B", null, dpr)).toBe(restingLinkWidth(dpr));
        expect(linkWidthFor("A", "B", "C", dpr)).toBe(restingLinkWidth(dpr));
        expect(linkWidthFor("A", "B", "A", dpr)).toBeGreaterThan(restingLinkWidth(dpr));
      }
      expect(linkWidthFor.length).toBe(4);
    });

    it("dash: from the target alone (a page not created yet)", () => {
      expect(linkDashFor("Notes/Plan")).toBeNull();
      expect(linkDashFor("ghost:plan")).toEqual(GHOST_LINK_DASH);
      expect(linkDashFor.length).toBe(1);
    });

    it("the key's style part holds both resting colours and the DPR, each on its own", () => {
      const style = linkLayerStyle(colors, 1);
      expect(linkLayerStyle({ ...colors, idle: "x" }, 1)).not.toBe(style);
      expect(linkLayerStyle({ ...colors, faded: "x" }, 1)).not.toBe(style);
      expect(linkLayerStyle(colors, 2)).not.toBe(style);
      // The active colour is drawn live (the hovered node's links), never into the picture: not in the key.
      expect(linkLayerStyle({ ...colors, active: "x" }, 1)).toBe(style);
    });
  });
});
