/**
 * Frontmatter-preserving YAML editing (#tterskg4).
 *
 * Gumply only manages `title`, `icon`, `tags`, `created` and `updated`. Every
 * other key, the key order, comments, flow style, quoting, line endings and the
 * presence of a final newline must survive a save untouched. Instead of
 * regenerating the block from an object, this edits only the managed key lines
 * of the existing YAML and leaves every other byte alone.
 */

import type { Frontmatter } from "./frontmatter.js";
import { frontmatterKey, isAliasesKey, isTagsKey } from "./frontmatter-keys.js";

// Top-level keys: letters of any script, digits, `_`, `-` and inner spaces
// (Obsidian property names like "due date" or "статус"), up to the first `:`.
const KEY_LINE = /^([\p{L}\p{N}_][\p{L}\p{N}_ -]*?):(.*)$/u;
const INDENTED = /^[ \t]/;

const KEY_ORDER = ["title", "icon", "tags", "created", "updated"] as const;

export interface NoteTemplate {
  /** Byte-order mark before the opening fence, if any. */
  bom: string;
  /** YAML text between the fences (original line endings), or null without frontmatter. */
  yaml: string | null;
  /** Dominant line ending of the file. */
  eol: "\n" | "\r\n";
  /** Whether the file ended with a newline. */
  finalNewline: boolean;
  /**
   * Blank lines between the closing `---` and the body, as in the file (most
   * files have 1, some have 0). Kept so a save doesn't reflow the header.
   */
  blankLinesAfterFrontmatter?: number;
}

function detectEol(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** Read the raw frontmatter envelope without normalising it. */
export function parseNoteTemplate(raw: string): NoteTemplate {
  const bom = raw.startsWith("\uFEFF") ? "\uFEFF" : "";
  const text = bom ? raw.slice(1) : raw;
  const eol = detectEol(text);
  const lines = text.split(/\r?\n/);

  if (lines.length === 0 || !/^---\s*$/.test(lines[0] ?? "")) {
    return { bom, yaml: null, eol, finalNewline: text.endsWith("\n") };
  }

  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (/^---\s*$/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  if (end === -1) return { bom, yaml: null, eol, finalNewline: text.endsWith("\n") };

  const yamlLines = lines.slice(1, end);
  const yaml = yamlLines.map((line) => `${line}\n`).join("");
  let blank = 0;
  while (end + 1 + blank < lines.length && (lines[end + 1 + blank] ?? "").trim() === "") blank += 1;
  const hasBody = end + 1 + blank < lines.length;
  return {
    bom,
    yaml: yaml.trim().length > 0 ? yaml : null,
    eol,
    finalNewline: text.endsWith("\n"),
    // Without a body there is nothing to keep apart; use the default later.
    ...(hasBody ? { blankLinesAfterFrontmatter: blank } : {}),
  };
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
  return needsQuotes(value) ? JSON.stringify(value) : value;
}

/** Split a `key: value # comment` line into value and its trailing comment. */
/** A YAML value and its trailing ` # comment` (quotes respected). */
export function splitTrailingComment(rest: string): { value: string; comment: string } {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < rest.length; i += 1) {
    const char = rest[i];
    if (quote === '"') {
      if (char === "\\") i += 1;
      else if (char === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (char === "'") {
        if (rest[i + 1] === "'") i += 1;
        else quote = null;
      }
      continue;
    }
    if ((char === '"' || char === "'") && rest.slice(0, i).trim().length === 0) {
      quote = char;
      continue;
    }
    if (char === "#" && i > 0 && /[ \t]/.test(rest[i - 1] ?? "")) {
      const valueEnd = rest.slice(0, i).replace(/[ \t]+$/, "").length;
      return { value: rest.slice(0, valueEnd), comment: rest.slice(valueEnd) };
    }
  }
  return { value: rest.replace(/[ \t]+$/, ""), comment: "" };
}

interface Block {
  start: number;
  end: number;
  key: string;
  rest: string;
}

/** Locate top-level key blocks. Indented continuation lines belong to the key. */
function findBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = KEY_LINE.exec(lines[i] ?? "");
    if (!match) continue;
    let end = i;
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j] ?? "";
      if (INDENTED.test(line)) end = j;
      else break;
    }
    blocks.push({ start: i, end, key: match[1] ?? "", rest: match[2] ?? "" });
    i = end;
  }
  return blocks;
}

/** A value written as a bare `key:` (YAML null): an empty property. */
export const YAML_EMPTY: unique symbol = Symbol("yaml-empty");

function renderKey(
  key: string,
  value: unknown,
  previousRest: string | null,
): string[] {
  const comment = previousRest === null ? "" : splitTrailingComment(previousRest).comment;
  // An empty property (any key, tags too) is a bare `key:`.
  if (value === YAML_EMPTY) return [`${key}:${comment}`];

  // `tags` under the note's own spelling (`Tags:` stays `Tags:`, #ippqkgus).
  if (isTagsKey(key)) {
    const tags = Array.isArray(value) ? value.map((item) => String(item)) : [];
    const flow = previousRest !== null && splitTrailingComment(previousRest).value.trimStart().startsWith("[");
    if (flow) {
      return [`${key}: [${tags.map(formatScalar).join(", ")}]${comment}`];
    }
    if (tags.length === 0) return [`${key}: []${comment}`];
    return [`${key}:${comment}`, ...tags.map((tag) => `  - ${formatScalar(tag)}`)];
  }

  if (Array.isArray(value)) {
    const items = value.map((item) => String(item));
    // A list that was written in flow style stays in flow style.
    const flow = previousRest !== null && splitTrailingComment(previousRest).value.trimStart().startsWith("[");
    if (flow) return [`${key}: [${items.map(formatScalar).join(", ")}]${comment}`];
    if (items.length === 0) return [`${key}: []${comment}`];
    return [`${key}:${comment}`, ...items.map((item) => `  - ${formatScalar(item)}`)];
  }

  // Typed properties (v0.7 A): numbers and booleans stay unquoted YAML scalars.
  if (typeof value === "number" || typeof value === "boolean") return [`${key}: ${String(value)}${comment}`];

  return [`${key}: ${formatScalar(String(value))}${comment}`];
}

