import { describe, expect, it } from "vitest";
import { ACTIVE_LINK_WIDTH, ghostStrokeWidth, linkWidthFor, restingLinkWidth } from "../src/graph/link-width";

/**
 * #s3sszwux: force-graph strokes all resting (and faded) links as one path, with `lineWidth =
 * width / k` under a `k × devicePixelRatio` transform. Skia computes that device width in float32;
 * at one device pixel or more, even a float32 hair above 1 (width 1 at k = 0.328144; a sweep of
 * fit zooms found one near k ≈ 0.333), it leaves its hairline path and that one ~123k-segment stroke takes ~50 s instead of ~0.45 s. Guard, through
 * the same function `GraphCanvas` passes to force-graph: that stroke stays under one device pixel.
 */
const f = Math.fround;
/** The device width Skia sees: float32 `lineWidth` times the float32 scale of the transform. */
const deviceWidth = (width: number, k: number, dpr: number) => f(f(width / k) * f(k * dpr));

const ZOOMS = [0.06, 0.226, 0.328144, 0.44, 0.7, 1, 3, 8]; // min zoom, settle fits, the float32 case, max
const RATIOS = [1, 1.25, 1.5, 2, 3];

describe("the batched link stroke stays under one device pixel (#s3sszwux)", () => {
  it("the check itself sees the float32 case: width 1 at k = 0.328144 lands above 1", () => {
    expect((1 / 0.328144) * 0.328144).toBe(1); // float64 hides it
    expect(deviceWidth(1, 0.328144, 1)).toBeGreaterThan(1); // float32, as Skia, shows it
  });

  for (const dpr of RATIOS) {
    it(`resting and faded links at devicePixelRatio ${dpr}`, () => {
      const resting = linkWidthFor("a", "b", null, dpr);
      const faded = linkWidthFor("a", "b", "c", dpr);
      for (const width of [resting, faded]) {
        expect(f(width * dpr)).toBeGreaterThan(0.95); // still a full-looking line
        for (const k of ZOOMS) expect(deviceWidth(width, k, dpr)).toBeLessThan(1);
      }
    });
  }

  for (const dpr of RATIOS) {
    it(`N6 3b: the dashed ghost circles at devicePixelRatio ${dpr} (#9x4duwmg)`, () => {
      const width = ghostStrokeWidth(dpr);
      expect(f(width * dpr)).toBeGreaterThan(0.95);
      for (const k of ZOOMS) expect(deviceWidth(width, k, dpr)).toBeLessThan(1);
    });
  }

  it("only the hovered node's links are wider", () => {
    expect(linkWidthFor("h", "b", "h", 1)).toBe(ACTIVE_LINK_WIDTH);
    expect(linkWidthFor("a", "h", "h", 2)).toBe(ACTIVE_LINK_WIDTH);
    expect(linkWidthFor("a", "b", "h", 2)).toBe(restingLinkWidth(2));
  });

  it("a missing or odd ratio is treated as 1", () => {
    expect(restingLinkWidth(Number.NaN)).toBeCloseTo(0.99);
    expect(restingLinkWidth(0)).toBeCloseTo(0.99);
  });
});
