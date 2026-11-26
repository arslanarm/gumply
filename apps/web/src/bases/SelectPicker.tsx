import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { selectedValues, type BaseValue, type SelectSettings } from "@gumply/core";
import { Icon } from "../components/Icon.js";
import { useT } from "../i18n/index.js";

/**
 * #7prbquxu phase 3 (spec/database-tables §6, mock-up 2): a Select or Multi-select cell's editor.
 * "Search or add an option…", the options in their order with the current one(s) ticked; Enter picks the
 * highlighted match, or adds what was typed as a new option when nothing matches. A Select closes on a pick; a Multi-select stays
 * open for the next. A value outside the options (typed in Obsidian) is offered as "Add as option".
 */
export function SelectPicker(props: {
  settings: SelectSettings;
  value: BaseValue;
  /** The first typed character, when typing on the active cell opened the picker. */
  initialQuery?: string;
  onChange: (next: string | string[] | null) => Promise<boolean>;
  /** Add a value to this base's options (its colour is chosen there). */
  onAddOption: (value: string) => Promise<void>;
  onClose: () => void;
}) {
  const t = useT();
  const multi = props.settings.kind === "multiselect";
  const [query, setQuery] = useState(props.initialQuery ?? "");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // A combobox (the search) that controls the listbox: a screen reader hears the options and the highlighted one
  // wherever the picker sits in the page (it is in a portal).
  const listId = useId();
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const [place, setPlace] = useState<CSSProperties>({ top: 0, left: 0 });
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;
  // Before the next key reaches the page (typing on an active cell opens this mid-word): no letter is lost.
  useLayoutEffect(() => inputRef.current?.focus({ preventScroll: true }), []);
  // #pzqmduua: the picker lives on the page's top layer (a portal), placed by its cell. Inside the table a row's paint
  // containment and the table's own scroll box clipped it, so it was focused and taking keys but couldn't be seen.
  // Under the cell, or above it when it doesn't fit below and there's more room above; it follows a scroll.
  useLayoutEffect(() => {
    let natural: number | undefined;
    // #7prbquxu (§8 follow-up): once a **scroll** takes its cell out of the table's visible box (under the sticky
    // header, or past the bottom), the picker closes, like Escape (nothing is written), instead of floating over the
    // header. Only a scroll: opening it, or a resize (a phone's on-screen keyboard shrinking the window), just places
    // it (@polish-dev).
    const scrolledAway = () => {
      const cell = anchorRef.current?.parentElement;
      const scroller = cell?.closest(".base-table-scroll");
      if (!cell || !scroller) return false;
      const box = cell.getBoundingClientRect();
      const frame = scroller.getBoundingClientRect();
      const head = scroller.querySelector(".base-table-head")?.getBoundingClientRect().bottom ?? frame.top;
      const middle = (box.top + box.bottom) / 2;
      return middle < Math.max(frame.top, head) || middle > frame.bottom;
    };
    const placeIt = () => {
      const cell = anchorRef.current?.parentElement;
      const picker = pickerRef.current;
      if (!cell || !picker) return;
      const box = cell.getBoundingClientRect();
      // Its own height, from before any cap below (so a scroll doesn't flip it back and forth).
      natural ??= picker.offsetHeight;
      const height = natural;
      const below = window.innerHeight - box.bottom;
      const up = below < height + 8 && box.top > below;
      const width = Math.max(box.width, 224);
      const left = Math.max(8, Math.min(box.left, window.innerWidth - width - 8));
      // Never taller than the room on its side (its list scrolls inside): on a short window it stays whole.
      const maxHeight = Math.max(96, (up ? box.top : below) - 8);
      setPlace(up ? { left, width, maxHeight, bottom: window.innerHeight - box.top } : { left, width, maxHeight, top: box.bottom });
    };
    const onScroll = () => {
      if (scrolledAway()) closeRef.current();
      else placeIt();
    };
    placeIt();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", placeIt);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", placeIt);
    };
  }, []);

  const current = selectedValues(props.value);
  const trimmed = query.trim();
  const shown = useMemo(
    () => props.settings.options.filter((option) => option.value.toLowerCase().includes(trimmed.toLowerCase())),
    [props.settings.options, trimmed],
  );
  const exact = props.settings.options.some((option) => option.value === trimmed);
  // #pzqmduua: when nothing matches, Enter adds the query; that item is then the active option, so a screen reader
  // hears what Enter will do (and it's shown highlighted).
  const adding = shown.length === 0 && trimmed !== "" && !exact;
  const unknown = current.filter((item) => !props.settings.options.some((option) => option.value === item));

  const pick = async (value: string) => {
    let next: string | string[] | null;
    if (multi) next = current.includes(value) ? current.filter((item) => item !== value) : [...current, value];
    else next = current[0] === value ? null : value;
    const saved = await props.onChange(next);
    if (saved && !multi) props.onClose();
    if (multi) setQuery("");
  };
  const add = async (value: string) => {
    await props.onAddOption(value);
    await pick(value);
  };

  const picker = (
    <div
      ref={pickerRef}
      className="base-select-picker"
      style={place}
      data-testid="base-select-picker"
      role="dialog"
      aria-label={t("bases.selectSearch")}
      onBlur={(event) => {
        // The cell closes its editor when focus leaves it; focus moving inside the picker (in a portal now, so
        // outside the cell's DOM) mustn't count as leaving.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) event.stopPropagation();
      }}
    >
      <input
        ref={inputRef}
        className="base-input"
        data-testid="base-select-search"
        placeholder={t("bases.selectSearch")}
        aria-label={t("bases.selectSearch")}
        role="combobox"
        aria-expanded={true}
        aria-autocomplete="list"
        aria-controls={listId}
        aria-activedescendant={shown[highlight] ? `${listId}-${highlight}` : adding ? `${listId}-add` : undefined}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setHighlight(0);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setHighlight((at) => Math.min(at + 1, Math.max(shown.length - 1, 0)));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setHighlight((at) => Math.max(at - 1, 0));
          } else if (event.key === "Enter") {
            event.preventDefault();
            // The highlighted match first (typing "C" and Enter picks "Cook"); a new option only when nothing
            // matches. Adding next to a match is the "Add “…”" item.
            if (shown[highlight]) void pick(shown[highlight]!.value);
            else if (trimmed && !exact) void add(trimmed);
          } else if (event.key === "Escape") {
            event.preventDefault();
            props.onClose();
          }
        }}
      />
      <div className="base-select-options" id={listId} role="listbox" aria-multiselectable={multi || undefined}>
        {shown.map((option, index) => {
          const selected = current.includes(option.value);
          return (
            <button
              key={option.value}
              id={`${listId}-${index}`}
              type="button"
              role="option"
              aria-selected={selected}
              className={`base-select-option${index === highlight ? " is-highlighted" : ""}`}
              data-testid={`base-select-option-${option.value}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void pick(option.value)}
            >
              <span className="base-option" data-color={option.color}>
                {option.value}
              </span>
              {selected ? <Icon name="checkSquare" size={14} /> : null}
            </button>
          );
        })}
        {trimmed && !exact ? (
          <button
            id={`${listId}-add`}
            type="button"
            role="option"
            aria-selected={false}
            className={`base-select-option is-add${adding ? " is-highlighted" : ""}`}
            data-testid="base-select-add"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void add(trimmed)}
          >
            <Icon name="plus" size={14} />
            {t("bases.selectAdd", { value: trimmed })}
          </button>
        ) : null}
        {unknown.map((item) => (
          <button
            key={`unknown-${item}`}
            type="button"
            role="option"
            aria-selected={false}
            className="base-select-option is-add"
            data-testid="base-select-add-unknown"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void props.onAddOption(item)}
          >
            <span className="base-option is-unknown">{item}</span>
            {t("bases.selectAddAsOption")}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <>
      <span ref={anchorRef} hidden />
      {createPortal(picker, document.body)}
    </>
  );
}