/**
 * Apply changes to the inner YAML. `undefined` in `changes` means "not
 * managed"; `null` removes the key. Unknown keys are never re-rendered.
 */
export function editFrontmatterYaml(
  yaml: string,
  changes: Readonly<Record<string, unknown>>,
  /** Keys to rename in place first (value bytes and position kept). */
  renames: ReadonlyArray<{ from: string; to: string }> = [],
): string {
  const finalNewline = yaml.endsWith("\n");
  const lines = yaml.replace(/\r\n/g, "\n").split("\n");
  // A trailing newline leaves an empty last element; keep it out of the edit.
  if (finalNewline) lines.pop();

  for (const { from, to } of renames) {
    const block = findBlocks(lines).find((candidate) => candidate.key === from);
    if (!block) continue;
    lines[block.start] = `${to}:${block.rest}`;
  }

  const blocks = findBlocks(lines);
  const existing = new Map(blocks.map((block) => [block.key, block]));
  const edits: Array<{ start: number; end: number; replacement: string[] }> = [];
  const appended: string[] = [];

  // `tags` / `aliases` go to the note's own key in any case (#ippqkgus): the
  // first one in file order, kept as spelled; a second spelling is never
  // touched. Two changes landing on the same key: the later one wins.
  const resolved = new Map<string, unknown>();
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) continue;
    const special = isTagsKey(key) ? "tags" : isAliasesKey(key) ? "aliases" : null;
    const target = special ? (frontmatterKey(blocks.map((block) => block.key), special) ?? key) : key;
    resolved.delete(target);
    resolved.set(target, value);
  }

  for (const [key, value] of resolved) {
    const block = existing.get(key);

    if (value === null) {
      if (block) edits.push({ start: block.start, end: block.end, replacement: [] });
      continue;
    }

    const replacement = renderKey(key, value, block ? block.rest : null);
    if (block) edits.push({ start: block.start, end: block.end, replacement });
    else appended.push(...replacement);
  }

  // Splice from the bottom so earlier ranges stay valid.
  edits.sort((a, b) => b.start - a.start);
  for (const edit of edits) {
    lines.splice(edit.start, edit.end - edit.start + 1, ...edit.replacement);
  }
  lines.push(...appended);

  const body = lines.join("\n");
  return finalNewline ? `${body}\n` : body;
}

/** The top-level keys of a frontmatter block, in order. */
export function frontmatterKeys(yaml: string | null): string[] {
  if (!yaml) return [];
  return findBlocks(yaml.replace(/\r\n/g, "\n").split("\n")).map((block) => block.key);
}

/**
 * Inner YAML for new frontmatter in the given key order, written exactly as
 * the property editor writes each key (Notion import B3, #cwi22mc6), so the
 * first edit in Gumply changes only the key it edits.
 */
export function orderedFrontmatterYaml(entries: ReadonlyArray<readonly [string, unknown]>): string {
  const lines: string[] = [];
  for (const [key, value] of entries) if (value !== undefined) lines.push(...renderKey(key, value, null));
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/** Canonical inner YAML for a brand-new frontmatter block. */
export function canonicalYaml(frontmatter: Frontmatter): string {
  const keys = [
    ...KEY_ORDER.filter((key) => frontmatter[key] !== undefined),
    ...Object.keys(frontmatter)
      .filter((key) => !(KEY_ORDER as readonly string[]).includes(key))
      .filter((key) => frontmatter[key] !== undefined)
      .sort(),
  ];

  const lines: string[] = [];
  for (const key of keys) {
    const value = frontmatter[key];
    if (value === undefined) continue;
    lines.push(...renderKey(key, value, null));
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/**
 * Write a note using the existing file as the byte template. Only the keys
 * listed in `changes` are touched; everything else is copied verbatim.
 */
export function serializeNoteLike(
  template: NoteTemplate | null,
  frontmatter: Frontmatter,
  content: string,
  changes?: readonly string[],
  /** Keys to rename in place (v0.7 properties). */
  renames: ReadonlyArray<{ from: string; to: string }> = [],
): string {
  const eol = template?.eol ?? "\n";
  const finalNewline = template?.finalNewline ?? true;
  const body = content
    .replace(/\r\n/g, "\n")
    .replace(/\s+$/, "")
    .replace(/\n/g, eol);

  const managed: Record<string, unknown> = {};
  const keys = changes ?? Object.keys(frontmatter);
  for (const key of keys) managed[key] = frontmatter[key] ?? null;

  const yaml =
    template?.yaml === null || template === null
      ? canonicalYaml(frontmatter)
      : editFrontmatterYaml(template.yaml, managed, renames);

  if (yaml.trim().length === 0 && body.length === 0) return "";
  if (yaml.trim().length === 0) {
    return `${template?.bom ?? ""}${body}${finalNewline ? eol : ""}`;
  }

  const block =
    `${template?.bom ?? ""}---${eol}` +
    yaml.replace(/\r?\n/g, eol) +
    `---${eol}`;
  if (body.length === 0) return finalNewline ? block : block.slice(0, -eol.length);
  const gap = eol.repeat(template?.blankLinesAfterFrontmatter ?? 1);
  return `${block}${gap}${body}${finalNewline ? eol : ""}`;
}
