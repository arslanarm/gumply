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
  return path.replace(/[%\s()<>#?\\]|[\u0000-\u001f\u007f]/g, (char) =>
    Array.from(new TextEncoder().encode(char))
      .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`)
      .join(""),
  );
}

function decodeHref(href: string): string {
  try {
    return decodeURI(href.replace(/%(?![0-9a-f]{2})/gi, "%25"));
  } catch {
    return href;
  }
}

/** The link a note writes for a vault file: relative to the note's folder. */
export function attachmentHref(noteId: string, vaultPath: string): string {
  const from = noteFolder(noteId).split("/").filter(Boolean);
  const to = (normaliseVaultPath(vaultPath) ?? vaultPath).split("/").filter(Boolean);
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common += 1;
  const up = from.length - common;
  const relative = [...Array<string>(up).fill(".."), ...to.slice(common)].join("/");
  return encodeHref(relative);
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
export function relinkAttachments(
  markdown: string,
  fromNoteId: string,
  toNoteId: string,
  exists?: (vaultPath: string) => boolean,
): string {
  if (noteFolder(fromNoteId) === noteFolder(toNoteId)) return markdown;
  const masked = maskCode(markdown);
  let out = "";
  let last = 0;
  MARKDOWN_LINK.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MARKDOWN_LINK.exec(masked)) !== null) {
    const href = match[3] ?? "";
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
