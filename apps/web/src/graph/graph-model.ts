import { graphItemPath, matchesGraphQuery, parseGraphQuery, type GraphData, type GraphGroup, type GraphNode, type PageId, type PageMeta } from "@gumply/core";
import { t } from "../i18n/index.js";

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

  const links: GraphLink[] = [
    ...data.links.map((link) => ({ source: link.source, target: link.target })),
    ...ghostLinks,
  ];

  // A page's count is its number of *distinct* neighbours in this view (pages
  // and ghosts): a two-way link is one connection, so the count matches what
  // hover highlights (#z5abndiz).
  const neighbours = new Map<string, Set<string>>();
  const connect = (from: string, to: string): void => {
    if (from === to) return;
    const set = neighbours.get(from) ?? new Set<string>();
    set.add(to);
    neighbours.set(from, set);
  };
  for (const link of links) {
    connect(link.source, link.target);
    connect(link.target, link.source);
  }

  return {
    nodes: data.nodes.map((node) => ({ ...node, linkCount: neighbours.get(node.id)?.size ?? 0 })),
    ghosts,
    links,
    tags: [...data.tags],
    linkCount: data.links.length + ghostLinks.length,
  };
}

export interface GraphFilter {
  /** The search box: a graph query (E1: `tag:#x`, `path:`, `file:`, words, `-not`, `OR`). */
  query?: string;
  /** Selected tags; a page matches any of them. */
  tags?: string[];
  /** E1 "Existing files only": no ghost nodes. */
  hideUnresolved?: boolean;
  /** E1: keep nodes with no links in view (default true). */
  showOrphans?: boolean;
  /** E1: tag nodes, each linked to the visible pages that carry the tag. */
  showTags?: boolean;
  /** E1: attachment nodes from `GET /graph?include=attachments` (absent: none). */
  attachments?: GraphData["attachments"];
}

export interface FilteredGraph {
  nodes: GraphNode[];
  ghosts: GhostNode[];
  /** E1: tag and attachment nodes (not pages: not in the page counts). */
  extras: GraphNode[];
  links: GraphLink[];
  /** Tags still present after filtering (for the chips). */
  tags: string[];
}

const TAG_PREFIX = "\u0001tag:";
const ATTACHMENT_PREFIX = "\u0001file:";

export const tagNodeId = (tag: string): string => `${TAG_PREFIX}${tag.toLowerCase()}`;
export const attachmentNodeId = (path: string): string => `${ATTACHMENT_PREFIX}${path}`;
export const isTagNodeId = (id: string): boolean => id.startsWith(TAG_PREFIX);
export const isAttachmentNodeId = (id: string): boolean => id.startsWith(ATTACHMENT_PREFIX);
/** The vault path of an attachment node. */
export const attachmentPath = (id: string): string => id.slice(ATTACHMENT_PREFIX.length);

function extraNode(id: string, title: string, tags: string[], linkCount: number): GraphNode {
  return { id, kind: "page", title, tags, parentId: null, childCount: 0, created: "", updated: "", linkCount };
}

/**
 * Apply the search query, tag chips and E1 filters. Ghosts survive a tag
 * filter only while one of their source pages is visible (spec/ux §9); tag
 * and attachment nodes only next to a visible page.
 */
