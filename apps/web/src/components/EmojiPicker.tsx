import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  EMOJI_CATEGORIES,
  findEmoji,
  firstEmoji,
  loadEmojiData,
  emojiDataIfLoaded,
  searchEmoji,
  type EmojiCategoryId,
  type EmojiEntry,
} from "../lib/emoji/data.js";
import { moveInGrid, type GridKey } from "../lib/emoji/grid-nav.js";
import { getRecentEmoji, pushRecentEmoji } from "../lib/emoji/recent.js";
import { Icon } from "./Icon.js";

export const EMOJI_COLUMNS = 10;

export interface EmojiPickerProps {
  /** Called with the chosen emoji. It is also added to Recent. */
  onSelect: (emoji: string) => void;
  /** Shows a "Remove" action when given. */
  onRemove?: () => void;
  /** Escape in the picker. */
  onClose?: () => void;
  /** Accessible name of the dialog. */
  label?: string;
  testId?: string;
}

interface Section {
  id: "recent" | "results" | EmojiCategoryId;
  label: string;
  items: { emoji: string; name: string }[];
}

const GRID_KEYS = new Set<string>(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

/**
 * Notion-style emoji picker: filter box, Random / Remove, a Recent row, every
 * standard emoji by category with a category bar, and keyboard navigation
 * (arrows + Enter) while focus stays in the filter box. Pasting or typing any
 * emoji into the filter box offers it too, even ones not in the list.
 */
export function EmojiPicker({
  onSelect,
  onRemove,
  onClose,
  label = "Emoji picker",
  testId = "emoji-picker",
}: EmojiPickerProps) {
  const [entries, setEntries] = useState<EmojiEntry[] | null>(() => emojiDataIfLoaded());
  const [loadFailed, setLoadFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [recent] = useState<string[]>(() => getRecentEmoji());
  const [active, setActive] = useState(-1);
  const [hovered, setHovered] = useState<{ emoji: string; name: string } | null>(null);
  const [activeCategory, setActiveCategory] = useState<Section["id"] | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const idPrefix = useRef(`emoji-${Math.random().toString(36).slice(2, 8)}`).current;

  useEffect(() => {
    if (entries) return;
    let cancelled = false;
    loadEmojiData()
      .then((data) => {
        if (!cancelled) setEntries(data);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [entries]);

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  const nameOf = useCallback(
    (emoji: string) => (entries ? findEmoji(entries, emoji)?.name : undefined) ?? emoji,
    [entries],
  );

  const sections = useMemo<Section[]>(() => {
    const typed = firstEmoji(query);
    const q = query.trim();
    if (q) {
      const items = entries
        ? searchEmoji(entries, q).map((entry) => ({ emoji: entry.emoji, name: entry.name }))
        : [];
      // A pasted or typed emoji is always offered first, even if it is not in
      // the list (skin tones, brand-new emoji).
      if (typed && typed === q && !items.some((item) => item.emoji === typed)) {
        items.unshift({ emoji: typed, name: nameOf(typed) });
      }
      return [{ id: "results", label: "Results", items }];
    }
    const list: Section[] = [];
    if (recent.length > 0) {
      list.push({
        id: "recent",
        label: "Recent",
        items: recent.map((emoji) => ({ emoji, name: nameOf(emoji) })),
      });
    }
    if (entries) {
      for (const category of EMOJI_CATEGORIES) {
        list.push({
          id: category.id,
          label: category.label,
          items: entries
            .filter((entry) => entry.category === category.id)
            .map((entry) => ({ emoji: entry.emoji, name: entry.name })),
        });
      }
    }
    return list.filter((section) => section.items.length > 0);
  }, [entries, query, recent, nameOf]);

  const flat = useMemo(() => sections.flatMap((section) => section.items), [sections]);
  const sizes = useMemo(() => sections.map((section) => section.items.length), [sections]);

  // Typing a filter puts the highlight on the best match; clearing removes it.
  useEffect(() => {
    setActive(query.trim() ? 0 : -1);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [query]);

  useEffect(() => {
    if (active < 0) return;
    // Scroll only the list: scrollIntoView would also scroll the page behind.
    const scroller = scrollRef.current;
    const cell = document.getElementById(`${idPrefix}-${active}`);
    if (!scroller || !cell) return;
    const heading = cell.closest("section")?.querySelector<HTMLElement>(".emoji-picker-heading");
    const stickyOffset = heading ? heading.offsetHeight : 0;
    const top = cell.offsetTop - (cell.offsetParent === scroller ? 0 : scroller.offsetTop);
    if (top - stickyOffset < scroller.scrollTop) {
      scroller.scrollTop = top - stickyOffset;
    } else if (top + cell.offsetHeight > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = top + cell.offsetHeight - scroller.clientHeight;
    }
  }, [active, idPrefix]);

  const choose = (emoji: string) => {
    pushRecentEmoji(emoji);
    onSelect(emoji);
  };

  // Stable callback so hovering (which only updates the footer) never
  // re-renders the ~1,900 emoji buttons.
  const chooseLatest = useRef(choose);
  chooseLatest.current = choose;
  const chooseRef = useCallback((emoji: string) => chooseLatest.current(emoji), []);

  const chooseRandom = () => {
    const pool = entries ?? [];
    if (pool.length === 0) return;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    if (pick) choose(pick.emoji);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (query) setQuery("");
      else onClose?.();
      return;
    }
    if (event.key === "Enter") {
      const item = flat[active] ?? (query.trim() ? flat[0] : undefined);
      if (item) {
        event.preventDefault();
        choose(item.emoji);
      }
      return;
    }
    if (GRID_KEYS.has(event.key)) {
      // Left/Right edit the filter text unless the grid is being navigated.
      if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && active < 0) return;
      event.preventDefault();
      setActive((current) => moveInGrid(sizes, EMOJI_COLUMNS, current, event.key as GridKey));
    }
  };

  const onPaste = (event: React.ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text").trim();
    const emoji = firstEmoji(text);
    if (emoji && emoji === text) {
      event.preventDefault();
      choose(emoji);
    }
  };

  const onScroll = () => {
    const scroller = scrollRef.current;
    if (!scroller || query.trim()) return;
    const top = scroller.scrollTop + 8;
    let current: Section["id"] | null = null;
    for (const section of sections) {
      const element = scroller.querySelector<HTMLElement>(`[data-section="${section.id}"]`);
      if (element && element.offsetTop <= top) current = section.id;
    }
    setActiveCategory(current);
  };

  const jumpTo = (id: Section["id"]) => {
    setQuery("");
    requestAnimationFrame(() => {
      const scroller = scrollRef.current;
      const element = scroller?.querySelector<HTMLElement>(`[data-section="${id}"]`);
      if (scroller && element) scroller.scrollTo({ top: element.offsetTop });
      setActiveCategory(id);
      inputRef.current?.focus({ preventScroll: true });
    });
  };

  const activeItem = flat[active];
  const preview = hovered ?? activeItem ?? null;
  const filtering = query.trim().length > 0;

  return (
    <div className="emoji-picker" role="dialog" aria-label={label} data-testid={testId}>
      <div className="emoji-picker-top">
        <label className="emoji-picker-search">
          <Icon name="search" size={14} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            placeholder="Search emoji…"
            aria-label="Search emoji"
            data-testid="emoji-search"
            role="combobox"
            aria-expanded="true"
            aria-controls={`${idPrefix}-list`}
            aria-activedescendant={active >= 0 ? `${idPrefix}-${active}` : undefined}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
        </label>
        <button
          type="button"
          className="emoji-picker-action"
          data-testid="emoji-random"
          data-tooltip="Random emoji"
          aria-label="Random emoji"
          disabled={!entries}
          onClick={chooseRandom}
        >
          <Icon name="shuffle" size={15} />
        </button>
        {onRemove ? (
          <button
            type="button"
            className="emoji-picker-action emoji-picker-remove"
            data-testid="emoji-remove"
            onClick={onRemove}
          >
            Remove
          </button>
        ) : null}
      </div>

      <div
        ref={scrollRef}
        className="emoji-picker-scroll"
        id={`${idPrefix}-list`}
        role="listbox"
        aria-label={filtering ? "Search results" : "Emoji"}
        onScroll={onScroll}
        onMouseLeave={() => setHovered(null)}
      >
        <EmojiSections
          sections={sections}
          active={active}
          idPrefix={idPrefix}
          showHeadings={!filtering}
          onChoose={chooseRef}
          onHover={setHovered}
        />
        {!entries && !loadFailed ? <p className="emoji-picker-note">Loading emoji…</p> : null}
        {loadFailed ? (
          <p className="emoji-picker-note">Couldn’t load the emoji list. Paste an emoji instead.</p>
        ) : null}
        {entries && filtering && flat.length === 0 ? (
          <p className="emoji-picker-note" data-testid="emoji-empty">
            No emoji match “{query.trim()}”.
          </p>
        ) : null}
      </div>

      <div className="emoji-picker-footer">
        {preview ? (
          <div className="emoji-picker-preview" aria-hidden="true">
            <span className="emoji-picker-preview-glyph">{preview.emoji}</span>
            <span className="emoji-picker-preview-name">{preview.name}</span>
          </div>
        ) : (
          <nav className="emoji-picker-tabs" aria-label="Emoji categories">
            {recent.length > 0 ? (
              <button
                type="button"
                className={`emoji-picker-tab${activeCategory === "recent" ? " is-active" : ""}`}
                aria-label="Recent"
                data-tooltip="Recent"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => jumpTo("recent")}
              >
                🕘
              </button>
            ) : null}
            {EMOJI_CATEGORIES.map((category) => (
              <button
                key={category.id}
                type="button"
                className={`emoji-picker-tab${
                  activeCategory === category.id ||
                  (activeCategory === null && !recent.length && category.id === "smileys")
                    ? " is-active"
                    : ""
                }`}
                aria-label={category.label}
                data-tooltip={category.label}
                disabled={!entries}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => jumpTo(category.id)}
              >
                {category.icon}
              </button>
            ))}
          </nav>
        )}
      </div>
    </div>
  );
}

interface EmojiSectionsProps {
  sections: Section[];
  active: number;
  idPrefix: string;
  showHeadings: boolean;
  onChoose: (emoji: string) => void;
  onHover: (item: { emoji: string; name: string }) => void;
}

const EmojiSections = memo(function EmojiSections({
  sections,
  active,
  idPrefix,
  showHeadings,
  onChoose,
  onHover,
}: EmojiSectionsProps) {
  let index = 0;
  return (
    <>
      {sections.map((section) => (
        <section
          key={section.id}
          className="emoji-picker-section"
          data-section={section.id}
          aria-label={section.label}
        >
          {showHeadings ? <h3 className="emoji-picker-heading">{section.label}</h3> : null}
          <div className="emoji-picker-grid" role="group" aria-label={section.label}>
            {section.items.map((item) => {
              const position = index++;
              return (
                <button
                  key={`${section.id}-${item.emoji}`}
                  id={`${idPrefix}-${position}`}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={position === active}
                  aria-label={item.name}
                  className={`emoji-picker-cell${position === active ? " is-active" : ""}`}
                  data-emoji={item.emoji}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => onHover(item)}
                  onClick={() => onChoose(item.emoji)}
                >
                  {item.emoji}
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </>
  );
});
