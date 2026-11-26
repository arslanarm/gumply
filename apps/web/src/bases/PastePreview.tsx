import { useEffect, useId, useMemo, useRef, useState } from "react";
import { isValidPropertyKey, type PropertyType, type SelectKind } from "@gumply/core";
import { useT } from "../i18n/index.js";
import { useModal } from "../lib/modal.js";
import { MAX_PASTE_OPTIONS, guessHeaderRow, guessType, offersSelect, pasteColumnNames, pastedOptions, pastedValue, type PastedRow } from "./paste.js";

/** The types a pasted column can take here; Select and Multi-select keep their options in the base. */
type PreviewType = PropertyType | SelectKind;
const PREVIEW_TYPES: readonly PreviewType[] = ["text", "number", "checkbox", "date", "multitext", "select", "multiselect"];
const isSelectKind = (type: PreviewType): type is SelectKind => type === "select" || type === "multiselect";
/** Above this many rows, the paste asks once more (spec §5). */
export const PASTE_CONFIRM_ROWS = 1_000;

export interface PreviewResult {
  rows: PastedRow[];
  /** The columns' keys in order (the view gains the ones it doesn't show yet). */
  keys: string[];
  /** Each new key's type (set only where the vault has none): a Select is text, a Multi-select a list. */
  types: Record<string, PropertyType>;
  /** Columns made Select or Multi-select: their pasted values become the base's options, in the same request. */
  selects: Record<string, { kind: SelectKind; values: string[] }>;
}

/**
 * #7prbquxu phase 2, step 3 (spec/database-tables §5, mock-up 3): a block pasted into an empty database or
 * on the typing row. "Paste N rows into “People”": the first row as headers (guessed), a name and a type
 * per column (guessed, changeable), the first column is the row's name. Every row is new; nothing is
 * written until Paste, and then in one request.
 */
