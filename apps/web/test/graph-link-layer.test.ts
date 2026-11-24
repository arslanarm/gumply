import { describe, expect, it } from "vitest";
import { groupLinks, layerContext, layerSize } from "../src/graph/link-layer";

/** #s3sszwux (iii), from N6 c0: the half-resolution CPU link layer's size, grouping and context (the drawing itself is measured in the browser). */
describe("the half-resolution link layer (N6 c0)", () => {
  it("is the main canvas's size by default (the links look as force-graph drew them); a factor scales it, rounded up, never empty", () => {
    expect(layerSize(1288, 680)).toEqual({ width: 1288, height: 680 });
    expect(layerSize(1288, 680, 0.5)).toEqual({ width: 644, height: 340 });
    expect(layerSize(1289, 681, 0.5)).toEqual({ width: 645, height: 341 });
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
});

describe("chunked link strokes (#s3sszwux v)", () => {
  it("strokes each slot in paths of at most `chunk` segments, with the slot's style, and counts the links", async () => {
    const { drawLinksChunked } = await import("../src/graph/link-layer");
    const calls: string[] = [];
    let segments = 0;
    const ctx = {
      strokeStyle: "" as string | CanvasGradient | CanvasPattern,
      lineWidth: 0,
      beginPath: () => { calls.push("begin"); segments = 0; },
      moveTo: () => undefined,
      lineTo: () => { segments += 1; },
      stroke: () => { calls.push(`stroke:${segments}:${String(ctx.strokeStyle)}:${ctx.lineWidth}`); },
      setLineDash: () => undefined,
    };
    const p = (x: number) => ({ x, y: 0 });
    const links = Array.from({ length: 7 }, (_, i) => ({ source: p(i), target: p(i + 1), slot: i < 5 ? 0 : 1 }));
    const counts = drawLinksChunked(ctx, links, [{ color: "a", width: 1, dash: null }, { color: "b", width: 2, dash: null }], (link) => link.slot, 2, 2);
    expect(counts).toEqual([5, 2]);
    // Slot 0: 5 links in strokes of 2, 2 and 1; slot 1: one stroke of 2. Width is in graph units (/ scale).
    expect(calls).toEqual(["begin", "stroke:2:a:0.5", "begin", "stroke:2:a:0.5", "begin", "stroke:1:a:0.5", "begin", "stroke:2:b:1"]);
  });
});
