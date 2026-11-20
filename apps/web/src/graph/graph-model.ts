import type { GraphData, GraphNode, PageId, PageMeta } from "@gumply/core";

/**
 * Pure graph-view model (M3, spec/ux §9). Turns the API payload into nodes,
 * ghost nodes for unresolved links, links and tags, and applies the view
 * rules (grouping, filters, labels, sizing, colours). Kept free of React and
 * canvas so it can be unit-tested.
 */

/** A missing page referenced by one or more pages. */
export interface GhostNode {
  /** Synthetic id, stable across spellings: `ghost:<lowercase title>`. */
  id: string;
  /** Display title (the most common spelling seen in links). */
  title: string;
  /** Case-insensitive key used for grouping. */
  key: string;
  /** Number of links pointing at this missing title. */
  refCount: number;
  /** Pages that reference it, sorted. */
  sources: PageId[];
}

export interface GraphLink {
  source: string;
  target: string;
}

export interface GraphModel {
  /** Real pages. */
  nodes: GraphNode[];
  ghosts: GhostNode[];
  /** Resolved links plus one link per source→ghost pair. */
  links: GraphLink[];
  /** All tags in the vault (filter chips). */
  tags: string[];
  /** Resolved links + ghost references, for the aria summary. */
  linkCount: number;
}

const GHOST_PREFIX = "ghost:";

export function ghostId(title: string): string {
  return `${GHOST_PREFIX}${title.trim().toLowerCase()}`;
}

export function isGhostId(id: string): boolean {
  return id.startsWith(GHOST_PREFIX);
}

function mostCommonSpelling(spellings: Map<string, number>): string {
  let best = "";
  let bestCount = -1;
  for (const [spelling, count] of spellings) {
    if (count > bestCount) {
      best = spelling;
      bestCount = count;
    }
  }
  return best;
}

