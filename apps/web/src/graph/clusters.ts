/**
 * #xb4b54gr: the graph's clusters. Pages that belong together (densely
 * linked, or in one folder, or sharing a first tag) get a soft tinted area
 * behind them, and a gentle force keeps each group together and the groups
 * apart. Pure functions: the same input always gives the same clusters, so a
 * reload never reshuffles the picture.
 *
 * Links mode is Louvain (modularity) with a fixed visiting order instead of
 * a random one: nodes are visited by id, ties go to the smaller community.
 */

import type { GraphClusterMode } from "@gumply/core";

export type ClusterMode = GraphClusterMode;

/** Clusters smaller than this get no area and no force. */
export const MIN_CLUSTER_SIZE = 3;
/** A cluster holding at least this share of the pages is the whole graph: it says nothing, so it isn't drawn. */
export const WHOLE_GRAPH_SHARE = 0.8;
/**
 * Links mode, the per-cluster rule (@graph-dev's review): a cluster is shaded
 * when its `excess` is at least this. Excess is the share of its link ends
 * that stay inside, above what a random set of the same volume would keep:
 * ((inside share) - s) / (1 - s), s = its volume / all link ends; 0 = chance,
 * 1 = an island. Scale-free, so a clean half of a two-topic vault (lift only
 * 1.8) qualifies, and a vault linked at random (max ~0.26 at 10k) doesn't.
 */
export const MIN_EXCESS = 0.4;
/** And its pages average at least this many links inside it (a hub with leaves isn't a group). */
export const MIN_INTERNAL_DEGREE = 2;
/**
 * Louvain's resolution in links mode: 1 (standard modularity). Above 1 splits
 * a sparse, evenly linked topic into pieces: two clean 30-page topics became
 * 6 clusters at 1.5 (4 at 1.2; group completeness 48% / 78%, 100% at 1),
 * which shows one topic as several areas. The gain on a graded web was small
 * (3k: 68% → 76% purity), so the simpler, stabler 1 wins (task thread).
 */
export const LINK_RESOLUTION = 1;
/** At most this many clusters are drawn (the biggest), so a huge vault isn't confetti. */
export const MAX_CLUSTERS = 40;

export interface ClusterInfo {
  /** Number of nodes in it. */
  size: number;
  /** Index of its most-linked node, ties to the smaller id. */
  hub: number;
  /**
   * How strongly it's drawn and held together, 0.2-1: links mode,
   * clamp((excess - 0.4) / 0.5, 0.2, 1), so tighter groups read stronger;
   * folder and tag groups 1.
   */
  strength: number;
}

export interface Clusters {
  /** Per node: its cluster (0 = the biggest), or -1 for none. */
  of: Int32Array;
  /** By cluster number. */
  list: ClusterInfo[];
  /** Links mode: Louvain's modularity of the whole partition (for reports; the rule is per cluster). */
  modularity?: number;
}

export const NO_CLUSTERS: Clusters = { of: new Int32Array(0), list: [] };

/** Indices 0..n-1 in id order (the fixed visiting order). */
function idOrder(ids: readonly string[]): Int32Array {
  const order = Int32Array.from(ids.keys());
  order.sort((a, b) => (ids[a]! < ids[b]! ? -1 : ids[a]! > ids[b]! ? 1 : a - b));
  return order;
}

interface WeightedGraph {
  n: number;
  /** CSR adjacency (no self-loops). */
  start: Int32Array;
  target: Int32Array;
  weight: Float64Array;
  /** Weight of each node's self-loop (from aggregation). */
  self: Float64Array;
  /** Weighted degree: neighbours plus twice the self-loop. */
  degree: Float64Array;
  /** Sum of all degrees (2m). */
  total: number;
}

function buildGraph(n: number, pairs: ReadonlyArray<readonly [number, number, number]>, self: Float64Array): WeightedGraph {
  const merged = new Map<number, number>();
  for (const [a, b, w] of pairs) {
    if (a === b) {
      self[a] = (self[a] ?? 0) + w;
      continue;
    }
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const key = lo * n + hi;
    merged.set(key, (merged.get(key) ?? 0) + w);
  }
  const count = new Int32Array(n + 1);
  for (const key of merged.keys()) {
    count[Math.floor(key / n) + 1]! += 1;
    count[(key % n) + 1]! += 1;
  }
  for (let i = 0; i < n; i += 1) count[i + 1]! += count[i]!;
  const start = Int32Array.from(count);
  const fill = Int32Array.from(count);
  const target = new Int32Array(count[n]!);
  const weight = new Float64Array(count[n]!);
  // Ascending keys: each node's neighbours end up in ascending order (deterministic sweeps).
  for (const key of [...merged.keys()].sort((a, b) => a - b)) {
    const a = Math.floor(key / n);
    const b = key % n;
    const w = merged.get(key)!;
    target[fill[a]!] = b;
    weight[fill[a]!++] = w;
    target[fill[b]!] = a;
    weight[fill[b]!++] = w;
  }
  const degree = new Float64Array(n);
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    let d = 2 * self[i]!;
    for (let e = start[i]!; e < start[i + 1]!; e += 1) d += weight[e]!;
    degree[i] = d;
    total += d;
  }
  return { n, start, target, weight, self, degree, total };
}

