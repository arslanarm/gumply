import { describe, expect, it } from "vitest";
import {
  MAX_CLUSTERS,
  computeClusters,
  convexHull,
  corePoints,
  linkCommunities,
  mixColors,
  separateHulls,
  traceRoundedHull,
  type ClusterNode,
} from "../src/graph/clusters";

/** #xb4b54gr: graph clusters (links / folder / tag), deterministic and sane on fixtures. */

const page = (id: string, extra: Partial<ClusterNode> = {}): ClusterNode => ({ id, clusterable: true, parentId: null, tags: [], ...extra });

/** A clique of `size` pages named `${prefix}1…`, every pair linked. */
function clique(prefix: string, size: number) {
  const nodes = Array.from({ length: size }, (_, i) => page(`${prefix}${i + 1}`));
  const links: Array<{ source: string; target: string }> = [];
  for (let a = 0; a < size; a += 1) for (let b = a + 1; b < size; b += 1) links.push({ source: nodes[a]!.id, target: nodes[b]!.id });
  return { nodes, links };
}

/** A seeded pseudo-random generator (tests only). */
function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe("links mode (Louvain)", () => {
  it("two linked cliques joined by one link make 2 clusters, each of its own pages", () => {
    const a = clique("A", 6);
    const b = clique("B", 5);
    const clusters = computeClusters("links", [...a.nodes, ...b.nodes], [...a.links, ...b.links, { source: "A1", target: "B1" }]);
    expect(clusters.list.map((info) => info.size)).toEqual([6, 5]);
    expect(new Set([...clusters.of.slice(0, 6)])).toEqual(new Set([0]));
    expect(new Set([...clusters.of.slice(6)])).toEqual(new Set([1]));
    // The hub is the most-linked page: A1 and B1 have the bridge.
    expect(clusters.list.map((info) => [...a.nodes, ...b.nodes][info.hub]!.id)).toEqual(["A1", "B1"]);
  });

  it("is deterministic: the same graph gives the same clusters, whatever order the nodes and links come in", () => {
    const random = rng(7);
    const ids = Array.from({ length: 300 }, (_, i) => `p${String(i).padStart(3, "0")}`);
    // Five planted groups of 60, dense inside, a little noise across.
    const links: Array<{ source: string; target: string }> = [];
    for (let i = 0; i < 300; i += 1) {
      for (let j = i + 1; j < 300; j += 1) {
        const same = Math.floor(i / 60) === Math.floor(j / 60);
        if (random() < (same ? 0.15 : 0.004)) links.push({ source: ids[i]!, target: ids[j]! });
      }
    }
    const nodes = ids.map((id) => page(id));
    const first = computeClusters("links", nodes, links);
    const again = computeClusters("links", nodes, links);
    expect([...again.of]).toEqual([...first.of]);
    // Shuffled input: the same cluster for each page id.
    const shuffled = [...nodes].reverse();
    const reordered = computeClusters("links", shuffled, [...links].reverse());
    const byId = (result: typeof first, list: ClusterNode[]) => new Map(list.map((node, i) => [node.id, result.of[i]]));
    expect(byId(reordered, shuffled)).toEqual(byId(first, nodes));
    // And it finds the five planted groups.
    expect(first.list.map((info) => info.size)).toEqual([60, 60, 60, 60, 60]);
    for (let g = 0; g < 5; g += 1) expect(new Set([...first.of.slice(g * 60, g * 60 + 60)]).size).toBe(1);
  });

  it("pages without links, ghost and tag nodes are in no cluster; clusters under 3 pages are dropped", () => {
    const tri = clique("T", 3);
    const pair = clique("P", 2);
    const nodes = [...tri.nodes, ...pair.nodes, page("Lonely"), page("ghost:x", { clusterable: false }), page("tag:y", { clusterable: false })];
    const clusters = computeClusters("links", nodes, [...tri.links, ...pair.links, { source: "T1", target: "ghost:x" }]);
    expect([...clusters.of]).toEqual([0, 0, 0, -1, -1, -1, -1, -1]);
    expect(clusters.list).toHaveLength(1);
  });

  it("a cluster holding nearly every page is the whole graph: no area for it", () => {
    const one = clique("A", 5);
    expect(computeClusters("links", one.nodes, one.links).list).toEqual([]);
    // Two real groups still show.
    const a = clique("A", 5);
    const b = clique("B", 5);
    expect(computeClusters("links", [...a.nodes, ...b.nodes], [...a.links, ...b.links]).list).toHaveLength(2);
  });

  it("keeps at most MAX_CLUSTERS, the biggest", () => {
    const groups = Array.from({ length: MAX_CLUSTERS + 5 }, (_, g) => clique(`G${String(g).padStart(2, "0")}-`, g < 5 ? 3 : 4));
    const clusters = computeClusters("links", groups.flatMap((group) => group.nodes), groups.flatMap((group) => group.links));
    expect(clusters.list).toHaveLength(MAX_CLUSTERS);
    expect(clusters.list.every((info) => info.size === 4)).toBe(true);
  });

  it("an empty graph and a graph with no links have no clusters", () => {
    expect(linkCommunities([], [])).toEqual(new Int32Array(0));
    expect(computeClusters("links", [page("a"), page("b"), page("c")], []).list).toEqual([]);
  });

  it("10,000 pages with 120,000 links: finds the topic blocks", () => {
    const random = rng(42);
    const n = 10_000;
    const nodes = Array.from({ length: n }, (_, i) => page(`n${i}`));
    const links: Array<{ source: string; target: string }> = [];
    for (let k = 0; k < 120_000; k += 1) {
      const a = Math.floor(random() * n);
      // Mostly within a block of 200, as real vaults cluster by topic.
      const b = random() < 0.85 ? Math.floor(a / 200) * 200 + Math.floor(random() * 200) : Math.floor(random() * n);
      links.push({ source: nodes[a]!.id, target: nodes[b]!.id });
    }
    // Timed in the perf script, not here (a wall-clock bound flakes under load).
    const clusters = computeClusters("links", nodes, links);
    expect(clusters.list.length).toBeGreaterThan(10);
  });
});

