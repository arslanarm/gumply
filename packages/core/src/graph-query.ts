/**
 * Graph search queries (v0.8 E1, spec/api-graph-groups), shared by the graph's
 * search filter and its colour groups, in the subset of Obsidian's search
 * syntax that a graph needs:
 *
 * - `tag:#work` (or `tag:work`): the tag or any tag nested under it;
 * - `path:Projects/Q1`: the item's vault path contains it;
 * - `file:plan`: the file name contains it;
 * - a plain word: the title or the file name contains it;
 * - `"a quoted phrase"` for spaces, `-term` for "not", terms side by side
 *   all have to match, and `OR` between terms means either side.
 *
 * Case-insensitive. Unknown `op:` prefixes are plain text, as in Obsidian.
 */
import { tagMatches } from "./tags.js";

export type GraphQueryOp = "tag" | "path" | "file" | "text";

export interface GraphQueryTerm {
  op: GraphQueryOp;
  /** Lowercase; for `tag`, without `#`. */
  value: string;
  negate: boolean;
}

/** Alternatives (`OR`) of terms that all have to match. Empty: matches everything. */
export type GraphQuery = GraphQueryTerm[][];

/** What a query is matched against. */
export interface GraphQueryItem {
  title: string;
  /** Vault path with extension (`Projects/Plan.md`, `Map.canvas`). */
  path: string;
  tags: readonly string[];
}

const OPS: ReadonlySet<string> = new Set(["tag", "path", "file"]);

/** Split into tokens: quoted phrases stay whole, `-` and `op:` stay attached. */
function tokens(query: string): string[] {
  const out: string[] = [];
  const pattern = /(-?)(?:([A-Za-z]+):)?(?:"([^"]*)"?|(\S+))/g;
  for (const match of query.matchAll(pattern)) out.push(match[0]);
  return out;
}

export function parseGraphQuery(query: string): GraphQuery {
  const alternatives: GraphQuery = [];
  let current: GraphQueryTerm[] = [];
  for (const token of tokens(query.trim())) {
    if (token === "OR") {
      if (current.length) alternatives.push(current);
      current = [];
      continue;
    }
    const match = /^(-?)(?:([A-Za-z]+):)?(?:"([^"]*)"?|(.*))$/s.exec(token);
    if (!match) continue;
    const negate = match[1] === "-";
    const prefix = match[2]?.toLowerCase();
    const raw = match[3] ?? match[4] ?? "";
    let op: GraphQueryOp = "text";
    let value = raw;
    if (prefix && OPS.has(prefix)) op = prefix as GraphQueryOp;
    else if (prefix) value = `${match[2]}:${raw}`; // unknown op: plain text, as written
    value = value.trim().toLowerCase();
    if (op === "tag") value = value.replace(/^#/, "");
    if (!value) continue;
    current.push({ op, value, negate });
  }
  if (current.length) alternatives.push(current);
  return alternatives;
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).toLowerCase();
}

function termMatches(term: GraphQueryTerm, item: GraphQueryItem): boolean {
  switch (term.op) {
    case "tag":
      return item.tags.some((tag) => tagMatches(tag, term.value));
    case "path":
      return item.path.toLowerCase().includes(term.value);
    case "file":
      return fileName(item.path).includes(term.value);
    default:
      return item.title.toLowerCase().includes(term.value) || fileName(item.path).includes(term.value);
  }
}

/** Whether `item` matches; an empty query matches everything. */
export function matchesGraphQuery(query: GraphQuery, item: GraphQueryItem): boolean {
  if (query.length === 0) return true;
  return query.some((terms) => terms.every((term) => termMatches(term, item) !== term.negate));
}

/** The vault path of a graph page by its id (pages are `<id>.md`, boards keep `.canvas`). */
export function graphItemPath(id: string, kind: string | undefined): string {
  if (kind === "whiteboard" || kind === "base" || /\.md$/i.test(id)) return id;
  return `${id}.md`;
}
