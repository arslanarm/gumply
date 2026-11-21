/**
 * A base's List, Cards and Kanban layouts (spec/api-bases, #sg36ng2d), in
 * Obsidian 1.14.4's shapes: `markers`/`indentProperties`/`separator` for
 * lists, `cardSize`/`image`/`imageFit`/`imageAspectRatio` for cards, and
 * `groupBy`/`groupOrder`/`columnWidth` for kanban.
 *
 * Many items: cards and list items use `content-visibility: auto`, so only
 * what's on screen is laid out and painted.
 */
import { useState, type DragEvent } from "react";
import { noteKey, propertyId, type BaseConfig, type BaseGroup, type BaseRow, type BaseValue, type BaseView, type BaseViewResult } from "@gumply/core";
import { Icon } from "../components/Icon.js";
import { useT } from "../i18n/index.js";
import { propertyLabel } from "./labels.js";
import { detailColumns, ImageBox, numberSetting, ValueText } from "./values.js";

export interface LayoutProps {
  config: BaseConfig;
  view: BaseView;
  result: BaseViewResult;
  readOnly?: boolean;
  onOpen: (id: string) => void;
  /** Set one note property of a page (kanban drop, calendar move). */
  onSetValue?: (row: BaseRow, key: string, value: BaseValue) => Promise<void>;
  /** "+ New", with the values the place it was added to implies. */
  onNewRow?: (values?: Record<string, BaseValue>) => void;
}

function TitleButton({ row, onOpen }: { row: BaseRow; onOpen: (id: string) => void }) {
  const t = useT();
  return (
    <button
      type="button"
      className="base-title-link"
      data-testid={`base-open-${row.id}`}
      aria-label={t("bases.openPage", { title: row.title })}
      onClick={() => onOpen(row.id)}
    >
      <span className="base-title-icon" aria-hidden="true">
        {row.icon ? row.icon : <Icon name="file" size={14} />}
      </span>
      <span className="base-title-text">{row.title}</span>
    </button>
  );
}

function NewButton({ onClick, testId }: { onClick: () => void; testId: string }) {
  const t = useT();
  return (
    <button type="button" className="base-new-row" data-testid={testId} onClick={onClick}>
      <Icon name="plus" size={14} />
      {t("bases.newRow")}
    </button>
  );
}

/* --------------------------------------------------------------- list */

export function ListView(props: LayoutProps) {
  const t = useT();
  const { view, result } = props;
  const markers = view.markers === "number" || view.markers === "none" ? view.markers : "bullet";
  const indent = view.indentProperties === true;
  const separator = typeof view.separator === "string" ? view.separator : ", ";
  const columns = detailColumns(result.columns);
  const Tag = markers === "number" ? "ol" : "ul";

  const item = (row: BaseRow) => (
    <li key={row.id} className="base-list-item" data-testid={`base-item-${row.id}`}>
      <TitleButton row={row} onOpen={props.onOpen} />
      {indent ? (
        <ul className="base-list-props">
          {columns.map((column) =>
            row.values[column.id] === null || row.values[column.id] === undefined ? null : (
              // As in Obsidian: an indented bullet with the value only.
              <li key={column.id} data-testid={`base-list-prop-${column.id}`}>
                <ValueText value={row.values[column.id] ?? null} column={column} />
              </li>
            ),
          )}
        </ul>
      ) : (
        <span className="base-list-inline">
          {columns
            .filter((column) => {
              const value = row.values[column.id];
              return value !== null && value !== undefined && value !== "" && !(Array.isArray(value) && !value.length);
            })
            .map((column, index) => (
              <span key={column.id} className="base-list-value">
                {index > 0 ? <span className="base-list-sep">{separator}</span> : null}
                <ValueText value={row.values[column.id] ?? null} column={column} />
              </span>
            ))}
        </span>
      )}
    </li>
  );

  const list = (rows: BaseRow[]) => (
    <Tag className={`base-list is-${markers}`} data-testid="base-list">
      {rows.map(item)}
    </Tag>
  );

  return (
    <div className="base-layout base-list-view">
      {result.groups
        ? result.groups.map((group) => (
            <section key={group.label} className="base-list-group">
              <h4 className="base-section-title">
                {group.label || t("bases.noValue")}
                <span className="base-group-count">{group.rows.length}</span>
              </h4>
              {list(group.rows.map((index) => result.rows[index]!))}
            </section>
          ))
        : list(result.rows)}
      {result.rows.length === 0 ? <div className="base-empty">{t("bases.empty")}</div> : null}
      {props.onNewRow && !props.readOnly ? <NewButton testId="base-new-row" onClick={() => props.onNewRow?.()} /> : null}
    </div>
  );
}

/* -------------------------------------------------------------- cards */

