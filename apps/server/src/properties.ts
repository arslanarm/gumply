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
  WIKILINK_INNER,
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

/** A plain YAML scalar that would read back as something else, or not as one string, needs quotes. */
function plainNeedsQuotes(value: string): boolean {
  return (
    value.length === 0 ||
    value !== value.trim() ||
    /^[\[\]{}#&*!|>'"%@`,?:-]/.test(value) ||
    /: | #|[\n\t]/.test(value) ||
    /:$/.test(value) ||
    /^(true|false|yes|no|on|off|null|~|[-+]?(\d[\d_]*(\.\d*)?|\.\d+)([eE][-+]?\d+)?|0x[0-9a-f]+|0o[0-7]+|\.inf|\.nan)$/i.test(value)
  );
}

const WIKILINK_FLOW = new RegExp(String.raw`^\[\[${WIKILINK_INNER}+\]\]$`);

/** An unquoted `[[Target]]`: YAML reads it as a list in a list, Obsidian (and its users) as a link. */
function wikilinkFlow(node: Node | null | undefined, yaml: string): string | null {
  if (!isSeq(node) || !node.flow || node.anchor || node.tag) return null;
  const range = (node as { range?: [number, number, number] }).range;
  if (!range) return null;
  const text = yaml.slice(range[0], range[1]);
  return WIKILINK_FLOW.test(text) ? text : null;
}

/** The value nodes a link rewrite may touch, in file order: keys and list positions. */
function linkTargets(document: ReturnType<typeof parseDocument>, source: string): Array<{ key: string; node: Node }> | null {
  if (document.errors.length > 0 || !isMap(document.contents)) return null;
  const out: Array<{ key: string; node: Node }> = [];
  const seen = new Set<string>();
  for (const pair of document.contents.items) {
    const keyNode = pair.key as Node | null;
    if (!isScalar(keyNode) || typeof keyNode.value !== "string") continue;
    const key = keyNode.value;
    if (HEADER_KEYS.includes(key) || key === "tags" || seen.has(key)) continue;
    seen.add(key);
    const value = pair.value as Node | null;
    if (!value) continue;
    if (isSeq(value) && !value.anchor && !value.tag && !wikilinkFlow(value, source)) {
      for (const item of value.items) out.push({ key, node: item as Node });
    } else {
      out.push({ key, node: value });
    }
  }
  return out;
}

/**
 * #3c86ify2: rewrite `[[links]]` inside frontmatter values (a rename, a folder
 * move, a heading rename), changing only the values that hold a matching link
 * (D37). The rewrite runs on the **decoded** value (so `"\\[[X]]"`, an escaped
 * opener, stays text, as in the body). Top-level text values and list items
 * are rewritten in their own quoting style:
 * - `"double"`: re-quoted as JSON (`"` and `\` escaped);
 * - `'single'`: `'` doubled;
 * - plain: kept plain unless the new text needs quotes, then double-quoted;
 * - an unquoted `[[Target]]` (a list in a list to YAML): rewritten as written.
 * Gumply's header keys, `tags`, block scalars (`|`, `>`), anchors and invalid
 * YAML are left alone. The result is read back: the same keys and values,
 * except exactly the rewritten ones, or the YAML is returned unchanged.
 */
export function rewritePropertyLinks(
  yaml: string,
  rewrite: (text: string) => { content: string; count: number },
): { yaml: string; count: number } {
  const unchanged = { yaml, count: 0 };
  if (!yaml.includes("[[")) return unchanged;
  const parse = (text: string) => parseDocument(text, { uniqueKeys: false, prettyErrors: false });
  const targets = linkTargets(parse(yaml), yaml);
  if (!targets) return unchanged;

  /** Per target: the new source text, and what it must read back as. */
  const edits = new Map<number, { start: number; end: number; text: string; check: (node: Node, source: string) => boolean }>();
  let count = 0;
  targets.forEach(({ node }, index) => {
    const range = (node as { range?: [number, number, number] }).range;
    if (!range) return;
    const flow = wikilinkFlow(node, yaml);
    if (flow !== null) {
      const result = rewrite(flow);
      if (result.count === 0 || result.content === flow) return;
      const text = result.content;
      edits.set(index, { start: range[0], end: range[1], text, check: (next, source) => wikilinkFlow(next, source) === text });
      count += result.count;
      return;
    }
    if (!simpleScalar(node) || typeof node.value !== "string" || !node.value.includes("[[")) return;
    const result = rewrite(node.value);
    if (result.count === 0 || result.content === node.value) return;
    const value = result.content;
    const type = (node as { type?: string }).type;
    let text: string;
    if (type === "QUOTE_SINGLE") text = `'${value.replace(/'/g, "''")}'`;
    else if (type === "PLAIN" && !plainNeedsQuotes(value)) text = value;
    else text = JSON.stringify(value);
    edits.set(index, { start: range[0], end: range[1], text, check: (next) => simpleScalar(next) && next.value === value });
    count += result.count;
  });
  if (edits.size === 0) return unchanged;

  let out = yaml;
  for (const edit of [...edits.values()].sort((a, b) => b.start - a.start)) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);

  // Read it back: the same keys and value nodes; rewritten ones as intended, the rest as before.
  const after = linkTargets(parse(out), out);
  if (!after || after.length !== targets.length) return unchanged;
  for (let index = 0; index < targets.length; index += 1) {
    const was = targets[index]!;
    const now = after[index]!;
    if (was.key !== now.key) return unchanged;
    const edit = edits.get(index);
    if (edit) {
      if (!edit.check(now.node, out)) return unchanged;
    } else if (JSON.stringify((was.node as { toJSON?: () => unknown }).toJSON?.() ?? null) !== JSON.stringify((now.node as { toJSON?: () => unknown }).toJSON?.() ?? null)) {
      return unchanged;
    }
  }
  if (JSON.stringify(readRawProperties(yaml).map((property) => property.key)) !== JSON.stringify(readRawProperties(out).map((property) => property.key))) {
    return unchanged;
  }
  return { yaml: out, count };
}
