/**
 * Columns in Markdown (spec/columns, #d93qerr7): Pandoc fenced divs.
 *
 *   :::: {.columns}
 *   ::: {.column width="40%"}
 *   Left blocks…
 *   :::
 *   ::: {.column}
 *   Right blocks…
 *   :::
 *   ::::
 *
 * Only this exact form is read as columns: an outer fence of n ≥ 4 colons with
 * the class `columns`, holding nothing but blank lines and `.column` divs of
 * 3 ≤ m < n colons, closed by a colon-only line of ≥ n colons. Anything else
 * (`::: note`, a lone column, an unclosed row, fences inside code) is left
 * to the other rules, so it stays exactly as it is today (D37).
 *
 * Each fence line and the blank lines around it are recorded as written, so
 * an untouched row is written back byte for byte. The blocks inside a column
 * are parsed by markdown-it itself, so every other byte rule applies there.
 */

/* markdown-it is untyped here (see wikilink plugin). */
/* eslint-disable @typescript-eslint/no-explicit-any */

export const COLUMNS_ATTR = "data-gumply-columns";
export const COLUMN_ATTR = "data-gumply-column";

export interface FenceInfo {
  colons: number;
  /** Classes from `{.a .b}` or a bare word. */
  classes: string[];
  /** `width="40%"` → 40. */
  width: number | null;
}

const OPEN = /^(:{3,})[ \t]*(?:\{([^{}]*)\}|([\w-]+))[ \t]*$/;
const CLOSE = /^(:{3,})[ \t]*$/;
const ANY_OPEN = /^ {0,3}:{3,}[ \t]*\S/;
const CODE_FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** An opening fence line, read; null when it isn't one. */
export function parseOpenFence(line: string): FenceInfo | null {
  const match = OPEN.exec(line);
  if (!match) return null;
  const attrs = match[2];
  const classes = attrs !== undefined ? [...attrs.matchAll(/(?:^|\s)\.([\w-]+)/g)].map((m) => m[1]!) : [match[3]!];
  const width = attrs !== undefined ? /(?:^|\s)width="?(\d+(?:\.\d+)?)%"?/.exec(attrs) : null;
  return { colons: match[1]!.length, classes, width: width ? Number(width[1]) : null };
}

export function closeColons(line: string): number {
  const match = CLOSE.exec(line);
  return match ? match[1]!.length : 0;
}

export interface ColumnSpan {
  /** The opening and closing fence lines, as written. */
  open: string;
  close: string;
  /** Line numbers of the opening and closing fences. */
  openLine: number;
  closeLine: number;
  /** Blank lines before the opening fence (after the row's opening or the previous column). */
  before: number;
  /** Blank lines right after the opening fence, and right before the closing one. */
  lead: number;
  trail: number;
  width: number | null;
}

export interface RowSpan {
  open: string;
  close: string;
  openLine: number;
  closeLine: number;
  /** Blank lines between the last column and the row's closing fence. */
  beforeClose: number;
  columns: ColumnSpan[];
}

const blank = (line: string | undefined) => line === undefined || line.trim().length === 0;

/**
 * The columns row starting at `start` in `lines` (searching up to `end`), or
 * null when the text there isn't exactly the columns form.
 */
export function findRow(lines: readonly string[], start: number, end: number = lines.length): RowSpan | null {
  const head = lines[start] ?? "";
  const row = parseOpenFence(head);
  if (!row || row.colons < 4 || !row.classes.includes("columns")) return null;
  const columns: ColumnSpan[] = [];
  let blanks = 0;
  let line = start + 1;
  while (line < end) {
    const text = lines[line]!;
    if (blank(text)) {
      blanks += 1;
      line += 1;
      continue;
    }
    const closing = closeColons(text);
    if (closing >= row.colons) {
      if (columns.length === 0) return null;
      return { open: head, close: text, openLine: start, closeLine: line, beforeClose: blanks, columns };
    }
    const fence = parseOpenFence(text);
    if (!fence || fence.colons < 3 || fence.colons >= row.colons || !fence.classes.includes("column")) return null;
    const column = readColumn(lines, line, end);
    if (!column) return null;
    columns.push({ ...column, before: blanks, width: fence.width });
    blanks = 0;
    line = column.closeLine + 1;
  }
  return null;
}

