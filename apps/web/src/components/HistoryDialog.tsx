import { Fragment, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { parseCanvas, parseFrontmatter, type BoardDocument, type CanvasBoard, type Page, type PageMeta } from "@gumply/core";
import { LazyBoardPreview, type BoardPageOption } from "../board/index.js";
import { boardCardLabel, boardDiffView, type BoardDiffMark } from "../lib/board-diff.js";
import { vaultPathOf } from "../lib/boards.js";
import { api, ApiRequestError, type HistoryDiff, type HistoryItem, type HistoryList } from "../api/client.js";
import { dateFormat, relativeTime, useT } from "../i18n/index.js";
import { errorMessage } from "../lib/errors.js";
import { flushAllSaves, hasUnsavedChanges } from "../lib/pending-saves.js";
import { Editor } from "./Editor.js";
import { Icon } from "./Icon.js";
import { LineDiffView } from "./LineDiffView.js";
import { hideManagedKeyChanges } from "../lib/history-diff.js";
import { useModal } from "../lib/modal.js";

/**
 * D41 / spec/version-history §6.2: a page's or board's versions beside a
 * read-only preview of the selected one, with its changes against now,
 * Restore (byte-exact, never renames, undoable), Copy text and Keep.
 */
export interface HistoryDialogProps {
  target: PageMeta;
  pages: readonly PageMeta[];
  onClose: () => void;
  /** A restore wrote the file: the open page reloads from the result. */
  onRestored: (result: Page | BoardDocument) => void;
}

/** `null` = the current version. */
type Selection = string | null;

const noop = () => undefined;
const DAY = 86_400_000;

/** "12 min ago" under a day, else the date and time in the app's language. */
export function versionTime(iso: string, now = Date.now()): string {
  const time = Date.parse(iso);
  if (!Number.isNaN(time) && now - time < DAY) return relativeTime(iso, now);
  return dateFormat({ dateStyle: "medium", timeStyle: "short" }).format(time);
}

function useHistorySourceLabel() {
  const t = useT();
  return (item: HistoryItem): string => {
    if (item.source === "mcp") return item.client ? t("history.source.mcp", { client: item.client }) : t("history.source.mcpUnnamed");
    return t(`history.source.${item.source}` as const);
  };
}

export function HistoryDialog({ target, pages, onClose, onRestored }: HistoryDialogProps) {
  // Focus in on open, Tab kept inside, focus back to the opener on close (#vefk9dwg).
  const modalRef = useRef<HTMLDivElement | null>(null);
  useModal(modalRef);
  const t = useT();
  const id = useId();
  const sourceLabel = useHistorySourceLabel();
  const board = target.kind === "whiteboard";
  const [list, setList] = useState<HistoryList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Selection>(null);
  // #n6skhe6p: each loaded text and diff remembers which version it's for, so the render right
  // after a click never shows the previous version's content under the new row.
  const [loadedText, setLoadedText] = useState<{ for: Selection; value: string } | null>(null);
  const text = loadedText && loadedText.for === selected ? loadedText.value : null;
  const [loadedDiff, setLoadedDiff] = useState<{ for: Selection; value: HistoryDiff } | null>(null);
  const diff = loadedDiff && loadedDiff.for === selected ? loadedDiff.value : null;
  const [view, setView] = useState<"preview" | "changes">("preview");
  const [whole, setWhole] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: "info" | "error"; message: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const listRef = useRef<HTMLUListElement | null>(null);
  /** Boards: the board as it is now (Changes draws the version's removed cards onto it). */
  const [currentBoard, setCurrentBoard] = useState<CanvasBoard | null>(null);
  const boardPages = useMemo<BoardPageOption[]>(
    () =>
      pages.map((item) => ({
        path: vaultPathOf(item),
        title: item.title,
        updated: item.updated,
        ...(item.icon ? { icon: item.icon } : {}),
      })),
    [pages],
  );

  const load = useCallback(async () => {
    try {
      const next = await api.history(target.id);
      setList(next);
      setLoadError(null);
      return next;
    } catch (error) {
      setLoadError(errorMessage(error));
      return null;
    }
  }, [target.id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    listRef.current?.focus();
  }, [list !== null]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  // The selected version's text, and its changes against now.
  useEffect(() => {
    let cancelled = false;
    const version = selected;
    const textRequest =
      selected === null
        ? board
          ? api.getBoard(target.id).then((doc) => JSON.stringify(doc.board))
          : api.getPage(target.id).then((page) => page.content)
        : api.historyText(target.id, selected);
    textRequest
      .then((value) => !cancelled && setLoadedText({ for: version, value }))
      .catch(() => !cancelled && setLoadedText({ for: version, value: "" }));
    if (selected !== null) api.historyDiff(target.id, selected).then((value) => !cancelled && setLoadedDiff({ for: version, value })).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [selected, target.id, board, list]);

  useEffect(() => {
    if (!board) return;
    let cancelled = false;
    api
      .getBoard(target.id)
      .then((doc) => !cancelled && setCurrentBoard(doc.board))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [board, target.id, list]);

  /** The selected version as a board (null while loading, or for a page). */
  const versionBoard = useMemo<CanvasBoard | null>(() => {
    if (!board || text === null) return null;
    try {
      return parseCanvas(text);
    } catch {
      return null;
    }
  }, [board, text]);

  const items = list?.items ?? [];
  const item = selected === null ? null : (items.find((entry) => entry.file === selected) ?? null);
  const sameAsCurrent = item !== null && list !== null && item.sha256 === list.current.sha256;
  const timeOf = (file: string | undefined) => {
    const found = file ? items.find((entry) => entry.file === file) : undefined;
    return found ? versionTime(found.at) : "";
  };

  const rows: Selection[] = useMemo(() => [null, ...items.map((entry) => entry.file)], [items]);
  // A file that appeared outside Gumply where an earlier page of that name had history:
  // the versions before that belong to the earlier page (divider above the first of them).
  const recreatedAt = (list?.moves ?? []).filter((move) => move.event === "recreated").reduce<string | null>((latest, move) => (latest === null || move.at > latest ? move.at : latest), null);
  const firstEarlier = recreatedAt === null ? null : (items.find((entry) => entry.at < recreatedAt)?.file ?? null);
  const activeIndex = Math.max(0, rows.indexOf(selected));

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLUListElement>) => {
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setSelected(rows[event.key === "Home" ? 0 : rows.length - 1] ?? null);
      return;
    }
    if (step === 0) return;
    event.preventDefault();
    const next = Math.min(rows.length - 1, Math.max(0, activeIndex + step));
    setSelected(rows[next] ?? null);
  };

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  const restore = async () => {
    if (!item || busy) return;
    setBusy(true);
    setStatus(null);
    try {
      let version = list?.current.version ?? "";
      // Unsaved edits in the open editor go out first; they're ours, so the restore follows them.
      if (hasUnsavedChanges()) {
        await flushAllSaves();
        version = (await load())?.current.version ?? version;
      }
      const result = await api.restoreVersion(target.id, item.file, version);
      onRestored(result);
      await load();
      setSelected(null);
      setStatus({ kind: "info", message: t("history.restored", { time: versionTime(item.at) }) });
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 409) {
        setStatus({ kind: "error", message: t("history.changedOnDisk") });
        await load();
      } else {
        setStatus({ kind: "error", message: t("history.restoreFailed", { error: errorMessage(error) }) });
      }
    } finally {
      setBusy(false);
    }
  };

  const togglePin = async () => {
    if (!item) return;
    try {
      const next = await api.pinVersion(target.id, item.file, !item.pinned);
      setList((current) =>
        current ? { ...current, items: current.items.map((entry) => (entry.file === next.file ? { ...entry, pinned: next.pinned } : entry)) } : current,
      );
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  };

  const copy = async () => {
    if (text === null) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  };

  const secondary = (entry: HistoryItem): string | null => {
    if (entry.restoredFrom) return t("history.reason.restoredFrom", { time: timeOf(entry.restoredFrom) || entry.restoredFrom });
    if (entry.title !== undefined) return t("history.renamedFrom", { title: entry.title });
    if (entry.folder !== undefined) return t("history.movedFrom", { folder: entry.folder === "" ? t("history.topLevel") : entry.folder });
    if (entry.reason === "session" || entry.reason === "trash" || entry.reason === "conflict") return t(`history.reason.${entry.reason}` as const);
    return null;
  };

  const preview = () => {
    if (text === null) return <p className="history-muted">{t("history.loading")}</p>;
    if (board) {
      if (!versionBoard) return <p className="history-muted">{t("history.loading")}</p>;
      return (
        <div className="history-board-wrap">
          <div className="history-board" data-testid="history-board-preview" aria-label={t("history.boardObjects", { count: versionBoard.nodes.length })} role="img">
            <Suspense fallback={null}>
              <LazyBoardPreview key={selected ?? "current"} board={versionBoard} pages={boardPages} interactive />
            </Suspense>
          </div>
          <p className="history-board-caption">{t("history.boardObjects", { count: versionBoard.nodes.length })}</p>
        </div>
      );
    }
    const content = selected === null ? text : parseFrontmatter(text).content;
    const page: Page = { ...target, content };
    return (
      <div className="history-page">
        <Editor key={`${target.id}:${selected ?? "current"}`} page={page} pages={pages} readOnly onSaveState={noop} onOpenLink={noop} onCreateLink={noop} />
      </div>
    );
  };

  const changes = () => {
    if (!diff) return <p className="history-muted">{t("history.loading")}</p>;
    if (diff.kind === "whiteboard") {
      if (diff.added.length + diff.removed.length + diff.changed.length === 0) return <p className="history-muted">{t("history.noChanges")}</p>;
      if (!versionBoard || !currentBoard) return <p className="history-muted">{t("history.loading")}</p>;
      return <BoardChanges version={versionBoard} current={currentBoard} diff={diff} pages={boardPages} />;
    }
    // #h4tyk92t: Gumply's own `updated:`/`created:` changes are hidden unless the whole file is shown.
    const lines = whole ? diff.lines : hideManagedKeyChanges(diff.lines);
    if (!lines.some((line) => line.op !== "same")) return <p className="history-muted">{t("history.noChanges")}</p>;
    // The diff runs from this version to now: "add" is what now has and this version lacks.
    return (
      <>
        <LineDiffView lines={lines} whole={whole} testId="history-diff" />
      </>
    );
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div className="modal history-dialog" role="dialog" ref={modalRef} aria-modal="true" aria-labelledby={`${id}-title`} data-testid="history-dialog">
        <header className="history-header">
          <h2 id={`${id}-title`}>
            {t("history.title")} <span className="history-page-title">{target.title}</span>
          </h2>
          <button type="button" className="icon-button" aria-label={t("history.close")} data-testid="history-close" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </header>
        <div className="history-body">
          <ul
            ref={listRef}
            className="history-list"
            role="listbox"
            tabIndex={0}
            aria-label={t("history.list")}
            aria-activedescendant={`${id}-row-${activeIndex}`}
            data-testid="history-list"
            onKeyDown={onListKeyDown}
          >
            {rows.map((file, index) => {
              const entry = file === null ? null : items.find((candidate) => candidate.file === file);
              const note = entry ? secondary(entry) : null;
              const row = (
                <li
                  key={file ?? "current"}
                  id={`${id}-row-${index}`}
                  data-index={index}
                  role="option"
                  aria-selected={selected === file}
                  className={`history-row${selected === file ? " is-selected" : ""}`}
                  data-testid={file === null ? "history-current" : "history-item"}
                  data-source={entry?.source}
                  onClick={() => setSelected(file)}
                >
                  {entry ? (
                    <>
                      <span className="history-row-time">
                        {versionTime(entry.at)}
                        {entry.pinned ? (
                          <span className="history-row-pin" title={t("history.kept")} aria-label={t("history.kept")}>
                            <Icon name="pin" size={12} />
                          </span>
                        ) : null}
                      </span>
                      <span className="history-row-source">{sourceLabel(entry)}</span>
                      {note ? <span className="history-row-note">{note}</span> : null}
                    </>
                  ) : (
                    <span className="history-row-time">{t("history.current")}</span>
                  )}
                </li>
              );
              return file !== null && file === firstEarlier ? (
                <Fragment key={file}>
                  <li role="presentation" className="history-divider" data-testid="history-earlier-page">
                    {t("history.earlierPage")}
                  </li>
                  {row}
                </Fragment>
              ) : (
                row
              );
            })}
          </ul>
          <section className="history-preview" aria-label={t("history.previewLabel")} data-testid="history-preview">
            {loadError ? (
              <p className="history-error" role="alert">
                {t("history.failed", { error: loadError })}
              </p>
            ) : list !== null && items.length === 0 ? (
              <div className="empty-state history-empty" data-testid="history-empty">
                <span className="empty-state-icon" aria-hidden="true">
                  <Icon name="clock" size={26} />
                </span>
                <p>{t("history.empty")}</p>
                <p className="history-empty-note">{t("history.emptyViewed")}</p>
              </div>
            ) : (
              <>
                {item ? (
                  <div className="history-toolbar">
                    <div className="history-tabs">
                      <button type="button" aria-pressed={view === "preview"} data-testid="history-view-preview" onClick={() => setView("preview")}>
                        {t("history.preview")}
                      </button>
                      <button type="button" aria-pressed={view === "changes"} data-testid="history-view-changes" onClick={() => setView("changes")}>
                        {t("history.changes")}
                      </button>
                    </div>
                    {view === "changes" && diff?.kind === "page" && diff.lines.some((line) => line.op !== "same") ? (
                      <button type="button" className="history-quiet" aria-pressed={whole} data-testid="history-whole-file" onClick={() => setWhole((value) => !value)}>
                        {whole ? t("history.changesOnly") : t("history.wholeFile")}
                      </button>
                    ) : null}
                    <span className="history-toolbar-gap" />
                    <div className="history-actions">
                      <button type="button" className="button-secondary" data-testid="history-copy" onClick={() => void copy()} disabled={text === null}>
                        {copied ? t("history.copied") : t("history.copy")}
                      </button>
                      <button
                        type="button"
                        className="button-secondary history-keep"
                        aria-pressed={item.pinned}
                        title={item.pinned ? t("history.keptHint") : undefined}
                        data-testid="history-keep"
                        onClick={() => void togglePin()}
                      >
                        <Icon name={item.pinned ? "circleCheck" : "pin"} size={14} />
                        <span>{item.pinned ? t("history.kept") : t("history.keep")}</span>
                      </button>
                      <button
                        type="button"
                        className="button-primary"
                        data-testid="history-restore"
                        disabled={busy || sameAsCurrent}
                        onClick={() => void restore()}
                      >
                        {t("history.restore")}
                      </button>
                    </div>
                  </div>
                ) : null}
                {status ? (
                  <p className={status.kind === "error" ? "history-error" : "history-status"} role={status.kind === "error" ? "alert" : "status"} data-testid="history-status">
                    {status.message}
                  </p>
                ) : null}
                {item?.title !== undefined ? (
                  <p className="history-note" data-testid="history-other-title">
                    {t("history.otherTitle", { title: item.title })}
                  </p>
                ) : null}
                {sameAsCurrent ? <p className="history-note">{t("history.sameAsCurrent")}</p> : null}
                <div className="history-content">{item && view === "changes" ? changes() : preview()}</div>
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}


const MARK_SYMBOL: Record<BoardDiffMark, string> = { added: "+", removed: "−", changed: "~" };

/**
 * A board's Changes (#fr5baurg): the board as it is now, with the cards added
 * since this version outlined green, the ones it had and now lacks ghosted
 * red, and changed ones amber. The legend pairs each colour with a symbol and
 * a word; the list below names every card that changed.
 */
export function BoardChanges({ version, current, diff, pages, labels, testId = "history-board-changes" }: {
  version: CanvasBoard;
  current: CanvasBoard;
  diff: { added: string[]; removed: string[]; changed: string[] };
  pages: BoardPageOption[];
  /** #h4tyk92t: Compare words the legend and the list for a copy, not a version. */
  labels?: { legend: Record<BoardDiffMark, string>; list: string };
  testId?: string;
}) {
  const t = useT();
  const view = useMemo(() => boardDiffView(version, current, diff), [version, current, diff]);
  const nodeById = useMemo(() => new Map(view.board.nodes.map((node) => [node.id, node])), [view]);
  const legend: Array<[BoardDiffMark, string]> = [
    ["added", labels?.legend.added ?? t("history.boardAdded", { count: diff.added.length })],
    ["removed", labels?.legend.removed ?? t("history.boardRemoved", { count: diff.removed.length })],
    ["changed", labels?.legend.changed ?? t("history.boardChanged", { count: diff.changed.length })],
  ];
  const word: Record<BoardDiffMark, string> = { added: t("history.added"), removed: t("history.removed"), changed: t("history.changed") };
  const rows = [...view.marks].sort((a, b) => ["added", "removed", "changed"].indexOf(a[1]) - ["added", "removed", "changed"].indexOf(b[1]));
  return (
    <div className="history-board-wrap" data-testid={testId}>
      <ul className="history-board-legend">
        {legend.map(([mark, label]) => (
          <li key={mark} className={`history-board-legend-${mark}`} data-mark={mark}>
            <span className="history-board-swatch" aria-hidden="true">
              {MARK_SYMBOL[mark]}
            </span>
            {label}
          </li>
        ))}
      </ul>
      <div className="history-board" aria-hidden="true">
        <Suspense fallback={null}>
          <LazyBoardPreview board={view.board} pages={pages} interactive highlight={view.marks} />
        </Suspense>
      </div>
      <h3 className="history-board-list-title">{labels?.list ?? t("history.boardChangesList")}</h3>
      <ul className="history-board-list" data-testid="history-board-list">
        {rows.map(([id, mark]) => (
          <li key={id} data-mark={mark}>
            <span className="history-board-swatch" aria-hidden="true">
              {MARK_SYMBOL[mark]}
            </span>
            <span className="visually-hidden">{word[mark]}: </span>
            {boardCardLabel(nodeById.get(id)) ?? t("history.boardCardUntitled")}
          </li>
        ))}
      </ul>
    </div>
  );
}