describe("folder and tag modes", () => {
  it("folder: pages under the same parent; top-level pages are in none", () => {
    const nodes = [
      page("Work/a", { parentId: "Work" }),
      page("Work/b", { parentId: "Work" }),
      page("Work/c", { parentId: "Work" }),
      page("Home/a", { parentId: "Home" }),
      page("Home/b", { parentId: "Home" }),
      page("Top"),
    ];
    const clusters = computeClusters("folder", nodes, []);
    // Home has 2 pages: under the minimum.
    expect([...clusters.of]).toEqual([0, 0, 0, -1, -1, -1]);
  });

  it("tag: the first tag, any case", () => {
    const nodes = [
      page("a", { tags: ["Ideas", "x"] }),
      page("b", { tags: ["ideas"] }),
      page("c", { tags: ["IDEAS"] }),
      page("d", { tags: ["x", "ideas"] }),
      page("e"),
    ];
    expect([...computeClusters("tag", nodes, []).of]).toEqual([0, 0, 0, -1, -1]);
  });

  it("off: nothing", () => {
    const { nodes, links } = clique("A", 5);
    const clusters = computeClusters("off", nodes, links);
    expect([...clusters.of]).toEqual([-1, -1, -1, -1, -1]);
    expect(clusters.list).toEqual([]);
  });
});

describe("areas", () => {
  it("an area is drawn around a cluster's core: a far-off page stays out of the shape", async () => {
    const { corePoints } = await import("../src/graph/clusters");
    const core = Array.from({ length: 12 }, (_, i) => [Math.cos(i) * 10, Math.sin(i) * 10] as [number, number]);
    const kept = corePoints([...core, [400, 0]]);
    expect(kept).toHaveLength(12);
    expect(kept).not.toContainEqual([400, 0]);
    // Few points: all kept.
    expect(corePoints([[0, 0], [100, 0], [0, 5]])).toHaveLength(3);
  });
});

describe("hull outline", () => {
  it("convex hull drops inner and repeated points", () => {
    const hull = convexHull([
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
      [1, 1],
      [2, 2],
    ]);
    expect(hull).toHaveLength(4);
    expect(hull).toEqual(expect.arrayContaining([[0, 0], [2, 0], [2, 2], [0, 2]]));
  });

  it("the rounded outline is a closed path around the hull, a disk for one point", () => {
    const calls: string[] = [];
    const ctx = {
      moveTo: () => calls.push("moveTo"),
      lineTo: () => calls.push("lineTo"),
      arc: (_x: number, _y: number, _r: number, from: number, to: number) => calls.push(`arc ${Math.round(((to - from) * 180) / Math.PI)}`),
      closePath: () => calls.push("closePath"),
    };
    traceRoundedHull(ctx, convexHull([[0, 0], [10, 0], [10, 10], [0, 10]]), 4);
    // A square: four quarter-turn arcs, which together turn once around.
    expect(calls).toEqual(["moveTo", "arc 90", "arc 90", "arc 90", "arc 90", "closePath"]);
    calls.length = 0;
    traceRoundedHull(ctx, [[5, 5]], 4);
    expect(calls).toEqual(["moveTo", "arc 360", "closePath"]);
    calls.length = 0;
    traceRoundedHull(ctx, convexHull([[0, 0], [10, 0]]), 4);
    expect(calls).toEqual(["moveTo", "arc 180", "arc 180", "closePath"]);
  });
});

