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

/** A node to keep in view: graph position plus screen-px extents around it. */
export interface FitItem {
  x: number;
  y: number;
  /** CSS px the node (and its label) reach left/right/up/down of its centre. */
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Largest zoom that keeps every item inside a `halfWidth × halfHeight` box
 * (CSS px, padding already removed) centred on `cx/cy` in graph space.
 * Screen-space extents (node radius, label width) don't scale with zoom, so
 * each item gives `distance · k + extent ≤ half` → `k ≤ (half − extent) / distance`.
 * Returns Infinity when every item sits on the centre.
 */
export function fitZoom(
  items: readonly FitItem[],
  cx: number,
  cy: number,
  halfWidth: number,
  halfHeight: number,
): number {
  // Never let an extent eat the whole box: keep at least a few px of travel.
  const room = (half: number, extent: number): number => Math.max(4, half - extent);
  let zoom = Number.POSITIVE_INFINITY;
  for (const item of items) {
    const dx = item.x - cx;
    const dy = item.y - cy;
    if (dx > 1e-6) zoom = Math.min(zoom, room(halfWidth, item.right) / dx);
    else if (dx < -1e-6) zoom = Math.min(zoom, room(halfWidth, item.left) / -dx);
    if (dy > 1e-6) zoom = Math.min(zoom, room(halfHeight, item.bottom) / dy);
    else if (dy < -1e-6) zoom = Math.min(zoom, room(halfHeight, item.top) / -dy);
  }
  return zoom;
}

/** #5n2p7phw: a node's place on screen, for keyboard moves. */
export interface ScreenPoint {
  id: string;
  x: number;
  y: number;
}

export type ArrowDirection = "left" | "right" | "up" | "down";

/**
 * #5n2p7phw: the node an arrow key moves to: the nearest one in that direction on screen, within a 90° cone
 * around it, scored by distance plus twice the sideways offset (so a node straight ahead beats a closer one off to
 * the side). Null when nothing lies that way.
 */
export function nearestInDirection(from: ScreenPoint, points: readonly ScreenPoint[], direction: ArrowDirection): string | null {
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const point of points) {
    if (point.id === from.id) continue;
    const dx = point.x - from.x;
    const dy = point.y - from.y;
    const ahead = direction === "right" ? dx : direction === "left" ? -dx : direction === "down" ? dy : -dy;
    const side = Math.abs(direction === "left" || direction === "right" ? dy : dx);
    if (ahead <= 0 || side > ahead) continue;
    const score = Math.hypot(dx, dy) + 2 * side;
    if (score < bestScore) {
      bestScore = score;
      best = point.id;
    }
  }
  return best;
}

/** #5n2p7phw: a node's neighbours in clockwise order on screen, starting from 12 o'clock (`[` and `]` step through). */
export function clockwiseNeighbours(center: ScreenPoint, neighbours: readonly ScreenPoint[]): string[] {
  const angle = (point: ScreenPoint) => {
    // 0 at 12 o'clock, growing clockwise (screen y grows downwards).
    const a = Math.atan2(point.x - center.x, -(point.y - center.y));
    return a < 0 ? a + Math.PI * 2 : a;
  };
  return [...neighbours].sort((a, b) => angle(a) - angle(b) || a.id.localeCompare(b.id)).map((point) => point.id);
}
