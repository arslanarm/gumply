import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { PageId, PageMeta } from "@gumply/core";
import { useT } from "../i18n/index.js";
import { comparePages, pageTrail } from "../lib/tree.js";
import { useActiveOptionVisible } from "./use-active-option.js";
import { Icon } from "./Icon.js";

/**
 * v0.9 F (#if236h9k): pick one page or board, searchable, in the same picker
 * style as "Move to…". Read-only: it only reports the choice.
 */
export interface PagePickerDialogProps {
  pages: readonly PageMeta[];
  label: string;
  placeholder: string;
  noMatch: (query: string) => string;
  onCancel: () => void;
  onSelect: (id: PageId) => void;
}

const LIMIT = 200;

export function PagePickerDialog({ pages, label, placeholder, noMatch, onCancel, onSelect }: PagePickerDialogProps) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => inputRef.current?.focus(), []);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    // Pages and boards (never folders, conflict copies or the Trash), in tree order by title.
    const documents = pages.filter((page) => page.kind !== "folder" && typeof page.conflictOf !== "string");
    const matches = needle.length === 0 ? documents : documents.filter((page) => page.title.toLowerCase().includes(needle));
    return [...matches].sort(comparePages).slice(0, LIMIT).map((page) => ({
      page,
      path: pageTrail(pages, page.id).slice(0, -1).map((item) => item.title).join(" / "),
    }));
  }, [pages, query]);
  useActiveOptionVisible(listRef, index, rows.length);
  useEffect(() => setIndex(0), [query]);

  const activeIndex = rows.length === 0 ? -1 : Math.min(index, rows.length - 1);

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
      setIndex((activeIndex + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const row = rows[activeIndex];
      if (row) onSelect(row.page.id);
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
      <div className="quick-switcher move-dialog" role="dialog" aria-modal="true" aria-label={label} data-testid="page-picker" onKeyDown={onKeyDown}>
        <p className="page-picker-heading">{label}</p>
        <div className="quick-switcher-input-row">
          <span className="quick-switcher-input-icon" aria-hidden="true">
            <Icon name="search" size={16} />
          </span>
          <input
            ref={inputRef}
            className="quick-switcher-input"
            data-testid="page-picker-input"
            type="text"
            value={query}
            placeholder={placeholder}
            aria-label={label}
            aria-controls="page-picker-results"
            aria-activedescendant={activeIndex >= 0 ? `page-picker-option-${activeIndex}` : undefined}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="quick-switcher-results" id="page-picker-results" ref={listRef} role="listbox" aria-label={label}>
          {rows.length === 0 ? (
            <p className="quick-switcher-empty">{trimmed ? noMatch(trimmed) : t("empty.noPages")}</p>
          ) : (
            rows.map((row, rowIndex) => {
              const active = rowIndex === activeIndex;
              return (
                <button
                  key={row.page.id}
                  id={`page-picker-option-${rowIndex}`}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={active}
                  className={`quick-switcher-option${active ? " is-active" : ""}`}
                  data-testid={`page-picker-option-${row.page.id}`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    onSelect(row.page.id);
                  }}
                  onMouseMove={() => setIndex(rowIndex)}
                >
                  <span className="quick-switcher-icon" aria-hidden="true">
                    {row.page.icon ? row.page.icon : <Icon name={row.page.kind === "whiteboard" ? "board" : row.page.kind === "base" ? "database" : "file"} size={16} />}
                  </span>
                  <span className="quick-switcher-text">
                    <span className="quick-switcher-title">{row.page.title}</span>
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
