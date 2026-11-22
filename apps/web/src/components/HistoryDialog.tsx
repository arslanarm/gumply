import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { parseFrontmatter, type BoardDocument, type Page, type PageMeta } from "@gumply/core";
import { api, ApiRequestError, type HistoryDiff, type HistoryItem, type HistoryList } from "../api/client.js";
import { dateFormat, relativeTime, useT } from "../i18n/index.js";
import { errorMessage } from "../lib/errors.js";
import { flushAllSaves, hasUnsavedChanges } from "../lib/pending-saves.js";
import { Editor } from "./Editor.js";
import { Icon } from "./Icon.js";

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

/** The diff lines to show: all of them, or the changes with two lines of context. */
function visibleLines(lines: Array<{ op: "same" | "add" | "remove"; text: string }>, whole: boolean) {
  if (whole) return lines.map((line) => ({ ...line, gap: false }));
  const keep = new Set<number>();
  lines.forEach((line, index) => {
    if (line.op === "same") return;
    for (let near = index - 2; near <= index + 2; near += 1) if (near >= 0 && near < lines.length) keep.add(near);
  });
  const out: Array<{ op: "same" | "add" | "remove"; text: string; gap: boolean }> = [];
  let previous = -1;
  for (const index of [...keep].sort((a, b) => a - b)) {
    if (previous >= 0 && index > previous + 1) out.push({ op: "same", text: "", gap: true });
    out.push({ ...lines[index]!, gap: false });
    previous = index;
  }
  return out;
}

export function HistoryDialog({ target, pages, onClose, onRestored }: HistoryDialogProps) {
  const t = useT();
  const id = useId();
  const sourceLabel = useHistorySourceLabel();
  const board = target.kind === "whiteboard";
  const [list, setList] = useState<HistoryList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Selection>(null);
  const [text, setText] = useState<string | null>(null);
  const [diff, setDiff] = useState<HistoryDiff | null>(null);
  const [view, setView] = useState<"preview" | "changes">("preview");
  const [whole, setWhole] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: "info" | "error"; message: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const listRef = useRef<HTMLUListElement | null>(null);

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
    setText(null);
    setDiff(null);
    const textRequest =
      selected === null
        ? board
          ? api.getBoard(target.id).then((doc) => JSON.stringify(doc.board))
          : api.getPage(target.id).then((page) => page.content)
        : api.historyText(target.id, selected);
    textRequest.then((value) => !cancelled && setText(value)).catch(() => !cancelled && setText(""));
    if (selected !== null) api.historyDiff(target.id, selected).then((value) => !cancelled && setDiff(value)).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [selected, target.id, board, list]);

  const items = list?.items ?? [];
  const item = selected === null ? null : (items.find((entry) => entry.file === selected) ?? null);
  const sameAsCurrent = item !== null && list !== null && item.sha256 === list.current.sha256;
  const timeOf = (file: string | undefined) => {
    const found = file ? items.find((entry) => entry.file === file) : undefined;
    return found ? versionTime(found.at) : "";
  };

  const rows: Selection[] = useMemo(() => [null, ...items.map((entry) => entry.file)], [items]);
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
      let count = 0;
      try {
        count = ((JSON.parse(text) as { nodes?: unknown[] }).nodes ?? []).length;
      } catch {
        count = 0;
      }
      return (
        <div className="empty-state history-board-note">
          <span className="empty-state-icon" aria-hidden="true">
            <Icon name="board" size={26} />
          </span>
          <p>{t("history.boardObjects", { count })}</p>
        </div>
      );
    }
    const content = selected === null ? text : parseFrontmatter(text).content;
    const page: Page = { ...target, content };
    return <Editor key={`${target.id}:${selected ?? "current"}`} page={page} pages={pages} readOnly onSaveState={noop} onOpenLink={noop} onCreateLink={noop} />;
  };

  const changes = () => {
    if (!diff) return <p className="history-muted">{t("history.loading")}</p>;
    if (diff.kind === "whiteboard") {
      return (
        <ul className="history-board-changes" data-testid="history-board-changes">
          <li>{t("history.boardAdded", { count: diff.added.length })}</li>
          <li>{t("history.boardRemoved", { count: diff.removed.length })}</li>
          <li>{t("history.boardChanged", { count: diff.changed.length })}</li>
        </ul>
      );
    }
    if (!diff.lines.some((line) => line.op !== "same")) return <p className="history-muted">{t("history.noChanges")}</p>;
    // The diff runs from this version to now: "add" is what now has and this version lacks.
    return (
      <>
        <button type="button" className="link-button history-whole" data-testid="history-whole-file" onClick={() => setWhole((value) => !value)}>
          {whole ? t("history.changesOnly") : t("history.wholeFile")}
        </button>
        <pre className="history-diff" data-testid="history-diff">
          {visibleLines(diff.lines, whole).map((line, index) =>
            line.gap ? (
              <span key={index} className="history-diff-gap" aria-hidden="true">
                ⋯{"\n"}
              </span>
            ) : (
              <span
                key={index}
                className={`history-diff-line history-diff-${line.op}`}
                data-op={line.op}
                aria-label={line.op === "same" ? undefined : `${line.op === "add" ? t("history.added") : t("history.removed")}: ${line.text}`}
              >
                <span className="history-diff-marker" aria-hidden="true">
                  {line.op === "add" ? "+" : line.op === "remove" ? "−" : " "}
                </span>
                {line.text}
                {"\n"}
              </span>
            ),
          )}
        </pre>
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
      <div className="modal history-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} data-testid="history-dialog">
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
              return (
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
            })}
          </ul>
          <section className="history-preview" aria-label={t("history.previewLabel")} data-testid="history-preview">
            {loadError ? (
              <p className="history-error" role="alert">
                {t("history.failed", { error: loadError })}
              </p>
            ) : list !== null && items.length === 0 ? (
              <p className="history-muted" data-testid="history-empty">
                {t("history.empty")}
              </p>
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
                    <div className="history-actions">
                      <button type="button" className="button-secondary" data-testid="history-copy" onClick={() => void copy()} disabled={text === null}>
                        {copied ? t("history.copied") : t("history.copy")}
                      </button>
                      <button
                        type="button"
                        className="button-secondary"
                        aria-pressed={item.pinned}
                        title={item.pinned ? t("history.keptHint") : undefined}
                        data-testid="history-keep"
                        onClick={() => void togglePin()}
                      >
                        {item.pinned ? t("history.kept") : t("history.keep")}
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

