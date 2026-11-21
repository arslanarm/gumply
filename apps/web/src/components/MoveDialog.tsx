import type { PageId, PageMeta } from "@gumply/core";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Icon } from "./Icon.js";
import { moveTargets, type MoveTarget } from "../lib/move.js";
import { useActiveOptionVisible, usePointerMovedSinceOpen } from "./use-active-option.js";
import { useT } from "../i18n/index.js";

export interface MoveDialogProps {
  page: PageMeta;
  pages: readonly PageMeta[];
  onCancel: () => void;
  /** `null` moves the page to the top level. */
  onSelect: (parentId: PageId | null) => void;
}

/** Searchable “Move to…” picker from the sidebar `⋯` menu (spec/ux §6). */
export function MoveDialog({ page, pages, onCancel, onSelect }: MoveDialogProps) {
  const t = useT();
  const pointerMoved = usePointerMovedSinceOpen();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const rows = useMemo(() => moveTargets(pages, page.id, query), [pages, page.id, query]);
  useActiveOptionVisible(listRef, index, rows.length);

  useEffect(() => {
    setIndex(0);
  }, [query]);

  useEffect(() => {
    setIndex((current) => (rows.length === 0 ? 0 : Math.min(current, rows.length - 1)));
  }, [rows.length]);

  const activeIndex = rows.length === 0 ? -1 : Math.min(index, rows.length - 1);

  const select = (row: MoveTarget | undefined) => {
    if (row) onSelect(row.parentId);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      return;
    }
    if (rows.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setIndex((activeIndex + delta + rows.length) % rows.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      select(rows[activeIndex]);
    }
  };

  const trimmed = query.trim();

  return (
    <div
      className="modal-backdrop quick-switcher-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        className="quick-switcher move-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("move.dialogLabel", { title: page.title })}
        data-testid="move-dialog"
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          className="quick-switcher-input"
          data-testid="move-input"
          type="text"
          value={query}
          placeholder={t("move.placeholder", { title: page.title })}
          aria-label={t("move.inputLabel", { title: page.title })}
          aria-controls="move-results"
          aria-activedescendant={activeIndex >= 0 ? `move-option-${activeIndex}` : undefined}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
        />

        <div
          className="quick-switcher-results"
          id="move-results"
          ref={listRef}
          role="listbox"
          aria-label={t("move.listLabel")}
        >
          {rows.length === 0 ? (
            <p className="quick-switcher-empty" data-testid="move-empty">
              {trimmed.length > 0 ? t("move.noMatch", { query: trimmed }) : t("move.noTargets")}
            </p>
          ) : (
            rows.map((row, rowIndex) => {
              const active = rowIndex === activeIndex;
              return (
                <button
                  key={row.key}
                  id={`move-option-${rowIndex}`}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={active}
                  className={`quick-switcher-option${active ? " is-active" : ""}`}
                  data-testid={
                    row.kind === "top" ? "move-target-top-level" : `move-target-${row.key}`
                  }
                  onMouseDown={(event) => {
                    event.preventDefault();
                    select(row);
                  }}
                  onMouseMove={(event) => {
                    if (pointerMoved(event)) setIndex(rowIndex);
                  }}
                >
                  <span className="quick-switcher-icon" aria-hidden="true">
                    {row.kind === "top" ? (
                      <Icon name="arrowUp" size={16} />
                    ) : row.page?.icon ? (
                      row.page.icon
                    ) : row.page?.kind === "folder" ? (
                      <Icon name="folder" size={16} />
                    ) : (
                      <Icon name="file" size={16} />
                    )}
                  </span>
                  <span className="quick-switcher-text">
                    <span className="quick-switcher-title">{row.label}</span>
                    {row.path ? <span className="quick-switcher-path">{row.path}</span> : null}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
