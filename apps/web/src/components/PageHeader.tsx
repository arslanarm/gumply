import { useEffect, useRef, useState } from "react";
import type { Page } from "@gumply/core";
import { plannedTitleRename } from "../lib/rename.js";
import { Icon } from "./Icon.js";

export interface PageHeaderProps {
  page: Page;
  onRename: (title: string) => Promise<void>;
  onDelete: () => void;
  /** Enter in the title moves the caret into the first body block. */
  onStartBody: () => void;
  /** Local graph panel is open for this page. */
  localGraphOpen?: boolean;
  onToggleLocalGraph?: () => void;
  /**
   * Focus and select the title for a new/empty page. Set false when the page
   * was opened by deleting another page: focus must stay in the sidebar.
   */
  autoFocusTitle?: boolean;
}

function formatUpdated(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "just now";
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** Title, rename affordance and metadata for the open page. */
export function PageHeader({
  page,
  onRename,
  onDelete,
  onStartBody,
  localGraphOpen = false,
  onToggleLocalGraph,
  autoFocusTitle = true,
}: PageHeaderProps) {
  const isEmpty = page.content.trim().length === 0;
  const [editing, setEditing] = useState(isEmpty);
  const [draft, setDraft] = useState(page.title);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  // The title this edit session started from. Commit compares against this,
  // not the live prop, so a rename from the sidebar cannot be reverted by a
  // stale header draft blurring afterwards (#n8kk26sc).
  const draftOriginRef = useRef(page.title);

  // Focus the title for new/empty pages only; existing pages keep focus free.
  useEffect(() => {
    draftOriginRef.current = page.title;
    setDraft(page.title);
    setEditing(page.content.trim().length === 0);
    // Reset only when the open page changes, not on every autosave.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.id]);

  // Follow an external rename while the draft is still untouched, so the
  // header shows the new title and the next commit starts from it.
  useEffect(() => {
    if (!editing || draft !== draftOriginRef.current) return;
    draftOriginRef.current = page.title;
    setDraft(page.title);
  }, [page.title, editing, draft]);

  // Never steal focus from an input the user is already using (e.g. an inline
  // sidebar rename that started while this page was still loading).
  useEffect(() => {
    if (!editing || !autoFocusTitle) return;
    const active = document.activeElement;
    const busy =
      active instanceof HTMLElement &&
      (active.tagName === "INPUT" ||
        active.tagName === "TEXTAREA" ||
        active.closest('[data-testid^="page-rename-input-"]') !== null);
    if (busy) return;
    titleInputRef.current?.focus();
    titleInputRef.current?.select();
  }, [editing, autoFocusTitle]);

  const startEditing = () => {
    draftOriginRef.current = page.title;
    setDraft(page.title);
    setEditing(true);
  };

  const commit = () => {
    const title = plannedTitleRename(draft, draftOriginRef.current);
    setEditing(false);
    if (title !== null) {
      draftOriginRef.current = title;
      void onRename(title);
    } else {
      setDraft(page.title);
    }
  };

  const cancel = () => {
    setEditing(false);
    setDraft(page.title);
  };

  return (
    <header className="page-header">
      <div className="page-heading">
        {page.icon ? <span className="page-icon-large">{page.icon}</span> : null}

        {editing ? (
          <div className="page-title-block" data-testid="page-title">
            <input
              ref={titleInputRef}
              className="page-title-input"
              data-testid="page-title-input"
              value={draft}
              placeholder="Untitled"
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commit}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commit();
                  onStartBody();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  cancel();
                }
              }}
            />
            <span className="visually-hidden">{draft.trim().length > 0 ? draft : "Untitled"}</span>
          </div>
        ) : (
          <h1
            className="page-title"
            data-testid="page-title"
            title="Double-click to rename"
            onDoubleClick={startEditing}
          >
            {page.title}
          </h1>
        )}

        <div
          className="page-header-actions"
          onMouseDown={
            editing
              ? (event) => {
                  // Keep focus in the title input so blurring does not swap the
                  // input for the <h1> (and shift this row) before the click lands.
                  event.preventDefault();
                }
              : undefined
          }
        >
          {onToggleLocalGraph ? (
            <button
              type="button"
              className={`button-secondary local-graph-toggle${localGraphOpen ? " is-active" : ""}`}
              data-testid="local-graph-toggle"
              aria-pressed={localGraphOpen}
              onClick={onToggleLocalGraph}
            >
              Local graph
            </button>
          ) : null}
          <button
            type="button"
            className="icon-button"
            data-testid="rename-page-button"
            data-tooltip="Rename page"
            aria-label="Rename page"
            onClick={startEditing}
          >
            <Icon name="pencil" size={16} />
          </button>
          <button
            type="button"
            className="icon-button icon-button-danger"
            data-testid="delete-page-button-page"
            data-tooltip="Delete page"
            aria-label="Delete page"
            onClick={onDelete}
          >
            <Icon name="trash" size={16} />
          </button>
        </div>
      </div>

      <p className="page-meta">
        Updated {formatUpdated(page.updated)}
        {page.tags.length > 0 ? ` · ${page.tags.map((tag) => `#${tag}`).join(" ")}` : ""}
      </p>
    </header>
  );
}
