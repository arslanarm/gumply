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
 * #nadk3urm: the graph's forces, each a multiplier on Gumply's own force (1 =
 * unchanged), like Obsidian's "Forces" sliders. Multipliers rather than values,
 * because the default forces depend on the graph's size (a firmer centre pull
 * for small vaults, a stronger charge for big ones): 1 is the default layout at
 * every size. Obsidian's own force values (another engine, another scale) are
 * not read.
 */
export interface GraphForces {
  /** The pull of every page towards the middle (0 = none: unlinked groups drift apart). */
  center: number;
  /** How hard pages push each other away. */
  repel: number;
  /** How hard a link pulls its two pages together. */
  linkStrength: number;
  /** A link's resting length. */
  linkDistance: number;
}

export interface GraphSettings {
  /** In order: the first group whose query matches colours a node. */
  groups: GraphGroup[];
  filters: GraphFilters;
  forces: GraphForces;
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

export const DEFAULT_GRAPH_FORCES: GraphForces = { center: 1, repel: 1, linkStrength: 1, linkDistance: 1 };

/** Each force's range and step (the panel's sliders use the same). */
export const GRAPH_FORCE_RANGES: Record<keyof GraphForces, { min: number; max: number; step: number }> = {
  center: { min: 0, max: 2, step: 0.05 },
  repel: { min: 0, max: 3, step: 0.05 },
  linkStrength: { min: 0, max: 2, step: 0.05 },
  linkDistance: { min: 0.25, max: 4, step: 0.05 },
};

export const GRAPH_FORCE_KEYS = Object.keys(DEFAULT_GRAPH_FORCES) as Array<keyof GraphForces>;

/** Whether every force is at its default (1). */
export function isDefaultGraphForces(forces: GraphForces): boolean {
  return GRAPH_FORCE_KEYS.every((key) => forces[key] === DEFAULT_GRAPH_FORCES[key]);
}

export const DEFAULT_GRAPH_SETTINGS: GraphSettings = { groups: [], filters: DEFAULT_GRAPH_FILTERS, forces: DEFAULT_GRAPH_FORCES };

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
    forces: normalizeGraphForces(data.forces),
  };
}

/** Forces from untrusted JSON: each one a finite number clamped to its range, else the default (1). */
export function normalizeGraphForces(raw: unknown): GraphForces {
  const data = isObject(raw) ? raw : {};
  const forces = { ...DEFAULT_GRAPH_FORCES };
  for (const key of GRAPH_FORCE_KEYS) {
    const value = data[key];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const { min, max } = GRAPH_FORCE_RANGES[key];
    forces[key] = Math.min(max, Math.max(min, value));
  }
  return forces;
}

/**
 * The file to write for `next`, keeping what's already in `.gumply/graph.json`
 * that Gumply doesn't know (spec/file-format §7: unknown keys are never
 * dropped on write): unknown top-level and `filters` keys stay, in the file's
 * order; a group keeps its unknown keys when its query matches a group on disk
 * (the first one not taken yet). Known keys take `next`'s values.
 */
export function mergeGraphSettings(onDisk: unknown, next: GraphSettings): Record<string, unknown> {
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
  // #nadk3urm: written once they're changed (or already in the file), so a vault
  // whose forces were never touched keeps its file as it was.
  if (isObject(disk.forces) || !isDefaultGraphForces(next.forces)) {
    merged.forces = { ...(isObject(disk.forces) ? disk.forces : {}), ...next.forces };
  }
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
