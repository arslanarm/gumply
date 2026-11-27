import { propertyId } from "./evaluate.js";
import type { BaseConfig } from "./format.js";

/**
 * #7prbquxu phase 3 (spec/database-tables §6): Select and Multi-select. The options belong to the database,
 * kept in its base's `properties.<id>` settings with our keys prefixed (Obsidian keeps them byte for byte
 * and may move `displayName` after them, so nothing here depends on key order):
 *
 *     properties:
 *       note.status:
 *         gumplyType: select          # or multiselect
 *         gumplyOptions:
 *           - value: Todo
 *             color: gray
 *
 * In the rows a Select is plain text and a Multi-select a YAML list, so Obsidian's filters, sort and
 * groupBy work on them as they are.
 */

export type SelectKind = "select" | "multiselect";

/**
 * #7prbquxu (@lead, data safety for the base file): the most options a paste makes for one Select. A mostly
 * unique column of thousands of rows would otherwise write thousands of options into the `.base`.
 */
export const MAX_PASTE_OPTIONS = 200;

/** Colour names, mapped to theme variables by the app (readable in both themes). */
export const SELECT_COLORS = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"] as const;
export type SelectColor = (typeof SELECT_COLORS)[number];

export interface SelectOption {
  value: string;
  color: SelectColor;
}

export interface SelectSettings {
  kind: SelectKind;
  options: SelectOption[];
}

const isColor = (value: unknown): value is SelectColor => typeof value === "string" && (SELECT_COLORS as readonly string[]).includes(value);

/** The base's settings entry for a key, in whichever id form the file uses (`status` or `note.status`). */
function entryKey(config: BaseConfig, key: string): string | null {
  for (const id of Object.keys(config.properties ?? {})) if (propertyId(id) === `note.${key}`) return id;
  return null;
}

/** A key's Select or Multi-select settings in this base, or null when it's neither. Unknown colours read as gray. */
export function selectSettings(config: BaseConfig, key: string): SelectSettings | null {
  const id = entryKey(config, key);
  const entry = id === null ? undefined : config.properties?.[id];
  const kind = entry?.gumplyType;
  if (kind !== "select" && kind !== "multiselect") return null;
  const raw = Array.isArray(entry?.gumplyOptions) ? entry.gumplyOptions : [];
  const options: SelectOption[] = [];
  for (const item of raw) {
    const value = typeof item === "object" && item !== null ? (item as { value?: unknown }).value : item;
    if (typeof value !== "string" && typeof value !== "number") continue;
    const text = String(value);
    if (text === "" || options.some((option) => option.value === text)) continue;
    const color = typeof item === "object" && item !== null ? (item as { color?: unknown }).color : undefined;
    options.push({ value: text, color: isColor(color) ? color : "gray" });
  }
  return { kind, options };
}

/**
 * The config with a key's Select settings set (or, with null, removed). Other keys of the entry
 * (`displayName`, Obsidian's own) stay; a new entry is written as `note.<key>`.
 */
export function withSelectSettings(config: BaseConfig, key: string, settings: SelectSettings | null): BaseConfig {
  const id = entryKey(config, key) ?? `note.${key}`;
  const current = { ...(config.properties?.[id] ?? {}) } as Record<string, unknown>;
  if (settings) {
    current.gumplyType = settings.kind;
    // No options yet ("+" Select): no key, rather than an empty flow list `[]` that a later option would extend
    // in flow style (`[{value: Todo, color: brown}]`). Read back, a missing list is no options.
    if (settings.options.length) current.gumplyOptions = settings.options.map((option) => ({ value: option.value, color: option.color }));
    else delete current.gumplyOptions;
  } else {
    delete current.gumplyType;
    delete current.gumplyOptions;
  }
  const properties = { ...(config.properties ?? {}) };
  if (Object.keys(current).length) properties[id] = current as { displayName?: string; [key: string]: unknown };
  else delete properties[id];
  const next: BaseConfig = { ...config };
  if (Object.keys(properties).length) next.properties = properties;
  else delete next.properties;
  return next;
}

/**
 * The order new options take their colours in. #bg7c9bzk (#faqr8pj9's #17): neighbours differ in hue, so a
 * database's first two or three options never look alike (the palette's order, brown, orange, yellow, did). Gray
 * isn't in it: it's the colour of a value with no option.
 */
export const NEW_OPTION_COLORS: readonly SelectColor[] = ["blue", "orange", "green", "purple", "red", "yellow", "pink", "brown"];

/** The colour for a new option: the first not used yet, in NEW_OPTION_COLORS's order; when all are, they repeat. */
export function nextOptionColor(options: readonly SelectOption[]): SelectColor {
  const used = new Set(options.map((option) => option.color));
  return NEW_OPTION_COLORS.find((color) => !used.has(color)) ?? NEW_OPTION_COLORS[options.length % NEW_OPTION_COLORS.length]!;
}

/** A row's value as a list of option values (a Select's text, a Multi-select's list; anything else none). */
export function selectedValues(value: unknown): string[] {
  if (typeof value === "string") return value === "" ? [] : [value];
  if (typeof value === "number") return [String(value)];
  if (Array.isArray(value)) return value.filter((item): item is string | number => typeof item === "string" || typeof item === "number").map(String);
  return [];
}