describe("the cluster force (layout-forces)", () => {
  /** Two groups of 30 pages, each fairly dense, with a few links across; laid out with or without the force. */
  async function layOut(withClusters: boolean) {
    const { createLayout, forceStrengths } = await import("../src/graph/layout-forces");
    const random = rng(3);
    const n = 60;
    const pairs: number[] = [];
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        const same = (i < 30) === (j < 30);
        if (random() < (same ? 0.2 : 0.03)) pairs.push(i, j);
      }
    }
    const cluster = Int32Array.from({ length: n }, (_, i) => (i < 30 ? 0 : 1));
    const layout = createLayout({
      x: new Float32Array(n).fill(Number.NaN),
      y: new Float32Array(n).fill(Number.NaN),
      links: Uint32Array.from(pairs),
      pinned: -1,
      ...forceStrengths(n, { local: false, width: 800, height: 600 }),
      reducedMotion: false,
      stream: false,
      ...(withClusters ? { cluster } : {}),
    });
    while (!layout.tick());
    const { x, y } = layout.positions();
    const centre = (from: number) => {
      let sx = 0;
      let sy = 0;
      for (let i = from; i < from + 30; i += 1) {
        sx += x[i]!;
        sy += y[i]!;
      }
      return [sx / 30, sy / 30] as const;
    };
    const spread = (from: number, [cx, cy]: readonly [number, number]) => {
      let sum = 0;
      for (let i = from; i < from + 30; i += 1) sum += (x[i]! - cx) ** 2 + (y[i]! - cy) ** 2;
      return Math.sqrt(sum / 30);
    };
    const a = centre(0);
    const b = centre(30);
    // How far apart the two groups sit, measured in their own size.
    return Math.hypot(a[0] - b[0], a[1] - b[1]) / ((spread(0, a) + spread(30, b)) / 2);
  }

  it("pulls each cluster together and pushes the clusters apart", async () => {
    const without = await layOut(false);
    const withForce = await layOut(true);
    expect(withForce).toBeGreaterThan(without * 1.3);
    expect(withForce).toBeGreaterThan(2);
  });

  it("is deterministic", async () => {
    expect(await layOut(true)).toBe(await layOut(true));
  });
});

describe("stable colours and re-clustering (@lead, @graph-dev review)", () => {
  it("adding one page keeps every cluster's colour slot", async () => {
    const { colorSlots } = await import("../src/graph/clusters");
    const a = clique("A", 6);
    const b = clique("B", 5);
    const c = clique("C", 4);
    const nodes = [...a.nodes, ...b.nodes, ...c.nodes];
    const links = [...a.links, ...b.links, ...c.links, { source: "A1", target: "B1" }, { source: "B2", target: "C1" }];
    const first = computeClusters("links", nodes, links);
    const firstSlots = colorSlots(first, nodes.map((node) => node.id), new Map());
    // A new page linked into B: B grows, and may now be numbered differently.
    const more = [...nodes, page("B6")];
    const moreLinks = [...links, ...b.nodes.map((node) => ({ source: "B6", target: node.id }))];
    const second = computeClusters("links", more, moreLinks);
    const secondSlots = colorSlots(second, more.map((node) => node.id), firstSlots.byId);
    for (const id of ["A1", "B1", "C1"]) expect(secondSlots.byId.get(id)).toBe(firstSlots.byId.get(id));
    expect(secondSlots.byId.get("B6")).toBe(firstSlots.byId.get("B1"));
  });

  it("a new cluster takes the lowest free slot; slots are never shared", async () => {
    const { colorSlots } = await import("../src/graph/clusters");
    const a = clique("A", 5);
    const b = clique("B", 4);
    const start = [...a.nodes, ...b.nodes];
    const first = computeClusters("links", start, [...a.links, ...b.links]);
    const before = colorSlots(first, start.map((node) => node.id), new Map());
    expect([before.byId.get("A1"), before.byId.get("B1")]).toEqual([0, 1]);
    const big = clique("Z", 8);
    const nodes = [...start, ...big.nodes];
    const after = colorSlots(computeClusters("links", nodes, [...a.links, ...b.links, ...big.links]), nodes.map((node) => node.id), before.byId);
    // Z is now cluster 0 (the biggest), but A and B keep their slots and Z takes the next free one.
    expect([after.byId.get("A1"), after.byId.get("B1"), after.byId.get("Z1")]).toEqual([0, 1, 2]);
  });

});

