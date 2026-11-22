/**
 * Obsidian reads the keys `tags` and `aliases` in any case (`Tags:`,
 * `ALIASES:`), plural only: `tag:` and `alias:` are ordinary properties
 * (#ippqkgus, measured in Obsidian 1.14.4).
 */
export function isTagsKey(key: string): boolean {
  return key.toLowerCase() === "tags";
}

export function isAliasesKey(key: string): boolean {
  return key.toLowerCase() === "aliases";
}

/**
 * The key a note uses for `tags` or `aliases`, as written: the first one in
 * file order whose name is that in any case. When a note has two spellings
 * (`tags:` and `Tags:`), Obsidian reads only the first, and Gumply reads and
 * writes only the first too; the other stays as written.
 */
export function frontmatterKey(keys: Iterable<string>, name: "tags" | "aliases"): string | undefined {
  for (const key of keys) if (key.toLowerCase() === name) return key;
  return undefined;
}
