import { describe, expect, it } from "vitest";
import { groupLinks, layerContext, layerFactor, layerSize } from "../src/graph/link-layer";

/** #s3sszwux (iii), from N6 c0: the half-resolution CPU link layer's size, grouping and context (the drawing itself is measured in the browser). */
describe("the half-resolution link layer (N6 c0)", () => {
  it("is half the main canvas, rounded up, never empty", () => {
    expect(layerSize(1288, 680)).toEqual({ width: 644, height: 340 });
    expect(layerSize(1289, 681)).toEqual({ width: 645, height: 341 });
    expect(layerSize(0, 0)).toEqual({ width: 1, height: 1 });
  });

  it("groups placed links by slot, as flat endpoint coordinates, and skips the rest", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 10, y: 5 };
    const c = { x: -3, y: 7 };
    const unplaced = { x: undefined, y: 1 };
    const links = [
      { source: a, target: b, slot: 0 },
      { source: b, target: c, slot: 2 },
      { source: a, target: c, slot: 0 },
      { source: a, target: unplaced, slot: 0 }, // an end not placed yet
      { source: "A", target: "B", slot: 0 }, // ids, not yet resolved to nodes
      { source: b, target: a, slot: -1 }, // not drawn
      { source: c, target: b, slot: 9 }, // no such slot
    ];
    const groups = groupLinks(links, 3, (link) => link.slot);
    expect(groups).toEqual([[0, 0, 10, 5, 0, 0, -3, 7], [], [10, 5, -3, 7]]);
  });

  it("makes its context once, as a CPU canvas (willReadFrequently), and reuses it", () => {
    const calls: Array<[string, unknown]> = [];
    const context = { tag: "ctx" } as unknown as CanvasRenderingContext2D;
    const canvas = { getContext: (kind: string, options: unknown) => (calls.push([kind, options]), context) } as unknown as HTMLCanvasElement;
    const layer = { canvas, context: undefined as CanvasRenderingContext2D | null | undefined };
    expect(layerContext(layer)).toBe(context);
    expect(layerContext(layer)).toBe(context);
    expect(calls).toEqual([["2d", { willReadFrequently: true }]]);
  });

  it("half resolution when zoomed out, full when zoomed in (crisp lines at 3×)", () => {
    expect(layerFactor(0.2)).toBe(0.5);
    expect(layerFactor(0.99)).toBe(0.5);
    expect(layerFactor(1)).toBe(1);
    expect(layerFactor(3)).toBe(1);
    expect(layerSize(1288, 680, layerFactor(3))).toEqual({ width: 1288, height: 680 });
    expect(layerSize(1288, 680, layerFactor(0.3))).toEqual({ width: 644, height: 340 });
  });
});
