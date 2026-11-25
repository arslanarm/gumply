/**
 * Note-relative attachment links (D23, amends D19).
 *
 * - Write: links are relative to the note's own folder. A page one level deep
 *   writes `../attachments/pic.png`; a top-level page writes
 *   `attachments/pic.png`. Characters that need it are percent-encoded.
 * - Read: note-relative paths, vault-root paths (`attachments/x.png`, written
 *   by Gumply before D23) and Obsidian `![[x.png]]` are all accepted.
 * - Move: `relinkAttachments` rewrites a note's own attachment links when its
 *   folder changes (used by the server's move/rename writer, #gma39xw2).
 *
 * Page ids are vault-relative paths without `.md` (D20): "Projects/Q1 plan".
 */
import { maskCode } from "./links.js";

export const ATTACHMENTS_DIR = "attachments";

/** The folder a note lives in ("" at the vault root). */
export function noteFolder(noteId: string): string {
  const slash = noteId.lastIndexOf("/");
  return slash === -1 ? "" : noteId.slice(0, slash);
}

/** Normalise `a/./b/../c` → `a/c`; null when it climbs out of the vault. */
export function normaliseVaultPath(path: string): string | null {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
}

/** Percent-encode what a CommonMark link destination can't hold as-is. */
export function encodeHref(path: string): string {
  return path.replace(/[%\s()<>#?\\|]|[\u0000-\u001f\u007f]/g, (char) =>
    Array.from(new TextEncoder().encode(char))
      .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`)
      .join(""),
  );
}

function decodeHref(href: string): string {
  try {
    // decodeURIComponent, not decodeURI: the writer (encodeHref) encodes `#`
    // and `?` too, and decodeURI leaves `%23` / `%3F` encoded, so a file
    // named `a#b.png` never resolved (#btgun63k). `/` is never encoded.
    return decodeURIComponent(href.replace(/%(?![0-9a-f]{2})/gi, "%25"));
  } catch {
    return href;
  }
}

/** A vault file's path relative to a note's folder, not encoded. */
function relativePath(noteId: string, vaultPath: string): string {
  const from = noteFolder(noteId).split("/").filter(Boolean);
  const to = (normaliseVaultPath(vaultPath) ?? vaultPath).split("/").filter(Boolean);
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common += 1;
  const up = from.length - common;
  return [...Array<string>(up).fill(".."), ...to.slice(common)].join("/");
}

/** The link a note writes for a vault file: relative to the note's folder. */
export function attachmentHref(noteId: string, vaultPath: string): string {
  return encodeHref(relativePath(noteId, vaultPath));
}

/** External (scheme, protocol-relative) links are not vault files. */
function isExternal(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");
}

/**
 * The vault path an attachment link points at, or null for external links
 * and paths outside the vault.
 *
 * `exists` (e.g. a lookup in the attachments list) settles the one
 * ambiguous case: `attachments/x.png` in a nested note is either next to the
 * note or the vault-root folder Gumply used before D23. Without it, a link
 * that starts with `attachments/` means the vault-root folder (only Gumply
 * writes such links, and only there), and anything else is note-relative.
 */
export function resolveAttachmentHref(
  noteId: string,
  href: string,
  exists?: (vaultPath: string) => boolean,
): string | null {
  const raw = href.trim().replace(/^<|>$/g, "");
  if (raw.length === 0 || isExternal(raw)) return null;
  const path = decodeHref(raw.split(/[?#]/)[0] ?? raw);

  if (path.startsWith("/")) return normaliseVaultPath(path);

  const folder = noteFolder(noteId);
  const relative = normaliseVaultPath(folder ? `${folder}/${path}` : path);
  const root = normaliseVaultPath(path);

  if (exists) {
    if (relative !== null && exists(relative)) return relative;
    if (root !== null && exists(root)) return root;
  }
  if (folder && root !== null && root.startsWith(`${ATTACHMENTS_DIR}/`) && !path.startsWith("./")) {
    return root;
  }
  return relative;
}

/** Whether a resolved vault path is inside the attachments folder. */
export function isAttachmentPath(vaultPath: string | null): vaultPath is string {
  return vaultPath !== null && vaultPath.startsWith(`${ATTACHMENTS_DIR}/`);
}

/** A Markdown link href that points into `attachments/` (any accepted form). */
export function looksLikeAttachmentHref(href: string): boolean {
  return /^(?:\.\/|(?:\.\.\/)+)?attachments\//.test(href.replace(/^<|>$/g, ""));
}

const MARKDOWN_LINK = /(!?)\[((?:[^\]\\]|\\.)*)\]\(\s*(<[^>\n]*>|[^)\s]+)((?:\s+"[^"\n]*")?\s*)\)/g;

/**
 * Rewrite a note's own attachment links after it moved from `fromNoteId` to
 * `toNoteId` (D23 "On move"). Only Markdown links/images that point into
 * `attachments/` change; Obsidian `![[x.png]]` (name-based), external links,
 * page links and code are left alone. Returns the input unchanged when
 * nothing needs rewriting.
 */
export interface RelinkOptions {
  /**
   * Leave a link alone when it already resolves, relative to the note's new
   * folder, to an existing file (`exists` required). For moves done outside
   * Gumply: Obsidian or a git checkout may have fixed the links already.
   */
  keepValidAtDestination?: boolean;
}

/** Strictly note-relative target of `href` (no vault-root fallback). */
function strictTarget(noteId: string, href: string): string | null {
  const raw = href.trim().replace(/^<|>$/g, "");
  if (raw.length === 0 || isExternal(raw)) return null;
  const path = decodeHref(raw.split(/[?#]/)[0] ?? raw);
  if (path.startsWith("/")) return null;
  const folder = noteFolder(noteId);
  return normaliseVaultPath(folder ? `${folder}/${path}` : path);
}

export function relinkAttachments(
  markdown: string,
  fromNoteId: string,
  toNoteId: string,
  exists?: (vaultPath: string) => boolean,
  options: RelinkOptions = {},
): string {
  if (noteFolder(fromNoteId) === noteFolder(toNoteId)) return markdown;
  const masked = maskCode(markdown);
  let out = "";
  let last = 0;
  MARKDOWN_LINK.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MARKDOWN_LINK.exec(masked)) !== null) {
    const href = match[3] ?? "";
    if (options.keepValidAtDestination && exists) {
      const here = strictTarget(toNoteId, href);
      if (isAttachmentPath(here) && exists(here)) continue;
    }
    const target = resolveAttachmentHref(fromNoteId, href, exists);
    if (!isAttachmentPath(target)) continue;
    const next = attachmentHref(toNoteId, target);
    const original = markdown.slice(match.index, match.index + match[0].length);
    const hrefStart = original.indexOf("](") + 2;
    const hrefIndex = original.indexOf(href, hrefStart);
    if (hrefIndex === -1) continue;
    out += markdown.slice(last, match.index);
    out += original.slice(0, hrefIndex) + next + original.slice(hrefIndex + href.length);
    last = match.index + match[0].length;
  }
  return last === 0 ? markdown : out + markdown.slice(last);
}

/**
 * #x8awsxev: after folder `from` moved to `to`, rewrite this note's Markdown links and images that point
 * at files inside it (`![pic](Files/a.png)`, `[doc](../Files/doc%20one.pdf)`). The note was `noteBefore`
 * and is `noteAfter` (the same unless it was in the folder). Each link keeps its form: note-relative stays
 * relative, `/absolute` stays absolute, a vault-root path from a nested note stays vault-root, `<…>` stays
 * wrapped (not encoded), the rest is percent-encoded as D23 writes it; a `#`/`?` suffix and a title are
 * kept. A link whose target is unchanged (inside the folder, relative) is left as it is. `exists` (the
 * vault's files after the move is fine: only paths outside the folder are asked) keeps a note-relative
 * file from being read as a vault-root one. Code is never touched.
 *
 * Known limit (shared with `relinkAttachments`, the same `MARKDOWN_LINK`): a link label can't hold `]`,
 * so in a linked image `[![alt](Files/a.png)](Files/b.png)` the inner image is rewritten but the outer
 * link's href isn't.
 */
export function relinkFolderFiles(
  markdown: string,
  noteBefore: string,
  noteAfter: string,
  from: string,
  to: string,
  exists?: (vaultPath: string) => boolean,
): { content: string; count: number } {
  const prefix = `${from.toLowerCase()}/`;
  const inFolder = (path: string | null): path is string => path !== null && path.toLowerCase().startsWith(prefix);
  const masked = maskCode(markdown);
  let out = "";
  let last = 0;
  let count = 0;
  MARKDOWN_LINK.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MARKDOWN_LINK.exec(masked)) !== null) {
    const href = match[3] ?? "";
    const wrapped = href.startsWith("<") && href.endsWith(">");
    const raw = wrapped ? href.slice(1, -1) : href;
    if (raw.length === 0 || isExternal(raw)) continue;
    const cut = raw.search(/[?#]/);
    const pathPart = cut === -1 ? raw : raw.slice(0, cut);
    const suffix = cut === -1 ? "" : raw.slice(cut);
    const path = wrapped ? pathPart : decodeHref(pathPart);
    const folder = noteFolder(noteBefore);
    let target: string | null;
    let form: "absolute" | "relative" | "root";
    if (path.startsWith("/")) {
      target = normaliseVaultPath(path);
      form = "absolute";
    } else {
      const relative = normaliseVaultPath(folder ? `${folder}/${path}` : path);
      const root = folder ? normaliseVaultPath(path) : null;
      if (inFolder(relative)) {
        target = relative;
        form = "relative";
      } else if (inFolder(root) && !(relative !== null && exists?.(relative))) {
        target = root;
        form = "root";
      } else continue;
    }
    if (!inFolder(target)) continue;
    // D37: a note that moved with the folder keeps its relative links into it as written (`./a.png`,
    // `sub/../a.png`): they still point at the same files.
    if (form === "relative" && inFolder(`${noteBefore}`)) continue;
    // Only the raw segments that spell the folder change; `./`, `../` and an encoded tail stay as written.
    const base = form === "relative" ? folder.split("/").filter(Boolean) : [];
    const swapped = swapFolderSegments(pathPart, base, from, to, wrapped);
    let nextPath: string;
    if (swapped !== null) nextPath = swapped;
    else {
      // Part of the folder comes from the note's own location: rebuild the path.
      const moved = `${to}${target.slice(from.length)}`;
      const rebuilt = form === "absolute" ? `/${moved}` : form === "root" ? moved : relativePath(noteAfter, moved);
      nextPath = wrapped ? rebuilt : encodeHref(rebuilt);
    }
    const next = wrapped ? `<${nextPath}${suffix}>` : `${nextPath}${suffix}`;
    if (next === href) continue;
    const original = markdown.slice(match.index, match.index + match[0].length);
    const hrefIndex = original.indexOf(href, original.indexOf("](") + 2);
    if (hrefIndex === -1) continue;
    out += markdown.slice(last, match.index) + original.slice(0, hrefIndex) + next + original.slice(hrefIndex + href.length);
    last = match.index + match[0].length;
    count += 1;
  }
  return last === 0 ? { content: markdown, count: 0 } : { content: out + markdown.slice(last), count };
}

/**
 * The raw path with only the segments that spell `from` replaced by `to`'s (encoded unless `wrapped`), or
 * null when `from` isn't spelled out by contiguous raw segments (part of it is the note's own folder).
 * `base` is the folder the path starts from (the note's folder for a relative link; [] otherwise).
 */
function swapFolderSegments(rawPath: string, base: readonly string[], from: string, to: string, wrapped: boolean): string | null {
  const raw = rawPath.split("/");
  const want = from.toLowerCase().split("/");
  const stack: Array<{ name: string; by: number }> = base.map((name) => ({ name, by: -1 }));
  for (let i = 0; i < raw.length; i++) {
    const segment = wrapped ? raw[i]! : decodeHref(raw[i]!);
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      stack.pop();
      continue;
    }
    stack.push({ name: segment, by: i });
    if (stack.length !== want.length || !stack.every((entry, k) => entry.name.toLowerCase() === want[k])) continue;
    const by = stack.map((entry) => entry.by);
    if (by[0] === -1 || by.some((index, k) => k > 0 && index !== by[k - 1]! + 1)) return null;
    const replacement = to.split("/").map((part) => (wrapped ? part : encodeHref(part)));
    return [...raw.slice(0, by[0]), ...replacement, ...raw.slice(by[by.length - 1]! + 1)].join("/");
  }
  return null;
}
