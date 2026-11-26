/**
 * Obsidian Bases files (`.base`, spec/api-bases, #sg36ng2d): read a file into
 * a `BaseConfig`, and write a changed config back touching only what changed.
 *
 * The file is edited through the `yaml` Document API: comments, key order,
 * quoting and keys Gumply doesn't know (other plugins' views, newer Obsidian
 * settings) are kept. A scalar that changes keeps its quoting style. Callers
 * never write a base whose config didn't change, so untouched files stay
 * byte-for-byte.
 */
import { isMap, isScalar, isSeq, parseDocument, type Document, type Node, type YAMLMap, type YAMLSeq } from "yaml";

export type BaseViewType = "table" | "cards" | "list" | "kanban" | "calendar" | (string & {});
export type BaseFilter = string | { and: BaseFilter[] } | { or: BaseFilter[] } | { not: BaseFilter[] };
export type SortDirection = "ASC" | "DESC";

export interface BaseView {
  type: BaseViewType;
  name: string;
  limit?: number;
  filters?: BaseFilter;
  order?: string[];
  sort?: { property: string; direction: SortDirection }[];
  groupBy?: { property: string; direction: SortDirection };
  groupOrder?: (string | null)[];
  summaries?: Record<string, string>;
  /** Layout keys (cards image, calendar `dateProperty`…) and keys Gumply doesn't know. */
  [key: string]: unknown;
}

export interface BaseConfig {
  filters?: BaseFilter;
  formulas?: Record<string, string>;
  properties?: Record<string, { displayName?: string; [key: string]: unknown }>;
  summaries?: Record<string, string>;
  views: BaseView[];
  [key: string]: unknown;
}

/** Layouts Gumply renders; others are listed and kept, but not shown. */
export const GUMPLY_VIEW_TYPES: readonly BaseViewType[] = ["table", "cards", "list", "kanban", "calendar"];

export class BaseParseError extends Error {}

const YAML_OPTIONS = { prettyErrors: false, uniqueKeys: false } as const;
/** Long filter strings must never be folded onto several lines. */
const STRINGIFY_OPTIONS = { lineWidth: 0, minContentWidth: 0, flowCollectionPadding: false } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normaliseFilter(value: unknown): BaseFilter | undefined {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  for (const key of ["and", "or", "not"] as const) {
    const list = value[key];
    if (Array.isArray(list)) {
      return { [key]: list.map(normaliseFilter).filter((item): item is BaseFilter => item !== undefined) } as BaseFilter;
    }
  }
  return undefined;
}

function normaliseView(value: unknown, index: number): BaseView {
  const view = isRecord(value) ? { ...value } : {};
  const type = typeof view.type === "string" && view.type ? view.type : "table";
  const name = typeof view.name === "string" && view.name.trim() ? view.name : `View ${index + 1}`;
  return { ...view, type, name } as BaseView;
}

/** Parse a `.base` file. An empty file is a base with no views. */
export function parseBase(source: string): BaseConfig {
  const doc = parseDocument(source, YAML_OPTIONS);
  if (doc.errors.length) throw new BaseParseError(doc.errors[0]!.message);
  const data: unknown = doc.toJS() ?? {};
  if (!isRecord(data)) throw new BaseParseError("A base must be a YAML mapping.");
  const config: BaseConfig = { ...(data as Record<string, unknown>), views: [] };
  const filters = normaliseFilter(data.filters);
  if (filters === undefined) delete config.filters;
  else config.filters = filters;
  config.views = Array.isArray(data.views) ? data.views.map(normaliseView) : [];
  return config;
}

/**
 * A new base: one table view, optionally limited to a folder or a tag.
 * With `rows` (#7prbquxu, spec/database-tables §1), a database that owns its rows
 * folder: the `gumply: {rows}` marker and `file.folder == "<rows>"` (that folder's
 * own pages, as the Notion import writes); `folder` and `tag` are then ignored.
 */
