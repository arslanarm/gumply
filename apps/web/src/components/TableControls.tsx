import type { Editor as TipTapEditor } from "@tiptap/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  alignColumn,
  deleteColumnAt,
  deleteRowAt,
  deleteTableAt,
  moveColumn,
  moveRow,
  toggleHeaderRowAt,
  type CellTarget,
} from "../editor/table/commands.js";

interface Hover {
  table: HTMLTableElement;
  row: number;
  column: number;
  rows: number;
  columns: number;
  tableRect: DOMRect;
  rowRect: DOMRect;
  cellRect: DOMRect;
}

type MenuKind = "row" | "column";

interface MenuState {
  kind: MenuKind;
  target: CellTarget;
  left: number;
  top: number;
  placed: boolean;
}

const ZONE = 28;

function inRect(rect: DOMRect, x: number, y: number, pad = 0): boolean {
  return x >= rect.left - pad && x <= rect.right + pad && y >= rect.top - pad && y <= rect.bottom + pad;
}

/** Notion-style table affordances: row/column handles with menus, + bars (#7witbbun). */
export function TableControls({ editor }: { editor: TipTapEditor }) {
  const [hover, setHover] = useState<Hover | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const hoverRef = useRef<Hover | null>(null);
  hoverRef.current = hover;
  const menuRef = useRef<MenuState | null>(null);
  menuRef.current = menu;
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const menuElementRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const root = editor.view.dom;

    const onMove = (event: MouseEvent) => {
      if (menuRef.current) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target && controlsRef.current?.contains(target)) return;

      const cell = target?.closest("td, th");
      if (cell instanceof HTMLTableCellElement && root.contains(cell)) {
        const tr = cell.parentElement as HTMLTableRowElement;
        const table = cell.closest("table") as HTMLTableElement;
        setHover({
          table,
          row: tr.rowIndex,
          column: cell.cellIndex,
          rows: table.rows.length,
          columns: tr.cells.length,
          tableRect: table.getBoundingClientRect(),
          rowRect: tr.getBoundingClientRect(),
          cellRect: cell.getBoundingClientRect(),
        });
        return;
      }
      // Keep the controls while the pointer is in the margin around the table.
      const current = hoverRef.current;
      if (current && inRect(current.table.getBoundingClientRect(), event.clientX, event.clientY, ZONE)) return;
      if (current) setHover(null);
    };
    const onHide = () => {
      if (!menuRef.current) setHover(null);
    };
    const onUpdate = () => {
      // The table may have changed shape: re-measure on the next move.
      if (!menuRef.current) setHover(null);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("scroll", onHide, true);
    window.addEventListener("resize", onHide);
    editor.on("update", onUpdate);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("scroll", onHide, true);
      window.removeEventListener("resize", onHide);
      editor.off("update", onUpdate);
    };
  }, [editor]);

  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuElementRef.current?.contains(target)) return;
      setMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenu(null);
        editor.commands.focus();
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menu, editor]);

  // Keep the menu inside the viewport (flip up / left when needed).
  useLayoutEffect(() => {
    const element = menuElementRef.current;
    if (!menu || menu.placed || !element) return;
    const rect = element.getBoundingClientRect();
    let { left, top } = menu;
    if (top + rect.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - 8 - rect.height);
    if (left + rect.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - rect.width);
    setMenu({ ...menu, left, top, placed: true });
  }, [menu]);

  if (!hover && !menu) return null;

  const targetFor = (state: Hover): CellTarget | null => {
    const pos = cellPosition(editor, state.table, state.row, state.column);
    return pos === null ? null : { pos, row: state.row, column: state.column };
  };

  const run = (action: (target: CellTarget) => boolean) => {
    const current = menuRef.current;
    setMenu(null);
    setHover(null);
    if (current) action(current.target);
    editor.commands.focus();
  };

  const openMenu = (kind: MenuKind, left: number, top: number) => {
    if (!hover) return;
    const target = targetFor(hover);
    if (!target) return;
    setMenu({ kind, target, left, top, placed: false });
  };

  const item = (key: string, label: string, action: (target: CellTarget) => boolean, danger = false) => (
    <button
      key={key}
      type="button"
      role="menuitem"
      className={`block-menu-item${danger ? " is-danger" : ""}`}
      data-testid={`table-menu-${key}`}
      onClick={() => run(action)}
    >
      {label}
    </button>
  );

  const addAtEnd = (kind: "row" | "column") => {
    if (!hover) return;
    const last: Hover = {
      ...hover,
      row: kind === "row" ? hover.rows - 1 : hover.row,
      column: kind === "column" ? hover.columns - 1 : hover.column,
    };
    const target = targetFor(last);
    if (!target) return;
    if (kind === "row") addRowAfter(editor, target);
    else addColumnAfter(editor, target);
    setHover(null);
  };

  return (
    <div ref={controlsRef} className="table-controls">
      {hover && !menu ? (
        <>
          <button
            type="button"
            className="table-handle table-row-handle"
            data-testid="table-row-handle"
            aria-label="Row actions"
            title="Row actions"
            style={{ left: hover.tableRect.left - 11, top: hover.rowRect.top + hover.rowRect.height / 2 - 11 }}
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              openMenu("row", rect.left, rect.bottom + 4);
            }}
          >
            ⋮⋮
          </button>
          <button
            type="button"
            className="table-handle table-col-handle"
            data-testid="table-col-handle"
            aria-label="Column actions"
            title="Column actions"
            style={{ left: hover.cellRect.left + hover.cellRect.width / 2 - 11, top: hover.tableRect.top - 11 }}
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              openMenu("column", rect.left, rect.bottom + 4);
            }}
          >
            ⋯
          </button>
          <button
            type="button"
            className="table-add table-add-row"
            data-testid="table-add-row"
            aria-label="Add a row"
            title="Add a row"
            style={{ left: hover.tableRect.left, top: hover.tableRect.bottom + 2, width: hover.tableRect.width }}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => addAtEnd("row")}
          >
            +
          </button>
          <button
            type="button"
            className="table-add table-add-col"
            data-testid="table-add-col"
            aria-label="Add a column"
            title="Add a column"
            style={{ left: hover.tableRect.right + 2, top: hover.tableRect.top, height: hover.tableRect.height }}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => addAtEnd("column")}
          >
            +
          </button>
        </>
      ) : null}

      {menu ? (
        <div
          ref={menuElementRef}
          className="block-menu table-menu"
          role="menu"
          aria-label={menu.kind === "row" ? "Row actions" : "Column actions"}
          data-testid="table-menu"
          style={{ left: menu.left, top: menu.top, visibility: menu.placed ? "visible" : "hidden" }}
        >
          {menu.kind === "row"
            ? [
                item("insert-above", "Insert row above", (t) => addRowBefore(editor, t)),
                item("insert-below", "Insert row below", (t) => addRowAfter(editor, t)),
                item("move-up", "Move row up", (t) => moveRow(editor, t, -1)),
                item("move-down", "Move row down", (t) => moveRow(editor, t, 1)),
                ...(menu.target.row === 0
                  ? [item("toggle-header", "Toggle header row", (t) => toggleHeaderRowAt(editor, t))]
                  : []),
                <div key="sep" className="block-menu-separator" />,
                item("delete-row", "Delete row", (t) => deleteRowAt(editor, t), true),
                item("delete-table", "Delete table", (t) => deleteTableAt(editor, t), true),
              ]
            : [
                item("insert-left", "Insert column left", (t) => addColumnBefore(editor, t)),
                item("insert-right", "Insert column right", (t) => addColumnAfter(editor, t)),
                item("move-left", "Move column left", (t) => moveColumn(editor, t, -1)),
                item("move-right", "Move column right", (t) => moveColumn(editor, t, 1)),
                <div key="sep-a" className="block-menu-separator" />,
                item("align-left", "Align left", (t) => alignColumn(editor, t, "left")),
                item("align-center", "Align center", (t) => alignColumn(editor, t, "center")),
                item("align-right", "Align right", (t) => alignColumn(editor, t, "right")),
                <div key="sep-b" className="block-menu-separator" />,
                item("delete-column", "Delete column", (t) => deleteColumnAt(editor, t), true),
                item("delete-table", "Delete table", (t) => deleteTableAt(editor, t), true),
              ]}
        </div>
      ) : null}
    </div>
  );
}

/** Document position inside the cell at (row, column) of a rendered table. */
function cellPosition(editor: TipTapEditor, table: HTMLTableElement, row: number, column: number): number | null {
  const cell = table.rows[row]?.cells[column];
  if (!cell) return null;
  try {
    return editor.view.posAtDOM(cell, 0);
  } catch {
    return null;
  }
}
