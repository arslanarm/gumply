import { describe, expect, it } from "vitest";
import {
  capAlpha,
  fitZoom,
  hitRadiusPx,
  MIN_HIT_RADIUS_PX,
  pickNode,
  visibleBounds,
  type AlphaForce,
} from "../src/graph/graph-interaction";

const radius = (node: { r: number }) => node.r;

describe("hitRadiusPx", () => {
  it("gives even the smallest node a 28 px target", () => {
    expect(hitRadiusPx(4)).toBe(MIN_HIT_RADIUS_PX);
    expect(MIN_HIT_RADIUS_PX * 2).toBeGreaterThanOrEqual(28);
  });

  it("grows with big nodes", () => {
    expect(hitRadiusPx(9)).toBe(15);
  });
});

describe("pickNode", () => {
  const nodes = [
    { id: "small", x: 0, y: 0, r: 4 },
    { id: "big", x: 30, y: 0, r: 9 },
    { id: "unplaced", r: 4 },
  ];

  it("hits a small node well outside its drawn circle", () => {
    expect(pickNode(nodes, 12, 0, 1, radius)?.id).toBe("small");
  });

  it("misses when the pointer is beyond every hit area", () => {
    expect(pickNode(nodes, 0, 40, 1, radius)).toBeNull();
  });

  it("works in screen px at any zoom", () => {
    // At zoom 2, 6 graph units = 12 screen px from the small node.
    expect(pickNode(nodes, 6, 0, 2, radius)?.id).toBe("small");
    // At zoom 0.5, 20 graph units = 10 screen px.
    expect(pickNode(nodes, 0, 20, 0.5, radius)?.id).toBe("small");
    expect(pickNode(nodes, 0, 40, 0.5, radius)).toBeNull();
  });

  it("prefers the node whose edge is closest when hit areas overlap", () => {
    const close = [
      { id: "small", x: 0, y: 0, r: 4 },
      { id: "big", x: 24, y: 0, r: 9 },
    ];
    // 13 px from small (edge 9 px away), 11 px from big (edge 2 px away).
    expect(pickNode(close, 13, 0, 1, radius)?.id).toBe("big");
    // On top of the small node it always wins, even beside a big one.
    expect(pickNode(close, 2, 0, 1, radius)?.id).toBe("small");
  });

  it("ignores nodes without a position yet", () => {
    expect(pickNode([{ id: "unplaced", r: 4 }], 0, 0, 1, radius)).toBeNull();
  });
});

describe("capAlpha", () => {
  function recordingForce(): AlphaForce & { seen: number[] } {
    const seen: number[] = [];
    const force = ((alpha: number) => {
      seen.push(alpha);
    }) as AlphaForce & { seen: number[] };
    force.seen = seen;
    force.strength = (value: number) => {
      force.lastStrength = value;
      return force;
    };
    return force;
  }

  it("passes alpha through until a cap is set", () => {
    const inner = recordingForce();
    const cap = { current: Number.POSITIVE_INFINITY };
    const wrapped = capAlpha(inner, cap);
    wrapped(1);
    cap.current = 0.25;
    wrapped(1);
    wrapped(0.1);
    expect(inner.seen).toEqual([1, 0.25, 0.1]);
  });

  it("keeps the force's setters working on the original force", () => {
    const inner = recordingForce();
    const wrapped = capAlpha(inner, { current: 1 });
    (wrapped.strength as (value: number) => unknown)(-80);
    expect(inner.lastStrength).toBe(-80);
  });

  it("never wraps twice", () => {
    const inner = recordingForce();
    const cap = { current: 0.5 };
    const twice = capAlpha(capAlpha(inner, cap), cap);
    twice(1);
    expect(inner.seen).toEqual([0.5]);
  });
});

describe("visibleBounds", () => {
  it("inverts zoom, pan and device pixel ratio", () => {
    // DPR 2, zoom 0.5 → 1 graph unit = 1 device px; graph origin at device (100, 50).
    const bounds = visibleBounds({ a: 1, d: 1, e: 100, f: 50 }, 800, 600, 0);
    expect(bounds).toEqual({ minX: -100, maxX: 700, minY: -50, maxY: 550 });
  });

  it("adds a margin so labels and halos at the edge are still drawn", () => {
    const bounds = visibleBounds({ a: 2, d: 2, e: 0, f: 0 }, 400, 400, 40);
    expect(bounds.minX).toBe(-20);
    expect(bounds.maxX).toBe(220);
  });
});

describe("fitZoom", () => {
  const dot = (x: number, y: number, r = 4) => ({ x, y, left: r, right: r, top: r, bottom: r });

  it("fits the farthest node, keeping its screen-space extent inside", () => {
    // 100 units right, 4 px radius, 104 px of room → (104 − 4) / 100 = 1.
    expect(fitZoom([dot(0, 0), dot(100, 0)], 0, 0, 104, 500)).toBeCloseTo(1);
  });

  it("makes room for a wide label on either side (#z5abndiz)", () => {
    const labelled = { x: 100, y: 0, left: 50, right: 50, top: 4, bottom: 22 };
    // (150 − 50) / 100 = 1: the label's half-width is kept inside.
    expect(fitZoom([labelled], 0, 0, 150, 500)).toBeCloseTo(1);
    // The same node to the left is limited by its left extent.
    expect(fitZoom([{ ...labelled, x: -100 }], 0, 0, 150, 500)).toBeCloseTo(1);
  });

  it("centres on a given point, so a far neighbour on one side decides the zoom", () => {
    // Centre on the current page at 0: the node at −200 needs the smaller zoom.
    const zoom = fitZoom([dot(0, 0), dot(50, 0), dot(-200, 0)], 0, 0, 104, 500);
    expect(zoom).toBeCloseTo(0.5);
  });

  it("uses the bottom extent for nodes below the centre (labels hang below)", () => {
    const item = { x: 0, y: 100, left: 4, right: 4, top: 4, bottom: 24 };
    expect(fitZoom([item], 0, 0, 500, 124)).toBeCloseTo(1);
  });

  it("is unbounded when everything sits on the centre", () => {
    expect(fitZoom([dot(0, 0)], 0, 0, 100, 100)).toBe(Number.POSITIVE_INFINITY);
  });
});
