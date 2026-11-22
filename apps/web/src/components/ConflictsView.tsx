import { useEffect, useState } from "react";
import { conflictCopyOf, type ConflictCopy, type ConflictKeep, type ConflictsList, type PageMeta, type PossibleCopy } from "@gumply/core";
import { api } from "../api/client.js";
import { useT } from "../i18n/index.js";
import { conflictSource } from "../lib/conflicts.js";
import { errorMessage } from "../lib/errors.js";
import type { CompareTarget } from "./ConflictCompareDialog.js";
import { Icon } from "./Icon.js";

/**
 * A possible copy by its file name ("Plan 2"): it usually carries the page's
 * own `title:`, so its title alone would read the same as the page's.
 */
export function fileNameOf(id: string): string {
  return id.slice(id.lastIndexOf("/") + 1).replace(/\.(canvas|base)$/i, "");
}

/** The name an orphan copy takes back ("Keep as “Note”"). */
export function orphanTitle(copy: Pick<ConflictCopy, "copyId" | "kind">): string {
  const segment = copy.copyId.slice(copy.copyId.lastIndexOf("/") + 1);
  const name = conflictCopyOf(copy.kind === "page" ? `${segment}.md` : segment);
  return (name?.originalName ?? segment).replace(/\.(md|canvas|base)$/i, "");
}

export interface ConflictsViewProps {
  pages: readonly PageMeta[];
  /** Changes whenever a resolve or a rescan may have changed the list. */
  refreshKey: number;
  onOpen: (id: string) => void;
  onCompare: (target: CompareTarget) => void;
  onResolve: (copy: ConflictCopy, keep: ConflictKeep) => Promise<void>;
  onNotACopy: (possible: PossibleCopy) => Promise<void>;
}

/**
 * D43 / spec/sync-conflicts §4.2: every conflict copy with its actions, the
 * attachment copies to sort out by hand, and the possible copies (collapsed).
 */
