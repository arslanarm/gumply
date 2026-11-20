/** Pure helpers for the “Linked from” panel (spec/ux §8). */

export interface SnippetPart {
  text: string;
  highlight: boolean;
}

/** Split a backlink snippet so `[[Page]]` fragments can be highlighted. */
export function splitSnippet(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  const pattern = /\[\[[^[\]]*\]\]/g;
  let last = 0;

  for (const match of snippet.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) parts.push({ text: snippet.slice(last, index), highlight: false });
    parts.push({ text: match[0], highlight: true });
    last = index + match[0].length;
  }

  if (last < snippet.length) parts.push({ text: snippet.slice(last), highlight: false });
  return parts;
}

/** Five rows by default; “Show all N” reveals the rest. */
export function visibleBacklinks<T>(items: readonly T[], expanded: boolean, limit = 5): T[] {
  return expanded ? [...items] : items.slice(0, limit);
}
