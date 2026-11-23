import type { PageMeta } from "@gumply/core";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { api } from "../api/client.js";
import { useT } from "../i18n/index.js";
import { errorMessage } from "../lib/errors.js";
import { Icon } from "./Icon.js";
import { useActiveOptionVisible, usePointerMovedSinceOpen } from "./use-active-option.js";
import { useModal } from "../lib/modal.js";

export interface TemplatePickerProps {
  /** "new": New page from template…; "insert": `/template` in a page. */
  mode: "new" | "insert";
  onCancel: () => void;
  onPick: (template: PageMeta) => void;
}

/**
 * Pick a page template (v0.7 C, #5hrsrqsj): the pages in the templates folder
 * (Obsidian's Templates plugin setting, default `Templates/`), searchable.
 */
export function TemplatePicker({ mode, onCancel, onPick }: TemplatePickerProps) {
  // Focus in on open, Tab kept inside, focus back to the opener on close (#vefk9dwg).
  const modalRef = useRef<HTMLDivElement | null>(null);
  useModal(modalRef, { ownsTab: true });
  const t = useT();
  const pointerMoved = usePointerMovedSinceOpen();
  const [state, setState] = useState<{ folder: string; templates: PageMeta[] } | { error: string } | null>(null);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    let cancelled = false;
    api
      .listTemplates()
      .then((result) => !cancelled && setState(result))
      .catch((error: unknown) => !cancelled && setState({ error: errorMessage(error) }));
    return () => {
      cancelled = true;
    };
  }, []);

  const templates = state && "templates" in state ? state.templates : [];
  const needle = query.trim().toLowerCase();
  const rows = useMemo(
    () => templates.filter((template) => needle.length === 0 || template.title.toLowerCase().includes(needle)),
    [templates, needle],
  );
  useActiveOptionVisible(listRef, index, rows.length);
  useEffect(() => setIndex(0), [query]);
  const activeIndex = rows.length === 0 ? -1 : Math.min(index, rows.length - 1);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (rows.length === 0) return;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setIndex((activeIndex + delta + rows.length) % rows.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const row = rows[activeIndex];
      if (row) onPick(row);
    } else if (event.key === "Tab") {
      event.preventDefault();
    }
  };

  const title = mode === "new" ? t("templates.newTitle") : t("templates.insertTitle");
  const folder = state && "folder" in state ? state.folder : "Templates";

  return (
    <div
      className="modal-backdrop quick-switcher-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        className="quick-switcher template-picker"
        role="dialog" ref={modalRef}
        aria-modal="true"
        aria-label={title}
        data-testid="template-picker"
        onKeyDown={onKeyDown}
      >
        <p className="template-picker-title">{title}</p>
        <div className="quick-switcher-input-row">
          <span className="quick-switcher-input-icon" aria-hidden="true">
            <Icon name="search" size={16} />
          </span>
          <input
          ref={inputRef}
          className="quick-switcher-input"
          data-testid="template-search"
          type="text"
          value={query}
          placeholder={t("templates.search")}
          aria-label={t("templates.search")}
          aria-controls="template-results"
          aria-activedescendant={activeIndex >= 0 ? `template-option-${activeIndex}` : undefined}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="quick-switcher-results" id="template-results" ref={listRef} role="listbox" aria-label={title}>
          {state === null ? null : "error" in state ? (
            <p className="quick-switcher-empty" role="alert">
              {t("templates.loadFailed")} {state.error}
            </p>
          ) : rows.length === 0 ? (
            <p className="quick-switcher-empty" data-testid="template-empty">
              {templates.length === 0 ? t("templates.empty", { folder }) : t("templates.noMatch", { query: query.trim() })}
            </p>
          ) : (
            rows.map((row, rowIndex) => {
              const active = rowIndex === activeIndex;
              return (
                <button
                  key={row.id}
                  id={`template-option-${rowIndex}`}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={active}
                  className={`quick-switcher-option${active ? " is-active" : ""}`}
                  data-testid={`template-option-${row.id}`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    onPick(row);
                  }}
                  onMouseMove={(event) => {
                    if (pointerMoved(event)) setIndex(rowIndex);
                  }}
                >
                  <span className="quick-switcher-icon" aria-hidden="true">
                    {row.icon ?? <Icon name="pageTemplate" size={16} />}
                  </span>
                  <span className="quick-switcher-text">
                    <span className="quick-switcher-title">{row.title}</span>
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

