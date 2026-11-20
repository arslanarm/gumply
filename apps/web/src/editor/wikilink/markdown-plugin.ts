/**
 * markdown-it rules for wiki links and attachments (D19).
 *
 * `[[Title]]` / `[[Title|alias]]` / `[[Title#heading]]` become `<wiki-link>`
 * elements for the TipTap node. Attachments are standard Markdown on disk
 * (`![alt](attachments/x.png)`, `[x.pdf](attachments/x.pdf)`); on read we also
 * accept Obsidian `![[x.png]]` and `[[x.pdf]]` when the name is a file.
 *
 * markdown-it and its token types are optional peer deps of tiptap-markdown,
 * hence the local `any` aliases at the boundary.
 */
import { hasAttachmentExtension } from "@gumply/core";

interface WikiLinkMeta {
  title: string;
  alias: string;
  heading: string;
}

interface AttachmentMeta {
  path: string;
  name: string;
  alt: string;
  /** Original Obsidian `![[x.png]]` / `[[x.pdf]]`, written back unchanged (D23). */
  obsidian?: string;
}

const IMAGE_EXTENSIONS = new Set(["avif", "bmp", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp"]);

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isImageName(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot !== -1 && IMAGE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

function attachmentPath(inner: string): string {
  const clean = inner.split("|")[0]?.trim() ?? "";
  return clean.includes("/") ? clean : `attachments/${clean}`;
}

function readInlineRule(state: any, silent: boolean): boolean {
  const src: string = state.src;
  const pos: number = state.pos;

  if (src[pos] !== "[" || src[pos + 1] !== "[") return false;

  const end = src.indexOf("]]", pos + 2);
  if (end === -1) return false;

  const inner = src.slice(pos + 2, end);
  if (inner.includes("[") || inner.includes("]")) return false;
  // Attachment names are handled by the attachment rule below.
  if (hasAttachmentExtension(inner.split("|")[0]?.trim() ?? "")) return false;

  const pipe = inner.indexOf("|");
  const targetPart = pipe === -1 ? inner : inner.slice(0, pipe);
  const alias = pipe === -1 ? "" : inner.slice(pipe + 1).trim();
  const hash = targetPart.indexOf("#");
  const title = (hash === -1 ? targetPart : targetPart.slice(0, hash)).trim();
  const heading = hash === -1 ? "" : targetPart.slice(hash + 1).trim();

  if (title.length === 0) return false;

  if (!silent) {
    const token = state.push("wikilink", "wiki-link", 0);
    const meta: WikiLinkMeta = { title, alias, heading };
    token.meta = meta;
    token.content = src.slice(pos, end + 2);
  }

  state.pos = end + 2;
  return true;
}

/**
 * `![[x.png]]` (Obsidian embed), `[[x.pdf]]` (Obsidian link) and
 * `[name](attachments/x.pdf)` (standard Markdown file link). Standard image
 * Markdown is left to markdown-it's own image rule.
 */
function readAttachmentRule(state: any, silent: boolean): boolean {
  const src: string = state.src;
  const pos: number = state.pos;
  let tokenType = "";
  let meta: AttachmentMeta | null = null;
  let end = pos;

  if (src[pos] === "!" && src[pos + 1] === "[" && src[pos + 2] === "[") {
    const close = src.indexOf("]]", pos + 3);
    if (close === -1) return false;
    const inner = src.slice(pos + 3, close).trim();
    if (!hasAttachmentExtension(inner)) return false;
    const path = attachmentPath(inner);
    const name = path.split("/").pop() ?? inner;
    end = close + 2;
    meta = { path, name, alt: "", obsidian: src.slice(pos, end) };
    tokenType = isImageName(name) ? "attachment_image" : "attachment_file";
  } else if (src[pos] === "[" && src[pos + 1] === "[") {
    const close = src.indexOf("]]", pos + 2);
    if (close === -1) return false;
    const inner = src.slice(pos + 2, close).trim();
    if (!hasAttachmentExtension(inner)) return false;
    const path = attachmentPath(inner);
    const name = path.split("/").pop() ?? inner;
    end = close + 2;
    meta = { path, name, alt: "", obsidian: src.slice(pos, end) };
    tokenType = "attachment_file";
  } else if (src[pos] === "[" && src[pos + 1] !== "[") {
    // D23: vault-root (`attachments/…`) and note-relative (`../attachments/…`).
    const match =
      /^\[([^\]]*)\]\(((?:\.\/|(?:\.\.\/)+)?attachments\/[^)\s]+)(?:\s+"[^"]*")?\)/.exec(src.slice(pos));
    if (!match) return false;
    const path = match[2] ?? "";
    if (path.length === 0) return false;
    meta = { path, name: path.split("/").pop() ?? path, alt: match[1] ?? "" };
    tokenType = "attachment_file";
    end = pos + match[0].length;
  } else {
    return false;
  }

  if (!silent && meta) {
    const token = state.push(tokenType, tokenType === "attachment_image" ? "img" : "file-attachment", 0);
    token.meta = meta;
    token.content = src.slice(pos, end);
  }
  state.pos = end;
  return true;
}

export function wikilinkMarkdownPlugin(md: any): void {
  md.inline.ruler.before("link", "attachment", readAttachmentRule);
  md.inline.ruler.before("link", "wikilink", readInlineRule);

  md.renderer.rules.wikilink = (tokens: any[], index: number): string => {
    const meta = tokens[index]?.meta as WikiLinkMeta | undefined;
    if (!meta) return "";
    const attrs = [
      `data-wikilink-title="${escapeHtml(meta.title)}"`,
      meta.alias.length > 0 ? `data-wikilink-alias="${escapeHtml(meta.alias)}"` : "",
      meta.heading.length > 0 ? `data-wikilink-heading="${escapeHtml(meta.heading)}"` : "",
    ]
      .filter((attr) => attr.length > 0)
      .join(" ");
    const label = meta.alias.length > 0 ? meta.alias : meta.title;
    return `<wiki-link ${attrs}>${escapeHtml(label)}</wiki-link>`;
  };

  md.renderer.rules.attachment_image = (tokens: any[], index: number): string => {
    const meta = tokens[index]?.meta as AttachmentMeta | undefined;
    if (!meta) return "";
    const obsidian = meta.obsidian ? ` data-obsidian="${escapeHtml(meta.obsidian)}"` : "";
    return `<img src="${escapeHtml(meta.path)}" alt="${escapeHtml(meta.alt)}"${obsidian}>`;
  };

  md.renderer.rules.attachment_file = (tokens: any[], index: number): string => {
    const meta = tokens[index]?.meta as AttachmentMeta | undefined;
    if (!meta) return "";
    const obsidian = meta.obsidian ? ` data-obsidian="${escapeHtml(meta.obsidian)}"` : "";
    return `<file-attachment data-path="${escapeHtml(meta.path)}" data-name="${escapeHtml(meta.name)}"${obsidian}>${escapeHtml(meta.name)}</file-attachment>`;
  };
}