/** One Louvain level: each node's community after local moving (renumbered 0..k-1 in visiting order). */
function localMoving(graph: WeightedGraph, order: Int32Array, resolution = 1): { community: Int32Array; count: number } {
  const { n, start, target, weight, degree, total } = graph;
  const community = Int32Array.from({ length: n }, (_, i) => i);
  const tot = Float64Array.from(degree);
  const toCommunity = new Float64Array(n);
  const touched: number[] = [];
  for (let sweep = 0; sweep < 20 && total > 0; sweep += 1) {
    let moved = 0;
    for (const node of order) {
      const own = community[node]!;
      const k = degree[node]!;
      for (let e = start[node]!; e < start[node + 1]!; e += 1) {
        const c = community[target[e]!]!;
        if (toCommunity[c] === 0) touched.push(c);
        toCommunity[c]! += weight[e]!;
      }
      tot[own]! -= k;
      // Gain of joining community c: w(node, c) - tot(c) * k / 2m. Staying put is the baseline.
      let best = own;
      let bestGain = toCommunity[own]! - (resolution * tot[own]! * k) / total;
      for (const c of touched) {
        const gain = toCommunity[c]! - (resolution * tot[c]! * k) / total;
        if (gain > bestGain + 1e-12 || (Math.abs(gain - bestGain) <= 1e-12 && c < best)) {
          best = c;
          bestGain = gain;
        }
      }
      tot[best]! += k;
      if (best !== own) {
        community[node] = best;
        moved += 1;
      }
      for (const c of touched) toCommunity[c] = 0;
      touched.length = 0;
    }
    if (moved === 0) break;
  }
  // Renumber in visiting order, so the next level's order is fixed too.
  const renumber = new Int32Array(n).fill(-1);
  let count = 0;
  for (const node of order) {
    const c = community[node]!;
    if (renumber[c] === -1) renumber[c] = count++;
  }
  for (let i = 0; i < n; i += 1) community[i] = renumber[community[i]!]!;
  return { community, count };
}

/**
 * Communities by links (Louvain), one number per node. `links` are index
 * pairs [s0, t0, s1, t1, …]; repeats add weight, self-links are ignored.
 */
export function linkCommunities(ids: readonly string[], links: ArrayLike<number>, resolution = 1): Int32Array {
  const n = ids.length;
  if (n === 0) return new Int32Array(0);
  const pairs: Array<[number, number, number]> = [];
  for (let i = 0; i + 1 < links.length; i += 2) {
    const a = links[i]!;
    const b = links[i + 1]!;
    if (a !== b && a < n && b < n) pairs.push([a, b, 1]);
  }
  let graph = buildGraph(n, pairs, new Float64Array(n));
  let order = idOrder(ids);
  // membership[node] = its node in the current level's graph.
  const membership = Int32Array.from({ length: n }, (_, i) => i);
  for (let level = 0; level < 10; level += 1) {
    const { community, count } = localMoving(graph, order, resolution);
    for (let i = 0; i < n; i += 1) membership[i] = community[membership[i]!]!;
    if (count === graph.n) break;
    // Aggregate: one node per community; links between communities summed, inside ones become self-loops.
    const next: Array<[number, number, number]> = [];
    const self = new Float64Array(count);
    for (let a = 0; a < graph.n; a += 1) {
      const ca = community[a]!;
      self[ca]! += graph.self[a]!;
      for (let e = graph.start[a]!; e < graph.start[a + 1]!; e += 1) {
        const b = graph.target[e]!;
        if (b < a) continue; // each edge once
        const cb = community[b]!;
        if (ca === cb) self[ca]! += graph.weight[e]!;
        else next.push([ca, cb, graph.weight[e]!]);
      }
    }
    graph = buildGraph(count, next, self);
    order = Int32Array.from({ length: count }, (_, i) => i);
  }
  return membership;
}

