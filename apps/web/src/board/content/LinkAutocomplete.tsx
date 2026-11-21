/**
 * `[[` autocomplete in board text (#5hme2fwj). Typing `[[` in a sticky, shape
 * or text node opens a menu of pages and boards under the caret; Enter/Tab or
 * a click inserts the link Gumply writes (`[[Title]]`, `[[file|Title]]`, or
 * `[[Map.canvas|Map]]` for boards). Esc closes the menu only.
 */
import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { BoardPageOption } from "../BoardEditor.js";
import { BoardIcon } from "../icons.js";
import { isBoardPath, wikiLinkFor } from "./links.js";
import { t } from "../../i18n/index.js";

const MAX_ITEMS = 8;

interface Open {
  /** Index of the `[[` in the textarea value. */
  start: number;
  query: string;
  left: number;
  top: number;
  index: number;
}

/** The `[[query` ending at the caret, if any (no `]]` or line break in between). */
export function openLinkQuery(value: string, caret: number): { start: number; query: string } | null {
  const before = value.slice(0, caret);
  const start = before.lastIndexOf("[[");
  if (start === -1) return null;
  const query = before.slice(start + 2);
  if (/[\]\n]/.test(query) || query.length > 80) return null;
  return { start, query };
}

export function matchPages(pages: readonly BoardPageOption[], query: string): BoardPageOption[] {
  const needle = query.trim().toLowerCase();
  return pages
    .filter((page) => !needle || page.title.toLowerCase().includes(needle))
    .sort((a, b) => {
      const aStarts = a.title.toLowerCase().startsWith(needle) ? 0 : 1;
      const bStarts = b.title.toLowerCase().startsWith(needle) ? 0 : 1;
      return aStarts - bStarts || a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
    })
    .slice(0, MAX_ITEMS);
}

const MIRRORED = [
  "boxSizing", "width", "fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderRightWidth",
  "borderBottomWidth", "borderLeftWidth", "textAlign", "textTransform", "wordSpacing", "tabSize",
] as const;

/** Viewport position just under the caret (works inside the zoomed canvas). */
function caretPoint(area: HTMLTextAreaElement, caret: number): { left: number; top: number } {
  const parent = area.parentElement;
  if (!parent) {
    const rect = area.getBoundingClientRect();
    return { left: rect.left, top: rect.bottom };
  }
  const mirror = document.createElement("div");
  const style = window.getComputedStyle(area);
  for (const key of MIRRORED) mirror.style[key] = style[key];
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  mirror.style.left = `${area.offsetLeft}px`;
  mirror.style.top = `${area.offsetTop - area.scrollTop}px`;
  mirror.textContent = area.value.slice(0, caret);
  const marker = document.createElement("span");
  marker.textContent = "​";
  mirror.appendChild(marker);
  parent.appendChild(mirror);
  const rect = marker.getBoundingClientRect();
  mirror.remove();
  return { left: rect.left, top: rect.bottom + 4 };
}

export function useLinkAutocomplete(ref: RefObject<HTMLTextAreaElement | null>, pages: readonly BoardPageOption[]) {
  const [open, setOpen] = useState<Open | null>(null);
  const openRef = useRef<Open | null>(null);
  openRef.current = open;
  const items = open ? matchPages(pages, open.query) : [];
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const update = useCallback(() => {
    const area = ref.current;
    if (!area || pages.length === 0) return;
    const caret = area.selectionStart;
    const found = area.selectionEnd === caret ? openLinkQuery(area.value, caret) : null;
    if (!found) {
      if (openRef.current) setOpen(null);
      return;
    }
    const point = caretPoint(area, found.start);
    const previous = openRef.current;
    setOpen({ ...found, ...point, index: previous && previous.start === found.start ? previous.index : 0 });
  }, [pages.length, ref]);

  const insert = useCallback(
    (page: BoardPageOption) => {
      const area = ref.current;
      const current = openRef.current;
      if (!area || !current) return;
      const link = wikiLinkFor(page, pages);
      const caret = area.selectionStart;
      // Swallow a `]]` the user already typed after the caret.
      const after = area.value.slice(caret).startsWith("]]") ? caret + 2 : caret;
      area.setRangeText(link, current.start, after, "end");
      setOpen(null);
      area.focus();
    },
    [pages, ref],
  );

  /** Returns true when the key was handled by the menu. */
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      const current = openRef.current;
      const list = itemsRef.current;
      if (!current) return false;
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(null);
        return true;
      }
      if (list.length === 0) return false;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setOpen({ ...current, index: (current.index + delta + list.length) % list.length });
        return true;
      }
      if ((event.key === "Enter" && !event.metaKey && !event.ctrlKey) || event.key === "Tab") {
        event.preventDefault();
        const page = list[current.index] ?? list[0];
        if (page) insert(page);
        return true;
      }
      return false;
    },
    [insert],
  );

  // Close when the editor goes away.
  useLayoutEffect(() => () => setOpen(null), []);

  const popup =
    open && items.length > 0
      ? createPortal(
          <div
            className="board-link-menu"
            role="listbox"
            aria-label={t("board.linkPage")}
            data-testid="board-link-menu"
            style={{ left: open.left, top: open.top }}
            onPointerDown={(event) => event.preventDefault()}
          >
            {items.map((page, index) => (
              <button
                key={page.path}
                type="button"
                role="option"
                aria-selected={index === open.index}
                className={`board-link-item${index === open.index ? " is-active" : ""}`}
                data-testid={`board-link-option-${page.path}`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  insert(page);
                }}
              >
                <span className="board-link-icon" aria-hidden="true">
                  {page.icon ?? <BoardIcon name={isBoardPath(page.path) ? "board" : "page"} size={15} />}
                </span>
                <span className="board-link-title">{page.title}</span>
                {isBoardPath(page.path) ? <span className="board-link-kind">{t("board.kindBoard")}</span> : null}
              </button>
            ))}
          </div>,
          document.body,
        )
      : null;

  return { update, onKeyDown, popup };
}
