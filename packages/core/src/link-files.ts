/**
 * Obsidian-style file links (#8k4ssrkb, spec/api-attachments-resolve):
 * `![[photo.png]]`, `[[att/report.pdf]]` resolve to a vault file the way
 * Obsidian 1.14.4 does (@opus-hunter's measurements):
 *
 * 1. a link that is a whole vault path wins (case-insensitive);
 * 2. otherwise the candidates are files whose path ends in `/<link>`:
 *    - those inside the linking note's folder (descendants included), if any;
 *    - then the shortest path (string length, not depth);
 *    - then a case-insensitive locale compare (`a/t.png` before `B/t.png`).
 *
 * Only attachment-type files (D19 allowlist) take part; dot folders
 * (`.trash`, `.gumply`, `.obsidian`…) never do. The real path is returned,
 * never the link text. Moving a note can change which same-named file a bare
 * link resolves to, as in Obsidian; nothing is rewritten.
 */
import { hasAttachmentExtension } from "./links.js";
import { WIKILINK_INNER } from "./wikilink-syntax.js";

/** Whether a vault path may be a link target: an allowlisted file outside dot folders. */
export function isLinkableFile(path: string): boolean {
  if (!hasAttachmentExtension(path)) return false;
  return !path.split("/").some((segment) => segment.startsWith(".") || segment.length === 0);
}

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: false });

function better(a: string, b: string): boolean {
  if (a.length !== b.length) return a.length < b.length;
  const order = collator.compare(a, b);
  return order !== 0 ? order < 0 : a < b;
}

/**
 * An in-memory index of the vault's linkable files: name → paths, so a
 * resolve looks only at files of that name (O(matches), not a scan).
 */
export class LinkFileIndex {
  private readonly byName = new Map<string, string[]>();
  private readonly byPath = new Map<string, string>();

  constructor(paths: Iterable<string>) {
    for (const path of paths) this.add(path);
  }

  /** Index one more file (a file saved since the last scan, #zawz963a). */
  add(path: string): void {
    if (!isLinkableFile(path)) return;
    const lower = path.toLowerCase();
    if (this.byPath.has(lower)) return;
    this.byPath.set(lower, path);
    const name = lower.slice(lower.lastIndexOf("/") + 1);
    const list = this.byName.get(name);
    if (list) list.push(path);
    else this.byName.set(name, [path]);
  }

  get size(): number {
    return this.byPath.size;
  }

  /** Every indexed file's vault path (#3ht5gh6q: the cover picker's image list). */
  paths(): string[] {
    return [...this.byPath.values()];
  }

  /**
   * The file `link` points at from the note at vault path `fromNote`
   * (`Projects/Plan.md`; null or unknown: as from the vault root).
   */
  resolve(link: string, fromNote: string | null): string | null {
    const clean = link.split("|")[0]!.split("#")[0]!.trim().replace(/^\/+/, "").replace(/\\/g, "/");
    if (!clean || !hasAttachmentExtension(clean)) return null;
    const lower = clean.toLowerCase();
    // 1. A whole vault path.
    const exact = this.byPath.get(lower);
    if (exact) return exact;
    // 2. Paths ending in `/<link>`.
    const name = lower.slice(lower.lastIndexOf("/") + 1);
    const suffix = `/${lower}`;
    const candidates = (this.byName.get(name) ?? []).filter((path) => path.toLowerCase().endsWith(suffix));
    if (!candidates.length) return null;
    const folder = fromNote && fromNote.includes("/") ? fromNote.slice(0, fromNote.lastIndexOf("/")).toLowerCase() : "";
    const near = folder ? candidates.filter((path) => path.toLowerCase().startsWith(`${folder}/`)) : candidates;
    const pool = near.length ? near : candidates;
    let best = pool[0]!;
    for (const path of pool) if (better(path, best)) best = path;
    return best;
  }
}

/** One-off resolve over a file list (tests, small callers). */
export function resolveLinkedFile(link: string, fromNote: string | null, files: Iterable<string>): string | null {
  return new LinkFileIndex(files).resolve(link, fromNote);
}

/**
 * The Obsidian-syntax file links in a Markdown body, as written before `|`
 * (`photo.png`, `att/pic.png`), skipping code. These are what a page's
 * `fileLinks` map resolves.
 */
export function obsidianFileLinks(markdown: string, mask: (text: string) => string): string[] {
  const text = mask(markdown);
  const out = new Set<string>();
  const pattern = new RegExp(String.raw`!?\[\[(${WIKILINK_INNER}+)\]\]`, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const inner = (match[1] ?? "").split("|")[0]!.split("#")[0]!.trim();
    if (inner && hasAttachmentExtension(inner)) out.add(inner);
  }
  return [...out];
}
