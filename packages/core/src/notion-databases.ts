/**
 * Notion databases → row-page frontmatter and a `.base` (v0.8 B3, #cwi22mc6;
 * spec/notion-import §6). Pure helpers for the planner in notion-import.ts.
 *
 * A Notion export carries no column types and no view settings: types are
 * inferred from the values (a type only when every non-empty value fits it,
 * else text), and the views are Gumply's defaults (a table in the order of
 * the exported view, plus a board where the export points to one).
 */
import { Document } from "yaml";
import { isValidPropertyKey, type PropertyType } from "./properties.js";

/** RFC 4180 CSV: BOM, CRLF or LF, quoted cells with commas, quotes and newlines. */
export function parseCsv(text: string): string[][] {
  const source = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let started = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]!;
    started = true;
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      started = false;
    } else cell += char;
  }
  if (started || cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const DATE_TEXT = /^([A-Za-z]+) (\d{1,2}), (\d{4})(?: (\d{1,2}):(\d{2}) ?([AP]M))?$/;

const pad = (value: number) => String(value).padStart(2, "0");

/** "November 3, 2026" → date `2026-11-03`; "November 3, 2026 4:05 PM" → datetime `2026-11-03T16:05`. English exports only. */
export function parseNotionDate(value: string): { type: "date" | "datetime"; iso: string } | null {
  const match = DATE_TEXT.exec(value.trim());
  if (!match) return null;
  const month = MONTHS.indexOf(match[1]!.toLowerCase()) + 1;
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (month === 0 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  const date = `${year}-${pad(month)}-${pad(day)}`;
  if (match[4] === undefined) return { type: "date", iso: date };
  let hour = Number(match[4]);
  const minute = Number(match[5]);
  if (hour < 1 || hour > 12 || minute > 59) return null;
  if (match[6] === "AM" && hour === 12) hour = 0;
  if (match[6] === "PM" && hour !== 12) hour += 12;
  return { type: "datetime", iso: `${date}T${pad(hour)}:${pad(minute)}` };
}

/** Gumply's own header keys: a Notion column never takes them (D37). */
const RESERVED_KEYS = new Set(["title", "icon", "created", "updated", "aliases", "cssclasses"]);
const NOTION_TIME_COLUMNS: Record<string, string> = { "created time": "created-notion", "last edited time": "edited-notion" };

/**
 * A Notion column name as a property key (§6): characters a key can't hold
 * become a space, runs collapse, the result is trimmed; empty → `property`;
 * a key taken in this database (case-insensitive) gets ` 2`, ` 3`…
 */
export function notionPropertyKey(header: string, used: Set<string>): string {
  const special = NOTION_TIME_COLUMNS[header.trim().toLowerCase()];
  let key =
    special ??
    header
      .normalize("NFC")
      .replace(/[^\p{L}\p{N}_ -]/gu, " ")
      .replace(/\s+/g, " ")
      .replace(/^[ -]+/, "")
      .trim()
      .slice(0, 100)
      .trim();
  if (!key) key = "property";
  if (RESERVED_KEYS.has(key.toLowerCase())) key = `${key}-notion`;
  let candidate = key;
  for (let n = 2; used.has(candidate.toLowerCase()) || !isValidPropertyKey(candidate); n += 1) {
    candidate = `${key.slice(0, 95)} ${n}`;
    if (n > 1000) break;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/** One item of a relation cell: `Title (Title%20<id>.md)` or `Title (https://www.notion.so/Title-<id>)` (unverified). */
export interface RelationItem {
  title: string;
  id: string;
  ref: string;
}

// The id is the last 32-hex run in the reference (`%20` before it is hex too).
const RELATION_ITEM = /(.+?) \(([^()\s]*([0-9a-f]{32})(?![0-9a-f])[^()\s]*)\)(?:, |$)/gy;

/** The items of a relation cell, or null when it isn't one. */
export function parseRelationCell(value: string): RelationItem[] | null {
  const items: RelationItem[] = [];
  RELATION_ITEM.lastIndex = 0;
  let end = 0;
  for (let match = RELATION_ITEM.exec(value); match; match = RELATION_ITEM.exec(value)) {
    items.push({ title: match[1]!, ref: match[2]!, id: match[3]! });
    end = RELATION_ITEM.lastIndex;
    if (end >= value.length) break;
  }
  return items.length > 0 && end === value.length ? items : null;
}

const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?$/;
const LIST_NAME = /^(tags?|labels?|categor(y|ies)|topics?|keywords?)$/i;

/** What a column holds, from its values. `relation` is written as a list of links. */
export type NotionColumnKind = Exclude<PropertyType, "tags" | "aliases"> | "relation";

/**
 * The column's kind (§6): one only when every non-empty value fits it, else
 * `text`. Multi-select needs a list-like name or commas in most rows with
 * short items (unverified until B5).
 */
export function inferNotionColumn(header: string, values: readonly string[]): NotionColumnKind {
  const filled = values.filter((value) => value.trim().length > 0);
  if (filled.length === 0) return "text";
  if (filled.every((value) => NUMBER.test(value.trim()))) return "number";
  if (filled.every((value) => value === "Yes" || value === "No")) return "checkbox";
  const dates = filled.map(parseNotionDate);
  if (dates.every((date) => date?.type === "date")) return "date";
  if (dates.every((date) => date?.type === "datetime")) return "datetime";
  if (filled.every((value) => parseRelationCell(value) !== null)) return "relation";
  // Dates ("November 3, 2026", ranges) have commas too: never a list.
  if (filled.some((value) => /[A-Za-z]+ \d{1,2}, \d{4}/.test(value))) return "text";
  const lists = filled.map((value) => value.split(", "));
  const shortItems = lists.every((items) => items.every((item) => item.trim().length > 0 && item.length <= 40 && !/[\n.]\s/.test(item)));
  const withCommas = lists.filter((items) => items.length > 1).length;
  const listLike = LIST_NAME.test(header.trim()) || (filled.length >= 3 && withCommas * 2 > filled.length);
  if (shortItems && listLike) return "multitext";
  return "text";
}

/** The property type a column kind is stored as. */
export function columnPropertyType(kind: NotionColumnKind): PropertyType {
  return kind === "relation" ? "multitext" : kind;
}

/** A cell as a frontmatter value (undefined: an empty cell, no key written). */
export function columnValue(
  kind: NotionColumnKind,
  value: string,
  link: (item: RelationItem) => string,
): string | number | boolean | string[] | undefined {
  if (value.trim().length === 0) return undefined;
  switch (kind) {
    case "number":
      return Number(value.trim());
    case "checkbox":
      return value === "Yes";
    case "date":
    case "datetime":
      return parseNotionDate(value)!.iso;
    case "relation":
      return parseRelationCell(value)!.map(link);
    case "multitext":
      return value.split(", ").map((item) => item.trim()).filter(Boolean);
    default:
      return value;
  }
}

/** Boards with more groups than this get no Kanban view (§6). */
export const KANBAN_MAX_GROUPS = 12;

/** A text column short enough to be a select or status (one line, ≤ 60 characters). */
export function isSelectLike(kind: NotionColumnKind, values: readonly string[]): boolean {
  return kind === "text" && values.every((value) => !/[\r\n]/.test(value) && value.length <= 60);
}

export interface NotionBaseSpec {
  /** Vault folder of the rows: the filter matches its direct children. */
  rowsFolder: string;
  /** Table columns after the title, in the exported view's order. */
  columns: string[];
  kanban: { key: string; groups: string[]; columns: string[] } | null;
}

const YAML_OUT = { lineWidth: 0, minContentWidth: 0, flowCollectionPadding: false } as const;

/** The `.base` file for an imported database (§6). */
export function notionBaseSource(spec: NotionBaseSpec): string {
  const views: Record<string, unknown>[] = [{ type: "table", name: "Table", order: ["file.name", ...spec.columns] }];
  if (spec.kanban) {
    views.push({
      type: "kanban",
      name: "Board",
      order: ["file.name", ...spec.kanban.columns],
      groupBy: { property: spec.kanban.key, direction: "ASC" },
      groupOrder: spec.kanban.groups,
    });
  }
  const doc = new Document({ filters: { and: [`file.folder == ${JSON.stringify(spec.rowsFolder)}`] }, views });
  return doc.toString(YAML_OUT);
}