/** Build the model from `GET /api/graph` (spec/api v1.2). */
export function buildGraphModel(data: GraphData): GraphModel {
  interface Group {
    key: string;
    spellings: Map<string, number>;
    sources: Set<PageId>;
  }

  const groups = new Map<string, Group>();
  for (const pair of data.unresolved) {
    const title = pair.targetTitle.trim();
    if (title.length === 0) continue;
    const key = title.toLowerCase();

    const group = groups.get(key) ?? { key, spellings: new Map(), sources: new Set() };
    group.spellings.set(title, (group.spellings.get(title) ?? 0) + 1);
    group.sources.add(pair.source);
    groups.set(key, group);
  }

  const ghosts: GhostNode[] = [...groups.values()]
    .map((group) => ({
      id: `${GHOST_PREFIX}${group.key}`,
      title: mostCommonSpelling(group.spellings),
      key: group.key,
      refCount: group.sources.size,
      sources: [...group.sources].sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  const ghostLinks: GraphLink[] = [];
  const seen = new Set<string>();
  for (const pair of data.unresolved) {
    const title = pair.targetTitle.trim();
    if (title.length === 0) continue;
    const target = ghostId(title);
    const key = `${pair.source}\u0000${target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ghostLinks.push({ source: pair.source, target });
  }
  ghostLinks.sort(
    (a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target),
  );

  return {
    nodes: [...data.nodes],
    ghosts,
    links: [...data.links.map((link) => ({ source: link.source, target: link.target })), ...ghostLinks],
    tags: [...data.tags],
    linkCount: data.links.length + ghostLinks.length,
  };
}

export interface GraphFilter {
  /** Case-insensitive title filter. */
  query?: string;
  /** Selected tags; a page matches any of them. */
  tags?: string[];
}

export interface FilteredGraph {
  nodes: GraphNode[];
  ghosts: GhostNode[];
  links: GraphLink[];
  /** Tags still present after filtering (for the chips). */
  tags: string[];
}

/**
 * Apply the title box and tag chips. Ghosts survive only while at least one of
 * their source pages is visible (spec/ux §9).
 */
export function filterGraph(model: GraphModel, filter: GraphFilter = {}): FilteredGraph {
  const needle = (filter.query ?? "").trim().toLowerCase();
  const selected = new Set((filter.tags ?? []).map((tag) => tag.toLowerCase()));

  const matchesText = (title: string): boolean =>
    needle.length === 0 || title.toLowerCase().includes(needle);

  const nodes = model.nodes.filter(
    (node) =>
      matchesText(node.title) &&
      (selected.size === 0 || node.tags.some((tag) => selected.has(tag.toLowerCase()))),
  );
  const visiblePages = new Set(nodes.map((node) => node.id));

  const ghosts = model.ghosts.filter(
    (ghost) => matchesText(ghost.title) && ghost.sources.some((source) => visiblePages.has(source)),
  );
  const visibleIds = new Set<string>([...visiblePages, ...ghosts.map((ghost) => ghost.id)]);

  return {
    nodes,
    ghosts,
    links: model.links.filter(
      (link) => visibleIds.has(link.source) && visibleIds.has(link.target),
    ),
    tags: [...new Set(nodes.flatMap((node) => node.tags))].sort((a, b) => a.localeCompare(b)),
  };
}

/** Node radius in px: 6 for isolated pages, up to 24 for the busiest node. */
export function nodeRadius(count: number, maxCount: number): number {
  if (count <= 0) return 6;
  const max = Math.max(1, maxCount);
  return 6 + 18 * Math.min(1, Math.sqrt(count) / Math.sqrt(max));
}

/** Largest reference count across pages and ghosts (for `nodeRadius`). */
export function maxReferenceCount(model: GraphModel): number {
  return Math.max(
    0,
    ...model.nodes.map((node) => node.linkCount ?? 0),
    ...model.ghosts.map((ghost) => ghost.refCount ?? 0),
  );
}

const LABEL_ALL_LIMIT = 30;
const LABEL_TOP = 15;

export interface LabelledEntry {
  id: string;
  count: number;
}

/**
 * Which nodes get a label: all when there are ≤30, otherwise the 15 with the
 * most links plus the hovered node and its direct neighbours (spec/ux §9).
 */
export function labelledIds(
  entries: readonly LabelledEntry[],
  hoveredId: string | null,
  neighbourIds: Iterable<string> = [],
): Set<string> {
  const labelled = new Set<string>();
  if (entries.length <= LABEL_ALL_LIMIT) {
    for (const entry of entries) labelled.add(entry.id);
    return labelled;
  }

  [...entries]
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
    .slice(0, LABEL_TOP)
    .forEach((entry) => labelled.add(entry.id));

  if (hoveredId) labelled.add(hoveredId);
  for (const id of neighbourIds) labelled.add(id);
  return labelled;
}

export function labelledNodeIds(
  model: GraphModel,
  hoveredId: string | null,
  neighbourIds: Iterable<string> = [],
): Set<string> {
  return labelledIds(
    [
      ...model.nodes.map((node) => ({ id: node.id, count: node.linkCount })),
      ...model.ghosts.map((ghost) => ({ id: ghost.id, count: ghost.refCount })),
    ],
    hoveredId,
    neighbourIds,
  );
}

/** Direct neighbours of a node in either direction, from the current links. */
export function neighbourIds(links: readonly GraphLink[], id: string): Set<string> {
  const neighbours = new Set<string>();
  for (const link of links) {
    if (link.source === id) neighbours.add(link.target);
    else if (link.target === id) neighbours.add(link.source);
  }
  neighbours.delete(id);
  return neighbours;
}

const PALETTE = [
  "#4f46e5",
  "#0e7490",
  "#b45309",
  "#15803d",
  "#be185d",
  "#7c3aed",
  "#0f766e",
  "#a16207",
  "#4338ca",
  "#9d174d",
];

/** Fallback palette when CSS variables are unavailable (unit tests, SSR). */
export const FALLBACK_GRAPH_PALETTE: readonly string[] = PALETTE;

function hashKey(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

/** Which `--graph-N` colour a tag/folder uses; stable across themes. */
export function paletteIndex(key: string): number {
  return hashKey(key.toLowerCase()) % PALETTE.length;
}

function colorFor(key: string, palette: readonly string[] = PALETTE): string {
  return palette[paletteIndex(key)] ?? palette[0] ?? PALETTE[0]!;
}

/** Colour by first tag, falling back to the top-level folder (spec/ux §9). */
export function nodeColor(meta: PageMeta, palette: readonly string[] = PALETTE): string {
  const tag = meta.tags[0];
  if (tag) return colorFor(tag, palette);
  const folder = meta.id.split("/")[0] ?? meta.id;
  return colorFor(folder, palette);
}

/** Resolve `--graph-0…9` from the current theme for canvas/legend use. */
export function graphPaletteFromStyles(styles: CSSStyleDeclaration): readonly string[] {
  return PALETTE.map(
    (fallback, index) => styles.getPropertyValue(`--graph-${index}`).trim() || fallback,
  );
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export interface GraphCounts {
  pages: number;
  /** Every drawn edge: resolved links plus links to ghost pages. */
  links: number;
  missing: number;
}

/** One definition of the graph's counts for the subtitle and the aria label. */
export function graphCounts(
  graph: Pick<GraphModel, "nodes" | "ghosts" | "links">,
): GraphCounts {
  return {
    pages: graph.nodes.length,
    links: graph.links.length,
    missing: graph.ghosts.length,
  };
}

/**
 * Visible header subtitle, e.g. "12 pages · 20 links · 2 missing". Counts the
 * same edges as the canvas aria label (ghosts included) and pluralises them.
 */
export function graphSubtitle(graph: Pick<GraphModel, "nodes" | "ghosts" | "links">): string {
  const counts = graphCounts(graph);
  return `${plural(counts.pages, "page")} · ${plural(counts.links, "link")}${
    counts.missing > 0 ? ` · ${counts.missing} missing` : ""
  }`;
}

/** Canvas aria-label, e.g. "12 pages, 20 links, 2 missing" (spec/ux §9). */
export function ariaSummary(graph: Pick<GraphModel, "nodes" | "ghosts" | "links">): string {
  const counts = graphCounts(graph);
  return `${plural(counts.pages, "page")}, ${plural(counts.links, "link")}, ${counts.missing} missing`;
}

/** Tooltip copy for a real page: `Title · N links · #tag` (spec/ux §9). */
export function nodeTooltip(node: GraphNode): string {
  const tag = node.tags[0];
  return `${node.title} · ${plural(node.linkCount, "link")}${tag ? ` · #${tag}` : ""}`;
}

/** Tooltip copy for a ghost: `“Title” — not created yet · N links · Click to create`. */
export function ghostTooltip(ghost: GhostNode): string {
  return `“${ghost.title}” — not created yet · ${plural(ghost.refCount, "link")} · Click to create`;
}
