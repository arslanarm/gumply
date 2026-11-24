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

/**
 * Up to this many nodes the worker streams positions as it goes. Above it
 * (@lead, #g95wkd9y), every repaint costs ~2 s on a slow laptop, so the graph
 * is drawn once, when it has settled: the page stays responsive meanwhile,
 * behind a dimmed start layout and an "Arranging the graph…" status.
 */
export const STREAM_MAX_NODES = 5000;

/** Whether positions are streamed while the layout runs (else: once, when settled). */
export function streamsPositions(count: number, reducedMotion: boolean): boolean {
  return !reducedMotion && count <= STREAM_MAX_NODES;
}

/**
 * N6 (#9x4duwmg): the charge's Barnes–Hut accuracy. d3's default (0.9) up to
 * STREAM_MAX_NODES, so those graphs look exactly as before; above it a coarser
 * 1.2, which on the 10k vault halves the layout (16.9 → 8.7 s for its 180
 * ticks) with the same median link length and no more overlap.
 */
export function chargeTheta(count: number): number {
  return count > STREAM_MAX_NODES ? 1.2 : 0.9;
}

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
  /** Post positions as the layout runs (else only progress, then the settled layout). */
  stream: boolean;
  /** #xb4b54gr: per node, its cluster (-1 = none); absent or empty = no cluster force. */
  cluster?: Int32Array;
  /**
   * #xb4b54gr: links-mode clusters are computed in the worker for big graphs
   * (Louvain takes ~0.3–0.5 s at 10k): the node ids (for the fixed order) and
   * which nodes are pages. The worker posts the clusters back before laying out.
   */
  clusterLinks?: { ids: string[]; clusterable: Uint8Array };
}

/**
 * #xb4b54gr: how firmly a cluster's pages are pulled to its centre, clusters
 * pushed apart, and links between clusters relaxed. In a connected web (35% of
 * links across groups) the links pull the groups into one hairball: at full
 * strength 28% of graded300's area lies under two hulls; with links across
 * groups at 0.2 and a pull of 0.1, none does, and every page sits nearest its
 * own group's centre (task thread). Links are still drawn as they are.
 */
export const CLUSTER_FORCE = {
  pull: 0.1,
  push: 0.3,
  /** Room kept between two clusters' areas (graph units). */
  gap: 150,
  /** A link's strength between two different shaded clusters, × the usual strength. */
  crossLink: 0.2,
} as const;

/**
 * #xb4b54gr: a link's strength factor: CLUSTER_FORCE.crossLink between two
 * different shaded clusters, else 1 (@graph-dev's review). Links to loose
 * pages keep their strength, and with no shaded clusters every factor is 1,
 * so such a vault lays out exactly as without clustering.
 */
export function clusterLinkFactor(a: number, b: number): number {
  return a >= 0 && b >= 0 && a !== b ? CLUSTER_FORCE.crossLink : 1;
}

interface ClusterForceNode {
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
}

/**
 * #xb4b54gr: keeps each cluster together and the clusters apart, in O(N + C²)
 * per tick (C ≤ MAX_CLUSTERS): every node is pulled gently to its cluster's
 * centre, and two clusters whose areas overlap are pushed apart as wholes.
 * `clusterOf(node, i)` is read once, when the force is initialised.
 */
