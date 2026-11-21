import { useMemo, useState } from "react";
import type { PageId, TrashedPage, TrashItem } from "@gumply/core";
import { useT } from "../i18n/index.js";
import { relativeTime } from "../lib/search.js";
import { filterTrash, trashDepth, trashLocation, trashedCount } from "../lib/trash.js";
import { Icon } from "./Icon.js";

export interface TrashViewProps {
  /** null while loading. */
  items: TrashItem[] | null;
  error: string | null;
  /** The desktop app can show a trashed file in the file manager. */
  desktop: boolean;
  onOpen: (item: TrashItem, id?: PageId) => void;
  onRestore: (item: TrashItem) => void;
  onDeleteForever: (item: TrashItem) => void;
  onEmpty: () => void;
  onRetry: () => void;
}

function ItemIcon({ page }: { page: TrashedPage }) {
  if (page.icon) return <span className="trash-item-emoji">{page.icon}</span>;
  return <Icon
      name={page.kind === "whiteboard" ? "board" : page.kind === "base" ? "database" : page.kind === "folder" ? "folder" : "file"}
      size={16}
    />;
}

/** The trash (#ppag3ugh): deleted pages and boards, newest first. */
export function TrashView({ items, error, desktop, onOpen, onRestore, onDeleteForever, onEmpty, onRetry }: TrashViewProps) {
  const t = useT();
  const [query, setQuery] = useState("");
  const shown = useMemo(() => (items ? filterTrash(items, query) : []), [items, query]);
  const total = items ? trashedCount(items) : 0;

  return (
    <div className="trash-view" data-testid="trash-view">
      <header className="trash-header">
        <div className="trash-heading">
          <h1 className="page-title">{t("trash.title")}</h1>
          <button
            type="button"
            className="button-secondary trash-empty-button"
            data-testid="trash-empty"
            disabled={!items || items.length === 0}
            onClick={onEmpty}
          >
            {t("trash.empty")}
          </button>
        </div>
        <p className="trash-intro">
          {t("trash.introBefore")} <code>.trash</code> {t("trash.introAfter")}
        </p>
        {items && items.length > 0 ? (
          <label className="trash-search">
            <Icon name="search" size={15} />
            <input
              type="search"
              placeholder={t("trash.searchPlaceholder", { count: total })}
              aria-label={t("trash.searchLabel")}
              data-testid="trash-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        ) : null}
      </header>

      {error ? (
        <div className="trash-note" role="alert">
          <p>{error}</p>
          <button type="button" className="button-secondary" onClick={onRetry}>
            {t("common.retry")}
          </button>
        </div>
      ) : items === null ? (
        <p className="trash-note">{t("trash.loading")}</p>
      ) : items.length === 0 ? (
        <div className="empty-state trash-empty-state" data-testid="trash-empty-state">
          <span className="empty-state-icon" aria-hidden="true">
            <Icon name="trash" size={26} />
          </span>
          <h2>{t("trash.emptyTitle")}</h2>
          <p>{t("trash.emptyBody")}</p>
        </div>
      ) : shown.length === 0 ? (
        <p className="trash-note" data-testid="trash-no-match">
          {t("trash.noMatch", { query: query.trim() })}
        </p>
      ) : (
        <ul className="trash-list" aria-label={t("trash.listLabel")}>
          {shown.map((item) => {
            const location = trashLocation(item);
            return (
              <li key={item.trashId} className="trash-entry" data-testid={`trash-item-${item.title}`}>
                <div className="trash-row">
                  <button type="button" className="trash-row-main" onClick={() => onOpen(item)}>
                    <span className="trash-item-icon" aria-hidden="true">
                      <ItemIcon page={item} />
                    </span>
                    <span className="trash-item-text">
                      <span className="trash-item-title">{item.title}</span>
                      <span className="trash-item-meta">
                        {location ? (
                          <>
                            {t("trash.in", { location })}
                            {item.originalParentTitle === null ? t("trash.noLongerThere") : ""} ·{" "}
                          </>
                        ) : null}
                        {t("trash.deleted", { time: relativeTime(item.deletedAt) })}
                      </span>
                    </span>
                  </button>
                  <span className="trash-row-actions">
                    <button
                      type="button"
                      className="button-secondary trash-restore"
                      data-testid="trash-restore"
                      onClick={() => onRestore(item)}
                    >
                      {t("trash.restore")}
                    </button>
                    {desktop ? (
                      <a
                        className="icon-button"
                        href={`/api/trash/${encodeURIComponent(item.trashId)}/reveal`}
                        target="_blank"
                        rel="noreferrer"
                        data-testid="trash-reveal"
                        data-tooltip={t("trash.showInFileManager")}
                        aria-label={t("trash.showItemInFileManager", { title: item.title })}
                      >
                        <Icon name="file" size={15} />
                      </a>
                    ) : null}
                    <button
                      type="button"
                      className="icon-button trash-delete-forever"
                      data-testid="trash-delete-forever"
                      data-tooltip={t("trash.deleteForever")}
                      aria-label={t("trash.deleteItemForever", { title: item.title })}
                      onClick={() => onDeleteForever(item)}
                    >
                      <Icon name="trash" size={15} />
                    </button>
                  </span>
                </div>
                {item.children.length > 0 ? (
                  <ul className="trash-children" aria-label={t("trash.subPagesOf", { title: item.title })}>
                    {item.children.map((child) => (
                      <li key={child.id}>
                        <button
                          type="button"
                          className="trash-child"
                          style={{ paddingLeft: `${trashDepth(item, child.id) * 1.25 + 0.5}rem` }}
                          data-testid={`trash-child-${child.title}`}
                          onClick={() => onOpen(item, child.id)}
                        >
                          <span className="trash-item-icon" aria-hidden="true">
                            <ItemIcon page={child} />
                          </span>
                          <span className="trash-item-title">{child.title}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
