/**
 * D23 in the editor: attachment nodes keep the link exactly as written in
 * the Markdown (untouched links are never rewritten); views resolve it
 * against the open page; new links are written note-relative.
 */
import { attachmentHref, resolveAttachmentHref, type Attachment } from "@gumply/core";
import { fileUrl } from "../api/client.js";
import { getWikiLinkEnvironment, type WikiLinkEnvironment } from "../editor/wikilink/link-store.js";

/** The link the open page writes for a vault file. */
export function hrefForAttachment(vaultPath: string): string {
  return attachmentHref(getWikiLinkEnvironment().pageId, vaultPath);
}

/** The vault path a link in the open page points at (null: external). */
export function resolveLink(href: string, env: WikiLinkEnvironment = getWikiLinkEnvironment()) {
  const known = new Set(env.attachments.map((item: Attachment) => item.path));
  return resolveAttachmentHref(env.pageId, href, known.size > 0 ? (path) => known.has(path) : undefined);
}

/**
 * External links that may be loaded or opened (#9zqypgmh): http(s) only, plus
 * `data:` for images. Anything else (`javascript:`, `file:`, …) is refused.
 */
export function safeExternalUrl(href: string, kind: "image" | "file"): string | null {
  const value = href.trim().replace(/^<|>$/g, "");
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("//")) return `https:${value}`;
  if (kind === "image" && /^data:image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml);/i.test(value)) return value;
  return null;
}

/** Whether a link points outside the vault (http(s)/data:) rather than at a vault file. */
export function isExternalLink(href: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href.trim().replace(/^</, ""));
}

/**
 * URL to load a link from: the API for vault files, the URL itself for safe
 * external links, or null when it can't be shown (unsafe or outside the vault).
 */
export function urlForLink(
  href: string,
  env: WikiLinkEnvironment = getWikiLinkEnvironment(),
  kind: "image" | "file" = "image",
): string | null {
  if (isExternalLink(href)) return safeExternalUrl(href, kind);
  const vaultPath = resolveLink(href, env);
  return vaultPath === null ? null : fileUrl(vaultPath);
}
