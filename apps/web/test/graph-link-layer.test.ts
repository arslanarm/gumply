import { describe, expect, it } from "vitest";
import { linkLayerKey, paintRestingLinks, type LinkLayerInputs, type LinkPainter } from "../src/graph/link-layer";

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

  it("draws every placed link once: plain ones in one path, links to a page not created yet in a dashed one", () => {
    const a = { id: "A", x: 0, y: 0 };
    const b = { id: "B", x: 10, y: 0 };
    const ghost = { id: "?Ghost", x: 5, y: 5 };
    const unplaced = { id: "C" };
    const links = [
      { source: a, target: b },
      { source: b, target: a },
      { source: a, target: ghost },
      { source: a, target: unplaced },
    ];
    const { painter, calls, dashes } = recorder();
    paintRestingLinks(painter, links, { color: "#123", widthCss: 0.99, scale: 0.5, dash: [4, 3], isDashed: (link) => (link.target as { id: string }).id.startsWith("?") });
    expect(calls.filter((call) => call === "line")).toHaveLength(3);
    expect(calls.filter((call) => call === "stroke")).toHaveLength(2);
    expect(dashes).toEqual([[], [4, 3], []]);
    // force-graph's width: the CSS width over the zoom.
    expect(painter.widths).toEqual([1.98, 1.98]);
    expect(painter.strokeStyle).toBe("#123");
  });

  it("with nothing placed it draws nothing (and leaves no dash behind)", () => {
    const { painter, calls, dashes } = recorder();
    paintRestingLinks(painter, [{ source: { x: Number.NaN, y: 0 }, target: { x: 1, y: 1 } }], { color: "#000", widthCss: 1, scale: 1, dash: [4, 3], isDashed: () => false });
    expect(calls).toEqual([]);
    expect(dashes).toEqual([[]]);
  });
});