/** `size` pages named `${prefix}N`, each linked to `per` others in the group, picked by a seeded generator. */
function group(prefix: string, size: number, per: number, random: () => number) {
  const nodes = Array.from({ length: size }, (_, i) => page(`${prefix}${i}`));
  const links: Array<{ source: string; target: string }> = [];
  for (let i = 0; i < size; i += 1) {
    for (let k = 0; k < per; k += 1) {
      const j = Math.floor(random() * size);
      if (j !== i) links.push({ source: nodes[i]!.id, target: nodes[j]!.id });
    }
  }
  return { nodes, links };
}

/** 9 groups (40 pages at internal degree 10 … 15 at 2), ~35% of link ends across, 30 loose pages: one web. */
function gradedWeb() {
  const random = rng(5);
  const spec: Array<[number, number]> = [[40, 10], [35, 8], [30, 6], [30, 5], [25, 4], [25, 3.5], [20, 3], [20, 2.5], [15, 2]];
  const nodes: ClusterNode[] = [];
  const truth: number[] = [];
  const members: number[][] = [];
  spec.forEach(([size], g) => {
    members.push([]);
    for (let i = 0; i < size; i += 1) {
      members[g]!.push(nodes.length);
      truth.push(g);
      nodes.push(page(`g${g}-${i}`));
    }
  });
  for (let i = 0; i < 30; i += 1) {
    truth.push(-1);
    nodes.push(page(`loose-${i}`));
  }
  const n = nodes.length;
  const links: Array<{ source: string; target: string }> = [];
  const link = (a: number, b: number) => a !== b && links.push({ source: nodes[a]!.id, target: nodes[b]!.id });
  spec.forEach(([size, degree], g) => {
    const m = members[g]!;
    const internal = Math.round((size * degree) / 2);
    for (let e = 0; e < internal; e += 1) link(m[Math.floor(random() * size)]!, m[Math.floor(random() * size)]!);
    for (let e = 0; e < Math.round(internal * 0.55); e += 1) link(m[Math.floor(random() * size)]!, Math.floor(random() * n));
  });
  for (let i = n - 30; i < n; i += 1) for (let k = 0; k < 2 + Math.floor(random() * 2); k += 1) link(i, Math.floor(random() * n));
  return { nodes, links, truth };
}

