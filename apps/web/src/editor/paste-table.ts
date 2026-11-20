/**
 * Pasted HTML tables (web pages, Google Sheets, Notion) become a GFM table
 * block, the same raw table block a pasted Markdown table becomes (#y5iqswjf).
 * Without this the schema has no table node and ProseMirror flattened the
 * cells into one line ("AB12").
 *
 * - Header: the first row (whether or not it uses `<th>`).
 * - Inline formatting in cells is kept as Markdown: bold, italic, strike,
 *   code, links. `|` is escaped, line breaks become spaces.
 * - Merged cells fall back to plain cells: a `colspan` cell is followed by
 *   empty cells, a `rowspan` cell's later rows get an empty cell.
 */
import { RAW_BLOCK_ATTR } from "./raw-markdown/markdown-plugin.js";
import { escapeMarkdownText } from "./raw-markdown/text.js";

/** Escape what would break a table cell or turn into Markdown syntax. */
function escapeCell(text: string): string {
  return escapeMarkdownText(text, false).replace(/\|/g, "\\|");
}

/** Inline Markdown for a cell's contents (a small, safe subset). */
export function cellMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeCell(node.textContent ?? "");
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const element = node as HTMLElement;
  const tag = element.tagName.toLowerCase();
  if (tag === "br") return " ";
  if (tag === "style" || tag === "script") return "";
  const inner = Array.from(element.childNodes).map(cellMarkdown).join("");
  const wrap = (mark: string) => {
    const trimmed = inner.trim();
    if (!trimmed) return inner;
    const lead = inner.slice(0, inner.length - inner.trimStart().length);
    const tail = inner.slice(inner.trimEnd().length);
    return `${lead}${mark}${trimmed}${mark}${tail}`;
  };
  const style = element.getAttribute("style") ?? "";
  if (tag === "b" || tag === "strong" || /font-weight:\s*(bold|[6-9]00)/.test(style)) return wrap("**");
  if (tag === "i" || tag === "em" || /font-style:\s*italic/.test(style)) return wrap("*");
  if (tag === "s" || tag === "del" || tag === "strike" || /line-through/.test(style)) return wrap("~~");
  if (tag === "code") {
    const text = (element.textContent ?? "").replace(/\|/g, "\\|");
    return text ? `\`${text}\`` : "";
  }
  if (tag === "a") {
    const href = element.getAttribute("href") ?? "";
    if (/^(https?:|mailto:)/i.test(href) && inner.trim()) {
      return `[${inner.trim()}](${href.replace(/[()\s|]/g, encodeURIComponent)})`;
    }
    return inner;
  }
  return inner;
}

function cellText(cell: HTMLTableCellElement): string {
  return cellMarkdown(cell).replace(/\s+/g, " ").trim();
}

/** Rows of cell Markdown, merged cells expanded into plain cells. */
export function tableRows(table: HTMLTableElement): string[][] {
  const rows: string[][] = [];
  const carried: Array<number> = []; // remaining rowspan per column
  for (const row of Array.from(table.rows)) {
    const out: string[] = [];
    let column = 0;
    const take = () => {
      while ((carried[column] ?? 0) > 0) {
        carried[column] = (carried[column] ?? 0) - 1;
        out.push("");
        column += 1;
      }
    };
    for (const cell of Array.from(row.cells)) {
      take();
      const span = Math.max(1, Math.min(50, cell.colSpan || 1));
      const rowSpan = Math.max(1, Math.min(500, cell.rowSpan || 1));
      out.push(cellText(cell));
      for (let i = 1; i < span; i += 1) out.push("");
      for (let i = 0; i < span; i += 1) {
        if (rowSpan > 1) carried[column + i] = rowSpan - 1;
      }
      column += span;
    }
    take();
    rows.push(out);
  }
  return rows.filter((row) => row.length > 0);
}

/** GFM Markdown for rows (first row is the header). */
export function rowsToMarkdown(rows: readonly string[][]): string {
  const width = Math.max(1, ...rows.map((row) => row.length));
  const pad = (row: readonly string[]) =>
    Array.from({ length: width }, (_, index) => row[index] ?? "");
  const line = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;
  const [header = [], ...body] = rows;
  return [
    line(pad(header)),
    `|${Array.from({ length: width }, () => "---").join("|")}|`,
    ...body.map((row) => line(pad(row))),
  ].join("\n");
}

/**
 * `<p><img></p>` → `<img>` (#symxj285). The image is a block node here, so
 * ProseMirror lifted it out of the paragraph and left an empty one behind
 * (a visible gap, saved as an extra blank line).
 */
function unwrapImageParagraphs(doc: Document): void {
  for (const paragraph of Array.from(doc.querySelectorAll("p"))) {
    const elements = Array.from(paragraph.children);
    const onlyImages =
      elements.length > 0 &&
      elements.every((child) => child.tagName === "IMG" || child.tagName === "BR") &&
      elements.some((child) => child.tagName === "IMG") &&
      (paragraph.textContent ?? "").trim() === "";
    if (onlyImages) {
      paragraph.replaceWith(...elements.filter((child) => child.tagName === "IMG"));
    }
  }
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * `transformPastedHTML`: replace every top-level `<table>` with an editable
 * table built from its GFM Markdown (#7witbbun), and unwrap image-only
 * paragraphs. `renderMarkdown` is the editor's own Markdown → HTML parser, so
 * a pasted table becomes exactly what the same table loads as. Without it the
 * table is kept as a raw GFM block. Other HTML is returned unchanged.
 */
export function pastedTablesToMarkdown(html: string, renderMarkdown?: (markdown: string) => string): string {
  const hasTable = /<table[\s>]/i.test(html);
  const hasImage = /<img[\s>]/i.test(html);
  if (!hasTable && !hasImage) return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (hasImage) unwrapImageParagraphs(doc);
  if (!hasTable) return doc.body.innerHTML;
  const tables = Array.from(doc.querySelectorAll("table")).filter(
    (table) => !table.parentElement?.closest("table"),
  );
  for (const table of tables) {
    const rows = tableRows(table);
    if (rows.length === 0) {
      table.remove();
      continue;
    }
    const markdown = rowsToMarkdown(rows);
    const holder = doc.createElement("div");
    holder.innerHTML = renderMarkdown
      ? renderMarkdown(markdown)
      : `<div ${RAW_BLOCK_ATTR}="${escapeAttr(markdown)}" data-raw-kind="table"></div>`;
    table.replaceWith(...Array.from(holder.childNodes));
  }
  return doc.body.innerHTML;
}
