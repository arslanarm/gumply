/**
 * A base's table layout (spec/api-bases, #sg36ng2d). Rows are virtualised
 * (`@tanstack/react-virtual`): only what's on screen mounts, so 2,000 pages
 * scroll as smoothly as 20. Note properties are edited in place and written
 * to the page's frontmatter; file properties and formulas are read-only.
 */
import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { BaseColumn, BaseConfig, BaseRow, BaseValue, BaseView, BaseViewResult } from "@gumply/core";
import { Icon } from "../components/Icon.js";
import { useT, type MessageKey } from "../i18n/index.js";
import { isValidPropertyKey, selectSettings, type SelectKind, PROPERTY_TYPES, WIKILINK_INNER, WIKILINK_PART, type Property, type PropertyType } from "@gumply/core";
import { PropertyValueEditor } from "../components/PropertiesBlock.js";
import { Popover } from "./Popover.js";
import { ownedRowsFolder, propertyId } from "@gumply/core";
import { isTitleColumn, propertyLabel, writtenId } from "./labels.js";
import { BaseSelectActions, BaseSelects, BaseText, SelectChips } from "./values.js";
import { SelectPicker } from "./SelectPicker.js";
import { OptionsEditor } from "./OptionsEditor.js";
import { AddColumn, COLUMN_TYPES } from "./AddColumn.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { PropertyTypeIcon } from "../components/PropertiesBlock.js";
import { api } from "../api/client.js";
import { plannedPaste, readPaste, type PastedRow } from "./paste.js";
import { PastePreview, type PreviewResult } from "./PastePreview.js";
import { copiedText, gridMoveFor, moveCell, typedValue, typingStarts, type GridMove, type GridPosition } from "./grid.js";
import { formatDateValue } from "../lib/dates.js";
import { currentModifierLabel } from "../lib/shortcuts.js";

export const ROW_HEIGHT = 34;

/** Obsidian's `rowHeight`: 1×, 2×, 4× or 8× a row (default `short`, spec/api-bases). */
const HEIGHTS: Record<string, number> = { short: 1, medium: 2, tall: 4, extra: 8 };

export function rowHeightOf(view: BaseView): number {
  return ROW_HEIGHT * (HEIGHTS[typeof view.rowHeight === "string" ? view.rowHeight : "short"] ?? 1);
}
const TITLE_WIDTH = 280;
const COLUMN_WIDTH = 170;

export interface TableViewProps {
  config: BaseConfig;
  view: BaseView;
  result: BaseViewResult;
  readOnly?: boolean;
  /** Embedded: the table scrolls within this height. */
  maxHeight?: number;
  onOpen: (id: string) => void;
  onEditValue: (row: BaseRow, column: BaseColumn, value: BaseValue) => Promise<boolean>;
  /** Resolves with the row's new id when the rename moved it. */
  onRename: (row: BaseRow, title: string) => Promise<string | void>;
  onNewRow?: () => void;
  /**
   * #7prbquxu: a database that owns its rows: the typing row at the bottom makes a row
   * with the typed name (it resolves once the table shows it). Replaces "+ New".
   */
  onAddRow?: (title: string) => Promise<string | void>;
  onChangeView: (view: BaseView) => void;
  /** #7prbquxu: an owned database's column menu: rename the key in its rows, delete it from them, change its type. */
  onRenameColumn?: (column: BaseColumn, to: string) => Promise<void>;
  onDeleteColumn?: (column: BaseColumn) => Promise<void>;
  onSetColumnType?: (column: BaseColumn, type: PropertyType | SelectKind) => Promise<void>;
  /** #7prbquxu (spec §4): "+" with Select or Multi-select: the view's new column and its Select settings, one write. */
  onAddSelectColumn?: (view: BaseView, key: string, kind: SelectKind) => Promise<void>;
  /** #7prbquxu phase 4b: "+" changes the view through this (one undoable step), when given. */
  onAddColumnView?: (view: BaseView) => void;
  /** #7prbquxu phase 2: "Import CSV…" rows for the paste preview (`n` bumps to open it again). */
  importBlock?: { rows: string[][]; n: number } | null;
  /** #7prbquxu phase 2, step 3: the preview's rows and columns, for this view (one server request). */
  onPastePreview?: (result: PreviewResult, view: string) => Promise<void>;
  /** #7prbquxu phase 2: a block pasted at the active cell (one server request). */
  onPasteRows?: (rows: PastedRow[]) => Promise<void>;
  /** A row just created: its title opens for typing. */
  renameRowId?: string | null;
  onRenameDone?: () => void;
}

type Item = { kind: "group"; label: string; count: number } | { kind: "row"; index: number };

function columnWidth(view: BaseView, column: BaseColumn): number {
  const sizes = view.columnSize;
  if (sizes && typeof sizes === "object" && !Array.isArray(sizes)) {
    // Obsidian keys `columnSize` by full id (`note.status`); accept the short one too.
    const map = sizes as Record<string, unknown>;
    const size = map[column.id] ?? map[writtenId(column.id)];
    if (typeof size === "number" && size >= 60 && size <= 1200) return size;
  }
  return isTitleColumn(column.id) ? TITLE_WIDTH : COLUMN_WIDTH;
}


/** A value as the cell shows it. */
export function display(value: BaseValue, type: string): string {
  if (value === null || value === "") return "";
  if (typeof value === "boolean") return "";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "string" && (type === "date" || type === "datetime")) {
    // In the interface language, like the page header's dates (shared with the properties block, #93wnicas).
    const shown = formatDateValue(value);
    if (shown !== null) return shown;
  }
  // `[[Page|alias]]` in a text property reads as its label.
  if (typeof value === "string") return value.replace(new RegExp(String.raw`\[\[(${WIKILINK_PART}*)(?:\|(${WIKILINK_INNER}*))?\]\]`, "g"), (_, target: string, alias?: string) => alias ?? target);
  return String(value);
}

