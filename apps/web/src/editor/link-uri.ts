/**
 * Which hrefs the editor's link mark accepts (#he3ed9uz). Shared by the
 * markdown-it side (a link the mark would refuse is kept as raw source, so its
 * bytes survive a save) and the mark itself.
 */
import { isAllowedUri } from "@tiptap/extension-link";

/**
 * Relative vault paths (`Files/report.pdf`, `Folder/Page.md`) are links too.
 * TipTap's default check refuses any relative path with a `/` in it (a regex
 * range in its source swallows `/`), so `[doc](Files/report.pdf)` was parsed as
 * plain text and the next save deleted the link (#he3ed9uz). A URL with no
 * scheme can't run script; anything with a scheme still goes through the
 * default protocol allow-list.
 */
export function isAllowedLinkUri(url: string, defaultValidate: (url: string) => boolean): boolean {
  // Same normalisation as TipTap (control characters and whitespace removed).
  const clean = url.replace(/[\u0000-\u0020\u00A0\u1680\u180E\u2000-\u2029\u205F\u3000]/g, "");
  // `//host/x` (and `/\host`, `\\host`) leave the vault: never a live link.
  if (/^[\\/]{2}/.test(clean)) return false;
  if (defaultValidate(url)) return true;
  return clean.length > 0 && !/^[a-z][a-z0-9+.\-]*:/i.test(clean);
}

/** True when the editor's link mark keeps this href (TipTap's allow-list + vault paths). */
export function editorAcceptsHref(href: string): boolean {
  return href.length > 0 && isAllowedLinkUri(href, (url) => Boolean(isAllowedUri(url)));
}