/** A community's scores for the per-cluster rule (links mode). */
export interface CommunityScore {
  size: number;
  /** Links with both ends inside. */
  inside: number;
  /** Sum of its pages' degrees (its link ends). */
  volume: number;
  /** ((2*inside / volume) - s) / (1 - s), s = volume / 2m: 0 = chance, 1 = an island. */
  excess: number;
  /** 2*inside / size. */
  internalDegree: number;
}

/** Per community (by raw number): the scores the rule reads. Pages with community -1 are left out. */
export function scoreCommunities(community: Int32Array, pairs: ArrayLike<number>, degree: ArrayLike<number>): Map<number, CommunityScore> {
  const total = pairs.length;
  const scores = new Map<number, CommunityScore>();
  community.forEach((c, i) => {
    if (c < 0) return;
    const score = scores.get(c) ?? { size: 0, inside: 0, volume: 0, excess: 0, internalDegree: 0 };
    score.size += 1;
    score.volume += degree[i] ?? 0;
    scores.set(c, score);
  });
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    const a = community[pairs[i]!]!;
    if (a >= 0 && a === community[pairs[i + 1]!]) scores.get(a)!.inside += 1;
  }
  for (const score of scores.values()) {
    const share = total > 0 ? score.volume / total : 0;
    const insideShare = score.volume > 0 ? (2 * score.inside) / score.volume : 0;
    score.excess = share < 1 ? (insideShare - share) / (1 - share) : 0;
    score.internalDegree = score.size > 0 ? (2 * score.inside) / score.size : 0;
  }
  return scores;
}

/**
 * The smallest excess gain a merge must bring. Excess rises whenever the cut
 * between two groups is above chance, and cross links at chance level (two
 * real topics) give gains of 0.000-0.016 on noise. Pieces of one topic gain
 * 0.006-0.108, depending on its size, degree and the loose notes around it
 * (task thread), so a sparse or very large topic can stay in pieces: a known
 * limitation (spec/api-graph-clusters). No pairwise test we measured separates
 * those pieces from real groups. Merges are greedy, so the first (smallest)
 * piece merge gates the rest. The margin test holds its fixtures' areas at
 * 0.02 and 0.04.
 */
export const MIN_MERGE_GAIN = 0.03;
/**
 * And the links between them must be at least this share of the smaller
 * part's link ends. Two near-islands joined by one link form a perfect island
 * (excess 1.0 against 0.97 each: a gain right at the line), but one link is a
 * sliver of their ends (0.020; planted pairs <= 0.019), while pieces of one
 * topic send 0.12-0.20 of theirs to each other (measured, task thread). The
 * margin test holds the areas at 0.07 and 0.15.
 */
export const MIN_CUT_SHARE = 0.1;

/**
 * Louvain's modularity splits a dense, evenly linked topic into pieces when it
 * holds much of the vault's links (its null model), so one topic would show as
 * several faint areas. Merge on the score areas are shaded by (@graph-dev's
 * review): repeatedly merge the linked pair whose union has the biggest excess
 * gain, while excess(A u B) > max(excess(A), excess(B)) + minGain, the union's
 * excess is at least MIN_EXCESS, and it holds under WHOLE_GRAPH_SHARE of the
 * pages. Best gain first, ties to the smallest first page index.
 * Returns the merged communities and every gain it saw (for measurement).
 */
