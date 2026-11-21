/**
 * Page id rules (D2): a page `a/b` lives at `vault/a/b.md`, its children in
 * `vault/a/b/`. Ids are vault-relative, `/`-separated and never contain `..`.
 */

const MAX_SLUG_LENGTH = 80;
const MAX_SEGMENT_LENGTH = 120;

/** Characters that cannot appear in a vault file name (or would break links). */
const UNSAFE_FILE_CHARS = /[\\/:*?"<>|#^[\]]/g;

/**
 * Turn a title into a filesystem-safe id segment.
 * Keeps Unicode letters/digits so non-Latin titles still work, collapses
 * whitespace and punctuation into single dashes, and falls back to `untitled`.
 */
export function slugify(input: string): string {
  const slug = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/[-_]+$/g, "");

  return slug.length > 0 ? slug : "untitled";
}

/**
 * Turn a title into a vault file-name segment (D20). Case and spaces are kept
 * so the file is readable in Finder/Obsidian; only unsafe characters are
 * removed. Falls back to `Untitled`.
 */
export function pageSegment(title: string): string {
  const cleaned = title
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(UNSAFE_FILE_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[. ]+$/g, "")
    .slice(0, MAX_SEGMENT_LENGTH)
    .trim()
    .replace(/[. ]+$/g, "");
  return cleaned.length > 0 ? cleaned : "Untitled";
}

/**
 * The title of a note without a frontmatter `title`: its file name, verbatim,
 * as Obsidian shows it (`meeting-notes.md` → "meeting-notes", #bayuasqq).
 * D20: the file name *is* the title, so renaming never "tidies" a user's file.
 */
export function titleFromId(id: string): string {
  const segment = id.split("/").filter(Boolean).pop() ?? "";
  return segment.trim().length > 0 ? segment : "Untitled";
}

/**
 * The readable form Gumply showed for slug-like file names before #bayuasqq
 * (`meeting-notes` → "Meeting notes"). Only link resolution still uses it, so
 * links written against that title keep resolving.
 */
export function legacySlugTitle(id: string): string {
  const segment = id.split("/").filter(Boolean).pop() ?? "";
  if (/\s/.test(segment)) return segment;
  const words = segment.replace(/[-_]+/g, " ").trim();
  if (words.length === 0) return "Untitled";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** True when `id` is a safe vault-relative page id. */
export function isValidPageId(id: string): boolean {
  if (typeof id !== "string" || id.length === 0) return false;
  if (id.startsWith("/") || id.endsWith("/")) return false;
  if (id.includes("\\") || id.includes("\0")) return false;
  if (id.length > 500) return false;
  const segments = id.split("/");
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      !segment.startsWith(".") &&
      segment !== "." &&
      segment !== ".." &&
      !/[\u0000-\u001f\u007f]/.test(segment) &&
      !/[<>:"|?*]/.test(segment),
  );
}

/**
 * Build a child id (D20): `child("projects", "Q1 plan")` -> `projects/Q1 plan`.
 * The id is the vault path, so the file name follows the title.
 */
export function childPageId(parentId: string | null, title: string): string {
  const segment = pageSegment(title);
  return parentId ? `${parentId}/${segment}` : segment;
}

/** Parent id, or `null` for a root page. */
export function parentOf(id: string): string | null {
  const index = id.lastIndexOf("/");
  return index === -1 ? null : id.slice(0, index);
}

/** Return `base`, or `base-2`, `base-3`, … until it is not in `taken`. */
export function uniqueId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

/** Vault-relative file path of a page id, e.g. `projects/gumply.md`. */
export function pageFilePath(id: string): string {
  return `${id}.md`;
}

/** Convert a vault-relative `.md` path back to a page id. */
export function pathToPageId(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\.md$/i, "");
}