describe("the per-cluster rule (excess >= 0.4, internal degree >= 2; @graph-dev's review)", () => {
  it("two clean topics joined by a few links: both halves are shaded (lift alone would fail them)", () => {
    const random = rng(21);
    const a = group("A", 30, 4, random);
    const b = group("B", 30, 4, random);
    const across = [0, 1, 2].map((i) => ({ source: `A${i}`, target: `B${i}` }));
    const clusters = computeClusters("links", [...a.nodes, ...b.nodes], [...a.links, ...b.links, ...across]);
    expect(clusters.list.map((info) => info.size).sort()).toEqual([30, 30]);
    expect(clusters.list.every((info) => info.strength > 0.5)).toBe(true);
  });

  it("one big clean topic plus scattered pages: the topic is one shaded area (it isn't 80% of the pages)", () => {
    const random = rng(22);
    const topic = group("T", 30, 4, random);
    // Loose notes: one link each, mostly to another loose note, sometimes into the topic.
    const scattered = Array.from({ length: 30 }, (_, i) => page(`S${i}`));
    const all = [...topic.nodes, ...scattered];
    const loose = scattered.map((node) => ({
      source: node.id,
      target: random() < 0.3 ? topic.nodes[Math.floor(random() * 30)]!.id : scattered[Math.floor(random() * 30)]!.id,
    }));
    const clusters = computeClusters("links", all, [...topic.links, ...loose]);
    // The topic is one shaded group (not split into pieces), and no other area takes topic pages.
    const topicCluster = clusters.of[0]!;
    expect(topicCluster).toBeGreaterThanOrEqual(0);
    expect(topic.nodes.filter((_, i) => clusters.of[i] === topicCluster).length).toBe(30);
    expect(topic.nodes.filter((_, i) => clusters.of[i]! >= 0 && clusters.of[i] !== topicCluster)).toEqual([]);
    // Loose notes linked into it may come along (Louvain puts a leaf with its neighbour), but they stay a minority.
    expect(scattered.filter((_, i) => clusters.of[30 + i] === topicCluster).length).toBeLessThan(30);
  });

  it("a graph linked at random (like make-vault's 10k): nothing shaded, and no community near the line", async () => {
    const { linkCommunities, scoreCommunities, LINK_RESOLUTION } = await import("../src/graph/clusters");
    const random = rng(23);
    const n = 2000;
    const nodes = Array.from({ length: n }, (_, i) => page(`r${i}`));
    const pairs: number[] = [];
    for (let k = 0; k < n * 12; k += 1) {
      const a = Math.floor(random() * n);
      const b = Math.floor(random() * n);
      if (a !== b) pairs.push(a, b);
    }
    const links = [];
    for (let i = 0; i < pairs.length; i += 2) links.push({ source: nodes[pairs[i]!]!.id, target: nodes[pairs[i + 1]!]!.id });
    expect(computeClusters("links", nodes, links).list).toEqual([]);
    const degree = new Float64Array(n);
    for (let i = 0; i < pairs.length; i += 2) {
      degree[pairs[i]!]! += 1;
      degree[pairs[i + 1]!]! += 1;
    }
    const raw = linkCommunities(nodes.map((node) => node.id), pairs, LINK_RESOLUTION);
    const best = Math.max(...[...scoreCommunities(raw, pairs, degree).values()].filter((score) => score.size >= 3).map((score) => score.excess));
    expect(best).toBeLessThan(0.35);
  });

  it("three clean topics, two of them joined by a single link: still three areas (a sliver of a cut doesn't merge)", () => {
    const nodes: ClusterNode[] = [];
    const links: Array<{ source: string; target: string }> = [];
    for (const topic of ["Garden", "Kitchen", "Music"]) {
      for (let i = 0; i < 8; i += 1) {
        nodes.push(page(`${topic} ${i}`));
        for (const step of [1, 2, 3]) links.push({ source: `${topic} ${i}`, target: `${topic} ${(i + step) % 8}` });
      }
    }
    links.push({ source: "Garden 0", target: "Kitchen 0" });
    expect(computeClusters("links", nodes, links).list.map((info) => info.size)).toEqual([8, 8, 8]);
  });

  it("a star (a hub with leaves) isn't a group: internal degree under 2", () => {
    const random = rng(24);
    const star = [page("Hub"), ...Array.from({ length: 12 }, (_, i) => page(`Leaf${i}`))];
    const starLinks = star.slice(1).map((leaf) => ({ source: "Hub", target: leaf.id }));
    const a = group("A", 20, 4, random);
    const b = group("B", 20, 4, random);
    const clusters = computeClusters("links", [...star, ...a.nodes, ...b.nodes], [...starLinks, ...a.links, ...b.links, { source: "Hub", target: "A0" }]);
    expect(clusters.of[0]).toBe(-1);
    expect(clusters.list.map((info) => info.size).sort()).toEqual([20, 20]);
  });

  it("tighter groups are drawn stronger; folder and tag groups at full strength", () => {
    const random = rng(25);
    const tight = group("T", 25, 8, random);
    const loose = group("L", 25, 2, random);
    const across = Array.from({ length: 12 }, (_, i) => ({ source: `T${i}`, target: `L${(i * 7) % 25}` }));
    const clusters = computeClusters("links", [...tight.nodes, ...loose.nodes], [...tight.links, ...loose.links, ...across]);
    const strengthOfPage = (index: number) => clusters.list[clusters.of[index]!]?.strength ?? 0;
    expect(strengthOfPage(0)).toBeGreaterThan(strengthOfPage(25));
    const folder = computeClusters("folder", [page("F/a", { parentId: "F" }), page("F/b", { parentId: "F" }), page("F/c", { parentId: "F" }), page("x"), page("y")], []);
    expect(folder.list[0]!.strength).toBe(1);
  });

  it("a planted vault passes; a sparse random one doesn't", () => {
    const random = rng(11);
    const n = 400;
    const nodes = Array.from({ length: n }, (_, i) => page(`r${i}`));
    const randomLinks: Array<{ source: string; target: string }> = [];
    for (let k = 0; k < n * 12; k += 1) randomLinks.push({ source: nodes[Math.floor(random() * n)]!.id, target: nodes[Math.floor(random() * n)]!.id });
    expect(computeClusters("links", nodes, randomLinks).list).toEqual([]);
    const planted: Array<{ source: string; target: string }> = [];
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        if (random() < (Math.floor(i / 50) === Math.floor(j / 50) ? 0.2 : 0.002)) planted.push({ source: nodes[i]!.id, target: nodes[j]!.id });
      }
    }
    expect(computeClusters("links", nodes, planted).list).toHaveLength(8);
  });
});

describe("the re-cluster key (A2, @graph-dev's review)", () => {
  it("new arrays with the same content give the same key (no layout restart); a real change gives a new one", async () => {
    const { clusterKeyFor } = await import("../src/graph/clusters");
    const make = () => [page("a", { parentId: "F", tags: ["x"] }), page("b", { parentId: "F" }), page("c")];
    const dataKey = "a\u0000b\u0000c|2";
    for (const mode of ["links", "folder", "tag"] as const) {
      expect(clusterKeyFor(mode, dataKey, make())).toBe(clusterKeyFor(mode, dataKey, make()));
      expect(clusterKeyFor(mode, dataKey, make())).not.toBe(clusterKeyFor(mode, "a\u0000b\u0000c|3", make()));
    }
    const moved = make();
    moved[1] = page("b", { parentId: "G" });
    expect(clusterKeyFor("folder", dataKey, moved)).not.toBe(clusterKeyFor("folder", dataKey, make()));
    expect(clusterKeyFor("links", dataKey, moved)).toBe(clusterKeyFor("links", dataKey, make()));
    const retagged = make();
    retagged[0] = page("a", { parentId: "F", tags: ["Y"] });
    expect(clusterKeyFor("tag", dataKey, retagged)).not.toBe(clusterKeyFor("tag", dataKey, make()));
    expect(clusterKeyFor("off", dataKey, make())).toBe("off");
  });
});

