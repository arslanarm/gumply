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

/** URL to load a link from: the API for vault files, as-is for external links. */
export function urlForLink(href: string, env: WikiLinkEnvironment = getWikiLinkEnvironment()): string {
  const vaultPath = resolveLink(href, env);
  return vaultPath === null ? fileUrl(href) : fileUrl(vaultPath);
}
