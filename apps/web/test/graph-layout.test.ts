import { describe, expect, it } from "vitest";
import {
  LAYOUT_SETTINGS,
  LAYOUT_WORKER_THRESHOLD,
  createLayout,
  engineTicks,
  layoutInputFor,
  postInterval,
  type LayoutInput,
} from "../src/graph/layout-forces";

/**
 * #g95wkd9y: big graphs are laid out in a worker. Counted, never timed: the
 * main thread runs no force ticks for them, the worker's run is bounded, and
 * a re-run from current positions (a filter change, the threshold crossed)
 * doesn't jump.
 */

/** A vault-like graph: `count` pages in clusters of 20, each linking to a few in its cluster. */
function graph(count: number) {
  const nodes = Array.from({ length: count }, (_, i) => ({ id: `Page ${i}` }) as { id: string; x?: number; y?: number });
  const links: Array<{ source: string; target: string }> = [];
  for (let i = 0; i < count; i += 1) {
    const base = Math.floor(i / 20) * 20;
    for (const step of [1, 3, 7]) links.push({ source: `Page ${i}`, target: `Page ${base + ((i - base + step) % 20)}` });
  }
  return { nodes, links };
}

function input(count: number, overrides: Partial<LayoutInput> = {}): LayoutInput {
  const { nodes, links } = graph(count);
  return { ...layoutInputFor(nodes, links, { centerId: null, width: 1200, height: 800, reducedMotion: false }), ...overrides };
}

describe("graph layout off the main thread (#g95wkd9y)", () => {
  it("force-graph runs no ticks at all for a big graph; small graphs keep today's engine", () => {
    for (const count of [2000, 8000, 10_020]) {
      expect(engineTicks(count, false)).toEqual({ warmupTicks: 0, cooldownTicks: 0, worker: true });
      expect(engineTicks(count, true)).toEqual({ warmupTicks: 0, cooldownTicks: 0, worker: true });
    }
    expect(engineTicks(LAYOUT_WORKER_THRESHOLD, false)).toEqual({ warmupTicks: 40, cooldownTicks: 140, worker: false });
    expect(engineTicks(12, true)).toEqual({ warmupTicks: 90, cooldownTicks: 2, worker: false });
  });

  it("the worker's run is bounded: it settles within force-graph's own tick budget", () => {
    for (const reducedMotion of [false, true]) {
      const layout = createLayout(input(400, { reducedMotion }));
      let done = false;
      let calls = 0;
      while (!done && calls < 1000) {
        done = layout.tick();
        calls += 1;
      }
      expect(done).toBe(true);
      expect(layout.ticks).toBeLessThanOrEqual(reducedMotion ? LAYOUT_SETTINGS.maxTicksReduced : LAYOUT_SETTINGS.maxTicks);
      // Settled stays settled: no more ticks are run.
      expect(layout.tick()).toBe(true);
      const { x, y } = layout.positions();
      expect([...x, ...y].every(Number.isFinite)).toBe(true);
    }
  });

  it("links become index pairs; links to nodes not drawn are left out; the local graph's page is pinned", () => {
    // Five or more nodes: below that the local layout isn't stretched.
    const nodes = [{ id: "A" }, { id: "B", x: 10, y: -5 }, { id: "C" }, { id: "D" }, { id: "E" }];
    const links = [
      { source: "A", target: "B" },
      { source: "B", target: "Ghost" },
      { source: "C", target: "A" },
    ];
    const built = layoutInputFor(nodes, links, { centerId: "B", width: 300, height: 900, reducedMotion: true });
    expect([...built.links]).toEqual([0, 1, 2, 0]);
    expect(built.pinned).toBe(1);
    expect(built.x[1]).toBe(10);
    expect(built.y[1]).toBe(-5);
    expect(Number.isNaN(built.x[0])).toBe(true);
    expect(built.reducedMotion).toBe(true);
    // A tall panel shapes the local layout: a weaker pull across, a stronger one down.
    expect(built.centerStrengthX).toBeGreaterThan(built.centerStrengthY);
    const layout = createLayout(built);
    while (!layout.tick());
    const { x, y } = layout.positions();
    expect([x[1], y[1]]).toEqual([0, 0]);
  });

  it("a re-run from the current positions doesn't jump (a filter change, or the threshold crossed)", () => {
    // Settle once, then start again from those positions, as GraphCanvas does.
    // The layout code doesn't depend on the threshold: 400 nodes test the same thing.
    const first = createLayout(input(400));
    while (!first.tick());
    const settled = first.positions();
    const again = createLayout(input(400, { x: Float32Array.from(settled.x), y: Float32Array.from(settled.y) }));
    again.tick();
    const resumed = again.positions();
    const fresh = createLayout(input(400));
    fresh.tick();
    const scratch = fresh.positions();
    const moved = (a: Float32Array, b: Float32Array, c: Float32Array, d: Float32Array) => {
      let max = 0;
      for (let i = 0; i < a.length; i += 1) max = Math.max(max, Math.hypot(a[i]! - c[i]!, b[i]! - d[i]!));
      return max;
    };
    // The first step from a settled layout moves nodes a little; from scratch they fly.
    const fromSettled = moved(resumed.x, resumed.y, settled.x, settled.y);
    const fromScratch = moved(scratch.x, scratch.y, settled.x, settled.y);
    expect(fromSettled).toBeLessThan(fromScratch / 10);
  });

  it("the bigger the graph, the fewer position updates (each repaint is costly): 100 ms to 1 s", () => {
    expect(postInterval(LAYOUT_WORKER_THRESHOLD)).toBe(150);
    expect(postInterval(500)).toBe(100);
    expect(postInterval(5_000)).toBe(500);
    expect(postInterval(10_020)).toBe(1000);
    expect(postInterval(50_000)).toBe(1000);
  });
});
