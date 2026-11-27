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
 *   all have to match, and `OR` between terms means either side;
 * - `( … )` groups (#yy347xgi): `basil (tag:#a OR tag:#b)` is basil within
 *   either tag, as in Obsidian. A group is expanded into the alternatives;
 *   `-( … )` negates it (`-(a OR b)` is `-a -b`, `-(a b)` is `-a OR -b`).
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

/** Split into tokens: quoted phrases stay whole, `-` and `op:` stay attached, `(` and `)` stand alone. */
function tokens(query: string): string[] {
  const out: string[] = [];
  const pattern = /[()]|(-?)(?:([A-Za-z]+):)?(?:"([^"]*)"?|([^\s()]+))/g;
  for (const match of query.matchAll(pattern)) out.push(match[0]);
  return out;
}

function parseTerm(token: string): GraphQueryTerm | null {
  const match = /^(-?)(?:([A-Za-z]+):)?(?:"([^"]*)"?|(.*))$/s.exec(token);
  if (!match) return null;
  const negate = match[1] === "-";
  const prefix = match[2]?.toLowerCase();
  const raw = match[3] ?? match[4] ?? "";
  let op: GraphQueryOp = "text";
  let value = raw;
  if (prefix && OPS.has(prefix)) op = prefix as GraphQueryOp;
  else if (prefix) value = `${match[2]}:${raw}`; // unknown op: plain text, as written
  value = value.trim().toLowerCase();
  if (op === "tag") value = value.replace(/^#/, "");
  if (!value) return null;
  return { op, value, negate };
}

/** A query that expands past this many alternatives keeps the first ones (a pathological nesting of ORs). */
const MAX_ALTERNATIVES = 256;

/** Not (any alternative): for each alternative, one of its terms negated; every combination (De Morgan). */
function negate(query: GraphQuery): GraphQuery {
  let out: GraphQuery = [[]];
  for (const terms of query) out = product(out, terms.map((term) => [{ ...term, negate: !term.negate }]));
  return out;
}

/** Terms side by side: every combination of their alternatives (`a (b OR c)` → `a b`, `a c`). */
function product(left: GraphQuery, right: GraphQuery): GraphQuery {
  const out: GraphQuery = [];
  for (const a of left) for (const b of right) if (out.length < MAX_ALTERNATIVES) out.push([...a, ...b]);
  return out;
}

export function parseGraphQuery(query: string): GraphQuery {
  const list = tokens(query.trim());
  let at = 0;
  // expr := and ("OR" and)* ; and := primary* ; primary := "(" expr ")" | term. Returns alternatives of terms.
  const expr = (): GraphQuery => {
    const alternatives: GraphQuery = [...and()];
    while (list[at] === "OR") {
      at += 1;
      alternatives.push(...and());
    }
    return alternatives.slice(0, MAX_ALTERNATIVES);
  };
  const and = (): GraphQuery => {
    let result: GraphQuery = [[]];
    while (at < list.length && list[at] !== "OR" && list[at] !== ")") {
      const token = list[at]!;
      at += 1;
      // `-( … )`: the group negated (the tokenizer leaves the `-` on its own before `(`).
      if (token === "-" && list[at] === "(") {
        at += 1;
        const group = expr();
        if (list[at] === ")") at += 1;
        if (group.length) result = product(result, negate(group));
        continue;
      }
      if (token === "(") {
        const group = expr();
        if (list[at] === ")") at += 1; // an unclosed group ends at the end
        if (group.length) result = product(result, group);
        continue;
      }
      const term = parseTerm(token);
      if (term) result = product(result, [[term]]);
    }
    return result;
  };
  const alternatives: GraphQuery = [];
  while (at < list.length) {
    alternatives.push(...expr());
    if (list[at] === ")") at += 1; // a stray ")" is skipped
  }
  // Empty alternatives (a bare `OR`, `()`) say nothing: dropped, as before.
  return alternatives.filter((terms) => terms.length > 0).slice(0, MAX_ALTERNATIVES);
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