export function filterGraph(model: GraphModel, filter: GraphFilter = {}): FilteredGraph {
  const query = parseGraphQuery(filter.query ?? "");
  const selected = new Set((filter.tags ?? []).map((tag) => tag.toLowerCase()));

  const nodes = model.nodes.filter(
    (node) =>
      matchesGraphQuery(query, { title: node.title, path: graphItemPath(node.id, node.kind), tags: node.tags }) &&
      (selected.size === 0 || node.tags.some((tag) => selected.has(tag.toLowerCase()))),
  );
  const visiblePages = new Set(nodes.map((node) => node.id));

  // #yy347xgi (3): a page not created yet has no tags of its own; for a `tag:` term it carries the tags of the
  // pages that link to it, so `tag:#x` keeps the not-created pages #x pages link to (as the chips always did), and
  // `-tag:#x` drops one that #x pages link to (it belongs to #x, @lead).
  const tagsOfPage = new Map(model.nodes.map((node) => [node.id, node.tags]));
  const ghosts = filter.hideUnresolved
    ? []
    : model.ghosts.filter((ghost) => {
        const tags = [...new Set(ghost.sources.flatMap((source) => tagsOfPage.get(source) ?? []))];
        if (!matchesGraphQuery(query, { title: ghost.title, path: ghost.title, tags })) return false;
        // A text query matches ghost titles independently of their sources (spec/ux
        // §9: only a tag filter hides a ghost when all sources are filtered out).
        if (selected.size === 0) return true;
        return ghost.sources.some((source) => visiblePages.has(source));
      });
  const visibleIds = new Set<string>([...visiblePages, ...ghosts.map((ghost) => ghost.id)]);
  const links = model.links.filter((link) => visibleIds.has(link.source) && visibleIds.has(link.target));

  const extras: GraphNode[] = [];
  if (filter.showTags) {
    const byTag = new Map<string, { title: string; pages: string[] }>();
    for (const node of nodes) {
      for (const tag of new Set(node.tags)) {
        const id = tagNodeId(tag);
        const entry = byTag.get(id) ?? { title: tag, pages: [] };
        entry.pages.push(node.id);
        byTag.set(id, entry);
      }
    }
    for (const [id, entry] of [...byTag].sort((a, b) => a[0].localeCompare(b[0]))) {
      extras.push(extraNode(id, `#${entry.title}`, [entry.title], entry.pages.length));
      for (const page of entry.pages) links.push({ source: page, target: id });
    }
  }
  if (filter.attachments) {
    const byPath = new Map<string, string[]>();
    for (const edge of filter.attachments) {
      if (!visiblePages.has(edge.source)) continue;
      const list = byPath.get(edge.path) ?? [];
      list.push(edge.source);
      byPath.set(edge.path, list);
    }
    for (const [path, sources] of [...byPath].sort((a, b) => a[0].localeCompare(b[0]))) {
      const id = attachmentNodeId(path);
      extras.push(extraNode(id, path.slice(path.lastIndexOf("/") + 1), [], sources.length));
      for (const source of sources) links.push({ source, target: id });
    }
  }

  let shownNodes = nodes;
  let shownGhosts = ghosts;
  let shownExtras = extras;
  if (filter.showOrphans === false) {
    const linked = new Set<string>();
    for (const link of links) {
      if (link.source === link.target) continue;
      linked.add(link.source);
      linked.add(link.target);
    }
    shownNodes = nodes.filter((node) => linked.has(node.id));
    shownGhosts = ghosts.filter((ghost) => linked.has(ghost.id));
    shownExtras = extras.filter((node) => linked.has(node.id));
  }

  return {
    nodes: shownNodes,
    ghosts: shownGhosts,
    extras: shownExtras,
    links,
    tags: [...new Set(shownNodes.flatMap((node) => node.tags))].sort((a, b) => a.localeCompare(b)),
  };
}

/**
 * E1 colour groups: the first group whose query matches a page (or an
 * attachment) gives its colour; null keeps the default colouring. Queries
 * are parsed once per group list, not per frame.
 */
export function groupColorer(groups: readonly GraphGroup[]): (node: GraphNode) => string | null {
  const parsed = groups.map((group) => ({ query: parseGraphQuery(group.query), color: group.color })).filter((group) => group.query.length > 0);
  if (parsed.length === 0) return () => null;
  return (node) => {
    if (isTagNodeId(node.id)) return null;
    const attachment = isAttachmentNodeId(node.id);
    const item = attachment
      ? { title: node.title, path: attachmentPath(node.id), tags: [] }
      : { title: node.title, path: graphItemPath(node.id, node.kind), tags: node.tags };
    return parsed.find((group) => matchesGraphQuery(group.query, item))?.color ?? null;
  };
}

/** Which palette colour attachment nodes use when no group colours them. */
export const ATTACHMENT_PALETTE_INDEX = 5;

/**
 * Node radius in CSS px (constant on screen at every zoom, Q1b): 4 for
 * isolated pages, up to 9 for the busiest node. Obsidian-sized, not blobs.
 */