describe("a connected web with groups of graded tightness (@plony: some parts more linked than others)", () => {
  it("shades most groups, keeps purity and completeness at least Louvain's own (85% / 89%), and grades the tint", () => {
    const { nodes, links, truth } = gradedWeb();
    const clusters = computeClusters("links", nodes, links);
    const share = (rows: Map<number, Map<number, number>>) => {
      let best = 0;
      let all = 0;
      for (const row of rows.values()) {
        const counts = [...row.values()];
        best += Math.max(...counts);
        all += counts.reduce((a, b) => a + b, 0);
      }
      return best / all;
    };
    const purity = new Map<number, Map<number, number>>();
    const completeness = new Map<number, Map<number, number>>();
    truth.forEach((group, i) => {
      if (group < 0) return;
      const c = clusters.of[i]!;
      if (c >= 0) {
        const row = purity.get(c) ?? new Map<number, number>();
        row.set(group, (row.get(group) ?? 0) + 1);
        purity.set(c, row);
      }
      const row = completeness.get(group) ?? new Map<number, number>();
      row.set(c, (row.get(c) ?? 0) + 1);
      completeness.set(group, row);
    });
    expect(share(purity)).toBeGreaterThanOrEqual(0.85);
    expect(share(completeness)).toBeGreaterThanOrEqual(0.89);
    expect(clusters.list.length).toBeGreaterThanOrEqual(7);
    // Graded: not every area at the same strength, none at an island's full tint.
    const strengths = clusters.list.map((info) => info.strength);
    expect(Math.max(...strengths) - Math.min(...strengths)).toBeGreaterThan(0.15);
    expect(Math.max(...strengths)).toBeLessThan(1);
  });
});

describe("the merge thresholds aren't on an edge for these fixtures (@graph-dev's margin test)", () => {
  type Fixture = { nodes: ClusterNode[]; links: Array<{ source: string; target: string }> };
  const fixtures: Record<string, () => Fixture> = {
    "graded web": () => gradedWeb(),
    "planted 8x50": () => {
      const random = rng(11);
      const nodes = Array.from({ length: 400 }, (_, i) => page(`p${i}`));
      const links: Fixture["links"] = [];
      for (let i = 0; i < 400; i += 1) {
        for (let j = i + 1; j < 400; j += 1) {
          if (random() < (Math.floor(i / 50) === Math.floor(j / 50) ? 0.2 : 0.002)) links.push({ source: nodes[i]!.id, target: nodes[j]!.id });
        }
      }
      return { nodes, links };
    },
    "random 400x12": () => {
      const random = rng(12);
      const nodes = Array.from({ length: 400 }, (_, i) => page(`r${i}`));
      const links = Array.from({ length: 4800 }, () => ({ source: nodes[Math.floor(random() * 400)]!.id, target: nodes[Math.floor(random() * 400)]!.id }));
      return { nodes, links };
    },
    "near-islands": () => {
      const nodes: ClusterNode[] = [];
      const links: Fixture["links"] = [];
      for (const topic of ["Garden", "Kitchen", "Music"]) {
        for (let i = 0; i < 8; i += 1) {
          nodes.push(page(`${topic} ${i}`));
          for (const step of [1, 2, 3]) links.push({ source: `${topic} ${i}`, target: `${topic} ${(i + step) % 8}` });
        }
      }
      links.push({ source: "Garden 0", target: "Kitchen 0" });
      return { nodes, links };
    },
    "one topic and loose notes (the open case)": () => {
      const random = rng(22);
      const topic = group("T", 30, 4, random);
      const scattered = Array.from({ length: 30 }, (_, i) => page(`S${i}`));
      const loose = scattered.map((node) => ({
        source: node.id,
        target: random() < 0.3 ? topic.nodes[Math.floor(random() * 30)]!.id : scattered[Math.floor(random() * 30)]!.id,
      }));
      return { nodes: [...topic.nodes, ...scattered], links: [...topic.links, ...loose] };
    },
    "two topics, a few links across": () => {
      const random = rng(21);
      const a = group("A", 30, 4, random);
      const b = group("B", 30, 4, random);
      return { nodes: [...a.nodes, ...b.nodes], links: [...a.links, ...b.links, ...[0, 1, 2].map((i) => ({ source: `A${i}`, target: `B${i}` }))] };
    },
  };
  // Different groups gain up to 0.016; this open case's first piece merge (which gates the rest) gains 0.044,
  // but sparse or very large topics can gain less (the spec's known limitation). Cut share: 0.020 (one link
  // between near-islands) against 0.12+ (pieces of one topic).
  const areas = (fixture: Fixture, tuning: { minMergeGain?: number; minCutShare?: number } = {}) => Array.from(computeClusters("links", fixture.nodes, fixture.links, tuning).of);

  for (const [name, build] of Object.entries(fixtures)) {
    it(`${name}: the same areas with MIN_MERGE_GAIN at 0.02 / 0.04 and MIN_CUT_SHARE at 0.07 / 0.15`, () => {
      const fixture = build();
      const expected = areas(fixture);
      for (const minMergeGain of [0.02, 0.04]) expect(areas(fixture, { minMergeGain }), `MIN_MERGE_GAIN ${minMergeGain}`).toEqual(expected);
      for (const minCutShare of [0.07, 0.15]) expect(areas(fixture, { minCutShare }), `MIN_CUT_SHARE ${minCutShare}`).toEqual(expected);
    });
  }

  it("and both thresholds do work: without them the areas change", () => {
    // No gain needed: real groups with a cut just above chance merge (the graded web).
    const web = fixtures["graded web"]!();
    expect(areas(web, { minMergeGain: 0 })).not.toEqual(areas(web));
    // No cut share needed: the two near-islands joined by one link become one area.
    const islands = fixtures["near-islands"]!();
    expect(areas(islands, { minCutShare: 0 })).not.toEqual(areas(islands));
  });
});