export function mergeByExcess(
  community: Int32Array,
  pairs: ArrayLike<number>,
  degree: ArrayLike<number>,
  options: { minGain?: number; minCutShare?: number; pageCount?: number; onMerge?: (a: number, b: number, gain: number) => void } = {},
): { community: Int32Array; merges: number[] } {
  const minGain = options.minGain ?? MIN_MERGE_GAIN;
  const minCutShare = options.minCutShare ?? MIN_CUT_SHARE;
  const total = pairs.length;
  const out = Int32Array.from(community);
  const merges: number[] = [];
  if (total === 0) return { community: out, merges };
  const pageCount = options.pageCount ?? out.length;
  const inside = new Map<number, number>();
  const volume = new Map<number, number>();
  const size = new Map<number, number>();
  const first = new Map<number, number>();
  out.forEach((c, i) => {
    if (c < 0) return;
    volume.set(c, (volume.get(c) ?? 0) + (degree[i] ?? 0));
    size.set(c, (size.get(c) ?? 0) + 1);
    if (!first.has(c)) first.set(c, i);
  });
  const between = new Map<number, Map<number, number>>();
  const addCut = (a: number, b: number, n: number) => {
    const row = between.get(a) ?? new Map<number, number>();
    row.set(b, (row.get(b) ?? 0) + n);
    between.set(a, row);
  };
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    const a = out[pairs[i]!]!;
    const b = out[pairs[i + 1]!]!;
    if (a < 0 || b < 0) continue;
    if (a === b) inside.set(a, (inside.get(a) ?? 0) + 1);
    else {
      addCut(a, b, 1);
      addCut(b, a, 1);
    }
  }
  const excess = (ins: number, vol: number) => {
    const share = vol / total;
    if (vol === 0 || share >= 1) return 0;
    return ((2 * ins) / vol - share) / (1 - share);
  };
  const parent = new Map<number, number>();
  for (;;) {
    let best: { a: number; b: number; gain: number; key: number } | null = null;
    for (const [a, row] of between) {
      for (const [b, cut] of row) {
        if (b <= a) continue;
        const ins = (inside.get(a) ?? 0) + (inside.get(b) ?? 0) + cut;
        const vol = (volume.get(a) ?? 0) + (volume.get(b) ?? 0);
        const union = excess(ins, vol);
        if (union < MIN_EXCESS) continue;
        if ((size.get(a) ?? 0) + (size.get(b) ?? 0) >= pageCount * WHOLE_GRAPH_SHARE) continue;
        if (cut < minCutShare * Math.min(volume.get(a) ?? 0, volume.get(b) ?? 0)) continue;
        const gain = union - Math.max(excess(inside.get(a) ?? 0, volume.get(a) ?? 0), excess(inside.get(b) ?? 0, volume.get(b) ?? 0));
        if (gain <= minGain) continue;
        const key = Math.min(first.get(a) ?? 0, first.get(b) ?? 0);
        if (!best || gain > best.gain + 1e-12 || (Math.abs(gain - best.gain) <= 1e-12 && key < best.key)) best = { a, b, gain, key };
      }
    }
    if (!best) break;
    const { a, b } = best;
    merges.push(best.gain);
    options.onMerge?.(a, b, best.gain);
    // b into a.
    parent.set(b, a);
    const cutAB = between.get(a)?.get(b) ?? 0;
    inside.set(a, (inside.get(a) ?? 0) + (inside.get(b) ?? 0) + cutAB);
    volume.set(a, (volume.get(a) ?? 0) + (volume.get(b) ?? 0));
    size.set(a, (size.get(a) ?? 0) + (size.get(b) ?? 0));
    first.set(a, Math.min(first.get(a) ?? 0, first.get(b) ?? 0));
    for (const [c, n] of between.get(b) ?? []) {
      if (c === a) continue;
      addCut(a, c, n);
      const row = between.get(c)!;
      row.delete(b);
      row.set(a, (row.get(a) ?? 0) + n);
    }
    between.get(a)?.delete(b);
    between.delete(b);
    inside.delete(b);
    volume.delete(b);
    size.delete(b);
  }
  const find = (c: number): number => {
    let root = c;
    while (parent.has(root)) root = parent.get(root)!;
    return root;
  };
  for (let i = 0; i < out.length; i += 1) if (out[i]! >= 0) out[i] = find(out[i]!);
  return { community: out, merges };
}

/**
 * After the merge, a page whose links mostly (more than half) go to one shaded
 * cluster joins it: stray pages of a topic come home (Leiden's refinement
 * idea). In page order, at most `sweeps` passes, stopping when nothing moves,
 * so nothing oscillates. Only pages with 2 or more links move: a loose note
 * with one link into a topic doesn't belong to it (and would chain others in).
 */
export function refineMembership(
  community: Int32Array,
  pairs: ArrayLike<number>,
  shaded: (c: number) => boolean,
  order: Int32Array,
  sweeps = 2,
): Int32Array {
  const out = Int32Array.from(community);
  const neighbours: number[][] = Array.from({ length: out.length }, () => []);
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    const a = pairs[i]!;
    const b = pairs[i + 1]!;
    if (a === b) continue;
    neighbours[a]!.push(b);
    neighbours[b]!.push(a);
  }
  for (let sweep = 0; sweep < sweeps; sweep += 1) {
    let moved = 0;
    for (const page of order) {
      const links = neighbours[page]!;
      if (links.length < 2) continue;
      const counts = new Map<number, number>();
      for (const other of links) {
        const c = out[other]!;
        if (c >= 0 && shaded(c)) counts.set(c, (counts.get(c) ?? 0) + 1);
      }
      for (const [c, n] of counts) {
        if (n * 2 > links.length && out[page] !== c) {
          out[page] = c;
          moved += 1;
          break;
        }
      }
    }
    if (moved === 0) break;
  }
  return out;
}

/** The per-cluster rule: excess and internal degree (size and the whole-graph rule come after). */
export function qualifies(score: CommunityScore): boolean {
  return score.excess >= MIN_EXCESS && score.internalDegree >= MIN_INTERNAL_DEGREE;
}

