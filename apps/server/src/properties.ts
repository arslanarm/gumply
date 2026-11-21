/**
 * Page properties on the server (v0.7 A, D34, spec/api v1.12): typed values
 * read from a page's frontmatter, and the vault's property types, shared
 * with Obsidian through `.obsidian/types.json` when the vault has one.
 */
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  HEADER_KEYS,
  isPropertyType,
  type Property,
  type PropertyType,
  type PropertyValue,
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
  return raw.map((property) => ({ ...property, type: typeOf(property.key) }));
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