export function forceCluster<N extends ClusterForceNode>(
  clusterOf: (node: N, index: number) => number,
  tuning: { pull?: number; push?: number } = {},
) {
  const pullBase = tuning.pull ?? CLUSTER_FORCE.pull;
  const pushBase = tuning.push ?? CLUSTER_FORCE.push;
  let nodes: N[] = [];
  let of = new Int32Array(0);
  let count = 0;
  let cx = new Float64Array(0);
  let cy = new Float64Array(0);
  let size = new Float64Array(0);
  let spread = new Float64Array(0);
  let dvx = new Float64Array(0);
  let dvy = new Float64Array(0);
  const force = (alpha: number) => {
    if (count === 0) return;
    cx.fill(0);
    cy.fill(0);
    size.fill(0);
    spread.fill(0);
    dvx.fill(0);
    dvy.fill(0);
    for (let i = 0; i < nodes.length; i += 1) {
      const c = of[i]!;
      if (c < 0) continue;
      cx[c]! += nodes[i]!.x ?? 0;
      cy[c]! += nodes[i]!.y ?? 0;
      size[c]! += 1;
    }
    for (let c = 0; c < count; c += 1) {
      if (size[c]! > 0) {
        cx[c]! /= size[c]!;
        cy[c]! /= size[c]!;
      }
    }
    for (let i = 0; i < nodes.length; i += 1) {
      const c = of[i]!;
      if (c < 0) continue;
      const dx = (nodes[i]!.x ?? 0) - cx[c]!;
      const dy = (nodes[i]!.y ?? 0) - cy[c]!;
      spread[c]! += dx * dx + dy * dy;
    }
    // A cluster's reach: its pages' RMS distance from the centre, a little enlarged.
    // (The drawn area reaches about 2× the RMS, plus its padding: corePoints keeps pages out to 2.2× the median.)
    for (let c = 0; c < count; c += 1) spread[c] = size[c]! > 0 ? Math.sqrt(spread[c]! / size[c]!) * 2.1 + 28 : 0;
    for (let a = 0; a < count; a += 1) {
      if (size[a] === 0) continue;
      for (let b = a + 1; b < count; b += 1) {
        if (size[b] === 0) continue;
        let dx = cx[b]! - cx[a]!;
        let dy = cy[b]! - cy[a]!;
        let distance = Math.hypot(dx, dy);
        if (distance < 1e-6) {
          // Same centre: part them along a fixed direction, so the result stays deterministic.
          dx = 1;
          dy = 0;
          distance = 1;
        }
        const wanted = spread[a]! + spread[b]! + CLUSTER_FORCE.gap;
        if (distance >= wanted) continue;
        const shift = ((wanted - distance) / distance) * pushBase * alpha;
        // The smaller cluster moves more.
        const total = size[a]! + size[b]!;
        dvx[a]! -= dx * shift * (size[b]! / total);
        dvy[a]! -= dy * shift * (size[b]! / total);
        dvx[b]! += dx * shift * (size[a]! / total);
        dvy[b]! += dy * shift * (size[a]! / total);
      }
    }
    for (let i = 0; i < nodes.length; i += 1) {
      const c = of[i]!;
      if (c < 0) continue;
      const node = nodes[i]!;
      const pull = pullBase * alpha;
      node.vx = (node.vx ?? 0) + (cx[c]! - (node.x ?? 0)) * pull + dvx[c]!;
      node.vy = (node.vy ?? 0) + (cy[c]! - (node.y ?? 0)) * pull + dvy[c]!;
    }
  };
  force.initialize = (next: N[]) => {
    nodes = next;
    of = new Int32Array(next.length);
    count = 0;
    next.forEach((node, i) => {
      const c = clusterOf(node, i);
      of[i] = c;
      if (c + 1 > count) count = c + 1;
    });
    cx = new Float64Array(count);
    cy = new Float64Array(count);
    size = new Float64Array(count);
    spread = new Float64Array(count);
    dvx = new Float64Array(count);
    dvy = new Float64Array(count);
  };
  return force;
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
  /** How far along it is, 0–1 (an estimate from the ticks run; 1 once settled). */
  progress(): number;
  /** Current positions, written into the given arrays (or new ones). */
  positions(x?: Float32Array, y?: Float32Array): { x: Float32Array; y: Float32Array };
}

/** A link end as d3 hands it: the node once resolved, its index before. */
const indexOf = (end: SimNode | number): number => (typeof end === "number" ? end : (end.index ?? -1));

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
    .force(
      "link",
      forceLink(links)
        .id((node: SimNode) => node.index)
        .distance(s.linkDistance)
        .strength(
          input.cluster && input.cluster.length === count
            ? (link: { source: SimNode | number; target: SimNode | number }) =>
                s.linkStrength * clusterLinkFactor(input.cluster![indexOf(link.source)] ?? -1, input.cluster![indexOf(link.target)] ?? -1)
            : s.linkStrength,
        ),
    )
    .force("charge", forceManyBody().strength(input.chargeStrength).distanceMax(s.chargeDistanceMax).theta(chargeTheta(count)))
    .force("x", forceX(0).strength(input.centerStrengthX))
    .force("y", forceY(0).strength(input.centerStrengthY));
  const cluster = input.cluster;
  if (cluster && cluster.length === count && cluster.some((c) => c >= 0)) {
    simulation.force("cluster", forceCluster<SimNode>((_node, i) => cluster[i] ?? -1));
  }
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
    progress() {
      if (ticks >= maxTicks || simulation.alpha() < s.alphaMin) return 1;
      // Alpha decays geometrically to alphaMin; the tick cap may come first.
      const byAlpha = Math.log(Math.max(simulation.alpha(), s.alphaMin)) / Math.log(s.alphaMin);
      return Math.min(1, Math.max(ticks / maxTicks, byAlpha));
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
  options: { centerId: string | null; width: number; height: number; reducedMotion: boolean; cluster?: Int32Array },
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
    stream: streamsPositions(nodes.length, options.reducedMotion),
    ...(options.cluster && options.cluster.length === nodes.length ? { cluster: options.cluster } : {}),
  };
}

/** force-graph's own engine for a graph of `count` nodes: off when the worker lays it out. */
export function engineTicks(count: number, reducedMotion: boolean): { warmupTicks: number; cooldownTicks: number; worker: boolean } {
  if (count > LAYOUT_WORKER_THRESHOLD) return { warmupTicks: 0, cooldownTicks: 0, worker: true };
  return reducedMotion ? { warmupTicks: 90, cooldownTicks: 2, worker: false } : { warmupTicks: 40, cooldownTicks: 140, worker: false };
}

/**
 * How often positions are posted: every repaint of a big graph is costly on
 * the main thread (10k nodes, 120k links), so the bigger the graph, the
 * fewer the updates: 100 ms at the threshold, up to 1 s at 10,000 nodes.
 */
export function postInterval(count: number): number {
  return Math.min(1000, Math.max(100, Math.round(count / 10)));
}
