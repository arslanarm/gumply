/**
 * #7prbquxu phase 2 (spec/database-tables §5): reading a pasted block of cells. Plain text as TSV
 * (Excel, Google Sheets, Numbers and Notion all write it, with Excel's `"…"` quoting for a tab or a
 * newline inside a cell); an HTML `<table>` when the plain text has no tab. Comma text is never split.
 * Pure functions (no DOM), so the server-free unit tests cover them.
 */

/** Rows of cells from TSV: quoted fields may hold tabs, newlines and `""`; one trailing newline is ignored. */
export function parseTsv(text: string): string[][] {
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
      while (i < source.length && source[i] !== "\t" && source[i] !== "\n") {
        cell += source[i];
        i += 1;
      }
    } else {
      while (i < source.length && source[i] !== "\t" && source[i] !== "\n") {
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

/** Whether a column repeats few enough values to offer Select (≤ 12 distinct, some repeated). */
export function offersSelect(values: readonly string[]): boolean {
  const filled = values.map((value) => value.trim()).filter((value) => value !== "");
  const distinct = new Set(filled);
  return filled.length > 1 && distinct.size <= 12 && distinct.size < filled.length;
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
