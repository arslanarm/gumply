/**
 * A base's table layout (spec/api-bases, #sg36ng2d). Rows are virtualised
 * (`@tanstack/react-virtual`): only what's on screen mounts, so 2,000 pages
 * scroll as smoothly as 20. Note properties are edited in place and written
 * to the page's frontmatter; file properties and formulas are read-only.
 */
import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { BaseColumn, BaseConfig, BaseRow, BaseValue, BaseView, BaseViewResult } from "@gumply/core";
import { Icon } from "../components/Icon.js";
import { useT, type MessageKey } from "../i18n/index.js";
import { PROPERTY_TYPES, WIKILINK_INNER, WIKILINK_PART, type Property, type PropertyType } from "@gumply/core";
import { PropertyValueEditor } from "../components/PropertiesBlock.js";
import { Popover } from "./Popover.js";
import { ownedRowsFolder, propertyId } from "@gumply/core";
import { isTitleColumn, propertyLabel, writtenId } from "./labels.js";
import { BaseText } from "./values.js";
import { formatDateValue } from "../lib/dates.js";

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
  onRename: (row: BaseRow, title: string) => Promise<void>;
  onNewRow?: () => void;
  /**
   * #7prbquxu: a database that owns its rows: the typing row at the bottom makes a row
   * with the typed name (it resolves once the table shows it). Replaces "+ New".
   */
  onAddRow?: (title: string) => Promise<void>;
  onChangeView: (view: BaseView) => void;
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

  const [headerMenu, setHeaderMenu] = useState<{ column: BaseColumn; anchor: HTMLElement } | null>(null);
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
      <div className="base-table-scroll" ref={scrollRef} data-testid="base-table-scroll" role="table" aria-rowcount={result.rows.length + 1}>
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
          <div className="base-th base-th-fill" aria-hidden="true" />
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
                onOpen={props.onOpen}
                onEditValue={props.onEditValue}
                onRename={props.onRename}
                onRenameDone={props.onRenameDone}
              />
            );
          })}
        </div>

        {props.onAddRow && !props.readOnly ? (
          <TypingRow columns={columns.length} onAddRow={props.onAddRow} />
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

      {headerMenu ? (
        <Popover anchor={headerMenu.anchor} onClose={() => setHeaderMenu(null)} label={propertyLabel(headerMenu.column.id, config, t)} testId="base-column-menu" className="is-menu">
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
        </Popover>
      ) : null}
    </div>
  );
}

/**
 * #7prbquxu (spec/database-tables §4): the row at the bottom of an owned database.
 * Typing a name and Enter makes the row and keeps the field ready for the next one.
 * An empty name makes nothing; Enter while an IME is composing belongs to the IME.
 */
function TypingRow(props: { columns: number; onAddRow: (title: string) => Promise<void> }) {
  const t = useT();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const add = async () => {
    const title = draft.trim();
    if (!title || busy) return;
    setBusy(true);
    try {
      await props.onAddRow(title);
      setDraft("");
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
          className="base-typing-input"
          data-testid="base-typing-input"
          aria-label={t("bases.typeName")}
          placeholder={t("bases.typeName")}
          value={draft}
          readOnly={busy}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Enter") {
              event.preventDefault();
              void add();
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
  onOpen: (id: string) => void;
  onEditValue: (row: BaseRow, column: BaseColumn, value: BaseValue) => Promise<boolean>;
  onRename: (row: BaseRow, title: string) => Promise<void>;
  onRenameDone?: () => void;
}

/** One row; memoized so scrolling only renders the rows that come into view. */
const TableRow = memo(function TableRow(props: TableRowProps) {
  const { row } = props;
  return (
    <div className="base-tr" role="row" style={{ transform: `translateY(${props.top}px)` }} data-testid={`base-row-${row.id}`}>
      {props.columns.map((column) =>
        isTitleColumn(column.id) ? (
          <TitleCell key={column.id} {...props} />
        ) : (
          <ValueCell key={column.id} row={row} column={column} readOnly={props.readOnly} onEditValue={props.onEditValue} />
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

  useEffect(() => {
    if (!props.renaming) return;
    setDraft(row.title);
    setEditing(true);
  }, [props.renaming, row.title]);

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
    <div className="base-td base-td-title" role="cell">
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
  readOnly?: boolean;
  onEditValue: (row: BaseRow, column: BaseColumn, value: BaseValue) => Promise<boolean>;
}) {
  const t = useT();
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
  useEffect(() => {
    if (wasEditing.current && !editing) {
      const active = document.activeElement;
      if (!active || active === document.body) cellRef.current?.focus();
    }
    wasEditing.current = editing;
  }, [editing]);

  if (column.type === "checkbox") {
    return (
      <div className="base-td base-td-check" role="cell">
        <input
          type="checkbox"
          aria-label={label}
          data-testid={`base-cell-${row.id}-${column.id}`}
          checked={value === true}
          disabled={!editable}
          onChange={() => void props.onEditValue(row, column, value !== true)}
        />
      </div>
    );
  }

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
        data-testid={`base-cell-editor-${row.id}-${column.id}`}
        onBlur={(event) => {
          const next = event.relatedTarget as Element | null;
          // The date picker is a popover outside the cell (#93wnicas): moving into it keeps the cell editing.
          if (event.currentTarget.contains(next) || next?.closest(".date-picker")) return;
          setEditing(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") setEditing(false);
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
  const content =
    lists && Array.isArray(value) ? (
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
      data-testid={`base-cell-${row.id}-${column.id}`}
      tabIndex={editable ? 0 : undefined}
      aria-label={editable ? label : undefined}
      title={column.editable ? undefined : t("bases.readOnlyCell")}
      onClick={() => {
        if (editable) setEditing(true);
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