export function nodeRadius(count: number, maxCount: number): number {
  if (count <= 0) return 4;
  const max = Math.max(1, maxCount);
  return 4 + 5 * Math.min(1, Math.sqrt(count) / Math.sqrt(max));
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
  "#2f5f8f",
  "#b35c00",
  "#b23a3c",
  "#2f7a75",
  "#3f7a34",
  "#8a6d00",
  "#7a4f6d",
  "#a63b7a",
  "#5a3a22",
  "#6a3fb0",
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

/** Palette slots a tag can take: the attachments' slot only when the others are used. */
const TAG_SLOT_ORDER = (preferred: number): number[] => {
  const all = Array.from({ length: PALETTE.length }, (_, step) => (preferred + step) % PALETTE.length);
  return [...all.filter((slot) => slot !== ATTACHMENT_PALETTE_INDEX), ATTACHMENT_PALETTE_INDEX];
};

/** #cp7xvwjc: how many pages each tag colours (a page's first tag, as `nodeColor` colours), keyed lower-case. */
export function firstTagCounts(nodes: ReadonlyArray<{ tags: readonly string[] }>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    const tag = node.tags[0];
    if (tag) counts.set(tag.toLowerCase(), (counts.get(tag.toLowerCase()) ?? 0) + 1);
  }
  return counts;
}

/** A key that changes only when the counts do (memos over a 10k-page list). */
export function firstTagCountsKey(counts: ReadonlyMap<string, number>): string {
  return [...counts.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([tag, count]) => `${tag}\u0000${count}`)
    .join("\u0001");
}

/**
 * #cp7xvwjc: which palette slot each tag colours nodes with, so the tags in a
 * vault don't share colours (a plain hash put #money and #reading both on
 * orange). From the vault's first-tag counts, so every view shows the same:
 * - the 10 tags that colour the most pages get distinct slots, **handed out
 *   most used first** (ties by name): each takes its hash slot if free, else
 *   the next free one. A new tag is the least used, so it takes a free slot
 *   and never pushes an existing tag off its colour;
 * - the attachments' slot goes last, so up to 9 tags never look like files;
 * - other tags keep their hash slot, moved off the attachments' slot
 *   (beyond 10, colours must repeat, but never with files).
 */
export function tagColorSlotsFromCounts(counts: ReadonlyMap<string, number>): Map<string, number> {
  const byUse = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const slots = new Map<string, number>();
  const used = new Set<number>();
  for (const [tag] of byUse.slice(0, PALETTE.length)) {
    const slot = TAG_SLOT_ORDER(paletteIndex(tag)).find((candidate) => !used.has(candidate))!;
    used.add(slot);
    slots.set(tag, slot);
  }
  for (const [tag] of byUse.slice(PALETTE.length)) slots.set(tag, TAG_SLOT_ORDER(paletteIndex(tag))[0]!);
  return slots;
}

/** `tagColorSlotsFromCounts` of these nodes' first tags. */
export function tagColorSlots(nodes: ReadonlyArray<{ tags: readonly string[] }>): Map<string, number> {
  return tagColorSlotsFromCounts(firstTagCounts(nodes));
}

/** The slot for `tag` in `slots`, else its hash slot. */
export function tagSlot(tag: string, slots?: ReadonlyMap<string, number>): number {
  return slots?.get(tag.toLowerCase()) ?? paletteIndex(tag);
}

/** Tags that colour nodes, most nodes first (ties by name): the legend's rows. */
export function colouringTags(nodes: ReadonlyArray<{ tags: readonly string[] }>): string[] {
  const counts = new Map<string, { tag: string; count: number }>();
  for (const node of nodes) {
    const tag = node.tags[0];
    if (!tag) continue;
    const entry = counts.get(tag.toLowerCase());
    if (entry) entry.count += 1;
    else counts.set(tag.toLowerCase(), { tag, count: 1 });
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || (a.tag.toLowerCase() < b.tag.toLowerCase() ? -1 : 1))
    .map((entry) => entry.tag);
}

/** Colour of a page without tags (legend: "page"). Matches `--graph-page`. */
export const PAGE_NODE_COLOR = "#8c8a84";

/**
 * Colour by first tag; pages without tags share one neutral page colour, so
 * every colour on the canvas is explained by the legend (#z5abndiz — the old
 * folder-hash fallback produced colours the legend never mentioned).
 */
export function nodeColor(
  meta: PageMeta,
  palette: readonly string[] = PALETTE,
  pageColor: string = PAGE_NODE_COLOR,
  slots?: ReadonlyMap<string, number>,
): string {
  const tag = meta.tags[0];
  if (!tag) return pageColor;
  return slots ? (palette[tagSlot(tag, slots)] ?? colorFor(tag, palette)) : colorFor(tag, palette);
}

