import type { PageId, PageMeta, SearchResult } from "@gumply/core";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
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
import { useModal } from "../lib/modal.js";
import { commandQuery, groupLabel, matchCommands, plainCommandMatches, type Command } from "../lib/commands.js";

/** Results the switcher asks for (the server's maximum, spec/api v1.31). */
const SWITCHER_SEARCH_LIMIT = 200;

export interface QuickSwitcherProps {
  pages: readonly PageMeta[];
  onOpen: (id: PageId) => void;
  onCreate: (title: string) => void;
  /** `Create whiteboard “X”`; without it the row isn't offered. */
  onCreateBoard?: (title: string) => void;
  /** `Create database view “X”` (D34); without it the row isn't offered. */
  onCreateBase?: (title: string) => void;
  /**
   * v0.9 H (#snuin2ja): the commands that apply where Cmd+K was opened, from
   * the registry (lib/commands.ts). `>` lists only them; plain typing shows
   * the best few after the pages.
   */
  commands?: readonly Command[];
  /** The open page, for the "This page · X" heading. */
  commandPage?: PageMeta | null;
  onCommand?: (id: string) => void;
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
  commands = [],
  commandPage = null,
  onCommand,
  onClose,
  initialQuery = "",
}: QuickSwitcherProps) {
  // Focus in on open, Tab kept inside, focus back to the opener on close (#vefk9dwg).
  const modalRef = useRef<HTMLDivElement | null>(null);
  useModal(modalRef, { ownsTab: true });
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

  // `>` first: commands only (#snuin2ja); the page search waits.
  const commandText = commandQuery(query);
  const commandMode = commandText !== null;
  const needle = commandMode ? "" : query.trim();
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
        // #g95wkd9y: the most the server returns. Title matches rank first, so a
        // common word ("meeting") needs room past them for the Text section.
        .search(needle, SWITCHER_SEARCH_LIMIT)
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

  const toCommandRow = (command: Command): SearchRow => ({ kind: "command", key: `command-${command.id}`, label: command.label, command });
  // Commands mode: every command that applies, grouped (or the matches, best first).
  const commandModeRows = useMemo(
    () => (commandText === null ? [] : matchCommands(commands, commandText).map(toCommandRow)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [commands, commandText],
  );
  // Plain typing: the best few commands after the pages and text.
  const commandRows = commandMode ? [] : plainCommandMatches(commands, needle).map(toCommandRow);
  // Typing an action's name ranks it above "Create “…”" (#5hrsrqsj review).
  const createRows = [
    ...(sections.create ? [sections.create] : []),
    ...(sections.createBoard && onCreateBoard ? [sections.createBoard] : []),
    ...(sections.createBase && onCreateBase ? [sections.createBase] : []),
  ];
  const tailRows = [...commandRows, ...createRows];
  const rows: SearchRow[] = commandMode ? commandModeRows : needle.length > 0 ? [...sections.pages, ...sections.text, ...tailRows] : recents;

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
    if (row.kind === "command") {
      if (row.command) onCommand?.(row.command.id);
      return;
    }
    if (row.kind === "create") {
      if (row.title) onCreate(row.title);
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
          row.command
            ? row.command.testId
            : row.page
              ? `search-result-${row.page.id}`
              : row.kind === "create-board"
                ? "search-create-board"
                : row.kind === "create-base"
                  ? "search-create-base"
                  : "search-create"
        }
        aria-keyshortcuts={row.command?.keys ? row.command.keys.join("+") : undefined}
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
          {row.command ? (
            <Icon name={row.command.icon} size={16} />
          ) : row.kind === "create" ? (
            <Icon name="plus" size={16} />
          ) : row.kind === "create-board" ? (
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
          <span className="quick-switcher-title">
            {row.label}
            {typeof row.page?.conflictOf === "string" ? (
              <span className="quick-switcher-conflict" data-testid="search-conflict-label">
                {t("conflicts.searchLabel")}
              </span>
            ) : null}
          </span>
          {row.path ? <span className="quick-switcher-path">{row.path}</span> : null}
          {/* Plain typing: say what a page or board command acts on. */}
          {row.command && !commandMode && (row.command.group === "page" || row.command.group === "board") ? (
            <span className="quick-switcher-path">{groupLabel(row.command.group, null)}</span>
          ) : null}
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
        {row.command?.keys ? (
          <span className="quick-switcher-keys" aria-hidden="true">
            {row.command.keys.map((key, keyIndex) => (
              <kbd key={keyIndex}>{key}</kbd>
            ))}
          </span>
        ) : null}
      </button>
    );
  };

  // Commands mode without a query: every command under its group's heading.
  const groupedCommands = () => {
    const out: ReactNode[] = [];
    let previous: string | null = null;
    commandModeRows.forEach((row, rowIndex) => {
      const group = row.command!.group;
      if (group !== previous) {
        out.push(
          <p key={`heading-${group}`} className="quick-switcher-heading" data-testid={`command-group-${group}`}>
            {groupLabel(group, commandPage)}
          </p>,
        );
        previous = group;
      }
      out.push(renderRow(row, rowIndex));
    });
    return out;
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
        role="dialog" ref={modalRef}
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
            placeholder={commandMode ? t("commands.commandsPlaceholder") : t("commands.placeholder")}
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
          {commandMode ? (
            commandModeRows.length === 0 ? (
              <p className="quick-switcher-empty" data-testid="search-empty">
                {t("commands.noMatch", { query: commandText ?? "" })}
              </p>
            ) : commandText ? (
              <>
                <p className="quick-switcher-heading">{t("commands.section")}</p>
                {commandModeRows.map((row, rowIndex) => renderRow(row, rowIndex))}
              </>
            ) : (
              groupedCommands()
            )
          ) : needle.length === 0 ? (
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
              {commandRows.length > 0 ? (
                <p className="quick-switcher-heading" data-testid="search-commands-heading">
                  {t("commands.section")}
                </p>
              ) : null}
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
            <kbd>Enter</kbd> {commandMode ? t("search.run") : t("search.open")}
          </span>
          <span>
            <kbd>Esc</kbd> {t("search.close")}
          </span>
        </div>
      </div>
    </div>
  );
}
