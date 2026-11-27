/**
 * The readable side of a board copy (#sdwrzdgx): what lands in a page or in
 * another app. The board's own format travels under {@link CLIPBOARD_MIME}.
 */
import { canvasNodeKind } from "@gumply/core";
import { readingOrder } from "./a11y.js";
import type { BoardPageOption } from "./BoardEditor.js";
import { wikiLinkFor } from "./content/links.js";
import type { BoardClipboard } from "./model.js";

/**
 * The copied objects as text, one per line, in reading order: text as
 * written, page and board cards as `[[…]]` links, images as `![[…]]`, link
 * cards as their URL and frames by their name. Drawings have no text.
 */
export function clipboardPlainText(clip: BoardClipboard, pages: readonly BoardPageOption[]): string {
  const byId = new Map(clip.nodes.map((node) => [node.id, node]));
  const lines: string[] = [];
  for (const id of readingOrder(clip.nodes)) {
    const node = byId.get(id);
    if (!node) continue;
    const value = node as typeof node & { text?: unknown; file?: unknown; url?: unknown; label?: unknown };
    let line = "";
    if (typeof value.file === "string") {
      const page = pages.find((option) => option.path === value.file);
      const name = value.file.split("/").pop() ?? value.file;
      if (canvasNodeKind(node) === "image") line = `![[${name}]]`;
      else line = page ? wikiLinkFor(page, pages) : `[[${value.file.replace(/\.md$/i, "")}]]`;
    } else if (typeof value.text === "string") line = value.text;
    else if (typeof value.url === "string") line = value.url;
    else if (typeof value.label === "string") line = value.label;
    line = line.trim();
    if (line) lines.push(line);
  }
  return lines.join("\n");
}
