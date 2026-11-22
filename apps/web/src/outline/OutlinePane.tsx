/**
 * The Outline pane (v0.8 D1, spec/outline): the open page's headings (or a
 * board's frames) as a keyboard tree. A click jumps; the heading you're
 * reading is highlighted. Read-only: it never writes to the page.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useT } from "../i18n/index.js";
import { Icon } from "../components/Icon.js";
import { currentIndex, hasChildren, visibleEntries, type OutlineEntry } from "./headings.js";
import { OUTLINE_TOP_OFFSET, scrollerOf } from "./scroll.js";

export type OutlineSource =
  | {
      kind: "page";
      entries: () => OutlineEntry[];
      subscribe: (listener: () => void) => () => void;
      element: (entry: OutlineEntry) => HTMLElement | null;
      reveal: (entry: OutlineEntry) => void;
      /** Esc: back to the editor, where the caret was. */
      focusBack: () => void;
    }
  | {
      kind: "board";
      entries: () => OutlineEntry[];
      subscribe: (listener: () => void) => () => void;
      reveal: (entry: OutlineEntry) => void;
      focusBack: () => void;
    }
  | { kind: "none" };

/** Collapsed entries per page, for this session only (never saved). */
const collapsedByPage = new Map<string, Set<string>>();

export function OutlinePane({ pageId, source }: { pageId: string; source: OutlineSource | null }) {
  const t = useT();
  const [entries, setEntries] = useState<OutlineEntry[]>(() => (source && source.kind !== "none" ? source.entries() : []));
  const [collapsed, setCollapsed] = useState<Set<string>>(() => collapsedByPage.get(pageId) ?? new Set());
  const [current, setCurrent] = useState(-1);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement | null>(null);

  // A page switch brings its own collapsed set.
  useEffect(() => {
    setCollapsed(collapsedByPage.get(pageId) ?? new Set());
    setFocusKey(null);
  }, [pageId]);

  const updateCollapsed = (next: Set<string>) => {
    collapsedByPage.set(pageId, next);
    setCollapsed(next);
  };

  // The list follows the document, at most once a frame.
  useEffect(() => {
    if (!source || source.kind === "none") {
      setEntries([]);
      return;
    }
    setEntries(source.entries());
    return source.subscribe(() => setEntries(source.entries()));
  }, [source]);

  // The heading you're reading: the last one at or above the top line of the page.
  const measure = useCallback(() => {
    if (!source || source.kind !== "page" || entries.length === 0) {
      setCurrent(-1);
      return;
    }
    const first = source.element(entries[0]!);
    const scroller = first ? scrollerOf(first) : null;
    if (!scroller) return;
    const top = scroller.getBoundingClientRect().top;
    const tops = entries.map((entry) => {
      const element = source.element(entry);
      return element ? element.getBoundingClientRect().top - top : Number.POSITIVE_INFINITY;
    });
    const index = currentIndex(tops, OUTLINE_TOP_OFFSET + 8);
    // At the top of the page, before any heading reaches the line: the first one, while it's on screen.
    setCurrent(index < 0 && tops[0]! < scroller.clientHeight ? 0 : index);
  }, [source, entries]);

  useEffect(() => {
    if (!source || source.kind !== "page" || entries.length === 0) {
      setCurrent(-1);
      return;
    }
    measure();
    const first = source.element(entries[0]!);
    const scroller = first ? scrollerOf(first) : null;
    if (!scroller) return;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [source, entries, measure]);

  const shown = useMemo(() => visibleEntries(entries, collapsed), [entries, collapsed]);
  const currentKey = current >= 0 ? entries[current]?.key ?? null : null;
  // A collapsed parent stands in for a hidden current heading.
  const currentShownKey = useMemo(() => {
    if (currentKey === null) return null;
    if (shown.some((entry) => entry.key === currentKey)) return currentKey;
    const index = entries.findIndex((entry) => entry.key === currentKey);
    for (let i = index - 1; i >= 0; i--) {
      if (entries[i]!.depth < entries[index]!.depth && shown.some((entry) => entry.key === entries[i]!.key)) return entries[i]!.key;
    }
    return null;
  }, [currentKey, shown, entries]);

  // The tree keeps the current heading in view.
  useLayoutEffect(() => {
    if (currentShownKey === null) return;
    const row = treeRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(currentShownKey)}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [currentShownKey]);

  const activeKey = focusKey !== null && shown.some((entry) => entry.key === focusKey) ? focusKey : (currentShownKey ?? shown[0]?.key ?? null);

  const focusRow = (key: string) => {
    setFocusKey(key);
    requestAnimationFrame(() => treeRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus());
  };

  const toggle = (key: string) => {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    updateCollapsed(next);
  };

  const jump = (entry: OutlineEntry) => {
    if (!source || source.kind === "none") return;
    setFocusKey(entry.key);
    source.reveal(entry);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!source || source.kind === "none" || activeKey === null) return;
    const index = shown.findIndex((entry) => entry.key === activeKey);
    const entry = shown[index];
    if (!entry) return;
    const fullIndex = entries.findIndex((item) => item.key === entry.key);
    const parent = entries.slice(0, fullIndex).reverse().find((item) => item.depth < entry.depth);
    const branch = hasChildren(entries, fullIndex);
    const open = branch && !collapsed.has(entry.key);
    switch (event.key) {
      case "ArrowDown":
        if (shown[index + 1]) focusRow(shown[index + 1]!.key);
        break;
      case "ArrowUp":
        if (shown[index - 1]) focusRow(shown[index - 1]!.key);
        break;
      case "Home":
        if (shown[0]) focusRow(shown[0].key);
        break;
      case "End":
        if (shown.length) focusRow(shown[shown.length - 1]!.key);
        break;
      case "ArrowRight":
        if (branch && !open) toggle(entry.key);
        else if (open && shown[index + 1]) focusRow(shown[index + 1]!.key);
        break;
      case "ArrowLeft":
        if (open) toggle(entry.key);
        else if (parent) focusRow(parent.key);
        break;
      case "Enter":
      case " ":
        jump(entry);
        break;
      case "Escape":
        source.focusBack();
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  if (!source) return null;

  if (source.kind === "none") {
    return (
      <div className="outline-pane">
        <p className="outline-empty" data-testid="outline-empty">
          {t("outline.noOutline")}
        </p>
      </div>
    );
  }

  const branches = entries.some((_, index) => hasChildren(entries, index));

  return (
    <div className="outline-pane" data-testid="outline-pane">
      {branches ? (
        <div className="outline-toolbar">
          <button
            type="button"
            className="outline-tool"
            data-testid="outline-collapse-all"
            onClick={() => updateCollapsed(new Set(entries.filter((_, index) => hasChildren(entries, index)).map((entry) => entry.key)))}
          >
            {t("outline.collapseAll")}
          </button>
          <button type="button" className="outline-tool" data-testid="outline-expand-all" onClick={() => updateCollapsed(new Set())}>
            {t("outline.expandAll")}
          </button>
        </div>
      ) : null}
      {entries.length === 0 ? (
        <p className="outline-empty" data-testid="outline-empty">
          {source.kind === "board" ? t("outline.emptyBoard") : t("outline.empty")}
        </p>
      ) : (
        <div className="outline-tree" role="tree" aria-label={t("outline.title")} ref={treeRef} onKeyDown={onKeyDown} data-testid="outline-tree">
          {shown.map((entry) => {
            const fullIndex = entries.indexOf(entry);
            const branch = hasChildren(entries, fullIndex);
            const open = branch && !collapsed.has(entry.key);
            const empty = entry.text === "";
            const label = empty
              ? source.kind === "board"
                ? t("outline.untitledFrame")
                : t("outline.emptyHeading")
              : entry.text;
            const isCurrent = entry.key === currentShownKey;
            return (
              <div
                key={entry.key}
                data-key={entry.key}
                role="treeitem"
                aria-level={entry.depth + 1}
                aria-expanded={branch ? open : undefined}
                aria-current={isCurrent ? "location" : undefined}
                aria-label={empty && source.kind === "page" ? t("outline.emptyHeadingLabel", { level: entry.level }) : undefined}
                tabIndex={entry.key === activeKey ? 0 : -1}
                className={`outline-item${isCurrent ? " is-current" : ""}${empty ? " is-empty" : ""}`}
                style={{ paddingLeft: `${0.35 + entry.depth * 0.9}rem` }}
                data-testid="outline-item"
                data-level={entry.level}
                onFocus={() => setFocusKey(entry.key)}
                onClick={() => jump(entry)}
              >
                {branch ? (
                  <span
                    className="outline-twisty"
                    data-testid="outline-twisty"
                    aria-hidden="true"
                    title={open ? t("outline.collapse") : t("outline.expand")}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggle(entry.key);
                    }}
                  >
                    <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
                  </span>
                ) : (
                  <span className="outline-twisty is-leaf" aria-hidden="true" />
                )}
                <span className="outline-text">{label}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
