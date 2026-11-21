/**
 * Database views (D34, spec/api-bases, #sg36ng2d): run a `.base` view over
 * the vault's pages on the server.
 *
 * Frontmatter values come from a per-file cache keyed by mtime, so a query
 * re-reads only files that changed since the last one. Property types follow
 * D34: `.obsidian/types.json`, else `.gumply/types.json`, else inferred.
 * (When #qw4pcm2h's indexed properties land, both come from VaultStore.)
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  frontmatterValues,
  runBaseView,
  typedProperties,
  type BaseSourceRow,
  type BaseViewResult,
  type FileInfo,
} from "@gumply/core";
import { notFound } from "./errors.js";
import type { BaseIndexEntry, VaultStore } from "./vault-store.js";

interface CachedFrontmatter {
  mtimeMs: number;
  values: Record<string, unknown>;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/** Obsidian's type names, inferred from a value (D34: when no types.json says). */
function inferType(key: string, value: unknown): string | null {
  if (key === "tags") return "tags";
  if (key === "aliases") return "aliases";
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return "checkbox";
  if (typeof value === "number") return "number";
  if (Array.isArray(value)) return "multitext";
  if (typeof value === "string") {
    if (DATE_ONLY.test(value)) return "date";
    if (DATE_TIME.test(value)) return "datetime";
  }
  return "text";
}

export class BaseQueries {
  private readonly cache = new Map<string, CachedFrontmatter>();

  constructor(
    private readonly store: VaultStore,
    private readonly root: string,
  ) {}

  private async frontmatterOf(entry: BaseIndexEntry): Promise<Record<string, unknown>> {
    const cached = this.cache.get(entry.filePath);
    if (cached && cached.mtimeMs === entry.fileMtimeMs) return cached.values;
    let values: Record<string, unknown> = {};
    try {
      values = frontmatterValues(await readFile(entry.filePath, "utf8"));
    } catch {
      // Gone since the last scan: no values.
    }
    this.cache.set(entry.filePath, { mtimeMs: entry.fileMtimeMs, values });
    return values;
  }

  /** `types[key]` from the vault's types.json (Obsidian's first, D34). */
  private async declaredTypes(): Promise<Map<string, string>> {
    for (const file of [join(this.root, ".obsidian", "types.json"), join(this.root, ".gumply", "types.json")]) {
      try {
        const data = JSON.parse(await readFile(file, "utf8")) as { types?: Record<string, unknown> };
        const types = new Map<string, string>();
        for (const [key, value] of Object.entries(data.types ?? {})) if (typeof value === "string") types.set(key, value);
        return types;
      } catch {
        // Missing or unreadable: try the next one, then infer.
      }
    }
    return new Map();
  }

  async run(baseId: string, options: { view?: string; thisId?: string; now?: number } = {}): Promise<BaseViewResult> {
    const document = this.store.getBase(baseId);
    if (document.error) throw notFound(`This base can't be read: ${document.error}`);
    const index = this.store.baseIndex();
    // Drop cache entries of files that are gone.
    const live = new Set(index.map((entry) => entry.filePath));
    for (const key of this.cache.keys()) if (!live.has(key)) this.cache.delete(key);

    const values = await Promise.all(index.map((entry) => this.frontmatterOf(entry)));
    const types = await this.declaredTypes();
    for (const record of values) {
      for (const [key, value] of Object.entries(record)) {
        if (types.has(key)) continue;
        const inferred = inferType(key, value);
        if (inferred) types.set(key, inferred);
      }
    }

    const byPath = new Map<string, FileInfo>();
    const rows: BaseSourceRow[] = index.map((entry, i) => {
      const file: FileInfo = {
        path: entry.path,
        title: entry.meta.title,
        ctime: Date.parse(entry.meta.created) || 0,
        mtime: Math.floor(entry.fileMtimeMs),
        tags: entry.meta.tags,
        links: entry.links,
        props: typedProperties(Object.entries(values[i]!), types),
      };
      byPath.set(entry.path.toLowerCase(), file);
      return {
        id: entry.meta.id,
        kind: entry.meta.kind ?? "page",
        title: entry.meta.title,
        ...(entry.meta.icon ? { icon: entry.meta.icon } : {}),
        updated: entry.meta.updated,
        file,
      };
    });

    // `this`: the page the base is embedded in, else the base file itself.
    const basePath = this.store.vaultPathOf(document.meta.id) ?? document.meta.id;
    const thisPath = options.thisId ? this.store.vaultPathOf(options.thisId) : null;
    const thisFile: FileInfo = (thisPath ? byPath.get(thisPath.toLowerCase()) : undefined) ?? {
      path: basePath,
      title: document.meta.title,
      ctime: Date.parse(document.meta.created) || 0,
      mtime: Date.parse(document.meta.updated) || 0,
      tags: [],
      links: [],
      props: new Map(),
    };

    const titles = new Map<string, string>();
    for (const row of rows) {
      titles.set(row.title.toLowerCase(), row.file.path);
      const name = row.file.path.slice(row.file.path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
      if (!titles.has(name.toLowerCase())) titles.set(name.toLowerCase(), row.file.path);
    }

    return runBaseView({
      config: document.config,
      view: options.view,
      rows,
      thisFile,
      types,
      now: options.now,
      resolveLink: (target) => {
        const clean = target.replace(/^\[\[|\]\]$/g, "").split("|")[0]!.split("#")[0]!.trim();
        return titles.get(clean.toLowerCase()) ?? null;
      },
    });
  }
}
