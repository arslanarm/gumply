/**
 * YAML frontmatter parsing/serialisation for note files (D2).
 *
 * Only the subset Obsidian-compatible notes need is supported: top-level
 * `key: value` pairs, quoted strings, inline lists and block lists.
 * Nested objects and multi-line strings are out of scope for the MVP.
 */

import { frontmatterKey, isTagsKey, matchKeyLine, yamlKey } from "./frontmatter-keys.js";
import { splitTrailingComment } from "./note-template.js";
import { isWholeWikilink } from "./wikilink-syntax.js";

export { frontmatterKey, isAliasesKey, isTagsKey } from "./frontmatter-keys.js";

export interface Frontmatter {
  title?: string;
  icon?: string;
  tags?: string[];
  created?: string;
  updated?: string;
  [key: string]: unknown;
}

export interface ParsedNote {
  frontmatter: Frontmatter;
  /** Markdown body with the frontmatter block removed. */
  content: string;
}

const FRONTMATTER_FENCE = /^---\s*$/;
const LIST_ITEM = /^[ \t]+-\s*(.*)$/;

const KEY_ORDER = ["title", "icon", "tags", "created", "updated"] as const;

function parseScalar(raw: string): string | undefined {
  const value = raw.trim();
  if (value.length === 0) return undefined;
  if (value === "~" || value === "null" || value === "NULL") return undefined;
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try {
      // JSON string escapes cover the quoted values we write ourselves.
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function splitInlineList(value: string): string[] {
  return value
    .slice(1, -1)
    .split(",")
    .map((item) => parseScalar(item) ?? "")
    .filter((item) => item.length > 0);
}

/** The value of `tags` / `aliases` in a parsed frontmatter, under whichever spelling the note uses. */
export function frontmatterValue(frontmatter: Readonly<Record<string, unknown>>, name: "tags" | "aliases"): unknown {
  const key = frontmatterKey(Object.keys(frontmatter), name);
  return key === undefined ? undefined : frontmatter[key];
}

/** Normalise tags from frontmatter (string, comma list or array). */
export function normalizeTags(value: unknown): string[] {
  // #7xbdttxy: a whole-value `[[link]]` under `tags` is a link in Obsidian 1.14, never a tag
  // (checked before a string is split, so `"[[Alpha Beta]]"` doesn't become two tags).
  if (typeof value === "string" && isWholeWikilink(value.trim())) return [];
  const raw: string[] = Array.isArray(value)
    ? value.map((item) => String(item)).filter((item) => !isWholeWikilink(item.trim()))
    : typeof value === "string"
      ? value.split(/[,\s]+/)
      : [];

  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of raw) {
    const tag = item.trim().replace(/^#+/, "").replace(/\s+/g, "-");
    if (tag.length === 0) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}

/**
 * Parse a note file into frontmatter + Markdown body.
 * Files without a complete frontmatter block are the body as a whole.
 *
 * The body never carries the file's final line terminator or trailing blank
 * lines (#5fv7c25w): every note, with or without frontmatter, reads the same
 * way, and what the editor saves compares equal. The file's own ending (LF,
 * CRLF, or none) is kept on write by `serializeNoteLike`.
 */
export function parseFrontmatter(raw: string): ParsedNote {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const lines = text.split("\n");

  if (lines.length === 0 || !FRONTMATTER_FENCE.test(lines[0] ?? "")) {
    return { frontmatter: {}, content: text.replace(/\s+$/, "") };
  }

  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (FRONTMATTER_FENCE.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  if (end === -1) return { frontmatter: {}, content: text.replace(/\s+$/, "") };

  const frontmatter: Frontmatter = {};
  const yamlLines = lines.slice(1, end);

  for (let i = 0; i < yamlLines.length; i += 1) {
    const line = yamlLines[i] ?? "";
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;

    // #8s94nyhn: quoted keys and plain keys with punctuation too (`Water every (days): 7`).
    const match = matchKeyLine(line);
    if (!match) continue;

    const key = match.key;
    // A trailing ` # comment` isn't part of the value (YAML, as Obsidian reads it).
    const rawValue = splitTrailingComment(match.rest.trimStart()).value.trim();

    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      frontmatter[key] = isTagsKey(key) ? normalizeTags(splitInlineList(rawValue)) : splitInlineList(rawValue);
      continue;
    }

    if (rawValue.length > 0) {
      const scalar = parseScalar(rawValue);
      if (scalar !== undefined) frontmatter[key] = scalar;
      continue;
    }

    // Empty value: either a block list or an absent value.
    const items: string[] = [];
    let cursor = i + 1;
    while (cursor < yamlLines.length) {
      const item = LIST_ITEM.exec(yamlLines[cursor] ?? "");
      if (!item) break;
      const value = parseScalar(splitTrailingComment(item[1] ?? "").value);
      if (value !== undefined) items.push(value);
      cursor += 1;
    }

    if (items.length > 0) {
      frontmatter[key] = isTagsKey(key) ? normalizeTags(items) : items;
      i = cursor - 1;
    }
  }

  // Tags under any spelling of the key (`Tags:`), each kept under its own key; readers take the first (frontmatterValue).
  for (const key of Object.keys(frontmatter)) {
    if (isTagsKey(key)) frontmatter[key] = normalizeTags(frontmatter[key]);
  }

  const content = lines
    .slice(end + 1)
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\s+$/, "");

  return { frontmatter, content };
}

function needsQuotes(value: string): boolean {
  return (
    value.length === 0 ||
    value !== value.trim() ||
    /^[\[{#&*!|>'"%@`]/.test(value) ||
    /: | #|[\n"\\]/.test(value) ||
    /^(true|false|null|~|-?\d+(\.\d+)?)$/i.test(value)
  );
}

function formatScalar(value: string): string {
  if (!needsQuotes(value)) return value;
  return JSON.stringify(value);
}

/** Serialise frontmatter to a `---` fenced YAML block. */
export function serializeFrontmatter(frontmatter: Frontmatter): string {
  const keys = [
    ...KEY_ORDER.filter((key) => frontmatter[key] !== undefined),
    ...Object.keys(frontmatter)
      .filter((key) => !(KEY_ORDER as readonly string[]).includes(key))
      .filter((key) => frontmatter[key] !== undefined)
      .sort(),
  ];

  const lines: string[] = ["---"];
  for (const key of keys) {
    const value = frontmatter[key];
    if (value === undefined) continue;

    if (key === "tags") {
      const tags = normalizeTags(value);
      if (tags.length === 0) {
        lines.push("tags: []");
        continue;
      }
      lines.push("tags:");
      for (const tag of tags) lines.push(`  - ${formatScalar(tag)}`);
      continue;
    }

    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${yamlKey(key)}: []`);
      } else {
        lines.push(`${yamlKey(key)}:`);
        for (const item of value) lines.push(`  - ${formatScalar(String(item))}`);
      }
      continue;
    }

    if (typeof value === "string") {
      lines.push(`${yamlKey(key)}: ${formatScalar(value)}`);
      continue;
    }

    lines.push(`${yamlKey(key)}: ${JSON.stringify(value)}`);
  }
  lines.push("---");
  return lines.join("\n");
}

/**
 * Serialise a full note. The body is normalised to LF with no trailing
 * whitespace and gets a single trailing newline.
 */
export function serializeNote(frontmatter: Frontmatter, content: string): string {
  const body = content.replace(/\r\n/g, "\n").replace(/\s+$/, "");
  const hasFrontmatter = Object.keys(frontmatter).some((key) => frontmatter[key] !== undefined);

  if (!hasFrontmatter) return body.length > 0 ? `${body}\n` : "";
  const block = serializeFrontmatter(frontmatter);
  return body.length > 0 ? `${block}\n\n${body}\n` : `${block}\n`;
}
