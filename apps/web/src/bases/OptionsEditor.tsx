import { useEffect, useRef, useState } from "react";
import { SELECT_COLORS, type SelectColor, type SelectOption, type SelectSettings } from "@gumply/core";
import { Icon } from "../components/Icon.js";
import { useT } from "../i18n/index.js";
import { Popover } from "./Popover.js";

/**
 * #7prbquxu phase 3 (spec/database-tables §6): "Edit options…" for a Select or Multi-select column.
 * Each option: its name (a rename rewrites the value in this database's rows, in one server request),
 * its colour, its place (the order is Kanban's default `groupOrder`), and Delete, which asks whether to
 * clear the value from the rows too (otherwise the rows keep it as text, shown as a plain chip).
 * Colours, order and a delete that keeps the values change the base only.
 */
export function OptionsEditor(props: {
  anchor: HTMLElement | null;
  label: string;
  settings: SelectSettings;
  onClose: () => void;
  onSetOptions: (options: SelectOption[]) => Promise<void>;
  onRename: (from: string, to: string) => Promise<void>;
  onClear: (value: string) => Promise<void>;
}) {
  const t = useT();
  const options = props.settings.options;
  const [names, setNames] = useState<Record<string, string>>({});
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // #pzqmduua: the question opens under the list, which can be below the popover's scrolled fold (ten options);
  // bring it into sight and put focus on its first choice, so the bin visibly does something (and keys reach it).
  const confirmRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (deleting === null) return;
    confirmRef.current?.scrollIntoView({ block: "nearest" });
    confirmRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }, [deleting]);
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  };
  const rename = (option: SelectOption) => {
    const to = (names[option.value] ?? option.value).trim();
    setNames((current) => {
      const next = { ...current };
      delete next[option.value];
      return next;
    });
    if (!to || to === option.value || options.some((other) => other.value === to)) return;
    void run(() => props.onRename(option.value, to));
  };
  const move = (index: number, by: number) => {
    const next = [...options];
    const [option] = next.splice(index, 1);
    next.splice(index + by, 0, option!);
    void run(() => props.onSetOptions(next));
  };
  const recolor = (value: string, color: SelectColor) =>
    void run(() => props.onSetOptions(options.map((option) => (option.value === value ? { ...option, color } : option))));

  return (
    <Popover anchor={props.anchor} onClose={props.onClose} label={t("bases.editOptions")} testId="base-options-editor" className="is-options">
      <div className="base-panel-title">{props.label}</div>
      {options.length === 0 ? <p className="base-add-column-note">{t("bases.noOptions")}</p> : null}
      {options.map((option, index) => (
        <div className="base-options-row" key={option.value} data-testid={`base-options-row-${option.value}`}>
          <input
            className="base-input"
            aria-label={t("bases.optionName")}
            data-testid={`base-option-name-${option.value}`}
            value={names[option.value] ?? option.value}
            disabled={busy}
            onChange={(event) => setNames((current) => ({ ...current, [option.value]: event.target.value }))}
            onBlur={() => rename(option)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === "Enter") {
                event.preventDefault();
                rename(option);
              }
            }}
          />
          <span className="base-option-colors" role="radiogroup" aria-label={t("bases.optionColor")}>
            {SELECT_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                role="radio"
                aria-checked={option.color === color}
                aria-label={t(`bases.optionColors.${color}`)}
                className="base-option-swatch base-option"
                data-color={color}
                data-testid={`base-option-color-${option.value}-${color}`}
                disabled={busy}
                onClick={() => recolor(option.value, color)}
              />
            ))}
          </span>
          <button type="button" className="base-icon-button" aria-label={t("bases.optionUp")} disabled={busy || index === 0} onClick={() => move(index, -1)}>
            <Icon name="arrowUp" size={14} />
          </button>
          <button
            type="button"
            className="base-icon-button is-down"
            aria-label={t("bases.optionDown")}
            data-testid={`base-option-down-${option.value}`}
            disabled={busy || index === options.length - 1}
            onClick={() => move(index, 1)}
          >
            <Icon name="arrowUp" size={14} />
          </button>
          <button
            type="button"
            className="base-icon-button is-danger"
            aria-label={t("bases.optionDelete", { value: option.value })}
            data-testid={`base-option-delete-${option.value}`}
            disabled={busy}
            onClick={() => setDeleting(option.value)}
          >
            <Icon name="trash" size={14} />
          </button>
        </div>
      ))}
      {deleting !== null ? (
        <div ref={confirmRef} className="base-options-confirm" role="alert" data-testid="base-option-delete-confirm">
          <p>{t("bases.optionDeleteAsk", { value: deleting })}</p>
          <button
            type="button"
            className="button-danger"
            data-testid="base-option-delete-clear"
            onClick={() => {
              const value = deleting;
              setDeleting(null);
              void run(() => props.onClear(value));
            }}
          >
            {t("bases.optionDeleteClear")}
          </button>
          <button
            type="button"
            className="button-secondary"
            data-testid="base-option-delete-keep"
            onClick={() => {
              const value = deleting;
              setDeleting(null);
              void run(() => props.onSetOptions(options.filter((option) => option.value !== value)));
            }}
          >
            {t("bases.optionDeleteKeep")}
          </button>
          <button type="button" className="button-secondary" onClick={() => setDeleting(null)}>
            {t("common.cancel")}
          </button>
        </div>
      ) : null}
    </Popover>
  );
}