/** How strongly a qualifying cluster is drawn and held: 0.2 just over the line, 1 for an island. */
export function strengthOf(excess: number): number {
  return Math.min(1, Math.max(0.2, (excess - MIN_EXCESS) / 0.5));
}

/** Newman's modularity of a partition: Σ over communities of (inside links / m) − (degree sum / 2m)². */
export function modularityOf(community: Int32Array, pairs: ArrayLike<number>, degree: ArrayLike<number>): number {
  const m = pairs.length / 2;
  if (m === 0) return 0;
  const inside = new Map<number, number>();
  const total = new Map<number, number>();
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    const a = community[pairs[i]!]!;
    if (a === community[pairs[i + 1]!]) inside.set(a, (inside.get(a) ?? 0) + 1);
  }
  community.forEach((c, i) => total.set(c, (total.get(c) ?? 0) + (degree[i] ?? 0)));
  let q = 0;
  for (const [c, sum] of total) q += (inside.get(c) ?? 0) / m - (sum / (2 * m)) ** 2;
  return q;
}

/** Communities by a key per node (a folder, a tag); null = none. */
export function keyCommunities(keys: ReadonlyArray<string | null>): Int32Array {
  const byKey = new Map<string, number>();
  const out = new Int32Array(keys.length);
  keys.forEach((key, i) => {
    if (key === null) {
      out[i] = -1;
      return;
    }
    let c = byKey.get(key);
    if (c === undefined) byKey.set(key, (c = byKey.size));
    out[i] = c;
  });
  return out;
}

/**
 * The shown clusters from raw communities: those with at least MIN_CLUSTER_SIZE
 * members, the biggest MAX_CLUSTERS of them, numbered biggest first (ties by
 * their smallest member id). Each cluster's hub is its most-linked node.
 */
export function finalizeClusters(
  raw: Int32Array,
  ids: readonly string[],
  degree: ArrayLike<number>,
  options: { minSize?: number; max?: number } = {},
): { of: Int32Array; list: Array<{ size: number; hub: number }> } {
  const minSize = options.minSize ?? MIN_CLUSTER_SIZE;
  const max = options.max ?? MAX_CLUSTERS;
  const members = new Map<number, number[]>();
  raw.forEach((c, i) => {
    if (c < 0) return;
    const list = members.get(c);
    if (list) list.push(i);
    else members.set(c, [i]);
  });
  const firstId = (list: number[]) => list.reduce((best, i) => (ids[i]! < best ? ids[i]! : best), ids[list[0]!]!);
  const total = raw.length;
  const kept = [...members.values()]
    .filter((list) => list.length >= minSize && list.length < total * WHOLE_GRAPH_SHARE)
    .map((list) => ({ list, first: firstId(list) }))
    .sort((a, b) => b.list.length - a.list.length || (a.first < b.first ? -1 : a.first > b.first ? 1 : 0))
    .slice(0, max);
  const of = new Int32Array(raw.length).fill(-1);
  const list: Array<{ size: number; hub: number }> = kept.map(({ list: nodes }, c) => {
    let hub = nodes[0]!;
    for (const i of nodes) {
      of[i] = c;
      const d = degree[i] ?? 0;
      const best = degree[hub] ?? 0;
      if (d > best || (d === best && ids[i]! < ids[hub]!)) hub = i;
    }
    return { size: nodes.length, hub };
  });
  return { of, list };
}

/** A node as the clustering sees it. */
export interface ClusterNode {
  id: string;
  /** Pages, boards and views take part; ghost, tag and attachment nodes don't. */
  clusterable: boolean;
  /** Folder mode: the parent (folder or page); null at the top level. */
  parentId: string | null;
  /** Tag mode: the first tag, if any. */
  tags: readonly string[];
}

/** The merge thresholds, as parameters only so the margin test can move them; the app uses the defaults. */
export interface ClusterTuning {
  minMergeGain?: number;
  minCutShare?: number;
}

