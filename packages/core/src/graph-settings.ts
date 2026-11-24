/**
 * Graph view settings (v0.8 E1, spec/api-graph-groups): colour groups and
 * filters, kept per vault in `.gumply/graph.json`. A vault Obsidian already
 * set up starts from `.obsidian/graph.json`, read (never written) until the
 * first change is saved to `.gumply/graph.json`.
 */

export interface GraphGroup {
  /** A graph query (`tag:#work`, `path:Projects`, …; see graph-query.ts). */
  query: string;
  /** `#rrggbb`. */
  color: string;
}

export interface GraphFilters {
  /** The search box: a graph query. */
  search: string;
  /** Tag nodes linked to their pages. */
  showTags: boolean;
  /** Attachment nodes linked to the pages that embed them. */
  showAttachments: boolean;
  /** "Existing files only": no ghost nodes for missing pages. */
  hideUnresolved: boolean;
  /** Nodes with no links in view. */
  showOrphans: boolean;
}

/**
 * #xb4b54gr: how the graph groups pages into clusters (a soft area behind
 * each, the groups kept apart): by links (communities), by folder, by first
 * tag, or not at all.
 */
export type GraphClusterMode = "links" | "folder" | "tag" | "off";

export const GRAPH_CLUSTER_MODES: readonly GraphClusterMode[] = ["links", "folder", "tag", "off"];

export interface GraphSettings {
  /** In order: the first group whose query matches colours a node. */
  groups: GraphGroup[];
  filters: GraphFilters;
  /**
   * #xb4b54gr (spec/api v1.36, spec/api-graph-clusters): "Group by" in the
   * graph panel. Absent in the file = the default.
   */
  clusterBy: GraphClusterMode;
}

export type GraphSettingsSource = "gumply" | "obsidian" | "default";

/** `GET /api/graph/settings`: the settings and where they came from. */
export interface GraphSettingsResponse extends GraphSettings {
  source: GraphSettingsSource;
}

export const MAX_GRAPH_GROUPS = 50;
export const MAX_GRAPH_QUERY = 500;

export const DEFAULT_GRAPH_FILTERS: GraphFilters = {
  search: "",
  showTags: false,
  showAttachments: false,
  hideUnresolved: false,
  showOrphans: true,
};

export const DEFAULT_GRAPH_CLUSTERS: GraphClusterMode = "links";

export const DEFAULT_GRAPH_SETTINGS: GraphSettings = { groups: [], filters: DEFAULT_GRAPH_FILTERS, clusterBy: DEFAULT_GRAPH_CLUSTERS };

const HEX = /^#[0-9a-f]{6}$/i;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Settings from untrusted JSON (a file, a request body): unknown keys dropped,
 * bad values replaced by defaults, groups without a query or colour skipped,
 * lists and text capped.
 */
export function normalizeGraphSettings(raw: unknown): GraphSettings {
  const data = isObject(raw) ? raw : {};
  const groups: GraphGroup[] = [];
  for (const entry of Array.isArray(data.groups) ? data.groups : []) {
    if (groups.length >= MAX_GRAPH_GROUPS) break;
    if (!isObject(entry) || typeof entry.query !== "string" || typeof entry.color !== "string") continue;
    if (!HEX.test(entry.color)) continue;
    groups.push({ query: entry.query.slice(0, MAX_GRAPH_QUERY), color: entry.color.toLowerCase() });
  }
  const filters = isObject(data.filters) ? data.filters : {};
  const flag = (key: keyof GraphFilters) => (typeof filters[key] === "boolean" ? (filters[key] as boolean) : (DEFAULT_GRAPH_FILTERS[key] as boolean));
  return {
    groups,
    filters: {
      search: typeof filters.search === "string" ? filters.search.slice(0, MAX_GRAPH_QUERY) : "",
      showTags: flag("showTags"),
      showAttachments: flag("showAttachments"),
      hideUnresolved: flag("hideUnresolved"),
      showOrphans: flag("showOrphans"),
    },
    clusterBy: GRAPH_CLUSTER_MODES.includes(data.clusterBy as GraphClusterMode) ? (data.clusterBy as GraphClusterMode) : DEFAULT_GRAPH_CLUSTERS,
  };
}

/**
 * The file to write for `next`, keeping what's already in `.gumply/graph.json`
 * that Gumply doesn't know (spec/file-format §7: unknown keys are never
 * dropped on write): unknown top-level and `filters` keys stay, in the file's
 * order; a group keeps its unknown keys when its query matches a group on disk
 * (the first one not taken yet). Known keys take `next`'s values.
 */
export function mergeGraphSettings(onDisk: unknown, next: GraphSettings, options: { clusterBy?: boolean } = {}): Record<string, unknown> {
  const disk = isObject(onDisk) ? onDisk : {};
  const merged: Record<string, unknown> = { ...disk };
  const diskGroups = Array.isArray(disk.groups) ? disk.groups.filter(isObject) : [];
  const taken = new Set<Record<string, unknown>>();
  merged.groups = next.groups.map((group) => {
    const match = diskGroups.find((candidate) => !taken.has(candidate) && candidate.query === group.query);
    if (!match) return { ...group };
    taken.add(match);
    return { ...match, query: group.query, color: group.color };
  });
  merged.filters = { ...(isObject(disk.filters) ? disk.filters : {}), ...next.filters };
  // #xb4b54gr: the mode is written only when the user set it (a PUT that carries
  // it); otherwise the file's own value stays, even one a newer Gumply wrote.
  if (options.clusterBy) merged.clusterBy = next.clusterBy;
  return merged;
}

/** `{ rgb: 14701138, a: 1 }` (Obsidian's colour) → `#e05252`. */
export function obsidianColor(value: unknown): string | null {
  if (!isObject(value) || typeof value.rgb !== "number" || !Number.isInteger(value.rgb)) return null;
  if (value.rgb < 0 || value.rgb > 0xffffff) return null;
  return `#${value.rgb.toString(16).padStart(6, "0")}`;
}

/** Obsidian's `.obsidian/graph.json` as Gumply settings (its other keys are left alone). */
export function fromObsidianGraph(raw: unknown): GraphSettings {
  const data = isObject(raw) ? raw : {};
  const groups: GraphGroup[] = [];
  for (const entry of Array.isArray(data.colorGroups) ? data.colorGroups : []) {
    if (!isObject(entry) || typeof entry.query !== "string") continue;
    const color = obsidianColor(entry.color);
    if (color) groups.push({ query: entry.query, color });
  }
  return normalizeGraphSettings({
    groups,
    filters: {
      search: data.search,
      showTags: data.showTags,
      showAttachments: data.showAttachments,
      hideUnresolved: data.hideUnresolved,
      showOrphans: data.showOrphans,
    },
  });
}
