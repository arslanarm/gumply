/**
 * Notion-style editable tables, saved as GFM (#7witbbun, v0.3.0).
 *
 * - Cells hold one paragraph of inline content (bold, italic, code, links,
 *   `[[links]]`), which is all GFM can store. Enter moves to the cell below
 *   (adding a row at the end), like a spreadsheet; Tab/Shift+Tab move along.
 * - On disk a table is GFM. A table the user never edited is written back
 *   byte-for-byte: the source of each top-level table is remembered when the
 *   page loads, keyed by the (immutable) ProseMirror node, so any edit drops
 *   the key and the table is re-written in normal GFM form.
 * - Column alignment (`:--`, `:-:`, `--:`) is kept per column.
 * - A table without a header row is written with an empty header row (GFM
 *   requires one), and read back without it.
 */
import Table from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { TableMap, addRow, findTable } from "@tiptap/pm/tables";

export type Align = "left" | "center" | "right" | null;

interface TableSerializerState {
  out: string;
  write(content?: string): void;
  renderInline(node: PMNode): void;
  ensureNewLine(): void;
  closeBlock(node: PMNode): void;
  text(text: string, escape?: boolean): void;
  inTable?: boolean;
}

// ---------- untouched tables: original source by node identity ----------

const tableSources = new WeakMap<PMNode, string>();

/** Remember the Markdown source of each top-level table in a freshly loaded doc. */
export function registerTableSources(doc: PMNode, sources: readonly string[]): void {
  const tables: PMNode[] = [];
  doc.forEach((child) => {
    if (child.type.name === "table") tables.push(child);
  });
  // Only when every table can be paired: otherwise just re-serialize them.
  if (tables.length !== sources.length) return;
  tables.forEach((table, index) => tableSources.set(table, sources[index]!));
}

// ---------- GFM serialization ----------

function alignMarker(align: Align): string {
  if (align === "left") return ":--";
  if (align === "center") return ":-:";
  if (align === "right") return "--:";
  return "---";
}

function writeCell(state: TableSerializerState, cell: PMNode): void {
  const start = state.out.length;
  let first = true;
  cell.forEach((block) => {
    if (block.textContent.trim().length === 0 && block.childCount === 0) return;
    if (!first) state.write(" ");
    first = false;
    if (block.isTextblock) state.renderInline(block);
    else state.write(block.textContent.replace(/\s+/g, " "));
  });
  // Every bare `|` in a cell (text, code spans, `[[Page|alias]]`) must be
  // escaped in GFM; already-escaped ones stay as they are.
  state.out = state.out.slice(0, start) + state.out.slice(start).replace(/(?<!\\)\|/g, "\\|");
}

export function serializeTable(state: TableSerializerState, node: PMNode): void {
  const source = tableSources.get(node);
  if (source !== undefined) {
    state.text(source, false);
    state.closeBlock(node);
    return;
  }

  const rows: PMNode[] = [];
  node.forEach((row) => rows.push(row));
  const width = Math.max(1, ...rows.map((row) => {
    let count = 0;
    row.forEach((cell) => {
      count += Number(cell.attrs.colspan ?? 1) || 1;
    });
    return count;
  }));
  const first = rows[0];
  const hasHeader = Boolean(first) && rowIsHeader(first!);

  // Column alignment comes from the header row (or the first row).
  const aligns: Align[] = [];
  first?.forEach((cell) => {
    const span = Number(cell.attrs.colspan ?? 1) || 1;
    for (let i = 0; i < span; i += 1) aligns.push((cell.attrs.align as Align) ?? null);
  });
  while (aligns.length < width) aligns.push(null);

  const writeRow = (row: PMNode | null) => {
    state.write("|");
    let written = 0;
    row?.forEach((cell) => {
      state.write(" ");
      writeCell(state, cell);
      state.write(" |");
      written += 1;
      const span = Number(cell.attrs.colspan ?? 1) || 1;
      for (let i = 1; i < span; i += 1) {
        state.write("  |");
        written += 1;
      }
    });
    for (; written < width; written += 1) state.write("  |");
  };

  state.inTable = true;
  writeRow(hasHeader ? first! : null);
  state.ensureNewLine();
  state.write(`|${aligns.map(alignMarker).join("|")}|`);
  for (const row of rows.slice(hasHeader ? 1 : 0)) {
    state.ensureNewLine();
    writeRow(row);
  }
  state.inTable = false;
  state.closeBlock(node);
}

