import { useLayoutEffect, useMemo, useRef, useState } from "react";
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
  // Before the next key reaches the page (typing on an active cell opens this mid-word): no letter is lost.
  useLayoutEffect(() => inputRef.current?.focus(), []);

  const current = selectedValues(props.value);
  const trimmed = query.trim();
  const shown = useMemo(
    () => props.settings.options.filter((option) => option.value.toLowerCase().includes(trimmed.toLowerCase())),
    [props.settings.options, trimmed],
  );
  const exact = props.settings.options.some((option) => option.value === trimmed);
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

  return (
    <div className="base-select-picker" data-testid="base-select-picker" role="dialog" aria-label={t("bases.selectSearch")}>
      <input
        ref={inputRef}
        className="base-input"
        data-testid="base-select-search"
        placeholder={t("bases.selectSearch")}
        aria-label={t("bases.selectSearch")}
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
      <div className="base-select-options" role="listbox" aria-multiselectable={multi || undefined}>
        {shown.map((option, index) => {
          const selected = current.includes(option.value);
          return (
            <button
              key={option.value}
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
            type="button"
            className="base-select-option is-add"
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
}