describe("separated groups (@lead: the graded web must read as groups, not one hairball)", () => {
  it("the graded web's layout: links across groups relaxed, so nearly every page sits nearest its own group", async () => {
    const { createLayout, forceStrengths, layoutInputFor } = await import("../src/graph/layout-forces");
    const { nodes, links } = gradedWeb();
    const clusters = computeClusters("links", nodes, links);
    const input = layoutInputFor(
      nodes.map((node) => ({ id: node.id })),
      links,
      { centerId: null, width: 1200, height: 800, reducedMotion: false, cluster: clusters.of },
    );
    expect(input.chargeStrength).toBe(forceStrengths(nodes.length, { local: false, width: 1200, height: 800 }).chargeStrength);
    const layout = createLayout(input);
    while (!layout.tick());
    const { x, y } = layout.positions();
    const sums = clusters.list.map(() => [0, 0, 0]);
    clusters.of.forEach((c, i) => {
      if (c < 0) return;
      sums[c]![0]! += x[i]!;
      sums[c]![1]! += y[i]!;
      sums[c]![2]! += 1;
    });
    const centres = sums.map(([sx, sy, n]) => [sx! / n!, sy! / n!] as const);
    let own = 0;
    let shaded = 0;
    clusters.of.forEach((c, i) => {
      if (c < 0) return;
      shaded += 1;
      const distances = centres.map(([cx, cy]) => Math.hypot(x[i]! - cx, y[i]! - cy));
      if (distances.indexOf(Math.min(...distances)) === c) own += 1;
    });
    // Measured: 100% (82% before links across groups were relaxed).
    expect(own / shaded).toBeGreaterThanOrEqual(0.95);
    // And the areas barely touch before they're cut apart: each core hull's centre is outside every other hull.
    const hulls = clusters.list.map((_, c) => convexHull(corePoints(Array.from(clusters.of).flatMap((k, i) => (k === c ? [[x[i]!, y[i]!] as [number, number]] : [])))));
    const inside = (p: readonly [number, number], hull: ReadonlyArray<readonly [number, number]>) =>
      hull.length >= 3 && hull.every((a, i) => {
        const b = hull[(i + 1) % hull.length]!;
        return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0;
      });
    centres.forEach((centre, c) => hulls.forEach((hull, other) => other !== c && expect(inside(centre, hull)).toBe(false)));
  });
});