export function newBaseSource(options: { folder?: string | null; tag?: string; viewName?: string; rows?: string } = {}): string {
  const lines: string[] = [];
  if (options.rows) lines.push("gumply:", `  rows: ${quoteIfNeeded(options.rows)}`);
  const filter = options.rows
    ? `file.folder == ${JSON.stringify(options.rows)}`
    : options.tag
      ? `file.hasTag(${JSON.stringify(options.tag.replace(/^#/, ""))})`
      : options.folder
        ? `file.inFolder(${JSON.stringify(options.folder)})`
        : null;
  if (filter) lines.push("filters:", "  and:", `    - ${quoteIfNeeded(filter)}`);
  lines.push("views:", "  - type: table", `    name: ${quoteIfNeeded(options.viewName ?? "Table")}`, "    order:", "      - file.name");
  return `${lines.join("\n")}\n`;
}

/**
 * The rows folder a database owns (#7prbquxu): `gumply.rows`, when its global filter
 * still reads that folder's own pages (`file.folder == "<rows>"`). Otherwise null, and
 * the base is a plain view of pages (an edited filter or a stray marker never hides
 * or renames a folder). Key order inside `gumply:` doesn't matter (Obsidian reorders).
 */
export function ownedRowsFolder(config: BaseConfig): string | null {
  const marker = config.gumply;
  if (!isRecord(marker) || typeof marker.rows !== "string" || !marker.rows.trim()) return null;
  const rows = marker.rows;
  const filter = config.filters;
  const list = filter === undefined ? [] : typeof filter === "string" ? [filter] : "and" in filter ? filter.and : [];
  const wanted = `file.folder == ${JSON.stringify(rows)}`;
  return list.some((item) => typeof item === "string" && item.replace(/\s*==\s*/, " == ").trim() === wanted) ? rows : null;
}

/** #7prbquxu phase 4: whether an owned database's marker asks to show its rows in the sidebar (`showRows: true`). */
export function rowsShown(config: BaseConfig): boolean {
  const marker = config.gumply;
  return isRecord(marker) && marker.showRows === true;
}

/** The config with the marker's `showRows` set (true) or removed (false); everything else as it was. */
export function withRowsShown(config: BaseConfig, shown: boolean): BaseConfig {
  const marker = isRecord(config.gumply) ? { ...config.gumply } : {};
  if (shown) marker.showRows = true;
  else delete marker.showRows;
  return { ...config, gumply: marker };
}

/**
 * The config of an owned database whose rows folder moved to `rows` (#7prbquxu): the
 * marker and the `file.folder ==` clause follow; everything else is kept, so
 * `updateBaseSource` rewrites only those two lines. A base that doesn't own a folder
 * comes back unchanged.
 */
export function withOwnedRows(config: BaseConfig, rows: string): BaseConfig {
  const owned = ownedRowsFolder(config);
  if (owned === null || owned === rows) return config;
  const before = `file.folder == ${JSON.stringify(owned)}`;
  const after = `file.folder == ${JSON.stringify(rows)}`;
  const swap = (item: BaseFilter): BaseFilter =>
    typeof item === "string" && item.replace(/\s*==\s*/, " == ").trim() === before ? after : item;
  const filter = config.filters;
  const filters: BaseFilter | undefined =
    filter === undefined ? undefined : typeof filter === "string" ? swap(filter) : "and" in filter ? { and: filter.and.map(swap) } : filter;
  return { ...config, gumply: { ...(config.gumply as Record<string, unknown>), rows }, ...(filters === undefined ? {} : { filters }) };
}

function quoteIfNeeded(text: string): string {
  const doc = parseDocument("x: 0");
  doc.set("x", text);
  return doc.toString(STRINGIFY_OPTIONS).slice(3).trimEnd();
}

/* ------------------------------------------------------------- writing */

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a).filter((key) => a[key] !== undefined);
    const otherKeys = Object.keys(b).filter((key) => b[key] !== undefined);
    return keys.length === otherKeys.length && keys.every((key) => deepEqual(a[key], b[key]));
  }
  return false;
}

