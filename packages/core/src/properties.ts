/**
 * Page properties (v0.7 A, D34): frontmatter keys, typed like Obsidian
 * Properties. Pure helpers shared by the server and the web app; the YAML
 * itself is read on the server.
 */
import { isAliasesKey, isTagsKey } from "./frontmatter-keys.js";
import { normalizeTags } from "./frontmatter.js";

/** Obsidian's property types (the names in `.obsidian/types.json`). */
export type PropertyType = "text" | "multitext" | "number" | "checkbox" | "date" | "datetime" | "tags" | "aliases";

export const PROPERTY_TYPES: readonly PropertyType[] = [
  "text",
  "multitext",
  "number",
  "checkbox",
  "date",
  "datetime",
  "tags",
  "aliases",
];

export type PropertyValue = string | number | boolean | string[] | null;

/** One frontmatter key of a page, as the properties block shows it. */
export interface Property {
  key: string;
  type: PropertyType;
  value: PropertyValue;
  /** False for YAML Gumply can't edit safely (nested maps, multi-line text): shown read-only, never rewritten. */
  editable: boolean;
  /** On the page's tags key: a value Obsidian won't read as tags (#6imze6ux). */
  issue?: TagsValueIssue;
}

/**
 * A `tags` value Gumply shows as tags but Obsidian 1.14 doesn't (#6imze6ux,
 * measured by @opus-hunter):
 * - `tags-string`: a string with a space or a comma (`tags: a, b`). Obsidian
 *   reads nothing; Gumply splits it. Fixable: make it a list of those tags.
 * - `tags-digits`: tags made only of digits (`2024`, `[2024]`, `"2029"`),
 *   which Obsidian never counts (its inline rule too).
 */
export interface TagsValueIssue {
  kind: "tags-string" | "tags-digits";
  /** `tags-string`: the tags Gumply reads (the list "Make it a list" writes); `tags-digits`: the all-digit ones. */
  tags: string[];
}

