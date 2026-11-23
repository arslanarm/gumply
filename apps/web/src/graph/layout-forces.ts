/**
 * #g95wkd9y: the graph's force layout, as plain data in and positions out, so
 * it can run in a Web Worker for big graphs (layout-worker.ts) and be counted
 * in tests. The forces and settings are the ones GraphCanvas gives
 * force-graph for small graphs: the same picture, off the main thread.
 *
 * A 10,000-node vault costs about 110 ms per tick (mostly the many-body
 * charge): 40 synchronous warm-up ticks were ~18 s on a slow laptop before the
 * graph painted at all, and the 140 cool-down ticks then ran one per frame.
 */
import { forceLink, forceManyBody, forceSimulation, forceX, forceY } from "d3-force-3d";

/** Above this many nodes the layout runs in a worker (and force-graph's engine is off). */
export const LAYOUT_WORKER_THRESHOLD = 1500;

/** The settings GraphCanvas uses (link spring, charge reach, decay). */
export const LAYOUT_SETTINGS = {
  linkDistance: 52,
  linkStrength: 0.45,
  chargeDistanceMax: 1400,
  alphaDecay: 0.03,
  alphaDecayReduced: 0.1,
  velocityDecay: 0.38,
  /** force-graph's warm-up + cool-down ticks (40 + 140; reduced motion 90 + 2). */
  maxTicks: 180,
  maxTicksReduced: 92,
  alphaMin: 0.001,
} as const;

/** What one layout run needs, as transferable arrays. */
export interface LayoutInput {
  /** Starting positions; NaN where a node has none yet (d3 places it). */
  x: Float32Array;
  y: Float32Array;
  /** Links as index pairs into the node arrays: [s0, t0, s1, t1, …]. */
  links: Uint32Array;
  /** A node held at the origin (the local graph's page), or -1. */
  pinned: number;
  chargeStrength: number;
  centerStrengthX: number;
  centerStrengthY: number;
  reducedMotion: boolean;
}

/** Charge and centring as GraphCanvas sets them for `count` nodes. */
export function forceStrengths(
  count: number,
  options: { local: boolean; width: number; height: number },
): { chargeStrength: number; centerStrengthX: number; centerStrengthY: number } {
  const chargeStrength = -60 - Math.min(180, count * 0.6);
  // Small vaults need a firmer centring pull; big vaults stay airy.
  const center = count <= 12 ? 0.22 : count <= 60 ? 0.16 : 0.12;
  let stretchX = 1;
  // Local graph: shape the layout like the (tall, narrow) panel (#z5abndiz).
  if (options.local && count >= 5) {
    const aspect = Math.min(2.5, Math.max(0.5, options.height / Math.max(1, options.width)));
    stretchX = aspect ** 0.35;
  }
  return { chargeStrength, centerStrengthX: center * stretchX, centerStrengthY: center / stretchX };
}

interface SimNode {
  index?: number;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
}

/** A running layout: `tick()` advances one step and says whether it has settled. */
export interface Layout {
  tick(): boolean;
  readonly ticks: number;
  /** Current positions, written into the given arrays (or new ones). */
  positions(x?: Float32Array, y?: Float32Array): { x: Float32Array; y: Float32Array };
}

export function createLayout(input: LayoutInput): Layout {
  const count = input.x.length;
  const nodes: SimNode[] = new Array(count);
  for (let i = 0; i < count; i += 1) {
    const node: SimNode = { index: i };
    if (Number.isFinite(input.x[i]) && Number.isFinite(input.y[i])) {
      node.x = input.x[i];
      node.y = input.y[i];
    }
    nodes[i] = node;
  }
  if (input.pinned >= 0 && input.pinned < count) {
    nodes[input.pinned]!.fx = 0;
    nodes[input.pinned]!.fy = 0;
  }
  const links: Array<{ source: number; target: number }> = [];
  for (let i = 0; i + 1 < input.links.length; i += 2) {
    const source = input.links[i]!;
    const target = input.links[i + 1]!;
    if (source < count && target < count && source !== target) links.push({ source, target });
  }
  const s = LAYOUT_SETTINGS;
  const simulation = forceSimulation(nodes, 2)
    .stop()
    .alphaMin(s.alphaMin)
    .alphaDecay(input.reducedMotion ? s.alphaDecayReduced : s.alphaDecay)
    .velocityDecay(s.velocityDecay)
    .force("link", forceLink(links).id((node: SimNode) => node.index).distance(s.linkDistance).strength(s.linkStrength))
    .force("charge", forceManyBody().strength(input.chargeStrength).distanceMax(s.chargeDistanceMax))
    .force("x", forceX(0).strength(input.centerStrengthX))
    .force("y", forceY(0).strength(input.centerStrengthY));
  const maxTicks = input.reducedMotion ? s.maxTicksReduced : s.maxTicks;
  let ticks = 0;
  return {
    tick(): boolean {
      if (ticks >= maxTicks || simulation.alpha() < s.alphaMin) return true;
      simulation.tick();
      ticks += 1;
      return ticks >= maxTicks || simulation.alpha() < s.alphaMin;
    },
    get ticks() {
      return ticks;
    },
    positions(x = new Float32Array(count), y = new Float32Array(count)) {
      for (let i = 0; i < count; i += 1) {
        x[i] = nodes[i]!.x ?? 0;
        y[i] = nodes[i]!.y ?? 0;
      }
      return { x, y };
    },
  };
}

/**
 * The worker's input for the drawn nodes and links: their current positions
 * (so a graph that crosses the threshold, or a re-run after a filter change,
 * continues from where it is instead of jumping) and links as index pairs.
 */
export function layoutInputFor(
  nodes: ReadonlyArray<{ id: string; x?: number; y?: number }>,
  links: ReadonlyArray<{ source: string; target: string }>,
  options: { centerId: string | null; width: number; height: number; reducedMotion: boolean },
): LayoutInput {
  const index = new Map<string, number>();
  const x = new Float32Array(nodes.length);
  const y = new Float32Array(nodes.length);
  nodes.forEach((node, i) => {
    index.set(node.id, i);
    x[i] = Number.isFinite(node.x) ? (node.x as number) : Number.NaN;
    y[i] = Number.isFinite(node.y) ? (node.y as number) : Number.NaN;
  });
  const pairs = new Uint32Array(links.length * 2);
  let used = 0;
  for (const link of links) {
    const source = index.get(link.source);
    const target = index.get(link.target);
    if (source === undefined || target === undefined) continue;
    pairs[used++] = source;
    pairs[used++] = target;
  }
  return {
    x,
    y,
    links: pairs.subarray(0, used),
    pinned: options.centerId === null ? -1 : (index.get(options.centerId) ?? -1),
    ...forceStrengths(nodes.length, { local: options.centerId !== null, width: options.width, height: options.height }),
    reducedMotion: options.reducedMotion,
  };
}

/** force-graph's own engine for a graph of `count` nodes: off when the worker lays it out. */
export function engineTicks(count: number, reducedMotion: boolean): { warmupTicks: number; cooldownTicks: number; worker: boolean } {
  if (count > LAYOUT_WORKER_THRESHOLD) return { warmupTicks: 0, cooldownTicks: 0, worker: true };
  return reducedMotion ? { warmupTicks: 90, cooldownTicks: 2, worker: false } : { warmupTicks: 40, cooldownTicks: 140, worker: false };
}