/** Make `node` hold `next`, editing in place where the shapes match. */
function patchNode(doc: Document, node: Node | null | undefined, previous: unknown, next: unknown): Node {
  if (deepEqual(previous, next) && node) return node;
  if (node && isScalar(node) && !isRecord(next) && !Array.isArray(next)) {
    node.value = next;
    // A changed value must still be valid in its old quoting style.
    if (typeof next !== "string" && (node.type === "QUOTE_DOUBLE" || node.type === "QUOTE_SINGLE")) node.type = undefined;
    if (typeof next === "string" && node.type === "PLAIN") node.type = undefined;
    return node;
  }
  if (node && isMap(node) && isRecord(next) && isRecord(previous)) {
    patchMap(doc, node, previous, next);
    return node;
  }
  if (node && isSeq(node) && Array.isArray(next) && Array.isArray(previous)) {
    patchSeq(doc, node, previous, next);
    return node;
  }
  return doc.createNode(next) as Node;
}

/**
 * #bg7c9bzk (#faqr8pj9's #21): Obsidian 1.14.4's top-level order for a .base. It rewrites a file just by opening it
 * when `properties:` comes after `views:`, so a key Gumply **adds** goes where Obsidian would put it. A file's
 * existing keys are never moved.
 */
const TOP_LEVEL_ORDER = ["gumply", "filters", "formulas", "properties", "summaries", "views"];

function patchMap(doc: Document, map: YAMLMap, previous: Record<string, unknown>, next: Record<string, unknown>, top = false): void {
  for (const key of Object.keys(previous)) {
    if (next[key] === undefined && previous[key] !== undefined) map.delete(key);
  }
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) continue;
    const existing = map.get(key, true) as Node | undefined;
    if (existing !== undefined && deepEqual(previous[key], value)) continue;
    const patched = patchNode(doc, existing, previous[key], value);
    if (patched === existing) continue;
    const rank = TOP_LEVEL_ORDER.indexOf(key);
    if (top && existing === undefined && rank !== -1) {
      // Before the first existing key that Obsidian writes after this one; else at the end, as before.
      const at = map.items.findIndex((pair) => {
        const other = TOP_LEVEL_ORDER.indexOf(String((pair.key as { value?: unknown } | null)?.value ?? pair.key));
        return other > rank;
      });
      if (at !== -1) {
        map.items.splice(at, 0, doc.createPair(key, patched));
        continue;
      }
    }
    map.set(key, patched);
  }
}

function patchSeq(doc: Document, seq: YAMLSeq, previous: unknown[], next: unknown[]): void {
  // #7prbquxu (@lead): an empty flow list (`gumplyOptions: []`) that gets its first items is written as a block
  // list, like the base's other lists, not grown in flow style (`[{value: Todo, color: brown}]`).
  if (seq.flow && previous.length === 0 && next.length > 0) seq.flow = false;
  // Keep the items that didn't change (and their comments) around an insert or a removal.
  let prefix = 0;
  while (prefix < previous.length && prefix < next.length && deepEqual(previous[prefix], next[prefix])) prefix += 1;
  let suffix = 0;
  while (
    suffix < previous.length - prefix &&
    suffix < next.length - prefix &&
    deepEqual(previous[previous.length - 1 - suffix], next[next.length - 1 - suffix])
  )
    suffix += 1;
  const oldMiddle = previous.length - prefix - suffix;
  const newMiddle = next.length - prefix - suffix;
  const oldValues = previous.slice(prefix, prefix + oldMiddle);
  const reordered =
    oldMiddle === newMiddle &&
    next.slice(prefix, prefix + newMiddle).every((value) => {
      const found = oldValues.findIndex((candidate) => deepEqual(candidate, value));
      if (found >= 0) oldValues.splice(found, 1);
      return found >= 0;
    });
  if (oldMiddle === newMiddle && !reordered) {
    for (let i = prefix; i < prefix + newMiddle; i += 1) {
      const existing = seq.items[i] as Node | undefined;
      const patched = patchNode(doc, existing, previous[i], next[i]);
      if (patched !== existing) seq.items[i] = patched;
    }
    return;
  }
  // A view moved: reuse its node so its comments and unknown keys move with it.
  const pool = seq.items.slice(prefix, prefix + oldMiddle) as Node[];
  const poolValues = previous.slice(prefix, prefix + oldMiddle);
  const replacement = next.slice(prefix, prefix + newMiddle).map((value) => {
    const found = poolValues.findIndex((candidate) => deepEqual(candidate, value));
    if (found >= 0) {
      poolValues.splice(found, 1);
      return pool.splice(found, 1)[0]!;
    }
    return doc.createNode(value) as Node;
  });
  seq.items.splice(prefix, oldMiddle, ...replacement);
}