/** The issue with a raw `tags` value, or null when Obsidian reads it as Gumply does. */
export function tagsValueIssue(raw: unknown): TagsValueIssue | null {
  if (typeof raw === "string" && /[\s,]/.test(raw.trim())) {
    const tags = normalizeTags(raw);
    return tags.length > 0 ? { kind: "tags-string", tags } : null;
  }
  const items = Array.isArray(raw) ? raw : raw === null || raw === undefined ? [] : [raw];
  const digits = items.map((item) => String(item).trim().replace(/^#+/, "")).filter((tag) => /^\d+$/.test(tag));
  return digits.length > 0 ? { kind: "tags-digits", tags: digits } : null;
}

/** `GET /api/properties`: every key used in the vault. */
export interface PropertyInfo {
  key: string;
  type: PropertyType;
  /** Pages that have this key. */
  count: number;
}

/** A change to one page's properties (`PUT /api/pages/:id`, `properties`). */
export interface PropertiesPatch {
  set?: Record<string, PropertyValue>;
  remove?: string[];
  rename?: Array<{ from: string; to: string }>;
}

/** Gumply shows these in the page header itself, not as properties. */
export const HEADER_KEYS: readonly string[] = ["title", "icon", "created", "updated"];

export function isPropertyType(value: unknown): value is PropertyType {
  return typeof value === "string" && (PROPERTY_TYPES as readonly string[]).includes(value);
}

/**
 * A property name Gumply can write and read back (#8s94nyhn): any text a spreadsheet header holds,
 * punctuation included (`Water every (days)`, `Price ($)`, `E-mail/phone`, `Due?`), as Obsidian and YAML
 * accept it; the frontmatter writer quotes a key where YAML needs it (`yamlKey`). Refused: an empty or
 * over-long name, spaces at either end, a control character or line break (one line in the file), and a
 * name starting `file.`, `note.` or `formula.`, which a `.base` would read as another column.
 */
export function isValidPropertyKey(key: unknown): key is string {
  return (
    typeof key === "string" &&
    key.length > 0 &&
    key.length <= 100 &&
    key === key.trim() &&
    !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(key) &&
    !/^(file|note|formula)\./.test(key)
  );
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** The type a value looks like (no stored type). */
function typeOfValue(value: unknown): PropertyType | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return "checkbox";
  if (typeof value === "number") return "number";
  if (Array.isArray(value)) return "multitext";
  if (typeof value === "string" && DATE.test(value)) return "date";
  if (typeof value === "string" && DATETIME.test(value)) return "datetime";
  return "text";
}

/**
 * The type of a key without a stored one: `tags`/`aliases` by name (as in
 * Obsidian), else what most of its non-empty values look like (text when
 * they disagree or there are none).
 */
export function inferPropertyType(key: string, values: readonly unknown[]): PropertyType {
  // In any case, plural only, as Obsidian (`Tags`, `Aliases`; not `tag`, #ippqkgus).
  if (isTagsKey(key)) return "tags";
  if (isAliasesKey(key)) return "aliases";
  const counts = new Map<PropertyType, number>();
  for (const value of values) {
    const type = typeOfValue(value);
    if (type) counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  let best: PropertyType = "text";
  let most = 0;
  for (const [type, count] of counts) {
    if (count > most) {
      best = type;
      most = count;
    }
  }
  return best;
}

/**
 * A value in the shape its type stores (what gets written): numbers and
 * booleans as such, lists as string arrays, dates as `YYYY-MM-DD` /
 * `YYYY-MM-DDTHH:mm`, empty as null. Returns undefined when it can't be.
 */
export function coercePropertyValue(type: PropertyType, value: unknown): PropertyValue | undefined {
  if (value === null || value === undefined || value === "") return null;
  switch (type) {
    case "number": {
      const number = typeof value === "number" ? value : Number(String(value).trim());
      return Number.isFinite(number) ? number : undefined;
    }
    case "checkbox":
      if (typeof value === "boolean") return value;
      if (value === "true" || value === "false") return value === "true";
      return undefined;
    case "multitext":
    case "tags":
    case "aliases": {
      const items = (Array.isArray(value) ? value : [value]).map((item) => String(item).trim()).filter((item) => item.length > 0);
      return type === "tags" ? items.map((tag) => tag.replace(/^#/, "")) : items;
    }
    case "date": {
      const text = String(value).trim();
      return DATE.test(text) ? text : DATETIME.test(text) ? text.slice(0, 10) : undefined;
    }
    case "datetime": {
      const text = String(value).trim();
      return DATETIME.test(text) ? text : DATE.test(text) ? `${text}T00:00` : undefined;
    }
    default:
      return Array.isArray(value) ? value.join(", ") : String(value);
  }
}

/**
 * Whether a value already has its type's shape (what Obsidian checks before
 * showing a type mismatch). Empty always fits.
 */
export function propertyValueMatches(type: PropertyType, value: PropertyValue): boolean {
  if (value === null || value === "") return true;
  switch (type) {
    case "number":
      return typeof value === "number";
    case "checkbox":
      return typeof value === "boolean";
    case "date":
      return typeof value === "string" && DATE.test(value);
    case "datetime":
      return typeof value === "string" && DATETIME.test(value);
    case "multitext":
    case "tags":
    case "aliases":
      return Array.isArray(value);
    default:
      return !Array.isArray(value);
  }
}

/**
 * The value converted to a new type, when that is clean (#qw4pcm2h review):
 * `"2"` → 2, `"true"` → true, a date string → a date, a single value → a
 * one-item list, a number → text. Undefined when it doesn't convert, or
 * would lose something (a list never becomes text).
 */
export function convertPropertyValue(type: PropertyType, value: PropertyValue): PropertyValue | undefined {
  if (propertyValueMatches(type, value)) return undefined;
  if (Array.isArray(value) && (type === "text" || type === "number" || type === "checkbox" || type === "date" || type === "datetime")) {
    return undefined;
  }
  const converted = coercePropertyValue(type, value);
  return converted === undefined || converted === null || !propertyValueMatches(type, converted) ? undefined : converted;
}
