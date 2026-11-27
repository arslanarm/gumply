/**
 * #7prbquxu phase 2 (spec/database-tables §5): reading a pasted block of cells. Plain text as TSV
 * (Excel, Google Sheets, Numbers and Notion all write it, with Excel's `"…"` quoting for a tab or a
 * newline inside a cell); an HTML `<table>` when the plain text has no tab. Comma text is never split.
 * Pure functions (no DOM), so the server-free unit tests cover them.
 */

/** Rows of cells from TSV: quoted fields may hold tabs, newlines and `""`; one trailing newline is ignored. */
export function parseTsv(text: string): string[][] {
  return parseDelimited(text, "\t");
}

/**
 * Rows of cells from CSV ("Import CSV…", spec §5): RFC 4180 quoting, as the TSV reader, with commas;
 * a byte-order mark at the start is dropped. Commas are split only here, never on paste.
 */
export function parseCsv(text: string): string[][] {
  return parseDelimited(text.replace(/^\uFEFF/, ""), ",");
}

function parseDelimited(text: string, separator: "\t" | ","): string[][] {
  const source = text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let i = 0;
  // An empty source still has one empty cell, so a single blank paste isn't "no rows".
  while (i <= source.length) {
    let cell = "";
    if (source[i] === '"') {
      // Quoted: up to the closing quote; `""` is one quote.
      i += 1;
      while (i < source.length) {
        if (source[i] === '"') {
          if (source[i + 1] === '"') {
            cell += '"';
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        cell += source[i];
        i += 1;
      }
      // Anything after the closing quote up to the separator is kept as written (Excel does too).
      while (i < source.length && source[i] !== separator && source[i] !== "\n") {
        cell += source[i];
        i += 1;
      }
    } else {
      while (i < source.length && source[i] !== separator && source[i] !== "\n") {
        cell += source[i];
        i += 1;
      }
    }
    row.push(cell);
    if (i >= source.length) {
      rows.push(row);
      break;
    }
    if (source[i] === "\n") {
      rows.push(row);
      row = [];
    }
    i += 1;
  }
  return rows;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1]?.toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** Rows of cells from the first `<table>` in HTML (cell text, `<br>` as a newline), or null when there's none. */
export function parseHtmlTable(html: string): string[][] | null {
  const table = /<table[\s>][\s\S]*?<\/table>/i.exec(html)?.[0];
  if (!table) return null;
  const rows: string[][] = [];
  for (const tr of table.match(/<tr[\s>][\s\S]*?<\/tr>/gi) ?? []) {
    const cells = [...tr.matchAll(/<t[dh](?:\s[^>]*)?>([\s\S]*?)<\/t[dh]>/gi)].map((match) =>
      decodeEntities((match[1] ?? "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""))
        .replace(/[ \t]+/g, " ")
        .trim(),
    );
    if (cells.length) rows.push(cells);
  }
  return rows.length ? rows : null;
}

/**
 * What a paste holds: `{ value }` for one value (no tab, no newline: it goes into the active cell as
 * typing would), `{ rows }` for a block. TSV when the plain text has a tab or several lines; the HTML
 * table when the plain text has no tab (a one-column copy from some apps); never split on commas.
 */
export function readPaste(text: string, html = ""): { value: string } | { rows: string[][] } {
  const plain = text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  if (plain.includes("\t")) return { rows: parseTsv(plain) };
  const fromHtml = html ? parseHtmlTable(html) : null;
  if (fromHtml && (fromHtml.length > 1 || (fromHtml[0]?.length ?? 0) > 1)) return { rows: fromHtml };
  if (plain.includes("\n")) return { rows: parseTsv(plain) };
  return { value: plain };
}

/** A column type a pasted column looks like (spec §5): never Select silently; that's offered separately. */
export type GuessedType = "number" | "checkbox" | "date" | "text";

const TRUE_WORDS = new Set(["true", "yes", "✓", "✔"]);
const FALSE_WORDS = new Set(["false", "no", ""]);

export function guessType(values: readonly string[]): GuessedType {
  const filled = values.map((value) => value.trim()).filter((value) => value !== "");
  if (filled.length === 0) return "text";
  if (filled.every((value) => /^-?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(value))) return "number";
  const lower = values.map((value) => value.trim().toLowerCase());
  if (lower.every((value) => TRUE_WORDS.has(value) || FALSE_WORDS.has(value)) && lower.some((value) => TRUE_WORDS.has(value))) return "checkbox";
  if (filled.every((value) => /^\d{4}-\d{2}-\d{2}$/.test(value) || /^\d{1,2}[./]\d{1,2}[./]\d{4}$/.test(value))) return "date";
  return "text";
}

export { MAX_PASTE_OPTIONS } from "@gumply/core";

/** A Select's options from a pasted column: each distinct non-empty value (a Multi-select's items split), in order. */
export function pastedOptions(values: readonly string[], kind: "select" | "multiselect"): string[] {
  const out: string[] = [];
  for (const cell of values) {
    const parsed = pastedValue(cell, kind === "select" ? "text" : "multitext");
    const items = parsed === null || parsed.value === null ? [] : Array.isArray(parsed.value) ? parsed.value : [String(parsed.value)];
    for (const item of items) if (item !== "" && !out.includes(item)) out.push(item);
  }
  return out;
}

/** Whether a column repeats few enough values to offer Select (≤ 12 distinct, some repeated). */
export function offersSelect(values: readonly string[]): boolean {
  const filled = values.map((value) => value.trim()).filter((value) => value !== "");
  const distinct = new Set(filled);
  // #bg7c9bzk (#faqr8pj9's #13): the hint says "only a few values, each repeated", so it's offered only when that's
  // mostly true: a text column (numbers, dates and checkboxes have their own types), at most 12 values, and at least
  // half the cells hold a value used more than once. One repeat among many unique values isn't a Select.
  if (filled.length < 2 || distinct.size > 12 || distinct.size === filled.length) return false;
  const uses = new Map<string, number>();
  for (const value of filled) uses.set(value, (uses.get(value) ?? 0) + 1);
  const inRepeats = filled.filter((value) => (uses.get(value) ?? 0) > 1).length;
  if (inRepeats * 2 < filled.length) return false;
  return guessType(filled) === "text";
}

/**
 * Whether the first row reads as headers (spec §5): every cell non-empty, unique text (not a number or
 * a date), and at least one later column isn't text.
 */
export function guessHeaderRow(rows: readonly string[][]): boolean {
  const [first, ...rest] = rows;
  if (!first || rest.length === 0) return false;
  const cells = first.map((cell) => cell.trim());
  if (cells.some((cell) => cell === "") || new Set(cells).size !== cells.length) return false;
  if (cells.some((cell) => guessType([cell]) !== "text")) return false;
  return cells.some((_, col) => guessType(rest.map((row) => row[col] ?? "")) !== "text");
}

/**
 * A pasted cell as a value of its column's type, or null when it isn't one (left out, and counted).
 * Checkboxes read TRUE/FALSE, yes/no, ✓ and empty; numbers allow thousands commas; dates take ISO and
 * day-first `05.01.2026` / `05/01/2026`; other types as typed (lists split on commas).
 */
export function pastedValue(text: string, type: string): { value: string | number | boolean | string[] | null } | null {
  const trimmed = text.trim();
  if (type === "checkbox") {
    const lower = trimmed.toLowerCase();
    if (TRUE_WORDS.has(lower)) return { value: true };
    if (FALSE_WORDS.has(lower)) return { value: false };
    return null;
  }
  if (trimmed === "") return { value: null };
  if (type === "number") {
    const number = Number(trimmed.replace(/,(?=\d{3}(\D|$))/g, ""));
    return Number.isFinite(number) ? { value: number } : null;
  }
  if (type === "date") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return { value: trimmed };
    const dayFirst = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(trimmed);
    if (dayFirst) return { value: `${dayFirst[3]}-${dayFirst[2]!.padStart(2, "0")}-${dayFirst[1]!.padStart(2, "0")}` };
    return null;
  }
  if (type === "multitext" || type === "tags" || type === "aliases") {
    const parts = trimmed
      .split(",")
      .map((part) => (type === "tags" ? part.trim().replace(/^#/, "") : part.trim()))
      .filter((part, index, all) => part.length > 0 && all.indexOf(part) === index);
    return { value: parts };
  }
  return { value: trimmed };
}

/** One row of a paste: an existing row (its id and the version it was shown at) or a new one (its title). */
export interface PastedRow {
  id?: string;
  expectedUpdated?: string;
  title?: string;
  set: Record<string, string | number | boolean | string[] | null>;
}

/** A column as the paste sees it. */
export interface PasteColumn {
  id: string;
  type: string;
  editable: boolean;
}

/**
 * A block pasted at the active cell (spec §5): it overwrites down and right; rows past the end become new
 * rows, named by the title column's value (or `untitled`). Not written: title cells of existing rows (a
 * rename isn't a paste), read-only columns, values that don't fit their column's type, and columns past
 * the last one (the "+" step comes later); each is counted, so the view can say so.
 */
export function plannedPaste(
  block: readonly string[][],
  start: { row: number; col: number },
  columns: readonly PasteColumn[],
  /** The view's rows in order, with the version each was shown at (a paste sets values over what was seen). */
  existing: ReadonlyArray<{ id: string; updated: string }>,
  untitled: string,
): { rows: PastedRow[]; left: number; pastLast: number } {
  const rows: PastedRow[] = [];
  let left = 0;
  let pastLast = 0;
  block.forEach((cells, r) => {
    const shown = existing[start.row + r];
    const id = shown?.id;
    const row: PastedRow = shown === undefined ? { set: {} } : { id: shown.id, expectedUpdated: shown.updated, set: {} };
    cells.forEach((text, c) => {
      const column = columns[start.col + c];
      if (!column) {
        if (r === 0) pastLast += 1;
        return;
      }
      if (column.id === "file.name" || column.id === "file.basename") {
        if (id === undefined) row.title = text.trim();
        else if (text.trim() !== "") left += 1;
        return;
      }
      if (!column.editable || !column.id.startsWith("note.")) {
        left += 1;
        return;
      }
      const value = pastedValue(text, column.type);
      if (value === null) left += 1;
      else row.set[column.id.slice(5)] = value.value;
    });
    if (id === undefined && !row.title) row.title = untitled;
    if (id === undefined || Object.keys(row.set).length) rows.push(row);
  });
  return { rows, left, pastLast };
}
