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
import { dateFormat, useT, type MessageKey } from "../i18n/index.js";
import { Popover } from "./Popover.js";
import { isTitleColumn, propertyLabel } from "./labels.js";

export const ROW_HEIGHT = 34;
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
  onEditValue: (row: BaseRow, column: BaseColumn, value: BaseValue) => Promise<void>;
  onRename: (row: BaseRow, title: string) => Promise<void>;
  onNewRow?: () => void;
  onChangeView: (view: BaseView) => void;
  /** A row just created: its title opens for typing. */
  renameRowId?: string | null;
  onRenameDone?: () => void;
}

type Item = { kind: "group"; label: string; count: number } | { kind: "row"; index: number };

function columnWidth(view: BaseView, column: BaseColumn): number {
  const sizes = view.columnSize;
  if (sizes && typeof sizes === "object" && !Array.isArray(sizes)) {
    const size = (sizes as Record<string, unknown>)[column.id];
    if (typeof size === "number" && size >= 60 && size <= 1200) return size;
  }
  return isTitleColumn(column.id) ? TITLE_WIDTH : COLUMN_WIDTH;
}


/** A value as the cell shows it. */
function display(value: BaseValue, type: string): string {
  if (value === null || value === "") return "";
  if (typeof value === "boolean") return "";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "string" && (type === "date" || type === "datetime")) {
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(value);
    if (match) {
      const [, y, m, d, h, min] = match;
      const date = new Date(Number(y), Number(m) - 1, Number(d), Number(h ?? 0), Number(min ?? 0));
      // In the interface language, like the page header's dates.
      return h !== undefined
        ? dateFormat({ dateStyle: "medium", timeStyle: "short" }).format(date)
        : dateFormat({ dateStyle: "medium" }).format(date);
    }
  }
  // `[[Page|alias]]` in a text property reads as its label.
  if (typeof value === "string") return value.replace(/\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_, target: string, alias?: string) => alias ?? target);
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

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const [headerMenu, setHeaderMenu] = useState<{ column: BaseColumn; anchor: HTMLElement } | null>(null);
  const sorts = Array.isArray(view.sort) ? view.sort : [];

  const setSort = (column: BaseColumn, direction: "ASC" | "DESC") => {
    const others = sorts.filter((sort) => sort.property !== column.id && `note.${sort.property}` !== column.id);
    props.onChangeView({ ...view, sort: [{ property: column.id, direction }, ...others] });
  };
  const hide = (column: BaseColumn) => {
    const order = (Array.isArray(view.order) ? view.order.map(String) : ["file.name"]).filter(
      (id) => id !== column.id && `note.${id}` !== column.id,
    );
    props.onChangeView({ ...view, order });
  };

  const style = {
    "--base-columns": template,
    "--base-width": `${totalWidth}px`,
    ...(props.maxHeight ? { maxHeight: props.maxHeight } : {}),
  } as CSSProperties;

  return (
    <div className="base-table" data-testid="base-table" role="table" aria-rowcount={result.rows.length + 1} style={style}>
      <div className="base-table-scroll" ref={scrollRef} data-testid="base-table-scroll">
        <div className="base-table-head" role="row">
          {columns.map((column) => {
            const sort = sorts.find((item) => item.property === column.id || `note.${item.property}` === column.id);
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
                  <span className="base-group-label">{item.label || t("bases.noValue")}</span>
                  <span className="base-group-count">{item.count}</span>
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

        {result.rows.length === 0 ? (
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

      {props.onNewRow && !props.readOnly ? (
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
  onEditValue: (row: BaseRow, column: BaseColumn, value: BaseValue) => Promise<void>;
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

function toInput(value: BaseValue, type: string): string {
  if (value === null || typeof value === "boolean") return "";
  if (Array.isArray(value)) return value.join(", ");
  if (type === "datetime" && typeof value === "string") return value.slice(0, 16);
  return String(value);
}

function fromInput(text: string, type: string): BaseValue {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  switch (type) {
    case "number":
      return Number.isFinite(Number(trimmed)) ? Number(trimmed) : trimmed;
    case "multitext":
    case "tags":
    case "aliases":
      return trimmed
        .split(",")
        .map((item) => item.trim().replace(type === "tags" ? /^#/ : /^$/, ""))
        .filter(Boolean);
    default:
      return trimmed;
  }
}

function ValueCell(props: {
  row: BaseRow;
  column: BaseColumn;
  readOnly?: boolean;
  onEditValue: (row: BaseRow, column: BaseColumn, value: BaseValue) => Promise<void>;
}) {
  const t = useT();
  const { row, column } = props;
  const value = row.values[column.id] ?? null;
  const editable = column.editable && !props.readOnly;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const label = t("bases.editCell", { property: column.displayName ?? column.id.replace(/^note\./, ""), title: row.title });

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
    const commit = () => {
      setEditing(false);
      const next = fromInput(draft, column.type);
      if (JSON.stringify(next) !== JSON.stringify(value)) void props.onEditValue(row, column, next);
    };
    return (
      <div className="base-td is-editing" role="cell">
        <input
          autoFocus
          className="base-cell-input"
          aria-label={label}
          data-testid={`base-cell-input-${row.id}-${column.id}`}
          type={column.type === "date" ? "date" : column.type === "datetime" ? "datetime-local" : column.type === "number" ? "number" : "text"}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
            else if (event.key === "Escape") setEditing(false);
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
            {column.type === "tags" ? `#${item.replace(/^#/, "")}` : display(item, "text")}
          </span>
        ))}
      </span>
    ) : (
      <span className={`base-value${column.type === "number" ? " is-number" : ""}`}>{display(value, column.type)}</span>
    );

  return (
    <div
      className={`base-td${editable ? " is-editable" : ""}${column.type === "number" ? " is-number" : ""}`}
      role="cell"
      data-testid={`base-cell-${row.id}-${column.id}`}
      tabIndex={editable ? 0 : undefined}
      aria-label={editable ? label : undefined}
      title={column.editable ? undefined : t("bases.readOnlyCell")}
      onClick={() => {
        if (!editable) return;
        setDraft(toInput(value, column.type));
        setEditing(true);
      }}
      onKeyDown={(event) => {
        if (!editable || (event.key !== "Enter" && event.key !== "F2")) return;
        event.preventDefault();
        setDraft(toInput(value, column.type));
        setEditing(true);
      }}
    >
      {content}
    </div>
  );
}
