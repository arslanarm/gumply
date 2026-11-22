import type { PageId, PageMeta, SearchResult } from "@gumply/core";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { api } from "../api/client.js";
import { isBoard } from "../lib/boards.js";
import { Icon } from "./Icon.js";
import {
  highlightSegments,
  recentRows,
  searchSections,
  type SearchRow,
} from "../lib/search.js";
import { useActiveOptionVisible, usePointerMovedSinceOpen } from "./use-active-option.js";
import { useT } from "../i18n/index.js";

export interface QuickSwitcherProps {
  pages: readonly PageMeta[];
  onOpen: (id: PageId) => void;
  onCreate: (title: string) => void;
  /** `Create whiteboard “X”`; without it the row isn't offered. */
  onCreateBoard?: (title: string) => void;
  /** `Create database view “X”` (D34); without it the row isn't offered. */
  onCreateBase?: (title: string) => void;
  /** `New board from template…`: opens the template gallery (spec/v0-6 §D). */
  onNewFromTemplate?: () => void;
  /** `Language…`: opens Settings (#7h5utv23). */
  onOpenLanguage?: () => void;
  /** v0.7 C: `Open today's note`. */
  onOpenToday?: () => void;
  /** v0.7 C: `New page from template…`. */
  onNewPageFromTemplate?: () => void;
  /** G1: export the open page as HTML (only when a page is open). */
  onExportHtml?: () => void;
  /** B4: Import from Notion…. */
  onImportNotion?: () => void;
  onClose: () => void;
  /** Start with this query (a clicked `#tag`, #ux5cukze). */
  initialQuery?: string;
}