/** Clusters for drawn nodes and links (by id), in the given mode. */
export function computeClusters(
  mode: ClusterMode,
  nodes: readonly ClusterNode[],
  links: ReadonlyArray<{ source: string; target: string }>,
  tuning: ClusterTuning = {},
): Clusters {
  if (mode === "off" || nodes.length === 0) return { of: new Int32Array(nodes.length).fill(-1), list: [] };
  // Only clusterable nodes are counted; the others keep -1.
  const kept: number[] = [];
  const at = new Map<string, number>();
  nodes.forEach((node, i) => {
    if (!node.clusterable) return;
    at.set(node.id, kept.length);
    kept.push(i);
  });
  const ids = kept.map((i) => nodes[i]!.id);
  const degree = new Float64Array(kept.length);
  const pairs: number[] = [];
  for (const link of links) {
    const a = at.get(link.source);
    const b = at.get(link.target);
    if (a === undefined || b === undefined || a === b) continue;
    pairs.push(a, b);
    degree[a]! += 1;
    degree[b]! += 1;
  }
  let raw: Int32Array;
  let modularity: number | undefined;
  const strengthByRaw = new Map<number, number>();
  if (mode === "links") {
    raw = linkCommunities(ids, pairs, LINK_RESOLUTION);
    modularity = modularityOf(raw, pairs, degree);
    // A page with no links is its own community: never a cluster.
    for (let i = 0; i < raw.length; i += 1) if (degree[i] === 0) raw[i] = -1;
    // Pieces of one evenly linked topic become one group again.
    raw = mergeByExcess(raw, pairs, degree, { minGain: tuning.minMergeGain, minCutShare: tuning.minCutShare }).community;
    // Stray pages join the shaded group most of their links go to (then the rule is applied to the result).
    const before = scoreCommunities(raw, pairs, degree);
    raw = refineMembership(raw, pairs, (c) => {
      const score = before.get(c);
      return score !== undefined && qualifies(score);
    }, idOrder(ids));
    // The per-cluster rule: only groups clearly denser inside than chance are shaded.
    const scores = scoreCommunities(raw, pairs, degree);
    for (let i = 0; i < raw.length; i += 1) {
      const score = raw[i]! >= 0 ? scores.get(raw[i]!) : undefined;
      if (!score || !qualifies(score)) raw[i] = -1;
    }
    for (const [c, score] of scores) if (qualifies(score)) strengthByRaw.set(c, strengthOf(score.excess));
  } else if (mode === "folder") {
    raw = keyCommunities(kept.map((i) => nodes[i]!.parentId));
  } else {
    raw = keyCommunities(kept.map((i) => nodes[i]!.tags[0]?.toLowerCase() ?? null));
  }
  const local = finalizeClusters(raw, ids, degree);
  // Each final cluster's strength, from its hub's raw community.
  const strengths = local.list.map((info) => (mode === "links" ? (strengthByRaw.get(raw[info.hub]!) ?? 1) : 1));
  const of = new Int32Array(nodes.length).fill(-1);
  kept.forEach((i, k) => {
    of[i] = local.of[k]!;
  });
  return {
    of,
    ...(modularity === undefined ? {} : { modularity }),
    list: local.list.map((info, c) => ({ size: info.size, hub: kept[info.hub]!, strength: strengths[c]! })),
  };
}

/**
 * The points an area is drawn around: a cluster's core. A page filed with a
 * group but linked elsewhere would stretch the area across the graph, so
 * points farther from the centre than `reach` × the median distance stay out
 * of the shape (they stay in the cluster for the force). Small clusters keep
 * every point.
 */
export function corePoints(points: ReadonlyArray<readonly [number, number]>, reach = 2.2): Array<[number, number]> {
  const all = points.map(([x, y]) => [x, y] as [number, number]);
  if (all.length < 6) return all;
  let cx = 0;
  let cy = 0;
  for (const [x, y] of all) {
    cx += x;
    cy += y;
  }
  cx /= all.length;
  cy /= all.length;
  const distances = all.map(([x, y]) => Math.hypot(x - cx, y - cy));
  const sorted = [...distances].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const limit = Math.max(median * reach, 1e-6);
  return all.filter((_, i) => distances[i]! <= limit);
}

