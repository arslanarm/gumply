/**
 * Pointer picking and drag physics for the graph canvas (#74jpajdy).
 *
 * force-graph's built-in picking reads a hidden "shadow" canvas that it only
 * repaints every 800 ms, so while the layout moves (or right after a zoom) the
 * hit areas lag behind what is drawn: hover arrived up to 2 s late and grabs
 * missed. We pick geometrically against the live node positions instead.
 */

/** Smallest hit radius in CSS px: a 28 px target, as spec/ux asks for controls. */
export const MIN_HIT_RADIUS_PX = 14;
/** Extra px around a node's drawn circle that still counts as a hit. */
export const HIT_SLOP_PX = 6;
/** Pointer travel (CSS px) before a press on a node becomes a drag, not a click. */
export const DRAG_THRESHOLD_PX = 4;
/** Simulation intensity while a node is dragged (neighbours follow, calmly). */
export const DRAG_ALPHA = 0.25;

export interface PickCandidate {
  id: string;
  /** Graph-space position. */
  x?: number;
  y?: number;
}

export function hitRadiusPx(drawnRadiusPx: number): number {
  return Math.max(drawnRadiusPx + HIT_SLOP_PX, MIN_HIT_RADIUS_PX);
}

/**
 * The node under a pointer, or null. `gx/gy` is the pointer in graph space and
 * `scale` the zoom (screen px per graph unit). Overlapping hit areas go to the
 * node whose drawn edge is closest, so a small node next to a big one is still
 * reachable and the node actually under the cursor always wins.
 */
export function pickNode<T extends PickCandidate>(
  nodes: readonly T[],
  gx: number,
  gy: number,
  scale: number,
  radiusPx: (node: T) => number,
): T | null {
  const k = Math.max(scale, 1e-6);
  let best: T | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const node of nodes) {
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) continue;
    const distancePx = Math.hypot((node.x as number) - gx, (node.y as number) - gy) * k;
    const radius = radiusPx(node);
    if (distancePx > hitRadiusPx(radius)) continue;
    const score = distancePx - radius;
    if (score < bestScore) {
      bestScore = score;
      best = node;
    }
  }
  return best;
}

/** A d3 force: called with alpha every tick, plus setters (`initialize`, `links`, …). */
export type AlphaForce = ((alpha: number) => void) & Record<string, unknown>;

const CAPPED = "__gumplyAlphaCap";

/**
 * Wrap a d3 force so it never sees an alpha above `cap.current`.
 *
 * force-graph can only restart a stopped simulation through
 * `d3ReheatSimulation()`, which jumps alpha to 1 and would make the whole graph
 * lurch when you start dragging. Capping what the forces see gives the calm
 * "alphaTarget 0.3" feel of d3's drag example instead. `Infinity` = no cap.
 * The setters are copied over, so force-graph can keep configuring the force.
 */
export function capAlpha(force: AlphaForce, cap: { current: number }): AlphaForce {
  const inner = (force[CAPPED] as AlphaForce | undefined) ?? force;
  const wrapped = ((alpha: number) => inner(Math.min(alpha, cap.current))) as AlphaForce;
  for (const key of Object.keys(inner)) wrapped[key] = inner[key];
  wrapped[CAPPED] = inner;
  return wrapped;
}

export interface GraphBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Graph-space rectangle visible through a 2D context's current transform
 * (zoom + pan + device pixel ratio), grown by `marginPx` CSS-ish px.
 */
export function visibleBounds(
  transform: { a: number; d: number; e: number; f: number },
  canvasWidth: number,
  canvasHeight: number,
  marginPx: number,
): GraphBounds {
  const sx = transform.a || 1;
  const sy = transform.d || 1;
  return {
    minX: (-marginPx - transform.e) / sx,
    maxX: (canvasWidth + marginPx - transform.e) / sx,
    minY: (-marginPx - transform.f) / sy,
    maxY: (canvasHeight + marginPx - transform.f) / sy,
  };
}