/** Resolve `--graph-0…9` from the current theme for canvas/legend use. */
export function graphPaletteFromStyles(styles: CSSStyleDeclaration): readonly string[] {
  return PALETTE.map(
    (fallback, index) => styles.getPropertyValue(`--graph-${index}`).trim() || fallback,
  );
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
 * Visible header subtitle, e.g. "12 pages · 20 links · 2 not created yet". Counts the
 * same edges as the canvas aria label (ghosts included) and pluralises them.
 */
export function graphSubtitle(graph: Pick<GraphModel, "nodes" | "ghosts" | "links">): string {
  const counts = graphCounts(graph);
  return [
    t("graph.pages", { count: counts.pages }),
    t("graph.links", { count: counts.links }),
    ...(counts.missing > 0 ? [t("graph.missing", { count: counts.missing })] : []),
  ].join(" · ");
}

/** Canvas aria-label, e.g. "12 pages, 20 links, 2 not created yet" (spec/ux §9). */
export function ariaSummary(graph: Pick<GraphModel, "nodes" | "ghosts" | "links">): string {
  const counts = graphCounts(graph);
  return [
    t("graph.pages", { count: counts.pages }),
    t("graph.links", { count: counts.links }),
    t("graph.missing", { count: counts.missing }),
  ].join(", ");
}

/** Tooltip copy for a real page: `Title · N links · #tag` (spec/ux §9). */
export function nodeTooltip(node: GraphNode): string {
  const tag = node.tags[0];
  return `${node.title} · ${t("graph.links", { count: node.linkCount })}${tag ? ` · #${tag}` : ""}`;
}

/**
 * Hover tooltip details, shown next to a node whose label already shows the
 * title, so the title isn't repeated (#z5abndiz): `4 links · #work`.
 */
export function nodeDetail(node: GraphNode): string {
  const tag = node.tags[0];
  const kind = node.kind === "whiteboard" ? `${t("board.cards.whiteboard")} · ` : "";
  return `${kind}${t("graph.links", { count: node.linkCount })}${tag ? ` · #${tag}` : ""}`;
}

/** Ghost tooltip details: `Not created yet · 1 link · Click to create`. */
export function ghostDetail(ghost: GhostNode): string {
  return t("graph.ghostDetail", { links: t("graph.links", { count: ghost.refCount }) });
}

/** Tooltip copy for a ghost: `“Title” — not created yet · N links · Click to create`. */
export function ghostTooltip(ghost: GhostNode): string {
  return t("graph.ghostTooltip", { title: ghost.title, links: t("graph.links", { count: ghost.refCount }) });
}

/**
 * #yy347xgi (3): the tag chips are `tag:#x` terms in the search, so the field shows what's applied and the chips
 * and a typed query can never disagree. A chip is pressed when the query has its positive term.
 */
export function queryHasTag(query: string, tag: string): boolean {
  const wanted = tag.toLowerCase();
  return parseGraphQuery(query).some((terms) => terms.some((term) => term.op === "tag" && !term.negate && term.value === wanted));
}

/** The query's tokens, `(` and `)` standing alone, quoted phrases whole (as the core parser splits them). */
function queryTokens(query: string): string[] {
  return query.match(/[()]|-?(?:[A-Za-z]+:)?(?:"[^"]*"?|[^\s()]+)/g) ?? [];
}

/** Tokens back to text: no space after `(` or before `)`, nor between `-` or `op:` and the `(` they open. */
function joinTokens(tokens: readonly string[]): string {
  let out = "";
  for (const token of tokens) {
    const glued = out.endsWith("(") || token === ")" || (token === "(" && (out.endsWith("-") || out.endsWith(":")));
    if (out && !glued) out += " ";
    out += token;
  }
  return out;
}

const isTagToken = (token: string): boolean => /^tag:#?[^\s()]+$/i.test(token);
/** A chip group's members: `tag:` terms, negated ones too (`-tag:#b`, from a hand-typed `tag:( a OR -b )`). */
const isGroupTagToken = (token: string): boolean => /^-?tag:#?[^\s()]+$/i.test(token);

/**
 * `tag:( a OR b )` typed by hand, in the chips' own form `( tag:#a OR tag:#b )`, so a chip that shows pressed for a
 * bare word in such a group can find it and take it out (@opus-editor). A word with its own op, a `-word` and
 * nested brackets are left as they are; `-tag:( … )` too (it's not a chip).
 */
function chipForm(tokens: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (!/^tag:$/i.test(token) || tokens[i + 1] !== "(") {
      out.push(token);
      continue;
    }
    let close = -1;
    for (let j = i + 2, depth = 0; j < tokens.length; j += 1) {
      if (tokens[j] === "(") depth += 1;
      else if (tokens[j] === ")") {
        if (depth === 0) {
          close = j;
          break;
        }
        depth -= 1;
      }
    }
    const inside = tokens.slice(i + 2, close === -1 ? tokens.length : close);
    if (inside.some((word) => word === "(" || word === ")")) {
      out.push(token);
      continue;
    }
    // A bare word is a tag here; `-b` meant "not tag b" inside `tag:( … )`, so it stays a negated tag (@opus-editor).
    const asTag = (word: string): string => {
      if (word === "OR" || word.includes(":") || word.startsWith('"') || word.startsWith('-"')) return word;
      // A stray "-" (or "-#") alone isn't a tag: left as typed (@opus-editor).
      if (word.startsWith("-")) return word.replace(/^-#?/, "") ? `-tag:#${word.slice(1).replace(/^#/, "")}` : word;
      return `tag:#${word.replace(/^#/, "")}`;
    };
    out.push("(", ...inside.map(asTag), ")");
    i = close === -1 ? tokens.length : close;
  }
  return out;
}

/**
 * Add the chip's `tag:#x` term to the query, or take every positive term for that tag out of it. Two or more
 * chips are one bracketed group, `(tag:#a OR tag:#b)` (@lead): they mean "either tag", while words typed beside
 * them still narrow. Taking a chip out takes its `OR` along and unwraps a group left with one term.
 */
export function toggleQueryTag(query: string, tag: string): string {
  const wanted = tag.toLowerCase();
  const isTerm = (token: string) => {
    const match = /^tag:#?([^\s()]+)$/i.exec(token);
    return Boolean(match && match[1]!.toLowerCase() === wanted);
  };
  let tokens = chipForm(queryTokens(query.trim()));
  if (!queryHasTag(query, tag)) {
    const term = `tag:#${tag}`;
    // An existing chip group: `( tag OR tag … )`.
    for (let open = 0; open < tokens.length; open += 1) {
      if (tokens[open] !== "(") continue;
      const close = tokens.indexOf(")", open);
      const inside = close === -1 ? [] : tokens.slice(open + 1, close);
      if (inside.length && inside.every((token, i) => (i % 2 === 0 ? isGroupTagToken(token) : token === "OR"))) {
        tokens.splice(close, 0, "OR", term);
        return joinTokens(tokens);
      }
    }
    // A lone chip term at the top level becomes the group.
    let depth = 0;
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i]!;
      if (token === "(") depth += 1;
      else if (token === ")") depth = Math.max(0, depth - 1);
      else if (depth === 0 && isTagToken(token) && tokens[i - 1] !== "OR" && tokens[i + 1] !== "OR") {
        tokens.splice(i, 1, "(", token, "OR", term, ")");
        return joinTokens(tokens);
      }
    }
    return joinTokens([...tokens, term]);
  }
  // Out: each term with its OR (the one before it, unless that opens a group; else the one after it).
  const kept: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (!isTerm(token)) {
      kept.push(token);
      continue;
    }
    if (kept[kept.length - 1] === "OR") kept.pop();
    else if (tokens[i + 1] === "OR") i += 1;
  }
  // Tidy groups: `()` goes, `(x)` unwraps.
  tokens = kept;
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < tokens.length; i += 1) {
      if (tokens[i] !== "(") continue;
      if (tokens[i + 1] === ")") {
        tokens.splice(i, 2);
        changed = true;
        break;
      }
      if (tokens[i + 2] === ")" && tokens[i + 1] !== "(" && tokens[i + 1] !== "OR") {
        tokens.splice(i, 3, tokens[i + 1]!);
        changed = true;
        break;
      }
    }
  }
  return joinTokens(tokens);
}
