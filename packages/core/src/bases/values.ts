/**
 * Frontmatter as Bases sees it (spec/api-bases): the YAML values of a note,
 * typed by YAML (numbers, booleans, lists), without Gumply's own keys.
 */
import { parse } from "yaml";
import { parseNoteTemplate } from "../note-template.js";

/** Gumply's own keys aren't Obsidian properties (spec/api v1.12 hides them too). */
const GUMPLY_KEYS = new Set(["title", "icon", "created", "updated"]);

export function frontmatterValues(raw: string): Record<string, unknown> {
  const template = parseNoteTemplate(raw);
  if (template.yaml === null) return {};
  let data: unknown;
  try {
    data = parse(template.yaml, { prettyErrors: false, uniqueKeys: false });
  } catch {
    return {};
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (!GUMPLY_KEYS.has(key)) values[key] = value;
  }
  return values;
}
