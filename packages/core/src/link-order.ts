/**
 * Which of several equally good link targets Obsidian 1.14.4 opens, for pages
 * (`resolveWikilink`) and files (`link-files.ts`, v1.17) alike, so the two
 * can't drift apart (#35e42m7v). Measured by @opus-hunter with
 * `metadataCache.getFirstLinkpathDest(link, source)`:
 *
 * 1. (the caller's job) a link that is a whole vault path wins outright;
 * 2. otherwise a candidate under the linking note's folder, at any depth;
 * 3. then the shortest path (string length, not depth);
 * 4. then alphabetical order, case-insensitive (`Aaaa/five.md` before
 *    `Zzzz/Five.md`: the case of the name doesn't matter).
 */

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: false });

/** The folder of the linking note, lowercased with a trailing `/` ("" at the vault root or with no note). */
export function linkSourceFolder(from: string | null | undefined): string {
  if (!from) return "";
  const slash = from.lastIndexOf("/");
  return slash === -1 ? "" : from.slice(0, slash + 1).toLowerCase();
}

/** Whether path `a` is preferred over path `b` (rules 2–4) for a note in `folder` (from `linkSourceFolder`). */
export function preferredLinkPath(a: string, b: string, folder: string): boolean {
  if (folder) {
    const insideA = a.toLowerCase().startsWith(folder);
    const insideB = b.toLowerCase().startsWith(folder);
    if (insideA !== insideB) return insideA;
  }
  if (a.length !== b.length) return a.length < b.length;
  const order = collator.compare(a, b);
  return order !== 0 ? order < 0 : a < b;
}

/** The candidate Obsidian opens (rules 2–4), or null for none. */
export function pickLinkTarget<T>(candidates: Iterable<T>, pathOf: (candidate: T) => string, from: string | null | undefined): T | null {
  const folder = linkSourceFolder(from);
  let best: T | null = null;
  for (const candidate of candidates) {
    if (best === null || preferredLinkPath(pathOf(candidate), pathOf(best), folder)) best = candidate;
  }
  return best;
}
