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

export interface QuickSwitcherProps {
  pages: readonly PageMeta[];
  onOpen: (id: PageId) => void;
  onCreate: (title: string) => void;
  /** `Create whiteboard “X”`; without it the row isn't offered. */
  onCreateBoard?: (title: string) => void;
  /** `New board from template…`: opens the template gallery (spec/v0-6 §D). */
  onNewFromTemplate?: () => void;
  onClose: () => void;
  /** Start with this query (a clicked `#tag`, #ux5cukze). */
  initialQuery?: string;
}

/** Cmd/Ctrl+K quick switcher (D13, spec/ux §10): one 560px overlay. */
export function QuickSwitcher({ pages, onOpen, onCreate, onCreateBoard, onNewFromTemplate, onClose, initialQuery = "" }: QuickSwitcherProps) {
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
        : { pages: [], text: [], create: null, createBoard: null, fromTemplate: null },
    [visibleResults, pages, query, needle],
  );

  const fromTemplate = onNewFromTemplate ? sections.fromTemplate : null;
  const rows: SearchRow[] =
    needle.length > 0
      ? [
          ...sections.pages,
          ...sections.text,
          ...(sections.create ? [sections.create] : []),
          ...(sections.createBoard && onCreateBoard ? [sections.createBoard] : []),
          ...(fromTemplate ? [fromTemplate] : []),
        ]
      : recents;

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
    if (row.kind === "from-template") {
      onNewFromTemplate?.();
      return;
    }
    if (row.kind === "create-board") {
      if (row.title) onCreateBoard?.(row.title);
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
              : row.kind === "from-template"
                ? "search-from-template"
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
          ) : row.kind === "create-board" || row.kind === "from-template" ? (
            <Icon name="board" size={16} />
          ) : row.page?.icon ? (
            row.page.icon
          ) : (
            <Icon name={isBoard(row.page) ? "board" : "file"} size={16} />
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
        aria-label="Search pages"
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
            placeholder="Search pages…"
            aria-label="Search pages"
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
          aria-label="Search results"
        >
          {needle.length === 0 ? (
            pages.length === 0 ? (
              <p className="quick-switcher-empty" data-testid="search-empty">
                No pages yet.
              </p>
            ) : (
              <>
                <p className="quick-switcher-heading">Recent</p>
                {recents.map((row, rowIndex) => renderRow(row, rowIndex))}
              </>
            )
          ) : (
            <>
              {sections.pages.length > 0 ? (
                <>
                  <p className="quick-switcher-heading">Pages</p>
                  {sections.pages.map((row, rowIndex) => renderRow(row, rowIndex))}
                </>
              ) : null}
              {sections.text.length > 0 ? (
                <>
                  <p className="quick-switcher-heading">Text</p>
                  {sections.text.map((row, rowIndex) =>
                    renderRow(row, sections.pages.length + rowIndex),
                  )}
                </>
              ) : null}
              {!searching && sections.pages.length === 0 && sections.text.length === 0 && !fromTemplate ? (
                <p className="quick-switcher-empty" data-testid="search-empty">
                  {pages.length === 0 ? "No pages yet." : `No pages match “${needle}”`}
                </p>
              ) : null}
              {searching ? <p className="quick-switcher-empty">Searching…</p> : null}
              {sections.create
                ? renderRow(sections.create, sections.pages.length + sections.text.length)
                : null}
              {sections.createBoard && onCreateBoard
                ? renderRow(
                    sections.createBoard,
                    sections.pages.length + sections.text.length + (sections.create ? 1 : 0),
                  )
                : null}
              {fromTemplate ? renderRow(fromTemplate, rows.length - 1) : null}
            </>
          )}
        </div>

        <div className="quick-switcher-footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>Enter</kbd> open
          </span>
          <span>
            <kbd>Esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