function Card({ row, props, ratio, fillWidth = false }: { row: BaseRow; props: LayoutProps; ratio: number; fillWidth?: boolean }) {
  const t = useT();
  const columns = detailColumns(props.result.columns);
  return (
    <article className="base-card" data-testid={`base-card-${row.id}`}>
      <ImageBox row={row} view={props.view} ratio={ratio} fillWidth={fillWidth} />
      <div className="base-card-body">
        <TitleButton row={row} onOpen={props.onOpen} />
        {columns.map((column) => {
          const value = row.values[column.id] ?? null;
          if (value === null || value === "" || (Array.isArray(value) && !value.length)) return null;
          return (
            // As in Obsidian: the property's name, small, above its value.
            <div className="base-card-prop" key={column.id} data-testid={`base-card-prop-${column.id}`}>
              <span className="base-card-prop-name">{propertyLabel(column.id, props.config, t)}</span>
              <span className="base-card-prop-value">
                <ValueText value={value} column={column} />
              </span>
            </div>
          );
        })}
      </div>
    </article>
  );
}

export function CardsView(props: LayoutProps) {
  const t = useT();
  const { view, result } = props;
  const size = numberSetting(view, "cardSize", 200, 50, 800);
  const ratio = numberSetting(view, "imageAspectRatio", 1, 0.25, 2.5);
  const grid = (rows: BaseRow[]) => (
    <div className="base-cards" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${size}px, 1fr))` }} data-testid="base-cards">
      {rows.map((row) => (
        <Card key={row.id} row={row} props={props} ratio={ratio} />
      ))}
    </div>
  );
  return (
    <div className="base-layout base-cards-view">
      {result.groups
        ? result.groups.map((group) => (
            <section key={group.label}>
              <h4 className="base-section-title">
                {group.label || t("bases.noValue")}
                <span className="base-group-count">{group.rows.length}</span>
              </h4>
              {grid(group.rows.map((index) => result.rows[index]!))}
            </section>
          ))
        : grid(result.rows)}
      {result.rows.length === 0 ? <div className="base-empty">{t("bases.empty")}</div> : null}
      {props.onNewRow && !props.readOnly ? <NewButton testId="base-new-row" onClick={() => props.onNewRow?.()} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------- kanban */

const ROW_MIME = "application/x-gumply-base-row";

/**
 * Cards move between columns only when grouped by a note property, as in
 * Obsidian (a formula or a `file.*` property can't be set).
 */
function groupKey(view: BaseView): string | null {
  const property = view.groupBy?.property;
  return typeof property === "string" ? noteKey(property) : null;
}

export function KanbanView(props: LayoutProps & { onPickGroup: () => void }) {
  const t = useT();
  const { view, result } = props;
  const width = numberSetting(view, "columnWidth", 280, 200, 500);
  const ratio = numberSetting(view, "imageAspectRatio", 0.5, 0.25, 2.5);
  const key = groupKey(view);
  const movable = key !== null && !props.readOnly && !!props.onSetValue;
  const [over, setOver] = useState<string | null>(null);

  if (!view.groupBy?.property || !result.groups) {
    return (
      <div className="base-notice" data-testid="base-kanban-ungrouped">
        <Icon name="kanban" size={18} />
        <p>{t("bases.kanbanNeedsGroup")}</p>
        {props.readOnly ? null : (
          <button type="button" className="button-secondary" data-testid="base-kanban-pick-group" onClick={props.onPickGroup}>
            {t("bases.groupBy")}
          </button>
        )}
      </div>
    );
  }

  const drop = (group: BaseGroup) => (event: DragEvent<HTMLElement>) => {
    setOver(null);
    const id = event.dataTransfer.getData(ROW_MIME);
    const row = result.rows.find((item) => item.id === id);
    if (!row || !key || !props.onSetValue) return;
    event.preventDefault();
    const current = row.values[propertyId(key)] ?? null;
    if (JSON.stringify(current) === JSON.stringify(group.value)) return;
    void props.onSetValue(row, key, group.value);
  };

  return (
    <div className="base-layout base-kanban" data-testid="base-kanban">
      {result.groups.map((group) => (
        <section
          key={group.label}
          className={`base-kanban-column${over === group.label ? " is-over" : ""}`}
          style={{ width }}
          data-testid={`base-column-${group.label || "none"}`}
          onDragOver={(event) => {
            if (!movable || !event.dataTransfer.types.includes(ROW_MIME)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setOver(group.label);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null);
          }}
          onDrop={drop(group)}
        >
          <h4 className="base-kanban-title">
            <span>{group.label || t("bases.noValue")}</span>
            <span className="base-group-count">{group.rows.length}</span>
          </h4>
          <div className="base-kanban-cards">
            {group.rows.map((index) => {
              const row = result.rows[index]!;
              return (
                <div
                  key={row.id}
                  className="base-kanban-card"
                  draggable={movable}
                  onDragStart={(event) => {
                    event.dataTransfer.setData(ROW_MIME, row.id);
                    event.dataTransfer.effectAllowed = "move";
                  }}
                >
                  <Card row={row} props={props} ratio={ratio} fillWidth />
                </div>
              );
            })}
          </div>
          {props.onNewRow && !props.readOnly ? (
            <NewButton
              testId={`base-new-in-${group.label || "none"}`}
              onClick={() => props.onNewRow?.(key && group.value !== null ? { [key]: group.value } : undefined)}
            />
          ) : null}
        </section>
      ))}
    </div>
  );
}