/** A column from its opening fence to the colon-only line that closes it. */
function readColumn(lines: readonly string[], start: number, end: number): Omit<ColumnSpan, "before" | "width"> | null {
  let code: string | null = null;
  let divs = 0;
  for (let line = start + 1; line < end; line += 1) {
    const text = lines[line]!;
    if (code !== null) {
      const marker = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(text);
      if (marker && marker[1]![0] === code[0] && marker[1]!.length >= code.length) code = null;
      continue;
    }
    const fence = CODE_FENCE.exec(text);
    if (fence) {
      code = fence[1]!;
      continue;
    }
    if (closeColons(text) >= 3) {
      if (divs > 0) {
        divs -= 1;
        continue;
      }
      let lead = 0;
      while (start + 1 + lead < line && blank(lines[start + 1 + lead])) lead += 1;
      let trail = 0;
      while (line - 1 - trail > start + lead && blank(lines[line - 1 - trail])) trail += 1;
      return { open: lines[start]!, close: text, openLine: start, closeLine: line, lead, trail };
    }
    if (ANY_OPEN.test(text)) divs += 1;
  }
  return null;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** markdown-it block rule: the exact columns form, at the top level or inside a column. */
export function columnsBlockRule(state: any, startLine: number, endLine: number, silent: boolean): boolean {
  if (state.parentType !== "root" && state.parentType !== "gumply_column") return false;
  if (state.sCount[startLine] - state.blkIndent !== 0) return false;
  const lineAt = (line: number) => String(state.src).slice(state.bMarks[line], state.eMarks[line]);
  const first = lineAt(startLine);
  if (!first.startsWith("::::")) return false;
  const lines: string[] = [];
  for (let line = 0; line < endLine; line += 1) lines.push(line < startLine ? "" : lineAt(line));
  const row = findRow(lines, startLine, endLine);
  if (!row) return false;
  if (silent) return true;

  const open = state.push("gumply_columns_open", "div", 1);
  open.block = true;
  open.map = [row.openLine, row.closeLine + 1];
  open.meta = { open: row.open, close: row.close, beforeClose: row.beforeClose };
  for (const column of row.columns) {
    const columnOpen = state.push("gumply_column_open", "div", 1);
    columnOpen.block = true;
    columnOpen.map = [column.openLine, column.closeLine + 1];
    columnOpen.meta = column;
    const from = column.openLine + 1 + column.lead;
    const to = column.closeLine - column.trail;
    if (to > from) {
      const parentType = state.parentType;
      const lineMax = state.lineMax;
      state.parentType = "gumply_column";
      state.lineMax = to;
      state.md.block.tokenize(state, from, to);
      state.parentType = parentType;
      state.lineMax = lineMax;
    }
    state.push("gumply_column_close", "div", -1).block = true;
  }
  state.push("gumply_columns_close", "div", -1).block = true;
  state.line = row.closeLine + 1;
  return true;
}

const INSTALLED = Symbol.for("gumply.columns");

/** Install the rule and its renderers once per markdown-it instance. */
export function columnsMarkdownPlugin(md: any): void {
  if (md[INSTALLED]) return;
  md[INSTALLED] = true;
  md.block.ruler.before("fence", "gumply_columns", columnsBlockRule);
  md.renderer.rules.gumply_columns_open = (tokens: any[], index: number) => {
    const meta = tokens[index].meta;
    const join = tokens[index].attrGet?.("data-md-join");
    return (
      `<div ${COLUMNS_ATTR}="" data-open="${escapeAttr(meta.open)}" data-close="${escapeAttr(meta.close)}"` +
      ` data-before-close="${meta.beforeClose}"${join ? ` data-md-join="${escapeAttr(join)}"` : ""}>\n`
    );
  };
  md.renderer.rules.gumply_columns_close = () => "</div>\n";
  md.renderer.rules.gumply_column_open = (tokens: any[], index: number) => {
    const meta = tokens[index].meta as ColumnSpan;
    const empty = meta.closeLine - meta.openLine - 1 - meta.lead - meta.trail <= 0;
    return (
      `<div ${COLUMN_ATTR}="" data-open="${escapeAttr(meta.open)}" data-close="${escapeAttr(meta.close)}"` +
      ` data-before="${meta.before}" data-lead="${meta.lead}" data-trail="${meta.trail}"` +
      `${meta.width !== null ? ` data-width="${meta.width}"` : ""}>${empty ? "<p></p>" : ""}\n`
    );
  };
  md.renderer.rules.gumply_column_close = () => "</div>\n";
}
