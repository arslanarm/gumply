/** Pure helpers for the “Linked from” panel (spec/ux §8). */
import { parseWikiLinkText } from "./wikilinks.js";

export interface SnippetPart {
  text: string;
  highlight: boolean;
}

/** What a `[[...]]` fragment reads as in a snippet (alias > title, plus #heading). */
function wikiLinkLabel(raw: string): string {
  // A board embed (D30): `![[Plan/Map.canvas|480]]` reads as "Map"; what
  // follows `|` is its height, not an alias.
  if (raw.startsWith("!")) {
    const target = raw.slice(3, -2).split("|")[0] ?? "";
    return (target.split("/").pop() ?? target).replace(/\.canvas$/i, "").trim() || target;
  }
  const parsed = parseWikiLinkText(raw);
  if (!parsed) return raw;
  const label = parsed.alias.length > 0 ? parsed.alias : parsed.title;
  return parsed.heading.length > 0 ? `${label}#${parsed.heading}` : label;
}

/** Split a backlink snippet so `[[Page]]` fragments can be highlighted. */
export function splitSnippet(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  const pattern = /!?\[\[[^[\]\r\n]*\]\]/g;
  let last = 0;

  for (const match of snippet.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) parts.push({ text: snippet.slice(last, index), highlight: false });
    parts.push({ text: wikiLinkLabel(match[0]), highlight: true });
    last = index + match[0].length;
  }

  if (last < snippet.length) parts.push({ text: snippet.slice(last), highlight: false });
  return parts;
}

/** Five rows by default; “Show all N” reveals the rest. */
export function visibleBacklinks<T>(items: readonly T[], expanded: boolean, limit = 5): T[] {
  return expanded ? [...items] : items.slice(0, limit);
}
