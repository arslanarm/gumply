/**
 * Image and file embeds in Markdown (D19).
 *
 * Standard Markdown: `![alt](attachments/x.png)` and
 * `[name](attachments/x.pdf)`, note-relative since D23 (`../attachments/…`);
 * `path` is the link as written; resolve it with `resolveAttachmentHref`.
 * Obsidian compatibility: `![[x.png]]` and `[[x.pdf]]` when the target name
 * has a file extension.
 */
import { hasAttachmentExtension, maskCode } from "./links.js";
import type { Embed, EmbedKind } from "./types.js";

const IMAGE_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "gif",
  "ico",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "webp",
]);

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

function extensionOf(name: string): string {
  if (!hasAttachmentExtension(name)) return "";
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

function isImage(name: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(name));
}

function kindOf(name: string, embedded: boolean): EmbedKind {
  return embedded && isImage(name) ? "image" : "file";
}

/** Extract Markdown and Obsidian image/file references, in document order. */
export function parseEmbeds(markdown: string): Embed[] {
  const text = maskCode(markdown);
  const embeds: Embed[] = [];

  // ![alt](path "optional title") — never treat the `[...]` part as a file link.
  const imagePattern = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match: RegExpExecArray | null;
  while ((match = imagePattern.exec(text)) !== null) {
    const path = match[2] ?? "";
    if (path.length === 0) continue;
    const raw = markdown.slice(match.index, match.index + match[0].length);
    embeds.push({
      kind: "image",
      path,
      name: basename(path),
      alt: match[1] ?? "",
      raw,
      index: match.index,
      syntax: "markdown",
    });
  }

  // [name](attachments/x.pdf) — ordinary links only count as file embeds when
  // they point at the attachments folder.
  // D23: note-relative forms (`../attachments/x.pdf`, `./attachments/…`) too.
  const filePattern = /(?<!!)\[([^\]]+)\]\(((?:\.\/|(?:\.\.\/)+)?attachments\/[^)\s]+)(?:\s+"[^"]*")?\)/g;
  while ((match = filePattern.exec(text)) !== null) {
    const path = match[2] ?? "";
    if (path.length === 0) continue;
    const raw = markdown.slice(match.index, match.index + match[0].length);
    embeds.push({
      kind: "file",
      path,
      name: basename(path),
      alt: match[1] ?? "",
      raw,
      index: match.index,
      syntax: "markdown",
    });
  }

  // Obsidian: ![[x.png]] (embed) and [[x.pdf]] (link). Only names with an
  // extension are attachments; ordinary [[Page]] links stay page links.
  const obsidianPattern = /(!?)\[\[([^[\]]+)\]\]/g;
  while ((match = obsidianPattern.exec(text)) !== null) {
    const embedded = match[1] === "!";
    const inner = (match[2] ?? "").split("|")[0]?.trim() ?? "";
    if (!hasAttachmentExtension(inner)) continue;
    const path = inner.includes("/") ? inner : `attachments/${inner}`;
    const raw = markdown.slice(match.index, match.index + match[0].length);
    embeds.push({
      kind: kindOf(inner, embedded),
      path,
      name: basename(path),
      alt: "",
      raw,
      index: match.index,
      syntax: "obsidian",
    });
  }

  return embeds.sort((a, b) => a.index - b.index);
}
