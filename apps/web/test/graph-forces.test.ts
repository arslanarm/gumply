import { describe, expect, it } from "vitest";
import { createLayout, layoutInputFor } from "../src/graph/layout-forces";

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
function groupGap(forces?: { center?: number; repel?: number; linkStrength?: number; linkDistance?: number }): number {
  const { nodes, links } = twoGroups();
  const options = { centerId: null, width: 1200, height: 800, reducedMotion: false, forces } as Parameters<typeof layoutInputFor>[2];
  const layout = createLayout(layoutInputFor(nodes, links, options));
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
    expect(free).toBeGreaterThan(pulled * 1.5);
  });
});
