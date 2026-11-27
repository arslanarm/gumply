import { describe, expect, it } from "vitest";
import type { CanvasBoard, CanvasNode } from "@gumply/core";
import { alignNodes, distributeNodes } from "../src/board/align";

/**
 * #b9425ktw D (#fzrwse3y's P3 6): align and distribute a multi-selection. Only the selected items move, only on
 * the one axis; a selection of one (align) or two (distribute) is unchanged; edges keep their ends (they name ids).
 */

const node = (id: string, x: number, y: number, width = 100, height = 50): CanvasNode =>
  ({ id, type: "text", text: id, x, y, width, height }) as CanvasNode;
const board = (...nodes: CanvasNode[]): CanvasBoard => ({ nodes, edges: [] }) as CanvasBoard;
const at = (b: CanvasBoard) => Object.fromEntries(b.nodes.map((n) => [n.id, [n.x, n.y]]));

describe("alignNodes", () => {
  const b = board(node("a", 0, 0, 100, 50), node("b", 40, 200, 200, 80), node("c", 300, 90, 60, 60), node("other", 900, 900));
  const ids = new Set(["a", "b", "c"]);

  it("left, centre and right line up the edges or middles on x; y is untouched", () => {
    expect(at(alignNodes(b, ids, "left"))).toEqual({ a: [0, 0], b: [0, 200], c: [0, 90], other: [900, 900] });
    // The selection spans 0..360, its middle is 180.
    expect(at(alignNodes(b, ids, "center"))).toEqual({ a: [130, 0], b: [80, 200], c: [150, 90], other: [900, 900] });
    expect(at(alignNodes(b, ids, "right"))).toEqual({ a: [260, 0], b: [160, 200], c: [300, 90], other: [900, 900] });
  });

  it("top, middle and bottom on y; x is untouched", () => {
    expect(at(alignNodes(b, ids, "top"))).toEqual({ a: [0, 0], b: [40, 0], c: [300, 0], other: [900, 900] });
    // The selection spans 0..280, its middle is 140.
    expect(at(alignNodes(b, ids, "middle"))).toEqual({ a: [0, 115], b: [40, 100], c: [300, 110], other: [900, 900] });
    expect(at(alignNodes(b, ids, "bottom"))).toEqual({ a: [0, 230], b: [40, 200], c: [300, 220], other: [900, 900] });
  });

  it("one item, or all already aligned: the same board (no undo step)", () => {
    expect(alignNodes(b, new Set(["a"]), "left")).toBe(b);
    const lined = alignNodes(b, ids, "left");
    expect(alignNodes(lined, ids, "left")).toBe(lined);
  });
});

describe("distributeNodes", () => {
  it("horizontally: equal gaps between items, first and last stay", () => {
    const b = board(node("a", 0, 0, 100), node("b", 130, 40, 50), node("c", 500, 10, 100));
    // Span 0..600, widths 250, so the two gaps are 175 each: b goes to 275.
    expect(at(distributeNodes(b, new Set(["a", "b", "c"]), "horizontal"))).toEqual({ a: [0, 0], b: [275, 40], c: [500, 10] });
  });

  it("vertically, in the items' order on y, whatever their order in the file", () => {
    const b = board(node("low", 0, 400, 100, 100), node("top", 50, 0, 100, 100), node("mid", 20, 120, 100, 50));
    // Span 0..500, heights 250, so gaps of 125: mid goes to 225.
    expect(at(distributeNodes(b, new Set(["low", "top", "mid"]), "vertical"))).toEqual({ low: [0, 400], top: [50, 0], mid: [20, 225] });
  });

  it("fewer than three items: the same board", () => {
    const b = board(node("a", 0, 0), node("b", 300, 0));
    expect(distributeNodes(b, new Set(["a", "b"]), "horizontal")).toBe(b);
  });
});
