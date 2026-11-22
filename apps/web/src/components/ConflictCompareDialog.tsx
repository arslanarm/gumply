import { useEffect, useId, useRef, useState } from "react";
import type { ConflictCopy, ConflictDiff, ConflictKeep, PageMeta, PossibleCopy } from "@gumply/core";
import { api } from "../api/client.js";
import { useT } from "../i18n/index.js";
import { conflictSource } from "../lib/conflicts.js";
import { errorMessage } from "../lib/errors.js";
import { Icon } from "./Icon.js";
import { LineDiffView } from "./LineDiffView.js";

/** What Compare opens on: a conflict copy, or a possible copy (§3). */
export type CompareTarget = { copy: ConflictCopy } | { possible: PossibleCopy };

export interface ConflictCompareDialogProps {
  target: CompareTarget;
  pages: readonly PageMeta[];
  onClose: () => void;
  /** Keep page / copy / both / Remove copy; resolves once the action ran (the dialog then closes). */
  onResolve: (copy: ConflictCopy, keep: ConflictKeep) => Promise<void>;
  onNotACopy: (possible: PossibleCopy) => Promise<void>;
  /** "Compare with the version before the conflict": History on the page. */
  onShowHistory?: (id: string) => void;
}

/**
 * D43 / spec/sync-conflicts §4.3: the page against its copy, as version
 * history's Changes view shows a version against now (− only in the page,
 * + only in the copy), with the resolve actions.
 */
export function ConflictCompareDialog({ target, pages, onClose, onResolve, onNotACopy, onShowHistory }: ConflictCompareDialogProps) {
  const t = useT();
  const id = useId();
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const [diff, setDiff] = useState<ConflictDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [whole, setWhole] = useState(false);
  const [busy, setBusy] = useState(false);
  const copyId = "copy" in target ? target.copy.copyId : target.possible.copyId;
  const originalId = "copy" in target ? target.copy.originalId : target.possible.originalId;
  const titleOf = (pageId: string | null) => pages.find((page) => page.id === pageId)?.title ?? pageId ?? "";

  useEffect(() => {
    closeRef.current?.focus();
    let live = true;
    api.conflictDiff(copyId).then(
      (result) => live && setDiff(result),
      (failure: unknown) => live && setError(errorMessage(failure)),
    );
    return () => {
      live = false;
    };
  }, [copyId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
      onClose();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const changes = () => {
    if (error) return <p className="history-muted" role="alert">{error}</p>;
    if (!diff) return <p className="history-muted">{t("conflicts.loading")}</p>;
    if (diff.kind === "board") {
      return (
        <ul className="history-board-changes" data-testid="conflict-board-changes">
          <li>{t("history.boardAdded", { count: diff.added.length })}</li>
          <li>{t("history.boardRemoved", { count: diff.removed.length })}</li>
          <li>{t("history.boardChanged", { count: diff.changed.length })}</li>
        </ul>
      );
    }
    if (!diff.lines.some((line) => line.op !== "same")) return <p className="history-muted">{t("conflicts.noChanges")}</p>;
    return <LineDiffView lines={diff.lines} whole={whole} testId="conflict-diff" />;
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div className="modal conflict-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} data-testid="conflict-compare">
        <header className="history-header">
          <h2 id={`${id}-title`}>
            {t("conflicts.compareTitle")} <span className="history-page-title">{titleOf(originalId)}</span>
          </h2>
          <button type="button" className="icon-button" aria-label={t("conflicts.close")} data-testid="conflict-compare-close" ref={closeRef} onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </header>
        <p className="conflict-legend">
          <span>
            <span className="history-diff-marker" aria-hidden="true">−</span> {t("conflicts.pageSide")}: {titleOf(originalId)}
          </span>
          <span>
            <span className="history-diff-marker" aria-hidden="true">+</span> {t("conflicts.copySide")}: {"copy" in target ? conflictSource(target.copy) : copyId}
          </span>
        </p>
        <div className="conflict-changes">{changes()}</div>
        <footer className="conflict-actions">
          {diff?.kind === "text" && diff.lines.some((line) => line.op !== "same") ? (
            <button type="button" className="button-secondary" onClick={() => setWhole((value) => !value)}>
              {whole ? t("history.changesOnly") : t("history.wholeFile")}
            </button>
          ) : null}
          {onShowHistory && originalId ? (
            <button type="button" className="button-secondary" data-testid="conflict-before" onClick={() => onShowHistory(originalId)}>
              {t("conflicts.beforeConflict")}
            </button>
          ) : null}
          <span className="conflict-actions-spacer" />
          {"copy" in target ? (
            target.copy.same ? (
              <button type="button" className="button-primary" disabled={busy} data-testid="conflict-remove-copy" onClick={() => void run(() => onResolve(target.copy, "delete"))}>
                {t("conflicts.removeCopy")}
              </button>
            ) : (
              <>
                <button type="button" className="button-secondary" disabled={busy} data-testid="conflict-keep-both" onClick={() => void run(() => onResolve(target.copy, "both"))}>
                  {t("conflicts.keepBoth")}
                </button>
                <button type="button" className="button-secondary" disabled={busy} data-testid="conflict-keep-copy" onClick={() => void run(() => onResolve(target.copy, "copy"))}>
                  {t("conflicts.keepCopy")}
                </button>
                <button type="button" className="button-primary" disabled={busy} data-testid="conflict-keep-page" onClick={() => void run(() => onResolve(target.copy, "page"))}>
                  {t("conflicts.keepPage")}
                </button>
              </>
            )
          ) : (
            <button type="button" className="button-secondary" disabled={busy} data-testid="conflict-not-a-copy" onClick={() => void run(() => onNotACopy(target.possible))}>
              {t("conflicts.notACopy")}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