/** Convex hull of points (Andrew's monotone chain), counter-clockwise, no repeats. */
export function convexHull(points: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  const sorted = points
    .map(([x, y]) => [x, y] as [number, number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const unique: Array<[number, number]> = [];
  for (const point of sorted) {
    const last = unique[unique.length - 1];
    if (!last || last[0] !== point[0] || last[1] !== point[1]) unique.push(point);
  }
  if (unique.length < 3) return unique;
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Array<[number, number]> = [];
  for (const point of unique) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper: Array<[number, number]> = [];
  for (let i = unique.length - 1; i >= 0; i -= 1) {
    const point = unique[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, point) <= 0) upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

/**
 * The outline of a hull grown by `pad` (its Minkowski sum with a disk): a
 * path of straight edges and arcs, so one `fill()` gives an even tint with
 * rounded corners. Works for 1 or 2 points too (a disk, a capsule).
 */
export function traceRoundedHull(
  ctx: Pick<CanvasRenderingContext2D, "moveTo" | "lineTo" | "arc" | "closePath">,
  hull: ReadonlyArray<readonly [number, number]>,
  pad: number,
): void {
  const n = hull.length;
  if (n === 0) return;
  if (n === 1) {
    const [x, y] = hull[0]!;
    ctx.moveTo(x + pad, y);
    ctx.arc(x, y, pad, 0, Math.PI * 2);
    ctx.closePath();
    return;
  }
  // The outward normal of edge i (from hull[i] to hull[i+1]); counter-clockwise hull, so it's to the right.
  const normal = (i: number): number => {
    const [ax, ay] = hull[i]!;
    const [bx, by] = hull[(i + 1) % n]!;
    return Math.atan2(by - ay, bx - ax) - Math.PI / 2;
  };
  for (let i = 0; i < n; i += 1) {
    const [x, y] = hull[i]!;
    const from = normal((i - 1 + n) % n);
    let to = normal(i);
    while (to < from) to += Math.PI * 2;
    if (i === 0) ctx.moveTo(x + pad * Math.cos(from), y + pad * Math.sin(from));
    ctx.arc(x, y, pad, from, to);
  }
  ctx.closePath();
}

type Point = readonly [number, number];

/** Distance from p to the segment ab. */
function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length2 = dx * dx + dy * dy;
  const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Whether p is inside the convex, counter-clockwise polygon (3+ points). */
function insideConvex(p: Point, poly: readonly Point[]): boolean {
  if (poly.length < 3) return false;
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    if ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) < 0) return false;
  }
  return true;
}

/** The distance between two convex polygons (0 when they overlap). */
function hullDistance(a: readonly Point[], b: readonly Point[]): number {
  if (a.some((p) => insideConvex(p, b)) || b.some((p) => insideConvex(p, a))) return 0;
  let best = Infinity;
  const edges = (poly: readonly Point[]) => (poly.length === 1 ? [[poly[0]!, poly[0]!] as const] : poly.map((p, i) => [p, poly[(i + 1) % poly.length]!] as const));
  for (const [p, q] of edges(a)) {
    for (const [r, s] of edges(b)) {
      // Crossing edges overlap; else the closest of the four endpoint distances.
      const d1 = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
      const d2 = (q[0] - p[0]) * (s[1] - p[1]) - (q[1] - p[1]) * (s[0] - p[0]);
      const d3 = (s[0] - r[0]) * (p[1] - r[1]) - (s[1] - r[1]) * (p[0] - r[0]);
      const d4 = (s[0] - r[0]) * (q[1] - r[1]) - (s[1] - r[1]) * (q[0] - r[0]);
      if (d1 * d2 < 0 && d3 * d4 < 0) return 0;
      best = Math.min(best, segmentDistance(p, r, s), segmentDistance(q, r, s), segmentDistance(r, p, q), segmentDistance(s, p, q));
    }
  }
  return best;
}

/** The part of a convex polygon where (x, y)·(ux, uy) <= limit (Sutherland–Hodgman; keeps the winding). */
function clipHalfPlane(poly: readonly Point[], ux: number, uy: number, limit: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const da = a[0] * ux + a[1] * uy - limit;
    const db = b[0] * ux + b[1] * uy - limit;
    if (da <= 0) out.push([a[0], a[1]]);
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      const t = da / (da - db);
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
    }
  }
  // No zero-length edges: the rounded outline takes each edge's direction.
  return out.filter((p, i) => {
    const q = out[(i + 1) % out.length]!;
    return out.length === 1 || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6;
  });
}

/**
 * #xb4b54gr (@lead): areas never overlap. Two hulls whose rounded outlines
 * (grown by `pad`) would touch are cut apart along the line between their
 * centres: each keeps its side of the middle of where they meet, `pad` back
 * from it. Pairs are found on the uncut hulls, so the result doesn't depend on
 * the order. O(C² · h²) for C hulls of h points (C ≤ 40): cheap per frame.
 * A hull cut to nothing comes back empty (drawn as nothing).
 */
export function separateHulls(hulls: ReadonlyArray<readonly Point[]>, pad: number): Array<Array<[number, number]>> {
  const out = hulls.map((hull) => hull.map(([x, y]) => [x, y] as [number, number]));
  const centre = hulls.map((hull): Point => {
    let x = 0;
    let y = 0;
    for (const p of hull) {
      x += p[0];
      y += p[1];
    }
    return hull.length > 0 ? [x / hull.length, y / hull.length] : [0, 0];
  });
  for (let a = 0; a < hulls.length; a += 1) {
    for (let b = a + 1; b < hulls.length; b += 1) {
      const A = hulls[a]!;
      const B = hulls[b]!;
      if (A.length === 0 || B.length === 0 || hullDistance(A, B) >= 2 * pad) continue;
      let ux = centre[b]![0] - centre[a]![0];
      let uy = centre[b]![1] - centre[a]![1];
      const length = Math.hypot(ux, uy);
      if (length < 1e-9) {
        ux = 1;
        uy = 0;
      } else {
        ux /= length;
        uy /= length;
      }
      const reachA = Math.max(...A.map((p) => p[0] * ux + p[1] * uy));
      const reachB = Math.min(...B.map((p) => p[0] * ux + p[1] * uy));
      const middle = (reachA + reachB) / 2;
      out[a] = out[a]!.length > 0 ? clipHalfPlane(out[a]!, ux, uy, middle - pad) : out[a]!;
      out[b] = out[b]!.length > 0 ? clipHalfPlane(out[b]!, -ux, -uy, -(middle + pad)) : out[b]!;
    }
  }
  return out;
}