/**
 * Write `next` into the base file `source`, changing only what differs from
 * what `source` holds. Returns `source` itself when nothing changed.
 */
export function updateBaseSource(source: string, next: BaseConfig): string {
  const doc = parseDocument(source, YAML_OPTIONS);
  if (doc.errors.length) throw new BaseParseError(doc.errors[0]!.message);
  const previous: unknown = doc.toJS() ?? {};
  const wanted = stripUndefined(next) as Record<string, unknown>;
  // `parseBase` fills in defaults (a view's name, a tidied filter). Parts the
  // caller didn't change are written as they were, defaults not added.
  if (isRecord(previous)) {
    const parsed = parseBase(source);
    if (deepEqual(stripUndefined(parsed), wanted)) return source;
    if ("filters" in previous && deepEqual(parsed.filters, wanted.filters)) wanted.filters = previous.filters;
    const rawViews = Array.isArray(previous.views) ? previous.views : [];
    if (Array.isArray(wanted.views)) {
      wanted.views = wanted.views.map((view) => {
        const same = parsed.views.findIndex((candidate) => deepEqual(stripUndefined(candidate), view));
        return same >= 0 && rawViews[same] !== undefined ? rawViews[same] : view;
      });
    }
  }
  if (deepEqual(previous, wanted)) return source;
  const before = doc.toString(STRINGIFY_OPTIONS);
  if (isMap(doc.contents) && isRecord(previous)) {
    patchMap(doc, doc.contents, previous, wanted as Record<string, unknown>, true);
  } else {
    doc.contents = doc.createNode(wanted) as typeof doc.contents;
  }
  const after = doc.toString(STRINGIFY_OPTIONS);
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  return spliceLines(source, before, after).replace(/\r?\n/g, eol);
}

/**
 * The `yaml` printer doesn't reproduce every byte (flow spacing, some
 * quoting), so the edit is carried over line by line: lines the edit didn't
 * touch come from `source`; only the changed lines are printed ones.
 * `before` is `source` as printed, `after` the edited document as printed.
 */
function spliceLines(source: string, before: string, after: string): string {
  const sourceLines = source.replace(/\r\n/g, "\n").split("\n");
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  // Printing may only differ from the file within lines; otherwise lines don't line up.
  if (sourceLines.length !== beforeLines.length) return after;
  const n = beforeLines.length;
  const m = afterLines.length;
  if (n * m > 4_000_000) return after;
  // Longest common subsequence of lines.
  const table = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * (m + 1) + j] =
        beforeLines[i] === afterLines[j]
          ? table[(i + 1) * (m + 1) + j + 1]! + 1
          : Math.max(table[(i + 1) * (m + 1) + j]!, table[i * (m + 1) + j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && beforeLines[i] === afterLines[j]) {
      out.push(sourceLines[i]!);
      i += 1;
      j += 1;
    } else if (j < m && (i >= n || table[i * (m + 1) + j + 1]! >= table[(i + 1) * (m + 1) + j]!)) {
      out.push(afterLines[j]!);
      j += 1;
    } else {
      i += 1;
    }
  }
  return out.join("\n");
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) if (item !== undefined) out[key] = stripUndefined(item);
  return out;
}