export function PastePreview(props: {
  block: string[][];
  database: string;
  /** Keys the database has already, with their types (a header naming one takes it). */
  known: ReadonlyMap<string, string>;
  untitled: string;
  onCancel: () => void;
  onPaste: (result: PreviewResult) => void;
}) {
  const t = useT();
  const id = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useModal(dialogRef);
  const width = Math.max(...props.block.map((row) => row.length));
  const [headers, setHeaders] = useState(() => guessHeaderRow(props.block));
  const body = headers ? props.block.slice(1) : props.block;
  const headerRow = props.block[0] ?? [];
  // #8s94nyhn: without a header row, the columns fill the database's existing ones in order.
  const defaults = pasteColumnNames(width, headers ? headerRow : null, [...props.known.keys()]);
  const defaultName = (col: number) => defaults[col] ?? t("bases.pasteColumn", { n: col + 1 });
  const [names, setNames] = useState<Record<number, string>>({});
  const [types, setTypes] = useState<Record<number, PreviewType>>({});
  const nameOf = (col: number) => names[col] ?? defaultName(col);
  const typeOf = (col: number): PreviewType => {
    const known = props.known.get(nameOf(col).trim());
    if (known && (PREVIEW_TYPES as readonly string[]).includes(known)) return known as PreviewType;
    // Guessed, never Select by itself (spec §5): that's offered by the hint.
    return types[col] ?? (guessType(body.map((row) => row[col] ?? "")) as PropertyType);
  };
  const [confirming, setConfirming] = useState(false);
  /** More distinct values than a paste may make options from (@lead, data safety for the base file). */
  const tooManyOptions = (col: number, kind: SelectKind) => pastedOptions(body.map((row) => row[col] ?? ""), kind).length > MAX_PASTE_OPTIONS;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        props.onCancel();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const columns = Array.from({ length: width }, (_, col) => col).slice(1);
  const problem = useMemo(() => {
    const seen = new Set<string>();
    for (const col of columns) {
      const name = nameOf(col).trim();
      if (!isValidPropertyKey(name)) return t("bases.pasteBadName", { name });
      if (seen.has(name)) return t("bases.pasteDuplicateName", { name });
      seen.add(name);
      // A column that's a Select already would gain more options than a paste may make.
      const type = typeOf(col);
      if (isSelectKind(type) && tooManyOptions(col, type)) return t("bases.pasteTooManyOptions", { name, count: MAX_PASTE_OPTIONS });
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [names, headers, width, types]);

  const paste = () => {
    if (problem || body.length === 0) return;
    if (body.length > PASTE_CONFIRM_ROWS && !confirming) {
      setConfirming(true);
      return;
    }
    const keys = columns.map((col) => nameOf(col).trim());
    // A Select's value is its text; a Multi-select's a list (comma-separated in a cell).
    const valueType = (type: PreviewType) => (type === "select" ? "text" : type === "multiselect" ? "multitext" : type);
    const rows: PastedRow[] = body.map((cells) => {
      const set: PastedRow["set"] = {};
      columns.forEach((col, index) => {
        const value = pastedValue(cells[col] ?? "", valueType(typeOf(col)));
        if (value !== null && value.value !== null) set[keys[index]!] = value.value;
      });
      return { title: (cells[0] ?? "").trim() || props.untitled, set };
    });
    const typesByKey: Record<string, PropertyType> = {};
    const selects: PreviewResult["selects"] = {};
    columns.forEach((col, index) => {
      const key = keys[index]!;
      const type = typeOf(col);
      if (!props.known.has(key)) typesByKey[key] = valueType(type) as PropertyType;
      if (isSelectKind(type)) {
        const values = rows.flatMap((row) => {
          const value = row.set[key];
          return Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
        });
        selects[key] = { kind: type, values: values.filter((value, at) => values.indexOf(value) === at) };
      }
    });
    props.onPaste({ rows, keys, types: typesByKey, selects });
  };

  const shown = body.slice(0, 5);
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && props.onCancel()}>
      <div className="modal base-paste-preview" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} data-testid="base-paste-preview" ref={dialogRef}>
        <h2 id={`${id}-title`}>{t("bases.pasteHeading", { count: body.length, name: props.database })}</h2>
        <p className="base-paste-source">{t("bases.pasteSource", { lines: props.block.length, columns: width })}</p>
        <label className="base-check">
          <input type="checkbox" data-testid="base-paste-headers" checked={headers} onChange={(event) => setHeaders(event.target.checked)} />
          <span>{t("bases.pasteHeaders")}</span>
        </label>
        <div className="base-paste-columns">
          <div className="base-paste-column is-name">
            <span className="base-panel-title">{t("bases.pasteNameColumn")}</span>
            <span className="base-paste-first">{headers ? (headerRow[0] ?? "") : t("bases.pasteColumn", { n: 1 })}</span>
          </div>
          {columns.map((col) => {
            const known = props.known.has(nameOf(col).trim());
            const values = body.map((row) => row[col] ?? "");
            const noSelect = !known && tooManyOptions(col, "select") && tooManyOptions(col, "multiselect");
            return (
              <div className="base-paste-column" key={col}>
                <input
                  className="base-input"
                  data-testid={`base-paste-name-${col}`}
                  aria-label={t("bases.columnName")}
                  value={nameOf(col)}
                  onChange={(event) => setNames((current) => ({ ...current, [col]: event.target.value }))}
                />
                <select
                  className="base-select"
                  data-testid={`base-paste-type-${col}`}
                  aria-label={t("properties.type")}
                  value={typeOf(col)}
                  disabled={known}
                  onChange={(event) => setTypes((current) => ({ ...current, [col]: event.target.value as PreviewType }))}
                >
                  {PREVIEW_TYPES.map((type) => (
                    <option key={type} value={type} disabled={noSelect && isSelectKind(type)}>
                      {type === "select" ? t("bases.selectType") : type === "multiselect" ? t("bases.multiselectType") : t(`properties.types.${type}`)}
                    </option>
                  ))}
                </select>
                {known ? (
                  <span className="base-paste-hint">{t("bases.pasteKnownColumn")}</span>
                ) : noSelect ? (
                  <span className="base-paste-hint" data-testid={`base-paste-no-select-${col}`}>
                    {t("bases.pasteNoSelect", { count: MAX_PASTE_OPTIONS })}
                  </span>
                ) : offersSelect(values) && !isSelectKind(typeOf(col)) ? <span className="base-paste-hint" data-testid={`base-paste-select-hint-${col}`}>{t("bases.pasteSelectHint")}</span> : null}
              </div>
            );
          })}
        </div>
        <table className="base-paste-sample" data-testid="base-paste-sample">
          <tbody>
            {shown.map((cells, r) => (
              <tr key={r}>
                {Array.from({ length: width }, (_, c) => (
                  <td key={c}>{cells[c] ?? ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {problem ? (
          <p className="base-add-column-note is-error" role="alert" data-testid="base-paste-problem">
            {problem}
          </p>
        ) : confirming ? (
          <p className="base-add-column-note" role="alert" data-testid="base-paste-many">
            {t("bases.pasteMany", { count: body.length })}
          </p>
        ) : null}
        <div className="modal-actions">
          <button type="button" className="button-secondary" data-testid="base-paste-cancel" onClick={props.onCancel}>
            {t("common.cancel")}
          </button>
          <button type="button" className="button-primary" data-testid="base-paste-confirm" disabled={Boolean(problem) || body.length === 0} onClick={paste}>
            {confirming ? t("bases.pasteAll", { count: body.length }) : t("bases.pasteConfirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