export function ConflictsView({ pages, refreshKey, onOpen, onCompare, onResolve, onNotACopy }: ConflictsViewProps) {
  const t = useT();
  const [list, setList] = useState<ConflictsList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const titleOf = (id: string | null) => pages.find((page) => page.id === id)?.title ?? id ?? "";

  useEffect(() => {
    let live = true;
    api.conflicts().then(
      (result) => {
        if (!live) return;
        setList(result);
        setError(null);
      },
      (failure: unknown) => live && setError(errorMessage(failure)),
    );
    return () => {
      live = false;
    };
  }, [refreshKey]);

  const act = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    try {
      await action();
    } finally {
      setBusy(null);
    }
  };

  const copyRow = (copy: ConflictCopy) => (
    <li key={copy.copyId} className="conflict-row" data-testid={`conflict-row-${copy.copyId}`}>
      <div className="conflict-row-text">
        <button type="button" className="conflict-row-title" onClick={() => onOpen(copy.originalId ?? copy.copyId)}>
          {copy.originalId ? titleOf(copy.originalId) : titleOf(copy.copyId)}
        </button>
        <span className="conflict-row-meta">
          {copy.originalId ? conflictSource(copy) : `${t("conflicts.originalGone")} · ${conflictSource(copy)}`}
          {copy.same ? ` · ${t("conflicts.same")}` : ""}
        </span>
      </div>
      <div className="conflict-row-actions">
        {copy.originalId === null ? (
          <button
            type="button"
            className="button-secondary"
            disabled={busy !== null}
            data-testid="conflict-keep-as"
            onClick={() => void act(copy.copyId, () => onResolve(copy, "as-original"))}
          >
            {t("conflicts.keepAs", { title: orphanTitle(copy) })}
          </button>
        ) : copy.same ? (
          <button type="button" className="button-secondary" disabled={busy !== null} data-testid="conflict-remove" onClick={() => void act(copy.copyId, () => onResolve(copy, "delete"))}>
            {t("conflicts.removeCopy")}
          </button>
        ) : (
          <>
            <button type="button" className="button-primary" data-testid="conflict-compare" onClick={() => onCompare({ copy })}>
              {t("conflicts.compare")}
            </button>
            <button type="button" className="button-secondary" disabled={busy !== null} data-testid="conflict-row-keep-page" onClick={() => void act(copy.copyId, () => onResolve(copy, "page"))}>
              {t("conflicts.keepPage")}
            </button>
            <button type="button" className="button-secondary" disabled={busy !== null} data-testid="conflict-row-keep-copy" onClick={() => void act(copy.copyId, () => onResolve(copy, "copy"))}>
              {t("conflicts.keepCopy")}
            </button>
            <button type="button" className="button-secondary" disabled={busy !== null} data-testid="conflict-row-keep-both" onClick={() => void act(copy.copyId, () => onResolve(copy, "both"))}>
              {t("conflicts.keepBoth")}
            </button>
          </>
        )}
      </div>
    </li>
  );

  return (
    <div className="trash-view conflicts-view" data-testid="conflicts-view">
      <header className="trash-header">
        <h1 className="page-title">{t("conflicts.title")}</h1>
        <p className="trash-intro">{t("conflicts.intro")}</p>
      </header>
      {error ? (
        <p className="history-muted" role="alert">
          {t("conflicts.failed")} {error}
        </p>
      ) : !list ? (
        <p className="history-muted">{t("conflicts.loading")}</p>
      ) : list.copies.length === 0 && list.attachments.length === 0 && list.possible.length === 0 ? (
        <div className="empty-state" data-testid="conflicts-empty">
          <span className="empty-state-icon" aria-hidden="true">
            <Icon name="circleCheck" size={26} />
          </span>
          <h2>{t("conflicts.empty")}</h2>
        </div>
      ) : (
        <>
          {list.copies.length > 0 ? (
            <section aria-labelledby="conflicts-copies">
              <h2 id="conflicts-copies" className="conflict-section-title">
                {t("conflicts.sectionCopies")}
              </h2>
              <ul className="conflict-list">{list.copies.map(copyRow)}</ul>
            </section>
          ) : null}
          {list.attachments.length > 0 ? (
            <section aria-labelledby="conflicts-files">
              <h2 id="conflicts-files" className="conflict-section-title">
                {t("conflicts.sectionFiles")}
              </h2>
              <p className="history-muted">{t("conflicts.fileByHand")}</p>
              <ul className="conflict-list">
                {list.attachments.map((file) => (
                  <li key={file.path} className="conflict-row" data-testid="conflict-file">
                    <div className="conflict-row-text">
                      <code>{file.path}</code>
                      <span className="conflict-row-meta">{file.originalPath ? `${file.originalPath} · ${conflictSource(file)}` : conflictSource(file)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {list.possible.length > 0 ? (
            <details className="conflict-possible" data-testid="conflicts-possible">
              <summary className="conflict-section-title">
                {t("conflicts.sectionPossible")} ({list.possible.length})
              </summary>
              <p className="history-muted">{t("conflicts.possibleHint")}</p>
              <ul className="conflict-list">
                {list.possible.map((possible) => (
                  <li key={possible.copyId} className="conflict-row" data-testid={`possible-row-${possible.copyId}`}>
                    <div className="conflict-row-text">
                      <button type="button" className="conflict-row-title" onClick={() => onOpen(possible.copyId)}>
                        {fileNameOf(possible.copyId)}
                      </button>
                      <span className="conflict-row-meta">
                        {t("conflicts.similarity", { percent: Math.round(possible.similarity * 100), title: titleOf(possible.originalId) })}
                      </span>
                    </div>
                    <div className="conflict-row-actions">
                      <button type="button" className="button-secondary" onClick={() => onCompare({ possible })}>
                        {t("conflicts.compare")}
                      </button>
                      <button
                        type="button"
                        className="button-secondary"
                        disabled={busy !== null}
                        data-testid="possible-not-a-copy"
                        onClick={() => void act(possible.copyId, () => onNotACopy(possible))}
                      >
                        {t("conflicts.notACopy")}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}
    </div>
  );
}
