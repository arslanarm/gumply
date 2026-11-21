/**
 * What a base's columns and pickers are called, and their types
 * (spec/api-bases). Note properties show their key, as in Obsidian; file
 * properties are named in the interface language.
 */
import type { BaseConfig, BaseViewResult } from "@gumply/core";
import type { MessageKey } from "../i18n/index.js";

type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

const FILE_FIELDS = ["name", "basename", "path", "folder", "ext", "ctime", "mtime", "tags", "links", "size"] as const;
type FileField = (typeof FILE_FIELDS)[number];

const FILE_TYPES: Record<FileField, string> = {
  name: "text",
  basename: "text",
  path: "text",
  folder: "text",
  ext: "text",
  ctime: "datetime",
  mtime: "datetime",
  tags: "tags",
  links: "multitext",
  size: "number",
};

/** File properties offered in pickers (Obsidian has more; these are the useful ones). */
export const PICKER_FILE_PROPERTIES = ["file.name", "file.folder", "file.ctime", "file.mtime", "file.tags"];

function fileField(id: string): FileField | null {
  if (!id.startsWith("file.")) return null;
  const field = id.slice(5);
  return (FILE_FIELDS as readonly string[]).includes(field) ? (field as FileField) : null;
}

export function propertyLabel(id: string, config: BaseConfig | null, t: Translate): string {
  const key = id.startsWith("note.") ? id.slice(5) : null;
  const display = config?.properties?.[id]?.displayName ?? (key ? config?.properties?.[key]?.displayName : undefined);
  if (typeof display === "string" && display.trim()) return display;
  const field = fileField(id);
  if (field) return t(`bases.file.${field}` as MessageKey);
  if (key !== null) return key;
  if (id.startsWith("formula.")) return id.slice(8);
  return id;
}

/** A property's type: v1.12 names for note properties, fixed ones for file properties. */
export function propertyType(id: string, result: BaseViewResult | null): string {
  const field = fileField(id);
  if (field) return FILE_TYPES[field];
  if (id.startsWith("formula.")) return "text";
  return (
    result?.columns.find((column) => column.id === id)?.type ??
    result?.properties?.find((property) => property.id === id)?.type ??
    "text"
  );
}

/** Everything a picker offers: note properties in use, formulas, then file properties. */
export function pickerProperties(config: BaseConfig | null, result: BaseViewResult | null): string[] {
  const ids = [
    ...(result?.properties ?? []).map((property) => property.id),
    ...Object.keys(config?.formulas ?? {}).map((name) => `formula.${name}`),
    ...PICKER_FILE_PROPERTIES,
  ];
  for (const column of result?.columns ?? []) if (!ids.includes(column.id)) ids.push(column.id);
  return [...new Set(ids)];
}

/** `file.name` and `file.basename` show the page itself (title, icon, link). */
export function isTitleColumn(id: string): boolean {
  return id === "file.name" || id === "file.basename";
}
