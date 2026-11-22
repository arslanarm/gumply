/**
 * Columns (spec/columns, #d93qerr7): a `columns` row holding `column`s,
 * stored as Pandoc fenced divs (see ./markdown.ts). The fences and the blank
 * lines around them are kept as read; new rows get the canonical shape.
 */
import { Node } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { columnsCleanup, moveToColumn } from "./commands.js";
import { COLUMN_ATTR, COLUMNS_ATTR, columnsMarkdownPlugin } from "./markdown.js";
import { columnsView } from "./view.js";

export const DEFAULT_ROW_OPEN = ":::: {.columns}";
export const DEFAULT_ROW_CLOSE = "::::";
export const DEFAULT_COLUMN_OPEN = "::: {.column}";
export const DEFAULT_COLUMN_CLOSE = ":::";

/** The bits of prosemirror-markdown's serializer state used here. */
interface ColumnsSerializerState {
  write(content?: string): void;
  closeBlock(node: PMNode): void;
  flushClose(size?: number): void;
  renderContent(parent: PMNode): void;
  closed: unknown;
}

const count = (value: unknown) => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
};

/** A column whose only content is one empty paragraph is written with no content lines. */
function isEmptyColumn(column: PMNode): boolean {
  return column.childCount === 1 && column.firstChild!.type.name === "paragraph" && column.firstChild!.content.size === 0;
}

/** The opening fence for a column: as read while its width is unchanged, else rebuilt. */
export function columnOpenFence(column: PMNode): string {
  const open = column.attrs.open as string | null;
  const width = column.attrs.width as number | null;
  const readWidth = column.attrs.readWidth as number | null;
  if (open && width === readWidth) return open;
  const colons = open ? (/^:+/.exec(open)?.[0] ?? ":::") : ":::";
  if (width === null) {
    if (open) return open.replace(/[ \t]+width="?\d+(?:\.\d+)?%"?/, "");
    return `${colons} {.column}`;
  }
  const value = `width="${Math.round(width)}%"`;
  if (open && /width="?\d+(?:\.\d+)?%"?/.test(open)) return open.replace(/width="?\d+(?:\.\d+)?%"?/, value);
  if (open && /\}[ \t]*$/.test(open)) return open.replace(/\}([ \t]*)$/, ` ${value}}$1`);
  return `${colons} {.column ${value}}`;
}

export function serializeColumns(state: ColumnsSerializerState, node: PMNode): void {
  state.write(String(node.attrs.open ?? DEFAULT_ROW_OPEN));
  node.forEach((column) => {
    state.write("\n" + "\n".repeat(count(column.attrs.before)));
    state.write(columnOpenFence(column));
    state.write("\n" + "\n".repeat(count(column.attrs.lead)));
    if (!isEmptyColumn(column)) {
      state.renderContent(column);
      // The last block ends its line; then the recorded blank lines.
      state.flushClose(1 + count(column.attrs.trail));
    }
    state.write(String(column.attrs.close ?? DEFAULT_COLUMN_CLOSE));
  });
  state.write("\n" + "\n".repeat(count(node.attrs.beforeClose)));
  state.write(String(node.attrs.close ?? DEFAULT_ROW_CLOSE));
  state.closeBlock(node);
}

const textAttr = (name: string) => ({
  default: null,
  parseHTML: (element: HTMLElement) => element.getAttribute(name),
  renderHTML: () => ({}),
});

const countAttr = (name: string) => ({
  default: 0,
  parseHTML: (element: HTMLElement) => count(element.getAttribute(name)),
  renderHTML: () => ({}),
});

export const Column = Node.create({
  name: "column",
  content: "block+",
  defining: true,
  isolating: true,

  addAttributes() {
    return {
      open: textAttr("data-open"),
      close: textAttr("data-close"),
      before: countAttr("data-before"),
      lead: countAttr("data-lead"),
      trail: countAttr("data-trail"),
      // Percent of the row; null = an equal share.
      width: {
        default: null,
        parseHTML: (element: HTMLElement) => {
          const value = Number(element.getAttribute("data-width"));
          return element.hasAttribute("data-width") && value > 0 ? value : null;
        },
        renderHTML: (attributes: Record<string, unknown>) =>
          typeof attributes.width === "number" ? { style: `flex: ${attributes.width} 1 0` } : {},
      },
      // The width as read, so an unchanged width keeps its fence text.
      readWidth: {
        default: null,
        parseHTML: (element: HTMLElement) => {
          const value = Number(element.getAttribute("data-width"));
          return element.hasAttribute("data-width") && value > 0 ? value : null;
        },
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: `div[${COLUMN_ATTR}]` }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", { ...HTMLAttributes, class: "md-column", "data-testid": "column" }, 0];
  },

  addStorage() {
    return {
      markdown: {
        // Written by the row.
        serialize() {},
      },
    };
  },
});

export const Columns = Node.create({
  name: "columns",
  group: "block",
  content: "column+",
  defining: true,
  isolating: true,

  addAttributes() {
    return {
      open: textAttr("data-open"),
      close: textAttr("data-close"),
      beforeClose: countAttr("data-before-close"),
    };
  },

  parseHTML() {
    return [{ tag: `div[${COLUMNS_ATTR}]` }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", { ...HTMLAttributes, class: "md-columns", "data-testid": "columns" }, 0];
  },

  addNodeView() {
    return (props) => columnsView(props as never);
  },

  addProseMirrorPlugins() {
    return [columnsCleanup];
  },

  addKeyboardShortcuts() {
    const move = (direction: "left" | "right") => () => {
      const tr = moveToColumn(this.editor.state, direction);
      if (!tr) return false;
      this.editor.view.dispatch(tr);
      return true;
    };
    return {
      "Mod-Alt-ArrowLeft": move("left"),
      "Mod-Alt-ArrowRight": move("right"),
    };
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: ColumnsSerializerState, node: PMNode) {
          serializeColumns(state, node);
        },
        parse: {
          setup: columnsMarkdownPlugin,
        },
      },
    };
  },
});
