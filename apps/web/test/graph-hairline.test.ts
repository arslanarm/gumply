import { describe, expect, it } from "vitest";
import { restingLinkWidth } from "../src/graph/link-width";

/**
 * #s3sszwux: force-graph strokes all resting links as one path whose device width is
 * `linkWidth × devicePixelRatio` (the zoom cancels out). At one device pixel or more, Skia
 * leaves its hairline path and that one ~123k-segment stroke takes tens of seconds. Guard:
 * the resting width stays under one device pixel at every ratio, with a margin for float error.
 */
describe("resting link width stays under one device pixel (#s3sszwux)", () => {
  for (const dpr of [1, 1.25, 1.5, 2, 3]) {
    it(`at devicePixelRatio ${dpr}`, () => {
      const device = restingLinkWidth(dpr) * dpr;
      expect(device).toBeLessThan(1);
      expect(device).toBeGreaterThan(0.95); // still a full-looking line
      // The same at the zooms a big graph settles at: width / k under a k × dpr transform.
      for (const k of [0.06, 0.226, 0.7, 1, 3]) expect(((restingLinkWidth(dpr) / k) * k * dpr)).toBeLessThan(1);
    });
  }
  it("a missing or odd ratio is treated as 1", () => {
    expect(restingLinkWidth(Number.NaN)).toBeCloseTo(0.99);
    expect(restingLinkWidth(0)).toBeCloseTo(0.99);
  });
});