/** A theme colour as [r, g, b] (hex #rgb / #rrggbb or rgb()/rgba()); null if unreadable. */
export function rgbOf(color: string): [number, number, number] | null {
  const value = color.trim();
  if (/^#[0-9a-f]{6}$/i.test(value)) return [1, 3, 5].map((at) => Number.parseInt(value.slice(at, at + 2), 16)) as [number, number, number];
  if (/^#[0-9a-f]{3}$/i.test(value)) return [1, 2, 3].map((at) => Number.parseInt(value[at]! + value[at]!, 16)) as [number, number, number];
  const match = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** `share` of `color` over `base` (0 = base, 1 = color), as #rrggbb; `base` when either is unreadable. */
export function mixColors(color: string, base: string, share: number): string {
  const a = rgbOf(color);
  const b = rgbOf(base);
  if (!a || !b) return base;
  return `#${a.map((channel, i) => Math.round(channel * share + b[i]! * (1 - share)).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Stable colours across re-clustering (@lead, #xb4b54gr): adding one page
 * mustn't repaint every area. Each new cluster takes the colour slot most of
 * its pages had before (the biggest overlap first, each old slot once); a
 * cluster with no such pages takes the lowest free slot. `previous` maps a
 * node id to its cluster's slot from the last run (empty on the first run:
 * then slot = cluster number).
 */
export function colorSlots(clusters: Clusters, ids: readonly string[], previous: ReadonlyMap<string, number>): { slots: number[]; byId: Map<string, number> } {
  const count = clusters.list.length;
  // votes[c] = old slot -> how many of cluster c's pages had it.
  const votes: Array<Map<number, number>> = Array.from({ length: count }, () => new Map());
  clusters.of.forEach((c, i) => {
    if (c < 0) return;
    const old = previous.get(ids[i]!);
    if (old === undefined) return;
    votes[c]!.set(old, (votes[c]!.get(old) ?? 0) + 1);
  });
  const candidates: Array<{ cluster: number; slot: number; overlap: number }> = [];
  votes.forEach((byOld, cluster) => byOld.forEach((overlap, slot) => candidates.push({ cluster, slot, overlap })));
  // Biggest overlap first; ties to the bigger (lower-numbered) cluster, then the lower slot.
  candidates.sort((a, b) => b.overlap - a.overlap || a.cluster - b.cluster || a.slot - b.slot);
  const slots = new Array<number>(count).fill(-1);
  const taken = new Set<number>();
  for (const { cluster, slot } of candidates) {
    if (slots[cluster] !== -1 || taken.has(slot)) continue;
    slots[cluster] = slot;
    taken.add(slot);
  }
  let free = 0;
  for (let c = 0; c < count; c += 1) {
    if (slots[c] !== -1) continue;
    while (taken.has(free)) free += 1;
    slots[c] = free;
    taken.add(free);
  }
  const byId = new Map<string, number>();
  clusters.of.forEach((c, i) => {
    if (c >= 0) byId.set(ids[i]!, slots[c]!);
  });
  return { slots, byId };
}

/**
 * When to re-cluster (and re-lay out): the mode plus the graph's `dataKey`
 * (its node ids and link count, as the layout uses), plus each page's parent
 * or first tag in those modes. New arrays with the same content (a filter
 * that hides nothing) give the same key, so a 10k layout isn't restarted
 * (@graph-dev's review, A2). O(N); no per-link hashing.
 */
export function clusterKeyFor(mode: ClusterMode, dataKey: string, nodes: readonly ClusterNode[]): string {
  if (mode === "off") return "off";
  if (mode === "links") return `links|${dataKey}`;
  const parts = nodes.map((node) => (mode === "folder" ? (node.parentId ?? "") : (node.tags[0]?.toLowerCase() ?? "")));
  return `${mode}|${dataKey}|${parts.join("\u0000")}`;
}
