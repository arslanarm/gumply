/**
 * Page id rules (D2): a page `a/b` lives at `vault/a/b.md`, its children in
 * `vault/a/b/`. Ids are vault-relative, `/`-separated and never contain `..`.
 */

const MAX_SLUG_LENGTH = 80;

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

/** Readable title for a page id: last segment, dashes to spaces, capitalised. */
export function titleFromId(id: string): string {
  const segment = id.split("/").filter(Boolean).pop() ?? "";
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
    (segment) => segment.length > 0 && !segment.startsWith("."),
  );
}

/** Build a child id: `child("projects", "Gumply")` -> `projects/gumply`. */
export function childPageId(parentId: string | null, title: string): string {
  const slug = slugify(title);
  return parentId ? `${parentId}/${slug}` : slug;
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
