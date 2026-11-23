import { describe, expect, it } from "vitest";
import { createZoomVar, zoomVarTargets, type ZoomVarElement } from "../src/board/zoom-var";

/**
 * #zkknytrs (perf offender 5): what one Ctrl+wheel zoom step restyles. An
 * inherited custom property written on an element restyles its whole subtree,
 * so each write is counted as the number of elements under it. Written on the
 * board root (the old way), a step restyled every object and all four of its
 * connection dots: ~5,000 elements at 1,000 objects, 60 times per gesture.
 * Work is counted, never timed.
 */

const DOTS = 4;

interface FakeNode extends ZoomVarElement {
  selected: boolean;
  hover: boolean;
  subtree: number;
  writes: number;
}

function fakeElement(subtree: number) {
  const element = {
    isConnected: true,
    subtree,
    writes: 0,
    selected: false,
    hover: false,
    style: {
      setProperty: () => {
        element.writes += 1;
      },
      removeProperty: () => {
        element.writes += 1;
        return "";
      },
    },
  };
  return element;
}

function fakeBoard(objects: number) {
  const nodes: FakeNode[] = Array.from({ length: objects }, () => fakeElement(1 + DOTS));
  const root = Object.assign(fakeElement(1 + objects * (1 + DOTS)), {
    querySelectorAll(selector: string) {
      expect(selector).toBe(".react-flow__node.selected, .react-flow__node:hover");
      return nodes.filter((node) => node.selected || node.hover);
    },
  });
  return { root, nodes };
}

/** Elements restyled by the writes since the last call. */
function restyled(elements: Array<{ writes: number; subtree: number }>): number {
  let total = 0;
  for (const element of elements) {
    total += element.writes * element.subtree;
    element.writes = 0;
  }
  return total;
}

/** The board-perf gesture: 30 steps in, 30 out, from a fitted 1,000-object board. */
function zoomGesture(start: number): number[] {
  const steps: number[] = [];
  let zoom = start;
  for (let i = 0; i < 60; i += 1) {
    zoom *= i < 30 ? 1.05 : 1 / 1.05;
    steps.push(zoom);
  }
  return steps;
}

describe("a zoom step restyles only where connection dots show (#zkknytrs)", () => {
  it("with one object hovered and nothing selected: that object only, never the board", () => {
    const { root, nodes } = fakeBoard(1000);
    nodes[500]!.hover = true;
    const zoomVar = createZoomVar<FakeNode>();
    const all = [root, ...nodes];
    for (const zoom of zoomGesture(0.1)) {
      // What BoardEditor does per viewport change, plus its next-frame pass.
      zoomVar.sync(zoomVarTargets(root as unknown as Element, false) as unknown as FakeNode[], zoom);
      zoomVar.sync(zoomVarTargets(root as unknown as Element, false) as unknown as FakeNode[], zoom);
      expect(restyled(all)).toBeLessThanOrEqual(1 + DOTS);
    }
    expect(root.writes).toBe(0);
  });

  it("with a few objects selected: those objects, a handful of elements per step", () => {
    const { root, nodes } = fakeBoard(1000);
    for (const index of [3, 40, 700]) nodes[index]!.selected = true;
    const zoomVar = createZoomVar<FakeNode>();
    const all = [root, ...nodes];
    let total = 0;
    for (const zoom of zoomGesture(0.1)) {
      zoomVar.sync(zoomVarTargets(root as unknown as Element, false) as unknown as FakeNode[], zoom);
      total += restyled(all);
    }
    expect(total).toBe(60 * 3 * (1 + DOTS));
  });

  it("is written once per change: a pass at the same zoom writes nothing", () => {
    const { root, nodes } = fakeBoard(1000);
    nodes[1]!.selected = true;
    const zoomVar = createZoomVar<FakeNode>();
    const targets = () => zoomVarTargets(root as unknown as Element, false) as unknown as FakeNode[];
    zoomVar.sync(targets(), 0.5);
    restyled([root, ...nodes]);
    zoomVar.sync(targets(), 0.5);
    expect(restyled([root, ...nodes])).toBe(0);
  });

  it("moves with the hover and the selection, clearing what is no longer shown", () => {
    const { root, nodes } = fakeBoard(10);
    const zoomVar = createZoomVar<FakeNode>();
    const targets = () => zoomVarTargets(root as unknown as Element, false) as unknown as FakeNode[];
    nodes[0]!.hover = true;
    zoomVar.sync(targets(), 0.5);
    expect(nodes[0]!.writes).toBe(1);
    nodes[0]!.hover = false;
    nodes[1]!.hover = true;
    zoomVar.sync(targets(), 0.5);
    // Removed from the old one, written on the new one.
    expect(nodes[0]!.writes).toBe(2);
    expect(nodes[1]!.writes).toBe(1);
  });

  it("goes on the whole board only with the connector tool (every dot shows), and comes off it after", () => {
    const { root, nodes } = fakeBoard(1000);
    const zoomVar = createZoomVar<FakeNode>();
    zoomVar.sync(zoomVarTargets(root as unknown as Element, true) as unknown as FakeNode[], 0.4);
    expect(root.writes).toBe(1);
    zoomVar.sync(zoomVarTargets(root as unknown as Element, false) as unknown as FakeNode[], 0.4);
    expect(root.writes).toBe(2);
    expect(nodes.every((node) => node.writes === 0)).toBe(true);
  });
});
