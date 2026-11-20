import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Page } from "@gumply/core";
import { plannedTitleRename } from "../lib/rename.js";
import { Icon } from "./Icon.js";

export interface PageHeaderProps {
  page: Page;
  onRename: (title: string) => Promise<void>;
  onSetIcon?: (icon: string | null) => Promise<void>;
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
  /** Bumped when the body asks for the title (ArrowUp/Backspace at its top). */
  focusTitleSignal?: number;
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
  onSetIcon,
  onDelete,
  onStartBody,
  localGraphOpen = false,
  onToggleLocalGraph,
  autoFocusTitle = true,
  focusTitleSignal = 0,
}: PageHeaderProps) {
  const isEmpty = page.content.trim().length === 0;
  const [editing, setEditing] = useState(isEmpty);
  const [draft, setDraft] = useState(page.title);
  const [iconOpen, setIconOpen] = useState(false);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const iconControlRef = useRef<HTMLDivElement | null>(null);
  // The title this edit session started from. Commit compares against this,
  // not the live prop, so a rename from the sidebar cannot be reverted by a
  // stale header draft blurring afterwards (#n8kk26sc).
  const draftOriginRef = useRef(page.title);

  // Coming up from the body: caret at the end of the title, no select-all.
  const caretAtEnd = useRef(false);
  const skipBlurCommit = useRef(false);
  const pendingTitleFocus = useRef(false);
  const focusTitleAtEnd = () => {
    const input = titleInputRef.current;
    if (!input) return;
    caretAtEnd.current = true;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    caretAtEnd.current = false;
  };

  useEffect(() => {
    if (focusTitleSignal === 0) return;
    if (editing) {
      focusTitleAtEnd();
      return;
    }
    pendingTitleFocus.current = true;
    draftOriginRef.current = page.title;
    setDraft(page.title);
    setEditing(true);
    // Only a new signal should move focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTitleSignal]);

  useLayoutEffect(() => {
    if (!editing || !pendingTitleFocus.current) return;
    pendingTitleFocus.current = false;
    focusTitleAtEnd();
  }, [editing]);

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
        // The body was focused on purpose (e.g. a page opened from a link).
        active.closest(".ProseMirror") !== null ||
        active.closest('[data-testid^="page-rename-input-"]') !== null);
    if (busy) return;
    titleInputRef.current?.focus();
    titleInputRef.current?.select();
  }, [editing, autoFocusTitle]);

  useEffect(() => {
    if (!iconOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (iconControlRef.current && !iconControlRef.current.contains(event.target as Node)) {
        setIconOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIconOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [iconOpen]);

  const chooseIcon = (icon: string | null) => {
    setIconOpen(false);
    if (onSetIcon) void onSetIcon(icon);
  };

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
        <div className="page-icon-control" ref={iconControlRef}>
          <button
            type="button"
            className={`page-icon-button${page.icon ? " has-icon" : ""}`}
            data-testid="page-icon-button"
            data-tooltip={page.icon ? "Change icon" : "Add icon"}
            aria-label={page.icon ? "Change page icon" : "Add page icon"}
            aria-expanded={iconOpen}
            onClick={() => setIconOpen((open) => !open)}
          >
            {page.icon ? (
              <span className="page-icon-large">{page.icon}</span>
            ) : (
              <span className="page-icon-add">
                <Icon name="plus" size={13} /> Add icon
              </span>
            )}
          </button>
          {iconOpen ? (
            <div className="page-icon-picker" role="dialog" aria-label="Page icon">
              <div className="page-icon-grid">
                {["📄", "📝", "📁", "💡", "✅", "🎯", "📌", "🚀", "🌱", "🔖", "🧠", "✨"].map(
                  (emoji) => (
                    <button
                      type="button"
                      key={emoji}
                      className="page-icon-choice"
                      aria-label={`Use ${emoji}`}
                      onClick={() => chooseIcon(emoji)}
                    >
                      {emoji}
                    </button>
                  ),
                )}
              </div>
              {page.icon ? (
                <button
                  type="button"
                  className="page-icon-remove"
                  onClick={() => chooseIcon(null)}
                >
                  Remove icon
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        {editing ? (
          <div className="page-title-block" data-testid="page-title">
            <input
              ref={titleInputRef}
              className="page-title-input"
              data-testid="page-title-input"
              value={draft}
              placeholder="Untitled"
              onFocus={(event) => {
                if (!caretAtEnd.current) event.currentTarget.select();
              }}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={() => {
                if (!skipBlurCommit.current) commit();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === "ArrowDown") {
                  // Ignore Enter while an IME is composing (e.g. Japanese).
                  if (event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  commit();
                  // Focus the body now so keys typed right after Enter land
                  // there; the blur this causes must not commit a second time.
                  skipBlurCommit.current = true;
                  onStartBody();
                  skipBlurCommit.current = false;
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

      <div className="page-meta">
        <span className="page-meta-time">Updated {formatUpdated(page.updated)}</span>
        {page.tags.length > 0 ? (
          <span className="page-tags">
            {page.tags.map((tag) => (
              <span className="page-tag" key={tag}>
                #{tag}
              </span>
            ))}
          </span>
        ) : null}
      </div>
    </header>
  );
}
