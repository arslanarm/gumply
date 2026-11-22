/**
 * Page properties on the server (v0.7 A, D34, spec/api v1.12): typed values
 * read from a page's frontmatter, and the vault's property types, shared
 * with Obsidian through `.obsidian/types.json` when the vault has one.
 */
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  frontmatterKey,
  HEADER_KEYS,
  isPropertyType,
  tagsValueIssue,
  type Property,
  type PropertyType,
  type PropertyValue,
  encodePropertyValue,
  propertyLinkSpans,
} from "@gumply/core";
import { isMap, isScalar, isSeq, parseDocument, type Node } from "yaml";

/** A frontmatter key and its value, before a type is attached. */
export interface RawProperty {
  key: string;
  value: PropertyValue;
  editable: boolean;
}

/** A scalar Gumply can edit in place: one line, no anchors, aliases or tags. */
function simpleScalar(node: Node | null | undefined): node is Node & { value: unknown } {
  if (!isScalar(node)) return false;
  if (node.anchor || node.tag) return false;
  if (node.type === "BLOCK_LITERAL" || node.type === "BLOCK_FOLDED") return false;
  const value = node.value;
  if (typeof value === "string" && value.includes("\n")) return false;
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

/**
 * The frontmatter's properties, in file order, without Gumply's header keys.
 * Values YAML can hold but Gumply can't edit safely (nested maps, lists of
 * maps, multi-line text, anchors) come back read-only, as their YAML text.
 * Unparseable YAML gives no properties (the page still opens).
 */
export function readRawProperties(yaml: string | null): RawProperty[] {
  if (!yaml) return [];
  const document = parseDocument(yaml, { uniqueKeys: false, prettyErrors: false });
  if (document.errors.length > 0 || !isMap(document.contents)) return [];
  const out: RawProperty[] = [];
  const seen = new Set<string>();
  for (const pair of document.contents.items) {
    const keyNode = pair.key as Node | null;
    if (!isScalar(keyNode) || typeof keyNode.value !== "string") continue;
    const key = keyNode.value;
    if (HEADER_KEYS.includes(key) || seen.has(key)) continue;
    seen.add(key);
    const value = pair.value as Node | null;
    if (value === null || value === undefined) {
      out.push({ key, value: null, editable: true });
    } else if (simpleScalar(value)) {
      const scalar = value.value as string | number | boolean | null;
      out.push({ key, value: typeof scalar === "number" && !Number.isFinite(scalar) ? String(scalar) : scalar, editable: true });
    } else if (isSeq(value) && !value.anchor && value.items.every((item) => simpleScalar(item as Node))) {
      const items = value.items.map((item) => (item as { value: unknown }).value).filter((item) => item !== null);
      out.push({ key, value: items.map((item) => String(item)), editable: true });
    } else {
      // Shown as it is written in the file (never re-rendered).
      const range = (value as { range?: [number, number, number] }).range;
      const text = range ? yaml.slice(range[0], range[1]) : String(value);
      out.push({ key, value: text.replace(/\s+$/, ""), editable: false });
    }
  }
  return out;
}

/** Attach a type to each raw property. */
export function typedProperties(raw: readonly RawProperty[], typeOf: (key: string) => PropertyType): Property[] {
  // #6imze6ux: the page's tags key (any case, the first spelling) says when Obsidian won't read its value as tags.
  const tagsKey = frontmatterKey(raw.map((property) => property.key), "tags");
  return raw.map((property) => {
    const typed: Property = { ...property, type: typeOf(property.key) };
    if (property.key === tagsKey && property.editable) {
      const issue = tagsValueIssue(property.value);
      if (issue) typed.issue = issue;
    }
    return typed;
  });
}

/** Index of the `}` / `]` closing the bracket at `open` (JSON strings skipped), or -1. */
function closingBracket(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const char = text[i]!;
    if (char === '"') {
      for (i += 1; i < text.length && text[i] !== '"'; i += 1) if (text[i] === "\\") i += 1;
    } else if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Where the value of top-level `key` starts in a JSON object's text, or -1. */
function topLevelValue(text: string, key: string): number {
  const root = text.indexOf("{");
  if (root === -1) return -1;
  let depth = 0;
  for (let i = root; i < text.length; i += 1) {
    const char = text[i]!;
    if (char === '"') {
      const start = i;
      for (i += 1; i < text.length && text[i] !== '"'; i += 1) if (text[i] === "\\") i += 1;
      if (depth === 1 && JSON.parse(text.slice(start, i + 1)) === key) {
        const colon = text.indexOf(":", i + 1);
        let value = colon + 1;
        while (/\s/.test(text[value] ?? "")) value += 1;
        // A key, not a string value: it's followed by `:`.
        if (colon !== -1 && text.slice(i + 1, colon).trim() === "") return value;
      }
    } else if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") depth -= 1;
  }
  return -1;
}

/** Add `entries` as members of the object at `open`..`close`, in its own layout. */
function insertMembers(text: string, open: number, close: number, entries: Array<[string, string]>, outerIndent: string, unit: string): string {
  const inner = text.slice(open + 1, close);
  const member = ([key, value]: [string, string], spaced: boolean) => `${JSON.stringify(key)}:${spaced ? " " : ""}${value}`;
  if (inner.trim() === "") {
    const lines = entries.map((entry) => `${outerIndent}${unit}${member(entry, true)}`);
    return `${text.slice(0, open + 1)}\n${lines.join(",\n")}\n${outerIndent}${text.slice(close)}`;
  }
  let last = close - 1;
  while (/\s/.test(text[last]!)) last -= 1;
  const multiline = /\n/.test(inner);
  if (multiline) {
    const indent = /\n([ \t]*)\S/.exec(inner)?.[1] ?? `${outerIndent}${unit}`;
    const spaced = /":\s/.test(inner);
    return `${text.slice(0, last + 1)}${entries.map((entry) => `,\n${indent}${member(entry, spaced)}`).join("")}${text.slice(last + 1)}`;
  }
  const spaced = /":\s/.test(inner);
  const comma = /,\s/.test(inner) ? ", " : ",";
  return `${text.slice(0, last + 1)}${entries.map((entry) => `${comma}${member(entry, spaced)}`).join("")}${text.slice(last + 1)}`;
}

/**
 * `types.json` with `types` added for keys it doesn't have yet (Notion
 * import B3, #cwi22mc6). The new entries are inserted into the text as it
 * is: every existing byte stays (D37). No file: a fresh one in the standard
 * format. Null: nothing to add. Throws on a file that isn't a JSON object.
 */
export function addMissingTypes(text: string | null, types: Readonly<Record<string, PropertyType>>): string | null {
  if (text === null) {
    const entries = Object.entries(types);
    return entries.length ? `${JSON.stringify({ types: Object.fromEntries(entries) }, null, 2)}\n` : null;
  }
  const data = JSON.parse(text) as unknown;
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("types.json isn't a JSON object");
  const current = (data as { types?: unknown }).types;
  const known = current && typeof current === "object" && !Array.isArray(current) ? (current as Record<string, unknown>) : null;
  // Obsidian matches property names case-insensitively: `Due` is the vault's `due`, never a second entry.
  const taken = new Set(Object.keys(known ?? {}).map((key) => key.toLowerCase()));
  const entries: Array<[string, string]> = [];
  for (const [key, type] of Object.entries(types)) {
    if (taken.has(key.toLowerCase())) continue;
    taken.add(key.toLowerCase());
    entries.push([key, JSON.stringify(type)]);
  }
  if (entries.length === 0) return null;
  const unit = /\n(\t|[ ]+)"/.exec(text)?.[1] ?? "  ";
  const valueAt = topLevelValue(text, "types");
  if (valueAt !== -1 && text[valueAt] === "{") {
    const close = closingBracket(text, valueAt);
    const lineStart = text.lastIndexOf("\n", valueAt) + 1;
    const outerIndent = /^[ \t]*/.exec(text.slice(lineStart))?.[0] ?? "";
    return insertMembers(text, valueAt, close, entries, outerIndent, unit);
  }
  if (valueAt !== -1) throw new Error("types.json has a `types` that isn't an object");
  // No `types` yet: add it as the root object's last member.
  const root = text.indexOf("{");
  const close = closingBracket(text, root);
  const block = `{\n${entries.map(([key, value]) => `${unit}${unit}${JSON.stringify(key)}: ${value}`).join(",\n")}\n${unit}}`;
  return insertMembers(text, root, close, [["types", block]], "", unit);
}

/**
 * The vault's stored property types. When the vault has `.obsidian/` (an
 * Obsidian vault), they live in Obsidian's own `.obsidian/types.json`, so
 * both apps agree; otherwise in `.gumply/types.json`. `.obsidian/` is never
 * created. Writes re-read the file right before changing one entry, keep
 * every other key and the file's indentation, and replace it atomically.
 */
export class PropertyTypesStore {
  private cache: { file: string; mtimeMs: number; types: Record<string, PropertyType> } | null = null;

  constructor(private readonly root: string) {}

  /** Where types live for this vault right now. */
  async file(): Promise<string> {
    const obsidian = join(this.root, ".obsidian");
    const isDir = await lstat(obsidian).then((info) => info.isDirectory(), () => false);
    return isDir ? join(obsidian, "types.json") : join(this.root, ".gumply", "types.json");
  }

  /** Stored types (unknown type names and other shapes are ignored). */
  async read(): Promise<Record<string, PropertyType>> {
    const file = await this.file();
    const info = await lstat(file).catch(() => null);
    if (!info || !info.isFile()) return {};
    if (this.cache && this.cache.file === file && this.cache.mtimeMs === info.mtimeMs) return this.cache.types;
    let types: Record<string, PropertyType> = {};
    try {
      const data = JSON.parse(await readFile(file, "utf8")) as { types?: unknown };
      if (data && typeof data.types === "object" && data.types !== null) {
        for (const [key, value] of Object.entries(data.types as Record<string, unknown>)) {
          if (isPropertyType(value)) types[key] = value;
        }
      }
    } catch {
      types = {};
    }
    this.cache = { file, mtimeMs: info.mtimeMs, types };
    return types;
  }

  /**
   * Add types for keys that have none yet, keeping every existing byte
   * (Notion import B3). Returns the keys added.
   */
  async addMissing(types: Readonly<Record<string, PropertyType>>): Promise<string[]> {
    const file = await this.file();
    let text: string | null = null;
    try {
      text = await readFile(file, "utf8");
    } catch {
      text = null;
    }
    const before = text === null ? {} : (((JSON.parse(text) as { types?: Record<string, unknown> }).types ?? {}) as Record<string, unknown>);
    const next = addMissingTypes(text, types);
    if (next === null) return [];
    if (file.startsWith(join(this.root, ".gumply"))) await mkdir(join(this.root, ".gumply"), { recursive: true });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temporary, next, "utf8");
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    this.cache = null;
    const had = new Set(Object.keys(before).map((key) => key.toLowerCase()));
    return Object.keys(types).filter((key) => !had.has(key.toLowerCase()));
  }

  /** Set one key's type (only that entry changes). */
  async set(key: string, type: PropertyType): Promise<void> {
    const file = await this.file();
    // Re-read just before writing: another app (Obsidian) may have changed it.
    let text: string | null = null;
    try {
      text = await readFile(file, "utf8");
    } catch {
      text = null;
    }
    let data: Record<string, unknown> = {};
    let indent: string | number = 2;
    let finalNewline = true;
    if (text !== null) {
      try {
        const parsed = JSON.parse(text) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
      } catch {
        // A damaged file: never overwrite what we can't read.
        throw new Error(`Can't update ${file}: it isn't valid JSON`);
      }
      const match = /^\{\r?\n([ \t]+)/.exec(text);
      indent = match ? (match[1]!.startsWith("\t") ? "\t" : match[1]!.length) : 2;
      finalNewline = text.endsWith("\n");
    }
    const types = data.types && typeof data.types === "object" && !Array.isArray(data.types) ? { ...(data.types as object) } : {};
    (types as Record<string, unknown>)[key] = type;
    data = { ...data, types };
    const next = JSON.stringify(data, null, indent) + (finalNewline ? "\n" : "");
    // `.gumply/` is ours to create; `.obsidian/` exists already (see `file()`).
    if (file.startsWith(join(this.root, ".gumply"))) await mkdir(join(this.root, ".gumply"), { recursive: true });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temporary, next, "utf8");
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    this.cache = null;
  }
}

/**
 * #3c86ify2: rewrite `[[links]]` inside frontmatter values (a rename, a folder
 * move, a heading rename), changing only the values that hold a matching link
 * (D37). The spans come from core `propertyLinkSpans`, the same walk the link
 * index uses (#rpugpydh). The rewrite runs on the **decoded** value (so
 * `"\\[[X]]"`, an escaped opener, stays text, as in the body), and each new
 * value is written in its own style (`encodePropertyValue`). The result is read
 * back: the same keys and values, except exactly the rewritten ones, or the
 * YAML is returned unchanged.
 */
export function rewritePropertyLinks(
  yaml: string,
  rewrite: (text: string) => { content: string; count: number },
): { yaml: string; count: number } {
  const unchanged = { yaml, count: 0 };
  if (!yaml.includes("[[")) return unchanged;
  const spans = propertyLinkSpans(yaml);
  if (!spans) return unchanged;

  const edits = new Map<number, { text: string; value: string }>();
  let count = 0;
  spans.forEach((span, index) => {
    if (!span.value.includes("[[")) return;
    const result = rewrite(span.value);
    if (result.count === 0 || result.content === span.value) return;
    edits.set(index, { text: encodePropertyValue(span.style, result.content), value: result.content });
    count += result.count;
  });
  if (edits.size === 0) return unchanged;

  let out = yaml;
  for (const index of [...edits.keys()].sort((a, b) => spans[b]!.start - spans[a]!.start)) {
    const span = spans[index]!;
    out = out.slice(0, span.start) + edits.get(index)!.text + out.slice(span.end);
  }

  // Read it back: the same spans, the rewritten ones as intended, the rest as before.
  const after = propertyLinkSpans(out);
  if (!after || after.length !== spans.length) return unchanged;
  for (let index = 0; index < spans.length; index += 1) {
    const expected = edits.get(index)?.value ?? spans[index]!.value;
    if (after[index]!.key !== spans[index]!.key || after[index]!.value !== expected) return unchanged;
  }
  const keys = (text: string) => JSON.stringify(readRawProperties(text).map((property) => property.key));
  if (keys(yaml) !== keys(out)) return unchanged;
  return { yaml: out, count };
}