function rowIsHeader(row: PMNode): boolean {
  let header = row.childCount > 0;
  row.forEach((cell) => {
    if (cell.type.name !== "tableHeader") header = false;
  });
  return header;
}

// ---------- nodes ----------

const alignAttribute = {
  align: {
    default: null,
    parseHTML: (element: HTMLElement) => {
      const value = (element.style.textAlign || element.getAttribute("align") || "").toLowerCase();
      return value === "left" || value === "center" || value === "right" ? value : null;
    },
    renderHTML: (attributes: { align?: Align }) =>
      attributes.align ? { style: `text-align: ${attributes.align}` } : {},
  },
};

export const GumplyTableCell = TableCell.extend({
  content: "paragraph",
  addAttributes() {
    return { ...this.parent?.(), ...alignAttribute };
  },
});

export const GumplyTableHeader = TableHeader.extend({
  content: "paragraph",
  addAttributes() {
    return { ...this.parent?.(), ...alignAttribute };
  },
});

export const GumplyTableRow = TableRow;

function caretToEnd(editor: Editor): void {
  const { selection } = editor.state;
  if (!selection.empty) editor.commands.setTextSelection(selection.to);
}

/** Enter in a cell: move to the cell below, adding a row after the last one. */
function moveDown(editor: Editor): boolean {
  const { state } = editor;
  const table = findTable(state.selection.$from);
  if (!table) return false;
  const $from = state.selection.$from;
  let cellDepth = $from.depth;
  while (cellDepth > 0 && !["tableCell", "tableHeader"].includes($from.node(cellDepth).type.name)) cellDepth -= 1;
  if (cellDepth === 0) return false;
  const cellPos = $from.before(cellDepth) - table.start;
  const map = TableMap.get(table.node);
  const rect = map.findCell(cellPos);
  let tr = state.tr;
  let tableNode = table.node;
  let tableMap = map;
  if (rect.bottom >= map.height) {
    tr = addRow(tr, { map, tableStart: table.start, table: table.node, left: 0, right: map.width, top: 0, bottom: map.height }, map.height);
    tableNode = tr.doc.nodeAt(table.pos)!;
    tableMap = TableMap.get(tableNode);
  }
  const below = tableMap.map[rect.bottom * tableMap.width + rect.left];
  if (below === undefined) return false;
  const target = table.start + below + 2; // inside the cell's paragraph
  tr.setSelection(TextSelection.near(tr.doc.resolve(target)));
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

export const GumplyTable = Table.extend({
  addKeyboardShortcuts() {
    return {
      ...this.parent?.(),
      Enter: ({ editor }) => (editor.isActive("table") ? moveDown(editor) : false),
      // Like Notion: Tab / Shift+Tab put the caret at the end of the next
      // cell instead of selecting its text (typing then never overwrites it).
      Tab: ({ editor }) => {
        if (!editor.isActive("table")) return false;
        const moved =
          editor.commands.goToNextCell() ||
          (editor.can().addRowAfter() && editor.chain().addRowAfter().goToNextCell().run());
        if (moved) caretToEnd(editor);
        return moved;
      },
      "Shift-Tab": ({ editor }) => {
        if (!editor.isActive("table")) return false;
        const moved = editor.commands.goToPreviousCell();
        if (moved) caretToEnd(editor);
        return moved;
      },
    };
  },

  addStorage() {
    return {
      ...this.parent?.(),
      markdown: {
        serialize: serializeTable,
        parse: {
          // A header row of only empty cells is how a header-less table is
          // written (GFM needs one): read it back without that row.
          updateDOM(element: Element) {
            for (const table of Array.from(element.querySelectorAll("table"))) {
              const head = table.querySelector("thead");
              const cells = head ? Array.from(head.querySelectorAll("th")) : [];
              const hasBody = (table.querySelector("tbody")?.rows.length ?? 0) > 0;
              if (head && hasBody && cells.length > 0 && cells.every((cell) => !cell.textContent?.trim() && cell.children.length === 0)) {
                head.remove();
              }
            }
          },
        },
      },
    };
  },
}).configure({
  resizable: false,
  allowTableNodeSelection: true,
  HTMLAttributes: { class: "gumply-table" },
});