/** Cmd/Ctrl+K quick switcher (D13, spec/ux §10): one 560px overlay. */
export function QuickSwitcher({
  pages,
  onOpen,
  onCreate,
  onCreateBoard,
  onCreateBase,
  onNewFromTemplate,
  onOpenLanguage,
  onOpenToday,
  onNewPageFromTemplate,
  onExportHtml,
  onImportNotion,
  onClose,
  initialQuery = "",
}: QuickSwitcherProps) {
  const t = useT();
  const pointerMoved = usePointerMovedSinceOpen();
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [settled, setSettled] = useState("");
  const [index, setIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const needle = query.trim();
  const searching = needle.length > 0 && settled !== needle;

  // 150ms debounce; the token makes late responses from older queries no-ops.
  useEffect(() => {
    const token = requestRef.current + 1;
    requestRef.current = token;

    if (needle.length === 0) {
      setResults([]);
      setSettled("");
      return;
    }

    const timer = window.setTimeout(() => {
      api
        .search(needle)
        .then((items) => {
          if (requestRef.current !== token) return;
          setResults(items);
          setSettled(needle);
        })
        .catch(() => {
          if (requestRef.current !== token) return;
          setResults([]);
          setSettled(needle);
        });
    }, 150);

    return () => window.clearTimeout(timer);
  }, [needle]);

  const recents = useMemo(() => recentRows(pages), [pages]);
  // Never show rows from a previous query: until this query settles, only the
  // create row (built from the local page list) is selectable.
  const visibleResults = settled === needle ? results : [];
  const sections = useMemo(
    () =>
      needle.length > 0
        ? searchSections(visibleResults, pages, query)
        : { pages: [], text: [], create: null, createBoard: null, fromTemplate: null, language: null, today: null, pageTemplate: null },
    [visibleResults, pages, query, needle],
  );

  // Commands the query asks for, after the results (each only when wired).
  const commandRows = [
    onNewPageFromTemplate ? sections.pageTemplate : null,
    onNewFromTemplate ? sections.fromTemplate : null,
    onOpenToday ? sections.today : null,
    onExportHtml ? (sections.exportHtml ?? null) : null,
    onImportNotion ? (sections.importNotion ?? null) : null,
    onOpenLanguage ? sections.language : null,
  ].filter((row): row is SearchRow => row !== null);
  // Typing an action's name ranks it above "Create “…”" (#5hrsrqsj review).
  const createRows = [
    ...(sections.create ? [sections.create] : []),
    ...(sections.createBoard && onCreateBoard ? [sections.createBoard] : []),
    ...(sections.createBase && onCreateBase ? [sections.createBase] : []),
  ];
  const tailRows = [...commandRows, ...createRows];
  const rows: SearchRow[] = needle.length > 0 ? [...sections.pages, ...sections.text, ...tailRows] : recents;

  useActiveOptionVisible(listRef, index, rows.length);

  useEffect(() => {
    setIndex(0);
  }, [query]);

  useEffect(() => {
    setIndex((current) => (rows.length === 0 ? 0 : Math.min(current, rows.length - 1)));
  }, [rows.length]);

  const activeIndex = rows.length === 0 ? -1 : Math.min(index, rows.length - 1);

  const select = (row: SearchRow | undefined) => {
    if (!row) return;
    if (row.kind === "create") {
      if (row.title) onCreate(row.title);
      return;
    }
    if (row.kind === "language") {
      onOpenLanguage?.();
      return;
    }
    if (row.kind === "from-template") {
      onNewFromTemplate?.();
      return;
    }
    if (row.kind === "today") {
      onOpenToday?.();
      return;
    }
    if (row.kind === "page-template") {
      onNewPageFromTemplate?.();
      return;
    }
    if (row.kind === "export-html") {
      onExportHtml?.();
      return;
    }
    if (row.kind === "import-notion") {
      onImportNotion?.();
      return;
    }
    if (row.kind === "create-board") {
      if (row.title) onCreateBoard?.(row.title);
      return;
    }
    if (row.kind === "create-base") {
      if (row.title) onCreateBase?.(row.title);
      return;
    }
    if (row.page) onOpen(row.page.id);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    // The input is the only tab stop; keep focus in the palette (spec/ux §5).
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

  const renderRow = (row: SearchRow, rowIndex: number) => {
    const active = rowIndex === activeIndex;
    return (
      <button
        key={row.key}
        id={`quick-switcher-option-${rowIndex}`}
        type="button"
        role="option"
        tabIndex={-1}
        aria-selected={active}
        className={`quick-switcher-option${active ? " is-active" : ""}`}
        data-testid={
          row.page
            ? `search-result-${row.page.id}`
            : row.kind === "create-board"
              ? "search-create-board"
              : row.kind === "create-base"
                ? "search-create-base"
                : row.kind === "from-template"
                ? "search-from-template"
                : row.kind === "language"
                  ? "search-language"
                  : row.kind === "today"
                    ? "search-today"
                    : row.kind === "page-template"
                      ? "search-page-template"
                      : row.kind === "export-html"
                        ? "search-export-html"
                        : row.kind === "import-notion"
                          ? "search-import-notion"
                          : "search-create"
        }
        // Keep the caret in the input so typing continues after a mouse pick.
        onMouseDown={(event) => {
          event.preventDefault();
          select(row);
        }}
        onMouseMove={(event) => {
          if (pointerMoved(event) && rowIndex !== activeIndex) setIndex(rowIndex);
        }}
      >
        <span className="quick-switcher-icon" aria-hidden="true">
          {row.kind === "create" ? (
            <Icon name="plus" size={16} />
          ) : row.kind === "language" ? (
            <Icon name="languages" size={16} />
          ) : row.kind === "today" ? (
            <Icon name="calendar" size={16} />
          ) : row.kind === "page-template" ? (
            <Icon name="pageTemplate" size={16} />
          ) : row.kind === "export-html" ? (
            <Icon name="download" size={16} />
          ) : row.kind === "import-notion" ? (
            <Icon name="folderOpen" size={16} />
          ) : row.kind === "create-board" || row.kind === "from-template" ? (
            <Icon name="board" size={16} />
          ) : row.kind === "create-base" ? (
            <Icon name="database" size={16} />
          ) : row.page?.icon ? (
            row.page.icon
          ) : (
            <Icon name={isBoard(row.page) ? "board" : row.page?.kind === "base" ? "database" : "file"} size={16} />
          )}
        </span>
        <span className="quick-switcher-text">
          <span className="quick-switcher-title">{row.label}</span>
          {row.path ? <span className="quick-switcher-path">{row.path}</span> : null}
          {row.snippet ? (
            <span className="quick-switcher-snippet">
              {highlightSegments(row.snippet, needle).map((part, partIndex) =>
                part.highlight ? (
                  <mark key={partIndex}>{part.text}</mark>
                ) : (
                  <span key={partIndex}>{part.text}</span>
                ),
              )}
            </span>
          ) : null}
        </span>
      </button>
    );
  };

  return (
    <div
      className="modal-backdrop quick-switcher-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="quick-switcher"
        role="dialog"
        aria-modal="true"
        aria-label={t("search.label")}
        data-testid="quick-switcher"
        onKeyDown={onKeyDown}
      >
        <div className="quick-switcher-input-row">
          <span className="quick-switcher-input-icon" aria-hidden="true">
            <Icon name="search" size={16} />
          </span>
          <input
            ref={inputRef}
            className="quick-switcher-input"
            data-testid="quick-switcher-input"
            type="text"
            value={query}
            placeholder={t("search.placeholder")}
            aria-label={t("search.label")}
            aria-controls="quick-switcher-results"
            aria-activedescendant={
              activeIndex >= 0 ? `quick-switcher-option-${activeIndex}` : undefined
            }
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        <div
          className="quick-switcher-results"
          id="quick-switcher-results"
          ref={listRef}
          role="listbox"
          aria-label={t("search.results")}
        >
          {needle.length === 0 ? (
            pages.length === 0 ? (
              <p className="quick-switcher-empty" data-testid="search-empty">
                {t("empty.noPages")}
              </p>
            ) : (
              <>
                <p className="quick-switcher-heading">{t("search.recent")}</p>
                {recents.map((row, rowIndex) => renderRow(row, rowIndex))}
              </>
            )
          ) : (
            <>
              {sections.pages.length > 0 ? (
                <>
                  <p className="quick-switcher-heading">{t("search.pages")}</p>
                  {sections.pages.map((row, rowIndex) => renderRow(row, rowIndex))}
                </>
              ) : null}
              {sections.text.length > 0 ? (
                <>
                  <p className="quick-switcher-heading">{t("search.text")}</p>
                  {sections.text.map((row, rowIndex) =>
                    renderRow(row, sections.pages.length + rowIndex),
                  )}
                </>
              ) : null}
              {!searching && sections.pages.length === 0 && sections.text.length === 0 && commandRows.length === 0 ? (
                <p className="quick-switcher-empty" data-testid="search-empty">
                  {pages.length === 0 ? t("empty.noPages") : t("search.noMatch", { query: needle })}
                </p>
              ) : null}
              {searching ? <p className="quick-switcher-empty">{t("search.searching")}</p> : null}
              {tailRows.map((row, tailIndex) => renderRow(row, sections.pages.length + sections.text.length + tailIndex))}
            </>
          )}
        </div>

        <div className="quick-switcher-footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> {t("search.navigate")}
          </span>
          <span>
            <kbd>Enter</kbd> {t("search.open")}
          </span>
          <span>
            <kbd>Esc</kbd> {t("search.close")}
          </span>
        </div>
      </div>
    </div>
  );
}
