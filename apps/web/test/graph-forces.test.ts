import { describe, expect, it } from "vitest";
import { DEFAULT_GRAPH_FORCES, type GraphForces } from "@gumply/core";
import { createLayout, forcesToken, forceStrengths, layoutInputFor } from "../src/graph/layout-forces";

/**
 * #nadk3urm: the graph panel's Forces (multipliers on Gumply's own forces, 1 =
 * unchanged) reach the layout. Two groups of 20 pages, linked inside, with no
 * link between them: the centre pull is all that keeps them near each other,
 * so with Center at 0 they drift apart.
 */

function twoGroups() {
  const nodes = Array.from({ length: 40 }, (_, i) => ({ id: `Page ${i}` }) as { id: string; x?: number; y?: number });
  const links: Array<{ source: string; target: string }> = [];
  for (let i = 0; i < 40; i += 1) {
    const base = i < 20 ? 0 : 20;
    for (const step of [1, 3, 7]) links.push({ source: `Page ${i}`, target: `Page ${base + ((i - base + step) % 20)}` });
  }
  return { nodes, links };
}

/** The distance between the two groups' centroids once the layout has settled. */
function groupGap(change: Partial<GraphForces> = {}): number {
  const { nodes, links } = twoGroups();
  // Whole forces, as the app always passes them (normalised settings): a partial set would leave NaN strengths.
  const forces: GraphForces = { ...DEFAULT_GRAPH_FORCES, ...change };
  const layout = createLayout(layoutInputFor(nodes, links, { centerId: null, width: 1200, height: 800, reducedMotion: false, forces }));
  while (!layout.tick());
  const { x, y } = layout.positions();
  const centroid = (from: number) => {
    let sx = 0;
    let sy = 0;
    for (let i = from; i < from + 20; i += 1) {
      sx += x[i]!;
      sy += y[i]!;
    }
    return [sx / 20, sy / 20] as const;
  };
  const [ax, ay] = centroid(0);
  const [bx, by] = centroid(20);
  return Math.hypot(bx - ax, by - ay);
}

describe("graph Forces (#nadk3urm)", () => {
  it("Center at 0 lets two unlinked groups drift apart; the default pull keeps them close", () => {
    const pulled = groupGap();
    const free = groupGap({ center: 0 });
    // Measured (2026-11-26): 142 → 533 px for these groups of 20 (×3.75); ×2.9–3.75 for groups of 10–200.
    expect(free).toBeGreaterThan(pulled * 2.5);
  });

  it("at the defaults every force is exactly the one used before the Forces existed, at every size", () => {
    // The constants as they were (layout-forces.ts and GraphCanvas before #nadk3urm).
    const before = (count: number) => ({
      chargeStrength: -60 - Math.min(180, count * 0.6),
      center: count <= 12 ? 0.22 : count <= 60 ? 0.16 : 0.12,
    });
    for (const count of [3, 12, 13, 60, 61, 300, 1500, 10_000]) {
      for (const forces of [undefined, DEFAULT_GRAPH_FORCES]) {
        const now = forceStrengths(count, { local: false, width: 800, height: 600, forces });
        expect(now).toEqual({
          chargeStrength: before(count).chargeStrength,
          centerStrengthX: before(count).center,
          centerStrengthY: before(count).center,
          linkStrength: 0.45,
          linkDistance: 52,
        });
      }
    }
  });

  it("each slider scales its own force only (the local graph's panel stretch included)", () => {
    const base = forceStrengths(100, { local: true, width: 300, height: 900 });
    const scaled = forceStrengths(100, { local: true, width: 300, height: 900, forces: { center: 0.5, repel: 2, linkStrength: 0, linkDistance: 3 } });
    expect(scaled.centerStrengthX).toBeCloseTo(base.centerStrengthX * 0.5, 12);
    expect(scaled.centerStrengthY).toBeCloseTo(base.centerStrengthY * 0.5, 12);
    expect(scaled.chargeStrength).toBeCloseTo(base.chargeStrength * 2, 12);
    expect(scaled.linkStrength).toBe(0);
    expect(scaled.linkDistance).toBeCloseTo(base.linkDistance * 3, 12);
    // The worker gets them through layoutInputFor.
    const { nodes, links } = twoGroups();
    const input = layoutInputFor(nodes, links, { centerId: null, width: 800, height: 600, reducedMotion: false, forces: { ...DEFAULT_GRAPH_FORCES, linkDistance: 2 } });
    expect(input.linkDistance).toBe(104);
  });

  it("the layout cache keeps its key at the defaults (kept layouts stay valid), and a changed force gets its own", () => {
    expect(forcesToken(undefined)).toBe("");
    expect(forcesToken(DEFAULT_GRAPH_FORCES)).toBe("");
    const a = forcesToken({ ...DEFAULT_GRAPH_FORCES, center: 0 });
    const b = forcesToken({ ...DEFAULT_GRAPH_FORCES, repel: 0 });
    expect(a).not.toBe("");
    expect(a).not.toBe(b);
    expect(forcesToken({ ...DEFAULT_GRAPH_FORCES, center: 0 })).toBe(a);
  });
});