export function TableView(props: TableViewProps) {
  const t = useT();
  const { result, view, config } = props;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const columns = result.columns;
  const widths = columns.map((column) => columnWidth(view, column));
  const template = `${widths.map((width) => `${width}px`).join(" ")} minmax(40px, 1fr)`;
  const totalWidth = widths.reduce((a, b) => a + b, 0) + 40;

  const items = useMemo<Item[]>(() => {
    if (!result.groups) return result.rows.map((_, index) => ({ kind: "row", index }));
    const list: Item[] = [];
    for (const group of result.groups) {
      list.push({ kind: "group", label: group.label, count: group.rows.length });
      for (const index of group.rows) list.push({ kind: "row", index });
    }
    return list;
  }, [result]);

  const rowHeight = rowHeightOf(view);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  });

  // A new row height re-measures every row.
  useEffect(() => virtualizer.measure(), [rowHeight, virtualizer]);

  // #7prbquxu (spec/database-tables §4): a database that owns its rows is a grid.
  // One input sits on the active cell and keeps the focus while the arrows, Tab,
  // Enter and Delete act; the first typed character (or an IME composition) turns
  // it into the cell's editor in place, so no character is lost.
  const grid = Boolean(props.onAddRow) && !props.readOnly;
  const rowOrder = useMemo(
    () => items.flatMap((item, itemIndex) => (item.kind === "row" ? [{ row: item.index, itemIndex }] : [])),
    [items],
  );
  const offsets = widths.map((_, index) => widths.slice(0, index).reduce((a, b) => a + b, 0));
  const [active, setActive] = useState<{ rowId: string; col: number } | null>(null);
  const [typing, setTyping] = useState(false);
  const [editRequest, setEditRequest] = useState<{ rowId: string; col: number; seed?: string } | null>(null);
  const selects = useContext(BaseSelects);
  const [pendingActive, setPendingActive] = useState<{ rowId: string; col: number } | null>(null);
  const sinkRef = useRef<HTMLInputElement | null>(null);
  /** #12 (#faqr8pj9): Shift+Tab before the first cell leaves the rows for the header's "+". */
  const addColumnRef = useRef<HTMLButtonElement | null>(null);
  const typingInputRef = useRef<HTMLInputElement | null>(null);
  const activePos = useMemo<GridPosition | null>(() => {
    if (!active) return null;
    const at = rowOrder.findIndex((entry) => result.rows[entry.row]?.id === active.rowId);
    return at < 0 ? null : { row: at, col: Math.min(active.col, columns.length - 1) };
  }, [active, rowOrder, result.rows, columns.length]);
  const activeRow = activePos ? result.rows[rowOrder[activePos.row]!.row] : undefined;
  /** #7prbquxu phase 2: where a Shift+arrow block started; with the active cell it spans the selection. */
  const [anchor, setAnchor] = useState<{ rowId: string; col: number } | null>(null);
  const selection = useMemo(() => {
    if (!anchor || !activePos) return null;
    const at = rowOrder.findIndex((entry) => result.rows[entry.row]?.id === anchor.rowId);
    if (at < 0) return null;
    const col = Math.min(anchor.col, columns.length - 1);
    if (at === activePos.row && col === activePos.col) return null;
    return { top: Math.min(at, activePos.row), bottom: Math.max(at, activePos.row), left: Math.min(col, activePos.col), right: Math.max(col, activePos.col) };
  }, [anchor, activePos, rowOrder, result.rows, columns.length]);
  const activeColumn = activePos ? columns[activePos.col] : undefined;

  // A row made from the typing row (Tab) becomes active once the table shows it.
  useEffect(() => {
    if (!pendingActive || !result.rows.some((row) => row.id === pendingActive.rowId)) return;
    setActive(pendingActive);
    setPendingActive(null);
  }, [pendingActive, result.rows]);

  // The active cell is scrolled into view and holds the focus (not while its editor is open).
  useEffect(() => {
    if (!grid || !activePos || editRequest) return;
    virtualizer.scrollToIndex(rowOrder[activePos.row]!.itemIndex, { align: "auto" });
    const scroller = scrollRef.current;
    if (scroller) {
      const left = offsets[activePos.col] ?? 0;
      const right = left + (widths[activePos.col] ?? 0);
      if (left < scroller.scrollLeft) scroller.scrollLeft = left;
      else if (right > scroller.scrollLeft + scroller.clientWidth) scroller.scrollLeft = right - scroller.clientWidth;
    }
    sinkRef.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid, activePos?.row, activePos?.col, editRequest]);

  const go = (to: GridPosition | "past-end") => {
    if (to === "past-end") {
      setActive(null);
      typingInputRef.current?.focus();
      return;
    }
    const row = result.rows[rowOrder[to.row]!.row];
    if (row) setActive({ rowId: row.id, col: to.col });
  };

  const renameAndFollow = async (row: BaseRow, title: string, col: number) => {
    const id = await props.onRename(row, title);
    if (typeof id === "string" && id !== row.id) setActive((current) => (current?.rowId === row.id ? { rowId: id, col } : current));
  };

  const commitTyping = async (then?: GridMove) => {
    const sink = sinkRef.current;
    if (!sink || !activePos || !activeRow || !activeColumn) return;
    const text = sink.value;
    sink.value = "";
    setTyping(false);
    const from = activePos;
    if (isTitleColumn(activeColumn.id)) {
      const title = text.trim();
      if (title && title !== activeRow.title) await renameAndFollow(activeRow, title, from.col);
    } else {
      const typed = typedValue(text, activeColumn.type);
      if (typed) await props.onEditValue(activeRow, activeColumn, typed.value);
    }
    if (then) go(moveCell(from, then, rowOrder.length, columns.length));
  };

  /** #12: Tab reached the rows (the first row's Name, while no cell is active): that cell becomes active. */
  const enterGrid = useCallback((rowId: string) => setActive({ rowId, col: 0 }), []);
  const requestEdit = useCallback((rowId: string, col: number) => {
    setActive({ rowId, col });
    setEditRequest({ rowId, col });
  }, []);
  // #5q4vaacm: an editor closed by Tab or Shift+Tab hands the move on, so the next cell is active (as typing over a
  // cell does); before, focus came back to the same cell and the next value typed overwrote the one just entered.
  const [afterEdit, setAfterEdit] = useState<GridMove | null>(null);
  const editDone = useCallback((move?: GridMove) => {
    setEditRequest(null);
    if (move) setAfterEdit(move);
  }, []);
  useEffect(() => {
    if (!afterEdit || editRequest || !activePos) return;
    setAfterEdit(null);
    go(moveCell(activePos, afterEdit, rowOrder.length, columns.length));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [afterEdit, editRequest]);
  const renameDone = useCallback(() => {
    setEditRequest(null);
    props.onRenameDone?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.onRenameDone]);

  const onSinkKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!activePos || !activeRow || !activeColumn) return;
    const composing = event.nativeEvent.isComposing || event.keyCode === 229;
    const sink = event.currentTarget;
    if (typing) {
      if (composing) return;
      if (event.key === "Enter") {
        event.preventDefault();
        void commitTyping("down");
      } else if (event.key === "Tab") {
        event.preventDefault();
        void commitTyping(event.shiftKey ? "prev" : "next");
      } else if (event.key === "Escape") {
        event.preventDefault();
        sink.value = "";
        setTyping(false);
      }
      return;
    }
    if (composing) return;
    // #12 (#faqr8pj9): the rows are one Tab stop, so a keyboard user opens a row from its cells: Ctrl/Cmd+Enter.
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      props.onOpen(activeRow.id);
      return;
    }
    // Shift+Tab on the very first cell leaves the rows backwards (Tab past the last one already goes to the typing row).
    if (event.key === "Tab" && event.shiftKey && activePos.row === 0 && activePos.col === 0 && !anchor) {
      event.preventDefault();
      setActive(null);
      addColumnRef.current?.focus();
      return;
    }
    const move = gridMoveFor(event.key, event.shiftKey);
    if (move) {
      event.preventDefault();
      // #7prbquxu phase 2: Shift+arrows grow a block from where they started (for Copy); other moves drop it.
      const extending = event.shiftKey && event.key.startsWith("Arrow");
      if (extending && !anchor) setAnchor({ rowId: activeRow.id, col: activePos.col });
      if (!extending) setAnchor(null);
      const to = moveCell(activePos, move, rowOrder.length, columns.length);
      if (extending && to === "past-end") return;
      go(to);
      return;
    }
    const title = isTitleColumn(activeColumn.id);
    const editable = title || activeColumn.editable;
    if (event.key === "Enter" || event.key === "F2") {
      event.preventDefault();
      if (!title && activeColumn.type === "checkbox") {
        if (editable) void props.onEditValue(activeRow, activeColumn, activeRow.values[activeColumn.id] !== true);
      } else if (editable) {
        setEditRequest({ rowId: activeRow.id, col: activePos.col });
      }
      return;
    }
    if (event.key === " " && !title && activeColumn.type === "checkbox") {
      event.preventDefault();
      if (editable) void props.onEditValue(activeRow, activeColumn, activeRow.values[activeColumn.id] !== true);
      return;
    }
    if ((event.key === "Delete" || event.key === "Backspace") && !title) {
      event.preventDefault();
      if (editable) void props.onEditValue(activeRow, activeColumn, activeColumn.type === "checkbox" ? false : null);
      return;
    }
    if (event.key === "Escape") {
      if (anchor) {
        setAnchor(null);
        return;
      }
      setActive(null);
      // #12: on to the typing row, so Tab and Shift+Tab carry on from the table (not from the page's top).
      if (typingInputRef.current) typingInputRef.current.focus();
      else sink.blur();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key.length === 1) {
      const starts = title ? "type" : typingStarts(activeColumn.type, activeColumn.editable);
      if (starts === "none") event.preventDefault();
      else if (!title && activeColumn.editable && selects.has(activeColumn.id)) {
        // #7prbquxu phase 3: a Select opens its picker with the typed character as the search.
        event.preventDefault();
        setEditRequest({ rowId: activeRow.id, col: activePos.col, seed: event.key });
      } else if (starts === "editor") {
        event.preventDefault();
        setEditRequest({ rowId: activeRow.id, col: activePos.col });
      }
      // "type": the character goes into the input, and `onInput` starts the edit.
    }
  };

  const [headerMenu, setHeaderMenu] = useState<{ column: BaseColumn; anchor: HTMLElement } | null>(null);
  const [addColumnAnchor, setAddColumnAnchor] = useState<HTMLElement | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<BaseColumn | null>(null);
  /** #7prbquxu phase 3: "Edit options…" open for this column. */
  const [editingOptions, setEditingOptions] = useState<{ column: BaseColumn; anchor: HTMLElement } | null>(null);
  const optionActions = useContext(BaseSelectActions);
  /** #7prbquxu phase 2: what the last paste left out (a short note under the table). */
  const [pasteNote, setPasteNote] = useState<string | null>(null);
  /** #7prbquxu phase 2, step 3: a block pasted on the typing row, waiting in the preview. */
  const [previewBlock, setPreviewBlock] = useState<string[][] | null>(null);
  // "Import CSV…": the file's rows open the same preview as a paste.
  useEffect(() => {
    if (props.importBlock) setPreviewBlock(props.importBlock.rows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.importBlock?.n]);
  const knownKeys = useMemo(
    // A column that's a Select in this base reads as one (its kind), so the preview keeps it.
    () => new Map(columns.filter((column) => column.id.startsWith("note.")).map((column) => [column.id.slice(5), selects.get(column.id)?.kind ?? column.type] as const)),
    [columns, selects],
  );
  const closeHeaderMenu = () => {
    setHeaderMenu(null);
    setRenaming(null);
  };
  const viewOrder = Array.isArray(view.order) && view.order.length ? view.order.map(String) : ["file.name"];
  // #7prbquxu: "+" adds a column (spec/database-tables §4); the type goes to types.json only for a new key.
  const addColumn = async (key: string, type: PropertyType | SelectKind, setType: boolean) => {
    const next = { ...view, order: [...viewOrder, key] };
    // A Select or Multi-select: the column and its (empty) options in one base write (@lead, spec §4).
    if ((type === "select" || type === "multiselect") && props.onAddSelectColumn) {
      await props.onAddSelectColumn(next, key, type);
      return;
    }
    // Only when the types file has none for the key (a key typed there but used nowhere keeps its type).
    if (setType && type !== "select" && type !== "multiselect") await api.setPropertyType(key, type, { ifAbsent: true }).catch(() => undefined);
    (props.onAddColumnView ?? props.onChangeView)(next);
  };
  const sorts = Array.isArray(view.sort) ? view.sort : [];

  const setSort = (column: BaseColumn, direction: "ASC" | "DESC") => {
    const others = sorts.filter((sort) => propertyId(String(sort.property)) !== column.id);
    props.onChangeView({ ...view, sort: [{ property: writtenId(column.id), direction }, ...others] });
  };
  const hide = (column: BaseColumn) => {
    const order = (Array.isArray(view.order) ? view.order.map(String) : ["file.name"]).filter(
      (id) => propertyId(id) !== column.id,
    );
    props.onChangeView({ ...view, order });
  };

  const style = {
    "--base-columns": template,
    "--base-width": `${totalWidth}px`,
    "--base-row": `${rowHeight}px`,
    ...(props.maxHeight ? { maxHeight: props.maxHeight } : {}),
  } as CSSProperties;

  return (
    <div className="base-table" data-testid="base-table" style={style}>
      {/* The table role is on the part that holds only rows; "New" and the column menus sit beside it (WCAG 1.3.1, #jchhjepb). */}
      <div
        className="base-table-scroll"
        ref={scrollRef}
        data-testid="base-table-scroll"
        role="table"
        aria-rowcount={result.rows.length + 1}
        onMouseDown={
          grid
            ? (event) => {
                const target = event.target as Element;
                const cell = target.closest<HTMLElement>("[data-grid-col]");
                const rowId = target.closest<HTMLElement>("[data-row-id]")?.dataset.rowId;
                if (!cell || rowId === undefined || target.closest("button, a, input")) return;
                setActive({ rowId, col: Number(cell.dataset.gridCol) });
                setAnchor(null);
              }
            : undefined
        }
      >
        <div className="base-table-head" role="row">
          {columns.map((column) => {
            const sort = sorts.find((item) => propertyId(String(item.property)) === column.id);
            return (
              <div className="base-th" role="columnheader" key={column.id} aria-sort={sort ? (sort.direction === "ASC" ? "ascending" : "descending") : undefined}>
                <button
                  type="button"
                  className="base-th-button"
                  data-testid={`base-th-${column.id}`}
                  disabled={props.readOnly}
                  onClick={(event) => setHeaderMenu({ column, anchor: event.currentTarget })}
                >
                  <span className="base-th-label">{propertyLabel(column.id, config, t)}</span>
                  {sort ? <Icon name="arrowUp" size={12} className={`base-sort-icon${sort.direction === "DESC" ? " is-desc" : ""}`} /> : null}
                </button>
              </div>
            );
          })}
          {grid ? (
            <div className="base-th base-th-fill" role="columnheader">
              <button
                type="button"
                ref={addColumnRef}
                className="base-th-add"
                data-testid="base-add-column-button"
                aria-label={t("bases.addColumn")}
                data-tooltip={t("bases.addColumn")}
                onClick={(event) => setAddColumnAnchor(event.currentTarget)}
              >
                <Icon name="plus" size={14} />
              </button>
            </div>
          ) : (
            <div className="base-th base-th-fill" aria-hidden="true" />
          )}
        </div>

        <div className="base-table-body" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((virtual) => {
            const item = items[virtual.index]!;
            const top = { transform: `translateY(${virtual.start}px)` };
            if (item.kind === "group") {
              return (
                <div className="base-group-row" key={virtual.key} style={top} role="row" data-testid="base-group">
                  <span className="base-group-label" role="cell">{item.label || t("bases.noValue")}</span>
                  <span className="base-group-count" role="cell">{item.count}</span>
                </div>
              );
            }
            const row = result.rows[item.index]!;
            return (
              <TableRow
                key={row.id}
                top={virtual.start}
                row={row}
                columns={columns}
                readOnly={props.readOnly}
                renaming={props.renameRowId === row.id}
                editCol={editRequest?.rowId === row.id ? editRequest.col : null}
                editSeed={editRequest?.rowId === row.id ? editRequest.seed : undefined}
                onOpen={props.onOpen}
                onEditValue={props.onEditValue}
                onRename={props.onRename}
                onRenameDone={grid ? renameDone : props.onRenameDone}
                {...(grid ? { onRequestEdit: requestEdit, onEditDone: editDone, grid: true, onEnterGrid: enterGrid } : {})}
                gridEntry={grid && !active && result.rows[rowOrder[0]?.row ?? -1]?.id === row.id}
              />
            );
          })}
          {grid && selection ? (
            <div
              className="base-grid-selection"
              data-testid="base-grid-selection"
              data-range={`${selection.top}:${selection.left}-${selection.bottom}:${selection.right}`}
              aria-hidden="true"
              style={{
                top: rowOrder[selection.top]!.itemIndex * rowHeight,
                height: (rowOrder[selection.bottom]!.itemIndex - rowOrder[selection.top]!.itemIndex + 1) * rowHeight,
                left: offsets[selection.left],
                width: widths.slice(selection.left, selection.right + 1).reduce((a, b) => a + b, 0),
              }}
            />
          ) : null}
          {grid && activePos && activeRow && activeColumn && !editRequest ? (
            <input
              ref={sinkRef}
              className={`base-grid-cell${typing ? " is-typing" : ""}${activeColumn.type === "number" ? " is-number" : ""}`}
              data-testid="base-grid-cell"
              data-active={`${activeRow.id}|${activeColumn.id}`}
              aria-label={
                isTitleColumn(activeColumn.id)
                  ? t("bases.openPage", { title: activeRow.title })
                  : t("bases.editCell", { property: activeColumn.displayName ?? activeColumn.id.replace(/^note\./, ""), title: activeRow.title })
              }
              aria-description={t("bases.gridOpenHint", { mod: currentModifierLabel() })}
              style={{
                top: rowOrder[activePos.row]!.itemIndex * rowHeight,
                left: offsets[activePos.col],
                width: widths[activePos.col],
                height: rowHeight,
              }}
              onKeyDown={onSinkKeyDown}
              onInput={(event) => {
                if (!typing && event.currentTarget.value) setTyping(true);
                setAnchor(null);
              }}
              onCompositionStart={() => {
                const title = isTitleColumn(activeColumn.id);
                if ((title ? "type" : typingStarts(activeColumn.type, activeColumn.editable)) === "type") setTyping(true);
              }}
              onCompositionEnd={(event) => {
                // Composed where typing doesn't apply (a checkbox, a read-only cell): dropped.
                if (!typing) event.currentTarget.value = "";
              }}
              onPaste={(event) => {
                // While typing, the input takes the paste as text.
                if (typing) return;
                event.preventDefault();
                const read = readPaste(event.clipboardData.getData("text/plain"), event.clipboardData.getData("text/html"));
                const sink = event.currentTarget;
                if ("value" in read) {
                  // One value: as typing would (a date or select opens its editor; a checkbox or read-only cell ignores it).
                  const title = isTitleColumn(activeColumn.id);
                  const starts = title ? "type" : typingStarts(activeColumn.type, activeColumn.editable);
                  if (starts === "type") {
                    sink.value = read.value;
                    setTyping(true);
                  } else if (starts === "editor") setEditRequest({ rowId: activeRow.id, col: activePos.col });
                  return;
                }
                const plan = plannedPaste(
                  read.rows,
                  activePos,
                  columns,
                  rowOrder.map((entry) => ({ id: result.rows[entry.row]!.id, updated: result.rows[entry.row]!.updated })),
                  t("defaults.untitledPage"),
                );
                setPasteNote(plan.left || plan.pastLast ? t("bases.pasteLeftOut", { count: plan.left + plan.pastLast }) : null);
                if (plan.rows.length) void props.onPasteRows?.(plan.rows);
              }}
              onCopy={(event) => {
                if (typing) return;
                event.preventDefault();
                const cellText = (row: BaseRow, column: BaseColumn) =>
                  isTitleColumn(column.id) ? row.title : copiedText(row.values[column.id] ?? null, column.type);
                if (!selection) {
                  event.clipboardData.setData("text/plain", cellText(activeRow, activeColumn));
                  return;
                }
                // A block: TSV (quoted where a cell holds a tab, a newline or a quote) and an HTML table.
                const grid: string[][] = [];
                for (let r = selection.top; r <= selection.bottom; r += 1) {
                  const row = result.rows[rowOrder[r]!.row]!;
                  grid.push(columns.slice(selection.left, selection.right + 1).map((column) => cellText(row, column)));
                }
                const quoted = (text: string) => (/[\t\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
                const html = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
                event.clipboardData.setData("text/plain", grid.map((cells) => cells.map(quoted).join("\t")).join("\n"));
                event.clipboardData.setData(
                  "text/html",
                  `<table>${grid.map((cells) => `<tr>${cells.map((text) => `<td>${html(text)}</td>`).join("")}</tr>`).join("")}</table>`,
                );
              }}
              onBlur={() => {
                if (typing) void commitTyping();
              }}
            />
          ) : null}
        </div>

        {props.onAddRow && !props.readOnly ? (
          <TypingRow
            columns={columns.length}
            inputRef={typingInputRef}
            onAddRow={props.onAddRow}
            onUp={() => {
              const last = rowOrder.length - 1;
              if (last >= 0) go({ row: last, col: 0 });
            }}
            onAdded={(rowId, next) => {
              if (next) setPendingActive({ rowId, col: Math.min(1, columns.length - 1) });
            }}
            {...(props.onPastePreview ? { onPasteBlock: setPreviewBlock } : {})}
          />
        ) : result.rows.length === 0 ? (
          <div className="base-empty" data-testid="base-empty">
            {t("bases.empty")}
          </div>
        ) : null}

        <div className="base-table-foot" role="row">
          {columns.map((column, index) => (
            <div className="base-tf" role="cell" key={column.id}>
              {index === 0 ? (
                <span className="base-count" data-testid="base-count">
                  {result.total > result.rows.length
                    ? t("bases.shownOf", { shown: result.rows.length, total: result.total })
                    : ownedRowsFolder(config)
                      ? t("bases.tableRows", { count: result.total })
                      : t("bases.rows", { count: result.total })}
                </span>
              ) : null}
              {result.summaries?.[column.id] !== undefined ? (
                <span className="base-summary" data-testid={`base-summary-${column.id}`}>
                  <span className="base-summary-name">{summaryName(view, column.id, t)}</span>
                  {result.summaries[column.id]}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      </div>

      {pasteNote ? (
        <p className="base-typing-hint" role="status" data-testid="base-paste-note">
          {pasteNote}
        </p>
      ) : null}

      {props.onAddRow && !props.readOnly && result.rows.length === 0 ? (
        <p className="base-typing-hint" data-testid="base-typing-hint">
          {t("bases.typingHint")}
        </p>
      ) : null}

      {props.onNewRow && !props.onAddRow && !props.readOnly ? (
        <button type="button" className="base-new-row" data-testid="base-new-row" onClick={props.onNewRow}>
          <Icon name="plus" size={14} />
          {t("bases.newRow")}
        </button>
      ) : null}

      {addColumnAnchor ? (
        <AddColumn anchor={addColumnAnchor} shown={viewOrder.map((id) => writtenId(propertyId(id)))} onClose={() => setAddColumnAnchor(null)} onAdd={addColumn} />
      ) : null}
      {headerMenu ? (
        <Popover anchor={headerMenu.anchor} onClose={closeHeaderMenu} label={propertyLabel(headerMenu.column.id, config, t)} testId="base-column-menu" className="is-menu">
          <button type="button" role="menuitem" onClick={() => (setSort(headerMenu.column, "ASC"), setHeaderMenu(null))}>
            {t("bases.sortAsc")}
          </button>
          <button type="button" role="menuitem" onClick={() => (setSort(headerMenu.column, "DESC"), setHeaderMenu(null))}>
            {t("bases.sortDesc")}
          </button>
          {isTitleColumn(headerMenu.column.id) ? null : (
            <button type="button" role="menuitem" data-testid="base-hide-column" onClick={() => (hide(headerMenu.column), setHeaderMenu(null))}>
              {t("bases.hideProperty")}
            </button>
          )}
          {grid && headerMenu.column.editable && headerMenu.column.id.startsWith("note.") ? (
            <ColumnEdits
              column={headerMenu.column}
              {...(selectSettings(config, headerMenu.column.id.slice(5)) ? { kind: selectSettings(config, headerMenu.column.id.slice(5))!.kind } : {})}
              shown={viewOrder.map((id) => writtenId(propertyId(id)))}
              renaming={renaming}
              onStartRename={() => setRenaming(headerMenu.column.id.slice(5))}
              onRenameChange={setRenaming}
              onRename={async (to) => {
                const column = headerMenu.column;
                closeHeaderMenu();
                await props.onRenameColumn?.(column, to);
              }}
              onSetType={async (type) => {
                const column = headerMenu.column;
                closeHeaderMenu();
                await props.onSetColumnType?.(column, type);
              }}
              onDelete={() => {
                setConfirmDelete(headerMenu.column);
                closeHeaderMenu();
              }}
              onEditOptions={() => {
                setEditingOptions({ column: headerMenu.column, anchor: headerMenu.anchor });
                closeHeaderMenu();
              }}
            />
          ) : null}
        </Popover>
      ) : null}
      {previewBlock ? (
        <PastePreview
          block={previewBlock}
          database={(ownedRowsFolder(config) ?? "").split("/").pop() ?? ""}
          known={knownKeys}
          untitled={t("defaults.untitledPage")}
          onCancel={() => setPreviewBlock(null)}
          onPaste={(previewed) => {
            setPreviewBlock(null);
            void props.onPastePreview?.(previewed, view.name);
          }}
        />
      ) : null}
      {editingOptions && selects.get(editingOptions.column.id) && optionActions ? (
        <OptionsEditor
          anchor={editingOptions.anchor}
          label={propertyLabel(editingOptions.column.id, config, t)}
          settings={selects.get(editingOptions.column.id)!}
          onClose={() => setEditingOptions(null)}
          onSetOptions={(options) => optionActions.setOptions(editingOptions.column.id, options)}
          onRename={(from, to) => optionActions.renameOption(editingOptions.column.id, from, to)}
          onClear={(value) => optionActions.clearOption(editingOptions.column.id, value)}
        />
      ) : null}
      {confirmDelete ? (
        <ConfirmDialog
          heading={t("bases.deleteColumnHeading", { name: confirmDelete.id.slice(5) })}
          body={t("bases.deleteColumnBody")}
          confirmLabel={t("bases.deleteColumnConfirm")}
          testId="base-delete-column-dialog"
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            const column = confirmDelete;
            setConfirmDelete(null);
            void props.onDeleteColumn?.(column);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * #7prbquxu (spec/database-tables §4): an owned database's column menu, after sort and Hide: Rename (the key
 * in this database's rows), the type (types.json), and Delete from all rows (asks first).
 */
function ColumnEdits(props: {
  column: BaseColumn;
  shown: readonly string[];
  renaming: string | null;
  onStartRename: () => void;
  onRenameChange: (name: string) => void;
  onRename: (to: string) => Promise<void>;
  onSetType: (type: PropertyType | SelectKind) => Promise<void>;
  onDelete: () => void;
  /** #7prbquxu phase 3: the column is a Select or Multi-select in this database. */
  kind?: SelectKind;
  onEditOptions?: () => void;
}) {
  const t = useT();
  const key = props.column.id.slice(5);
  const draft = props.renaming?.trim() ?? "";
  const error =
    props.renaming === null || draft === key || !draft
      ? null
      : !isValidPropertyKey(draft)
        ? t("properties.invalidName")
        : props.shown.includes(draft)
          ? t("bases.columnExists", { name: draft })
          : null;
  return (
    <>
      <div className="base-menu-separator" role="separator" />
      {props.renaming === null ? (
        <button type="button" role="menuitem" data-testid="base-rename-column" onClick={props.onStartRename}>
          <Icon name="pencil" size={14} />
          {t("properties.rename")}
        </button>
      ) : (
        <div className="base-rename-column">
          <input
            className="base-input"
            data-testid="base-rename-column-input"
            aria-label={t("bases.columnName")}
            aria-invalid={error ? true : undefined}
            autoFocus
            value={props.renaming}
            onChange={(event) => props.onRenameChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === "Enter") {
                event.preventDefault();
                if (draft && draft !== key && !error) void props.onRename(draft);
              }
            }}
          />
          {error ? (
            <div className="base-add-column-note is-error" role="alert" data-testid="base-rename-column-error">
              {error}
            </div>
          ) : null}
        </div>
      )}
      <div className="base-panel-title">{t("properties.type")}</div>
      {COLUMN_TYPES.map((type) => {
        const current = !props.kind && type === props.column.type;
        return (
          <button
            key={type}
            type="button"
            role="menuitemradio"
            aria-checked={current}
            className={current ? "is-current" : ""}
            data-testid={`base-column-type-${type}`}
            onClick={() => void (current ? undefined : props.onSetType(type))}
          >
            <PropertyTypeIcon type={type} size={14} />
            {t(`properties.types.${type}`)}
          </button>
        );
      })}
      {(["select", "multiselect"] as const).map((kind) => (
        <button
          key={kind}
          type="button"
          role="menuitemradio"
          aria-checked={props.kind === kind}
          className={props.kind === kind ? "is-current" : ""}
          data-testid={`base-column-type-${kind}`}
          onClick={() => void (props.kind === kind ? undefined : props.onSetType(kind))}
        >
          <Icon name={kind === "select" ? "chevronDown" : "tag"} size={14} />
          {t(kind === "select" ? "bases.selectType" : "bases.multiselectType")}
        </button>
      ))}
      {props.kind && props.onEditOptions ? (
        <button type="button" role="menuitem" data-testid="base-edit-options" onClick={props.onEditOptions}>
          <Icon name="palette" size={14} />
          {t("bases.editOptions")}
        </button>
      ) : null}
      <div className="base-menu-separator" role="separator" />
      <button type="button" role="menuitem" className="is-danger" data-testid="base-delete-column" onClick={props.onDelete}>
        <Icon name="trash" size={14} />
        {t("bases.deleteColumn")}
      </button>
    </>
  );
}

/**
 * #7prbquxu (spec/database-tables §4): the row at the bottom of an owned database.
 * Typing a name and Enter makes the row and keeps the field ready for the next one.
 * An empty name makes nothing; Enter while an IME is composing belongs to the IME.
 */
function TypingRow(props: {
  columns: number;
  inputRef: React.MutableRefObject<HTMLInputElement | null>;
  onAddRow: (title: string) => Promise<string | void>;
  /** ArrowUp: back to the last row. */
  onUp: () => void;
  /** The row was made; `next` when Tab asked to go on into its second column. */
  onAdded: (rowId: string, next: boolean) => void;
  /** #7prbquxu phase 2: a block pasted here opens the preview (one value is typed as usual). */
  onPasteBlock?: (block: string[][]) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const add = async (next: boolean) => {
    const title = draft.trim();
    if (!title || busy) return;
    setBusy(true);
    try {
      const id = await props.onAddRow(title);
      setDraft("");
      if (typeof id === "string") props.onAdded(id, next);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="base-tr base-typing-row" role="row" data-testid="base-typing-row">
      <div className="base-td base-td-title" role="cell">
        <span className="base-typing-icon" aria-hidden="true">
          <Icon name="plus" size={14} />
        </span>
        <input
          ref={props.inputRef}
          className="base-typing-input"
          data-testid="base-typing-input"
          aria-label={t("bases.typeName")}
          placeholder={t("bases.typeName")}
          value={draft}
          readOnly={busy}
          onChange={(event) => setDraft(event.target.value)}
          onPaste={(event) => {
            if (!props.onPasteBlock) return;
            const read = readPaste(event.clipboardData.getData("text/plain"), event.clipboardData.getData("text/html"));
            if ("value" in read) return;
            event.preventDefault();
            props.onPasteBlock(read.rows);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Enter") {
              event.preventDefault();
              void add(false);
            } else if (event.key === "Tab" && !event.shiftKey && draft.trim()) {
              event.preventDefault();
              void add(true);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              props.onUp();
            } else if (event.key === "Escape" && draft) {
              event.preventDefault();
              setDraft("");
            }
          }}
        />
      </div>
      {Array.from({ length: Math.max(0, props.columns - 1) }, (_, index) => (
        <div className="base-td" role="cell" key={index} />
      ))}
      <div className="base-td base-td-fill" role="cell" />
    </div>
  );
}

function summaryName(view: BaseView, id: string, t: ReturnType<typeof useT>): string {
  const summaries = (view.summaries ?? {}) as Record<string, unknown>;
  const name = summaries[id] ?? (id.startsWith("note.") ? summaries[id.slice(5)] : undefined);
  if (typeof name !== "string") return "";
  const key = `bases.summaryOf.${name}` as MessageKey;
  const label = t(key);
  return label === key ? name : label;
}

interface TableRowProps {
  row: BaseRow;
  columns: BaseColumn[];
  /** Offset in the body; a number (not a style object) so unchanged rows skip rendering while scrolling. */
  top: number;
  readOnly?: boolean;
  renaming: boolean;
  /** #7prbquxu: the column whose editor the database grid asked to open in this row. */
  editCol?: number | null;
  /** #7prbquxu phase 3: the character typed to open it (a Select picker's first search letter). */
  editSeed?: string | undefined;
  onOpen: (id: string) => void;
  onEditValue: (row: BaseRow, column: BaseColumn, value: BaseValue) => Promise<boolean>;
  onRename: (row: BaseRow, title: string) => Promise<string | void>;
  onRenameDone?: () => void;
  /** The database grid: a click opens the cell's editor through the grid. */
  onRequestEdit?: (rowId: string, col: number) => void;
  onEditDone?: (move?: GridMove) => void;
  /**
   * #12 (#faqr8pj9): a database grid's rows are one Tab stop: cells and row buttons leave the Tab order, and while no
   * cell is active the first row's Name cell (`gridEntry`) is where Tab enters; focusing it makes it active.
   */
  grid?: boolean;
  gridEntry?: boolean;
  onEnterGrid?: (rowId: string) => void;
}

/** One row; memoized so scrolling only renders the rows that come into view. */
const TableRow = memo(function TableRow(props: TableRowProps) {
  const { row } = props;
  return (
    <div className="base-tr" role="row" style={{ transform: `translateY(${props.top}px)` }} data-testid={`base-row-${row.id}`} data-row-id={row.id}>
      {props.columns.map((column, col) =>
        isTitleColumn(column.id) ? (
          <TitleCell key={column.id} {...props} />
        ) : (
          <ValueCell
            key={column.id}
            row={row}
            column={column}
            col={col}
            readOnly={props.readOnly}
            grid={props.grid === true}
            onEditValue={props.onEditValue}
            editRequested={props.editCol === col}
            {...(props.editCol === col && props.editSeed ? { editSeed: props.editSeed } : {})}
            {...(props.onRequestEdit ? { onRequestEdit: props.onRequestEdit } : {})}
            {...(props.onEditDone ? { onEditDone: props.onEditDone } : {})}
          />
        ),
      )}
      <div className="base-td base-td-fill" role="cell" />
    </div>
  );
});

function TitleCell(props: TableRowProps) {
  const t = useT();
  const { row } = props;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(row.title);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const asked = props.renaming || props.editCol === 0;
  useEffect(() => {
    if (!asked) return;
    setDraft(row.title);
    setEditing(true);
  }, [asked, row.title]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const finish = (save: boolean) => {
    setEditing(false);
    props.onRenameDone?.();
    const title = draft.trim();
    if (save && title && title !== row.title) void props.onRename(row, title);
  };

  return (
    <div
      className="base-td base-td-title"
      role="cell"
      data-grid-col={0}
      tabIndex={props.gridEntry ? 0 : undefined}
      aria-label={props.gridEntry ? t("bases.openPage", { title: row.title }) : undefined}
      onFocus={(event) => {
        if (props.gridEntry && event.target === event.currentTarget) props.onEnterGrid?.(row.id);
      }}
    >
      {editing ? (
        <input
          ref={inputRef}
          className="base-cell-input"
          data-testid={`base-title-input-${row.id}`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => finish(true)}
          onKeyDown={(event) => {
            if (event.key === "Enter") finish(true);
            else if (event.key === "Escape") finish(false);
          }}
        />
      ) : (
        <>
          <button
            type="button"
            className="base-title-link"
            data-testid={`base-open-${row.id}`}
            tabIndex={props.grid ? -1 : undefined}
            aria-label={t("bases.openPage", { title: row.title })}
            onClick={() => props.onOpen(row.id)}
          >
            <span className="base-title-icon" aria-hidden="true">
              {row.icon ? row.icon : <Icon name="file" size={14} />}
            </span>
            <span className="base-title-text">{row.title}</span>
          </button>
          {props.readOnly ? null : (
            <button
              type="button"
              className="base-cell-edit"
              tabIndex={props.grid ? -1 : undefined}
              aria-label={t("sidebar.rename")}
              data-tooltip={t("sidebar.rename")}
              onClick={() => {
                setDraft(row.title);
                setEditing(true);
              }}
            >
              <Icon name="pencil" size={12} />
            </button>
          )}
        </>
      )}
    </div>
  );
}

function ValueCell(props: {
  row: BaseRow;
  column: BaseColumn;
  /** The column's index (the database grid's `data-grid-col`). */
  col: number;
  readOnly?: boolean;
  /** #12: in a database grid the cell isn't a Tab stop of its own (the grid's active cell is). */
  grid?: boolean;
  onEditValue: (row: BaseRow, column: BaseColumn, value: BaseValue) => Promise<boolean>;
  /** #7prbquxu: the database grid asks this cell's editor to open (Enter, F2, a date typed). */
  editRequested?: boolean;
  editSeed?: string;
  onRequestEdit?: (rowId: string, col: number) => void;
  onEditDone?: (move?: GridMove) => void;
}) {
  const t = useT();
  const select = useContext(BaseSelects).get(props.column.id);
  const selectActions = useContext(BaseSelectActions);
  const { row, column } = props;
  const value = row.values[column.id] ?? null;
  const editable = column.editable && !props.readOnly;
  const [editing, setEditing] = useState(false);
  const label = t("bases.editCell", { property: column.displayName ?? column.id.replace(/^note\./, ""), title: row.title });
  // When the editor closes with Escape or a save, its input goes and focus
  // would drop to <body>: give it back to the cell (WCAG 2.4.3, #jchhjepb).
  // A click elsewhere has already moved focus, so it's left alone.
  const cellRef = useRef<HTMLDivElement | null>(null);
  const wasEditing = useRef(false);
  /** #5q4vaacm: where Tab or Shift+Tab asked the grid to go once this editor has closed. */
  const moveAfter = useRef<GridMove | undefined>(undefined);
  useEffect(() => {
    if (wasEditing.current && !editing) {
      // The database grid takes the focus back to its active cell itself (or moves on, after a Tab).
      const move = moveAfter.current;
      moveAfter.current = undefined;
      if (props.onEditDone) props.onEditDone(move);
      else {
        const active = document.activeElement;
        if (!active || active === document.body) cellRef.current?.focus();
      }
    }
    wasEditing.current = editing;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);
  useEffect(() => {
    if (props.editRequested && editable) setEditing(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.editRequested]);

  // #5q4vaacm: in the database grid, Tab and Shift+Tab commit the editor (its own blur commit, as clicking away does)
  // and move on, like Notion and a spreadsheet. A Select picker (a portal) bubbles its keys here too: it closes
  // without picking.
  const tabOut = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab" || !props.onEditDone || event.nativeEvent.isComposing) return;
    // A date picker (a portal) keeps its own Tab: its month buttons, a datetime's time field, Today and Clear must stay
    // reachable by keyboard (@graph-dev). Tab from the field itself still commits and moves.
    if ((event.target as Element | null)?.closest?.(".date-picker")) return;
    event.preventDefault();
    event.stopPropagation();
    moveAfter.current = event.shiftKey ? "prev" : "next";
    (document.activeElement as HTMLElement | null)?.blur();
    setEditing(false);
  };

  if (column.type === "checkbox") {
    return (
      <div className="base-td base-td-check" role="cell" data-grid-col={props.col}>
        <input
          type="checkbox"
          aria-label={label}
          data-testid={`base-cell-${row.id}-${column.id}`}
          checked={value === true}
          disabled={!editable}
          tabIndex={props.grid ? -1 : undefined}
          onChange={() => void props.onEditValue(row, column, value !== true)}
        />
      </div>
    );
  }

  // A Select opens its picker in the same render as the grid's request (no state round-trip), so keys typed right
  // after the first one land in its search.
  if (select && (editing || (props.editRequested && editable))) {
    return (
      <div
        className="base-td is-editing"
        role="cell"
        data-grid-col={props.col}
        data-testid={`base-cell-editor-${row.id}-${column.id}`}
        onBlur={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Element | null)) return;
          setEditing(false);
        }}
        onKeyDown={tabOut}
      >
        <SelectChips value={value} settings={select} />
        <SelectPicker
          settings={select}
          value={value}
          {...(props.editSeed ? { initialQuery: props.editSeed } : {})}
          onChange={(next) => props.onEditValue(row, column, next)}
          onAddOption={(option) => selectActions?.addOption(column.id, option) ?? Promise.resolve()}
          onClose={() => setEditing(false)}
        />
      </div>
    );
  }

  // Only single text and number values: a list's Enter adds an item, a date's belongs to its picker.
  const enterMovesDown = column.type === "text" || column.type === "number";

  if (editing) {
    // The properties header's own editor (v1.12, #qw4pcm2h), without chrome.
    const property: Property = {
      key: column.id.replace(/^note\./, ""),
      type: (PROPERTY_TYPES as readonly string[]).includes(column.type) ? (column.type as PropertyType) : "text",
      value,
      editable: true,
    };
    return (
      <div
        className="base-td is-editing"
        role="cell"
        data-grid-col={props.col}
        data-testid={`base-cell-editor-${row.id}-${column.id}`}
        onBlur={(event) => {
          const next = event.relatedTarget as Element | null;
          // The date picker is a popover outside the cell (#93wnicas): moving into it keeps the cell editing.
          if (event.currentTarget.contains(next) || next?.closest(".date-picker")) return;
          setEditing(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") setEditing(false);
          else if (event.key === "Enter" && enterMovesDown && props.onEditDone && !event.nativeEvent.isComposing) {
            // #5q4vaacm (spec §4): Enter commits (the editor's own Enter, a blur) and moves down, as typing over a
            // cell does. Lists keep Enter for their next item, and dates for their picker.
            moveAfter.current = "down";
            setEditing(false);
          } else tabOut(event);
        }}
      >
        <PropertyValueEditor
          compact
          autoFocus
          property={property}
          onSave={async (next) => {
            const saved = await props.onEditValue(row, column, next);
            // Lists stay open for the next chip; single values close.
            if (saved && !Array.isArray(next)) setEditing(false);
            return saved;
          }}
        />
      </div>
    );
  }

  const lists = column.type === "multitext" || column.type === "tags" || column.type === "aliases";
  const content = select ? (
    <SelectChips value={value} settings={select} />
  ) : lists && Array.isArray(value) ? (
      <span className="base-chips">
        {value.map((item, index) => (
          <span className="base-chip" key={`${item}-${index}`}>
            {column.type === "tags" ? `#${item.replace(/^#/, "")}` : <BaseText text={item} rowId={row.id} />}
          </span>
        ))}
      </span>
    ) : (
      <span className={`base-value${column.type === "number" ? " is-number" : ""}`}>
        {typeof value === "string" && column.type === "text" ? <BaseText text={value} rowId={row.id} /> : display(value, column.type)}
      </span>
    );

  return (
    <div
      ref={cellRef}
      className={`base-td${editable ? " is-editable" : ""}${column.type === "number" ? " is-number" : ""}`}
      role="cell"
      data-grid-col={props.col}
      data-testid={`base-cell-${row.id}-${column.id}`}
      tabIndex={editable ? (props.grid ? -1 : 0) : undefined}
      aria-label={editable ? label : undefined}
      title={column.editable ? undefined : t("bases.readOnlyCell")}
      onClick={() => {
        if (!editable) return;
        if (props.onRequestEdit) props.onRequestEdit(row.id, props.col);
        else setEditing(true);
      }}
      onKeyDown={(event) => {
        if (!editable || (event.key !== "Enter" && event.key !== "F2")) return;
        event.preventDefault();
        setEditing(true);
      }}
    >
      {content}
    </div>
  );
}
