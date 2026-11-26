/**
 * #7prbquxu (spec/database-tables §4): the spreadsheet-like keyboard of a database
 * that owns its rows. Pure helpers, so the rules are tested without a browser:
 * where a key moves the active cell, which cells start an edit when a character is
 * typed, and what typed text becomes for each column type.
 */
import type { BaseValue } from "@gumply/core";

/** A cell by its row's position in display order and its column's index. */
export interface GridPosition {
  row: number;
  col: number;
}

export type GridMove = "up" | "down" | "left" | "right" | "next" | "prev";

/**
 * Where `move` takes the active cell in a `rows` × `cols` table. "past-end" means
 * it left the last row going down (or the last cell going forward): the typing
 * row is next. Up, left, right and back stop at the edges.
 */
export function moveCell(position: GridPosition, move: GridMove, rows: number, cols: number): GridPosition | "past-end" {
  const { row, col } = position;
  switch (move) {
    case "up":
      return { row: Math.max(0, row - 1), col };
    case "down":
      return row + 1 >= rows ? "past-end" : { row: row + 1, col };
    case "left":
      return { row, col: Math.max(0, col - 1) };
    case "right":
      return { row, col: Math.min(cols - 1, col + 1) };
    case "next":
      if (col + 1 < cols) return { row, col: col + 1 };
      return row + 1 >= rows ? "past-end" : { row: row + 1, col: 0 };
    case "prev":
      if (col > 0) return { row, col: col - 1 };
      return row > 0 ? { row: row - 1, col: cols - 1 } : { row, col };
  }
}

/** The arrow and Tab keys the grid handles (null for any other key). */
export function gridMoveFor(key: string, shift: boolean): GridMove | null {
  switch (key) {
    case "ArrowUp":
      return "up";
    case "ArrowDown":
      return "down";
    case "ArrowLeft":
      return "left";
    case "ArrowRight":
      return "right";
    case "Tab":
      return shift ? "prev" : "next";
    default:
      return null;
  }
}

/**
 * What typing a character on an active cell does:
 * - "type": the text replaces the value (as in a spreadsheet);
 * - "editor": the cell's own editor opens instead (dates: a picker);
 * - "none": nothing (a checkbox toggles with Space; read-only cells can't change).
 */
export function typingStarts(type: string, editable: boolean): "type" | "editor" | "none" {
  if (!editable) return "none";
  if (type === "checkbox") return "none";
  if (type === "date" || type === "datetime") return "editor";
  return "type";
}

const LIST_TYPES = new Set(["multitext", "tags", "aliases"]);

/**
 * Typed text as a value of the column's type, or null when it isn't one (a number
 * column given "abc"). Empty text clears the value. Lists split on commas, as the
 * properties editor does; tags lose a leading `#`.
 */
export function typedValue(text: string, type: string): { value: BaseValue } | null {
  const trimmed = text.trim();
  if (trimmed === "") return { value: null };
  if (type === "number") {
    const number = Number(trimmed);
    return Number.isFinite(number) ? { value: number } : null;
  }
  if (LIST_TYPES.has(type)) {
    const parts = trimmed
      .split(",")
      .map((part) => (type === "tags" ? part.trim().replace(/^#/, "") : part.trim()))
      .filter((part, index, all) => part.length > 0 && all.indexOf(part) === index);
    return { value: parts };
  }
  return { value: trimmed };
}

/** A cell's value as copied text (one cell of a TSV): lists comma-joined, checkboxes TRUE/FALSE. */
export function copiedText(value: BaseValue, type: string): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean" || type === "checkbox") return value === true ? "TRUE" : "FALSE";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}