describe("relaxed links only between shaded groups (@graph-dev's review)", () => {
  it("the link factor: 0.2 between two different shaded clusters, else 1 (inside one, or to a loose page)", async () => {
    const { clusterLinkFactor, CLUSTER_FORCE } = await import("../src/graph/layout-forces");
    expect(clusterLinkFactor(0, 1)).toBe(CLUSTER_FORCE.crossLink);
    expect(clusterLinkFactor(2, 2)).toBe(1);
    expect(clusterLinkFactor(0, -1)).toBe(1);
    expect(clusterLinkFactor(-1, -1)).toBe(1);
  });

  it("with no shaded clusters (a vault linked at random) the layout is exactly the one without clustering", async () => {
    const { createLayout, layoutInputFor } = await import("../src/graph/layout-forces");
    const random = rng(31);
    const n = 400;
    const nodes = Array.from({ length: n }, (_, i) => page(`r${i}`));
    const links = Array.from({ length: n * 6 }, () => ({ source: nodes[Math.floor(random() * n)]!.id, target: nodes[Math.floor(random() * n)]!.id })).filter((link) => link.source !== link.target);
    const clusters = computeClusters("links", nodes, links);
    expect(clusters.list).toEqual([]);
    const settle = (cluster?: Int32Array) => {
      const layout = createLayout(
        layoutInputFor(nodes.map((node) => ({ id: node.id })), links, { centerId: null, width: 1200, height: 800, reducedMotion: false, ...(cluster ? { cluster } : {}) }),
      );
      while (!layout.tick());
      const { x, y } = layout.positions();
      return [...x, ...y];
    };
    const plain = settle();
    // The clusters' answer (every page -1) handed in anyway: no cluster force, every link at full strength.
    expect(settle(clusters.of)).toEqual(plain);
  });
});

describe("areas never overlap (separateHulls)", () => {
  const square = (cx: number, cy: number, r: number): Array<[number, number]> => [[cx - r, cy - r], [cx + r, cy - r], [cx + r, cy + r], [cx - r, cy + r]];
  /** Grown by pad, do two convex polygons overlap? Sampled: any point within pad of both. */
  function paddedOverlap(a: Array<[number, number]>, b: Array<[number, number]>, pad: number) {
    const near = (poly: Array<[number, number]>, px: number, py: number) => {
      const insidePoly = poly.length >= 3 && poly.every((p, i) => {
        const q = poly[(i + 1) % poly.length]!;
        return (q[0] - p[0]) * (py - p[1]) - (q[1] - p[1]) * (px - p[0]) >= 0;
      });
      if (insidePoly) return true;
      return poly.some((p, i) => {
        const q = poly[(i + 1) % poly.length]!;
        const dx = q[0] - p[0];
        const dy = q[1] - p[1];
        const t = Math.max(0, Math.min(1, ((px - p[0]) * dx + (py - p[1]) * dy) / (dx * dx + dy * dy || 1)));
        return Math.hypot(px - p[0] - t * dx, py - p[1] - t * dy) < pad - 1e-6;
      });
    };
    for (let px = -200; px <= 200; px += 2) for (let py = -200; py <= 200; py += 2) if (near(a, px, py) && near(b, px, py)) return true;
    return false;
  }

  it("two interleaved hulls are cut apart (with their padding), keep their winding, and stay non-empty", () => {
    const [a, b] = separateHulls([square(-20, 0, 50), square(20, 10, 50)], 10);
    expect(paddedOverlap(a!, b!, 10)).toBe(false);
    for (const poly of [a!, b!]) {
      expect(poly.length).toBeGreaterThanOrEqual(3);
      // Counter-clockwise (y down on screen, as convexHull returns them): positive shoelace area.
      const area = poly.reduce((sum, p, i) => sum + p[0] * poly[(i + 1) % poly.length]![1] - poly[(i + 1) % poly.length]![0] * p[1], 0);
      expect(area).toBeGreaterThan(0);
    }
  });

  it("hulls far apart are left exactly as they were; three in a row are all separated", () => {
    const far = [square(-100, 0, 20), square(100, 0, 20)];
    expect(separateHulls(far, 10)).toEqual(far);
    const row = separateHulls([square(-40, 0, 30), square(0, 0, 30), square(40, 0, 30)], 6);
    for (let i = 0; i < 3; i += 1) for (let j = i + 1; j < 3; j += 1) expect(paddedOverlap(row[i]!, row[j]!, 6)).toBe(false);
  });

  it("works for a single point and an empty hull", () => {
    const out = separateHulls([[[0, 0]], square(5, 0, 10), []], 4);
    expect(out[2]).toEqual([]);
    // The point inside the square is cut away (an area may vanish rather than overlap); the square stays.
    expect(out[0]!.length === 0 || !paddedOverlap(out[0]!, out[1]!, 4)).toBe(true);
    expect(out[1]!.length).toBeGreaterThanOrEqual(3);
  });
});

describe("dots in their area's colour", () => {
  it("mixes a share of the area colour over the page grey; unreadable colours fall back to the grey", () => {
    expect(mixColors("#ff0000", "#000000", 0.6)).toBe("#990000");
    expect(mixColors("rgb(0, 0, 255)", "#ffffff", 0.5)).toBe("#8080ff");
    expect(mixColors("var(--x)", "#777777", 0.6)).toBe("#777777");
  });
});
