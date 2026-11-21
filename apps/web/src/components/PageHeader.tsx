import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Page, PageId } from "@gumply/core";
import { plannedTitleRename } from "../lib/rename.js";
import { loadEmojiData } from "../lib/emoji/data.js";
import { preloadGraph } from "../lazy-parts.js";
import { EmojiPicker } from "./EmojiPicker.js";
import { Icon } from "./Icon.js";
import { dateFormat, t, useT } from "../i18n/index.js";

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
  /**
   * Open with the title in edit mode (selected, so typing names it). Defaults
   * to "the page has no body yet". Boards have no body, so the app passes
   * this explicitly: only a board created just now (#ksx7szar).
   */
  editTitleOnOpen?: boolean;
  /** Bumped when the body asks for the title (ArrowUp/Backspace at its top). */
  focusTitleSignal?: number;
  /**
   * Identity of the open page for this session. Unlike `page.id` it survives a
   * rename (D20: the id follows the title), so renaming never resets the
   * header or re-focuses the title.
   */
  sessionKey?: string;
  /**
   * v0.7 C: the page is a daily note. ‹ › open the previous/next daily note
   * that exists (browsing never creates files), disabled at the ends.
   */
  daily?: { previous: PageId | null; next: PageId | null; onOpen: (id: PageId) => void };
}

function formatUpdated(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t("time.justNow");
  // Cached per language (#7h5utv23).
  return dateFormat({ dateStyle: "medium", timeStyle: "short" }).format(date);
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
  editTitleOnOpen,
  focusTitleSignal = 0,
  sessionKey,
  daily,
}: PageHeaderProps) {
  useT();
  const isEmpty = page.content.trim().length === 0;
  const startsEditing = editTitleOnOpen ?? isEmpty;
  const [editing, setEditing] = useState(startsEditing);
  const [draft, setDraft] = useState(page.title);
  const [iconOpen, setIconOpen] = useState(false);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const iconControlRef = useRef<HTMLDivElement | null>(null);
  const iconButtonRef = useRef<HTMLButtonElement | null>(null);
  // The title this edit session started from. Commit compares against this,
  // not the live prop, so a rename from the sidebar cannot be reverted by a
  // stale header draft blurring afterwards (#n8kk26sc).
  const draftOriginRef = useRef(page.title);

  // Caret placement without select-all: coming up from the body (end of
  // the title) or a click on the title (where the user clicked).
  const caretAtEnd = useRef(false);
  const skipBlurCommit = useRef(false);
  const pendingCaret = useRef<number | null>(null);
  const focusTitleAt = (offset?: number) => {
    const input = titleInputRef.current;
    if (!input) return;
    const at = Math.min(offset ?? input.value.length, input.value.length);
    caretAtEnd.current = true;
    input.focus();
    input.setSelectionRange(at, at);
    caretAtEnd.current = false;
  };
  const focusTitleAtEnd = () => focusTitleAt();

  // Only a signal raised while this header is mounted counts: the header
  // remounts on page switches and must not replay an old request (that put
  // the caret after "Untitled" on the next new page).
  const handledSignal = useRef(focusTitleSignal);
  // Layout effect + App's flushSync: the title is focused before the next
  // key event, so fast typing after ArrowUp never lands in the body.
  useLayoutEffect(() => {
    if (focusTitleSignal === handledSignal.current) return;
    handledSignal.current = focusTitleSignal;
    if (editing) {
      focusTitleAtEnd();
      return;
    }
    pendingCaret.current = page.title.length;
    draftOriginRef.current = page.title;
    setDraft(page.title);
    setEditing(true);
    // Only a new signal should move focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTitleSignal]);

  useLayoutEffect(() => {
    if (!editing || pendingCaret.current === null) return;
    const offset = pendingCaret.current;
    pendingCaret.current = null;
    focusTitleAt(offset);
  }, [editing]);

  // Like Notion, one click on the title edits it with the caret where the
  // user clicked (#smwaixfp item 7); the pencil still selects all.
  const editAtPointer = (event: React.MouseEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const heading = event.currentTarget;
    let offset = page.title.length;
    const doc = document as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    const position = doc.caretPositionFromPoint?.(event.clientX, event.clientY);
    if (position && heading.contains(position.offsetNode)) {
      offset = position.offset;
    } else {
      const range = document.caretRangeFromPoint?.(event.clientX, event.clientY);
      if (range && heading.contains(range.startContainer)) offset = range.startOffset;
    }
    pendingCaret.current = offset;
    startEditing();
  };

  // Focus the title for new/empty pages only; existing pages keep focus free.
  useEffect(() => {
    draftOriginRef.current = page.title;
    setDraft(page.title);
    setEditing(startsEditing);
    // Reset only when another page opens, not on autosave or a rename.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey ?? page.id]);

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
            data-tooltip={page.icon ? t("page.changeIcon") : t("page.addIcon")}
            aria-label={page.icon ? t("page.changeIconLabel") : t("page.addIconLabel")}
            aria-expanded={iconOpen}
            aria-haspopup="dialog"
            ref={iconButtonRef}
            // Start fetching the emoji list before the click lands.
            onPointerEnter={() => void loadEmojiData().catch(() => undefined)}
            onFocus={() => void loadEmojiData().catch(() => undefined)}
            onClick={() => setIconOpen((open) => !open)}
          >
            {page.icon ? (
              <span className="page-icon-large">{page.icon}</span>
            ) : (
              <span className="page-icon-add">
                <Icon name="plus" size={13} /> {t("page.addIcon")}
              </span>
            )}
          </button>
          {iconOpen ? (
            <div className="page-icon-popover">
              <EmojiPicker
                label={t("page.iconLabel")}
                testId="page-icon-picker"
                onSelect={chooseIcon}
                onRemove={page.icon ? () => chooseIcon(null) : undefined}
                onClose={() => {
                  setIconOpen(false);
                  iconButtonRef.current?.focus();
                }}
              />
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
              placeholder={t("defaults.untitledPage")}
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
            <span className="visually-hidden">{draft.trim().length > 0 ? draft : t("defaults.untitledPage")}</span>
          </div>
        ) : (
          <h1
            className="page-title"
            data-testid="page-title"
            onMouseDown={editAtPointer}
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
              onPointerEnter={preloadGraph}
              onFocus={preloadGraph}
              onClick={onToggleLocalGraph}
            >
              {t("page.localGraph")}
            </button>
          ) : null}
          <button
            type="button"
            className="icon-button"
            data-testid="rename-page-button"
            data-tooltip={t("page.rename")}
            aria-label={t("page.rename")}
            onClick={startEditing}
          >
            <Icon name="pencil" size={16} />
          </button>
          <button
            type="button"
            className="icon-button icon-button-danger"
            data-testid="delete-page-button-page"
            data-tooltip={t("sidebar.deletePage")}
            aria-label={t("sidebar.deletePage")}
            onClick={onDelete}
          >
            <Icon name="trash" size={16} />
          </button>
        </div>
      </div>

      <div className="page-meta">
        {daily ? (
          <span className="daily-nav" data-testid="daily-nav" aria-label={t("daily.label")} role="group">
            <button
              type="button"
              className="daily-nav-button"
              data-testid="daily-previous"
              aria-label={t("daily.previous")}
              data-tooltip={t("daily.previous")}
              disabled={!daily.previous}
              onClick={() => daily.previous && daily.onOpen(daily.previous)}
            >
              <Icon name="chevronLeft" size={14} />
            </button>
            <button
              type="button"
              className="daily-nav-button"
              data-testid="daily-next"
              aria-label={t("daily.next")}
              data-tooltip={t("daily.next")}
              disabled={!daily.next}
              onClick={() => daily.next && daily.onOpen(daily.next)}
            >
              <Icon name="chevronRight" size={14} />
            </button>
          </span>
        ) : null}
        <span className="page-meta-time">{t("page.updated", { time: formatUpdated(page.updated) })}</span>
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
