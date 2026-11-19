import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  childPageId,
  collectLinkEdges,
  extractTags,
  extractWikilinks,
  isValidPageId,
  makeSnippet,
  normalizeTags,
  parentOf,
  parseFrontmatter,
  pathToPageId,
  resolveWikilink,
  rewriteWikilinkTargets,
  serializeNote,
  titleFromId,
  type Backlink,
  type DeletePageResult,
  type Frontmatter,
  type GraphData,
  type GraphNode,
  type LinkEdge,
  type Page,
  type PageId,
  type PageMeta,
  type SearchResult,
} from "@gumply/core";
import { badRequest, conflict, notFound } from "./errors.js";

export interface CreatePageInput {
  title: string;
  parentId?: string | null;
  content?: string;
  icon?: string;
}

export interface UpdatePageInput {
  title?: string;
  content?: string;
  icon?: string | null;
  tags?: string[];
}

export interface GraphOptions {
  center?: PageId;
  /** BFS radius around `center`; defaults to 1 when `center` is set. */
  depth?: number;
}

const MAX_TITLE_LENGTH = 300;
const MAX_CONTENT_LENGTH = 5_000_000;
const MAX_GRAPH_DEPTH = 5;
const MAX_TAGS = 200;

/** Page plus the bits of on-disk state the index needs. */
interface PageRecord extends Omit<Page, "childCount"> {
  filePath: string;
  /** Frontmatter tags only; `tags` is this plus inline tags. */
  fmTags: string[];
}

/** `.trash/<trashId>/meta.json` (D11). */
interface TrashManifest {
  id: PageId;
  trashId: string;
  deleted: PageId[];
  deletedAt: string;
}

function toIso(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function metaOf(record: PageRecord, childCount: number): PageMeta {
  const meta: PageMeta = {
    id: record.id,
    title: record.title,
    tags: [...record.tags],
    parentId: record.parentId,
    childCount,
    created: record.created,
    updated: record.updated,
  };
  if (record.icon) meta.icon = record.icon;
  return meta;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1 && count < 100) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Markdown vault with an in-memory page + link index (D2/D4).
 *
 * All mutations go through a promise queue so concurrent requests cannot
 * interleave file writes. The index is rebuilt on start (scan) and kept in
 * sync on every create/update/delete/move.
 */
export class VaultStore {
  readonly root: string;

  private readonly pages = new Map<PageId, PageRecord>();
  private readonly edgesBySource = new Map<PageId, LinkEdge[]>();
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(root: string) {
    this.root = resolve(root);
  }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await this.rebuild();
  }

  /** Flat list of every page, sorted by id. */
  list(): PageMeta[] {
    const counts = new Map<PageId, number>();
    for (const record of this.pages.values()) {
      if (record.parentId) counts.set(record.parentId, (counts.get(record.parentId) ?? 0) + 1);
    }
    return [...this.pages.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((record) => metaOf(record, counts.get(record.id) ?? 0));
  }

  get(id: PageId): Page {
    const record = this.require(id);
    return { ...metaOf(record, this.directChildCount(id)), content: record.content };
  }

  create(input: CreatePageInput): Promise<Page> {
    return this.enqueue(() => this.createNow(input));
  }

  update(id: PageId, patch: UpdatePageInput): Promise<Page & { rewrittenPages: PageId[] }> {
    return this.enqueue(() => this.updateNow(id, patch));
  }

  remove(id: PageId): Promise<DeletePageResult> {
    return this.enqueue(() => this.removeNow(id));
  }

  restore(trashId: string): Promise<PageMeta[]> {
    return this.enqueue(() => this.restoreNow(trashId));
  }

  move(id: PageId, parentId: PageId | null): Promise<Page> {
    return this.enqueue(() => this.moveNow(id, parentId));
  }

  backlinks(id: PageId): Backlink[] {
    this.require(id);

    const out: Backlink[] = [];
    for (const [sourceId, edges] of this.edgesBySource) {
      if (sourceId === id) continue;
      const edge = edges.find((candidate) => candidate.target === id);
      if (!edge) continue;

      const source = this.pages.get(sourceId);
      if (!source) continue;
      out.push({
        page: metaOf(source, this.directChildCount(sourceId)),
        snippet: this.linkSnippet(source, edge.targetTitle),
      });
    }

    return out.sort(
      (a, b) => a.page.title.localeCompare(b.page.title) || a.page.id.localeCompare(b.page.id),
    );
  }

  graph(options: GraphOptions = {}): GraphData {
    const allMetas = this.list();
    const metaById = new Map(allMetas.map((meta) => [meta.id, meta]));

    let included = new Set<PageId>(metaById.keys());
    const { center, depth } = options;

    if (center !== undefined) {
      if (!metaById.has(center)) throw notFound(`Page not found: ${center}`);
      const radius = depth ?? 1;
      if (!Number.isInteger(radius) || radius < 1 || radius > MAX_GRAPH_DEPTH) {
        throw badRequest(`depth must be an integer between 1 and ${MAX_GRAPH_DEPTH}`);
      }

      included = new Set([center]);
      const adjacency = this.adjacency();
      let frontier: PageId[] = [center];
      for (let level = 0; level < radius; level += 1) {
        const next: PageId[] = [];
        for (const node of frontier) {
          for (const neighbour of adjacency.get(node) ?? []) {
            if (included.has(neighbour)) continue;
            included.add(neighbour);
            next.push(neighbour);
          }
        }
        frontier = next;
      }
    } else if (depth !== undefined) {
      throw badRequest("depth requires center");
    }

    const edges = this.allEdges().filter(
      (edge) => edge.target !== null && included.has(edge.source) && included.has(edge.target),
    );

    const counts = new Map<PageId, number>();
    for (const edge of edges) {
      counts.set(edge.source, (counts.get(edge.source) ?? 0) + 1);
      if (edge.target) counts.set(edge.target, (counts.get(edge.target) ?? 0) + 1);
    }

    const nodes: GraphNode[] = allMetas
      .filter((meta) => included.has(meta.id))
      .map((meta) => ({ ...meta, linkCount: counts.get(meta.id) ?? 0 }));

    const tags = [...new Set(allMetas.flatMap((meta) => meta.tags))].sort((a, b) =>
      a.localeCompare(b),
    );

    return {
      nodes,
      links: edges.map((edge) => ({ source: edge.source, target: edge.target as PageId })),
      tags,
    };
  }

  search(query: string): SearchResult[] {
    const trimmed = query.trim();
    if (trimmed.length === 0) return [];
    const needle = trimmed.toLowerCase();

    const results: SearchResult[] = [];
    for (const record of this.pages.values()) {
      const title = record.title.toLowerCase();
      let titleScore = 0;
      if (title === needle) titleScore = 100;
      else if (title.startsWith(needle)) titleScore = 80;
      else if (title.includes(needle)) titleScore = 60;

      const occurrences = countOccurrences(record.content.toLowerCase(), needle);
      if (titleScore === 0 && occurrences === 0) continue;

      const bodyBoost = Math.min(occurrences, 10);
      results.push({
        page: metaOf(record, this.directChildCount(record.id)),
        snippet: makeSnippet(record.content, trimmed, 80),
        score: titleScore > 0 ? titleScore + bodyBoost : bodyBoost + 1,
      });
    }

    return results.sort(
      (a, b) => b.score - a.score || a.page.title.localeCompare(b.page.title),
    );
  }

  // --- mutations ---------------------------------------------------------

  private async createNow(input: CreatePageInput): Promise<Page> {
    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (title.length === 0) throw badRequest("title is required");
    if (title.length > MAX_TITLE_LENGTH) {
      throw badRequest(`title is too long (max ${MAX_TITLE_LENGTH} characters)`);
    }

    const content = input.content ?? "";
    if (typeof content !== "string") throw badRequest("content must be a string");
    if (content.length > MAX_CONTENT_LENGTH) throw badRequest("content is too large");

    const parentId = input.parentId ?? null;
    if (parentId !== null) {
      if (typeof parentId !== "string" || !isValidPageId(parentId)) {
        throw badRequest("parentId must be a valid page id or null");
      }
      this.require(parentId);
    }

    const icon = typeof input.icon === "string" && input.icon.trim().length > 0
      ? input.icon.trim()
      : undefined;

    const baseId = childPageId(parentId, title);
    const id = await this.freeId(baseId);
    const now = new Date().toISOString();
    const filePath = this.filePathFor(id);

    await this.writePage(
      filePath,
      { title, ...(icon ? { icon } : {}), tags: [], created: now, updated: now },
      content,
    );

    const record: PageRecord = {
      id,
      title,
      tags: [],
      parentId,
      created: now,
      updated: now,
      content,
      filePath,
      fmTags: [],
    };
    if (icon) record.icon = icon;

    this.pages.set(id, record);
    this.refreshTags(record);
    this.reindexAll();
    return this.get(id);
  }

  private async updateNow(id: PageId, patch: UpdatePageInput): Promise<Page & { rewrittenPages: PageId[] }> {
    const record = this.require(id);
    const previousTitle = record.title;

    const nextTitle = patch.title === undefined ? record.title : patch.title.trim();
    if (nextTitle.length === 0) throw badRequest("title must not be empty");
    if (nextTitle.length > MAX_TITLE_LENGTH) {
      throw badRequest(`title is too long (max ${MAX_TITLE_LENGTH} characters)`);
    }

    const nextContent = patch.content === undefined ? record.content : patch.content;
    if (typeof nextContent !== "string") throw badRequest("content must be a string");
    if (nextContent.length > MAX_CONTENT_LENGTH) throw badRequest("content is too large");

    let nextIcon = record.icon;
    if (patch.icon === null) nextIcon = undefined;
    else if (patch.icon !== undefined) {
      if (typeof patch.icon !== "string") throw badRequest("icon must be a string or null");
      nextIcon = patch.icon.trim().length > 0 ? patch.icon.trim() : undefined;
    }

    const fmTags =
      patch.tags === undefined ? record.fmTags : normalizeTags(patch.tags).slice(0, MAX_TAGS);
    const updated = new Date().toISOString();
    const frontmatter: Frontmatter = {
      title: nextTitle,
      ...(nextIcon ? { icon: nextIcon } : {}),
      tags: fmTags,
      created: record.created,
      updated,
    };

    const titleChanged = nextTitle !== previousTitle;
    // Snapshot before the rename so link resolution still sees the old title.
    const beforeMetas = titleChanged ? this.list() : [];

    await this.writePage(record.filePath, frontmatter, nextContent);

    record.title = nextTitle;
    record.content = nextContent;
    record.updated = updated;
    record.fmTags = fmTags;
    if (nextIcon) record.icon = nextIcon;
    else delete record.icon;
    this.refreshTags(record);

    const rewrittenPages: PageId[] = [];

    if (titleChanged) {
      // D12: keep link text truthful by rewriting `[[Old…]]` in other pages.
      for (const other of [...this.pages.values()]) {
        if (other.id === id) continue;

        const result = rewriteWikilinkTargets(
          other.content,
          (link) => resolveWikilink(link.targetTitle, beforeMetas)?.id === id,
          nextTitle,
        );
        if (result.count === 0) continue;

        const rewrittenAt = new Date().toISOString();
        await this.writePage(
          other.filePath,
          {
            title: other.title,
            ...(other.icon ? { icon: other.icon } : {}),
            tags: other.fmTags,
            created: other.created,
            updated: rewrittenAt,
          },
          result.content,
        );
        other.content = result.content;
        other.updated = rewrittenAt;
        this.refreshTags(other);
        rewrittenPages.push(other.id);
      }

      rewrittenPages.sort((a, b) => a.localeCompare(b));
      this.reindexAll();
    } else {
      this.recomputeSource(id);
    }

    return { ...this.get(id), rewrittenPages };
  }

  private async removeNow(id: PageId): Promise<DeletePageResult> {
    const record = this.require(id);
    const deleted = this.subtreeIds(id);
    const trashId = await this.freeTrashId();
    const trashDir = join(this.root, ".trash", trashId);
    const pageInTrash = join(trashDir, `${id}.md`);
    const childDir = join(this.root, id);
    const childInTrash = join(trashDir, id);

    const manifest: TrashManifest = {
      id,
      trashId,
      deleted,
      deletedAt: new Date().toISOString(),
    };

    try {
      await mkdir(dirname(pageInTrash), { recursive: true });
      await writeFile(join(trashDir, "meta.json"), JSON.stringify(manifest, null, 2), "utf8");
      await rename(record.filePath, pageInTrash);
      if (await pathExists(childDir)) {
        await mkdir(dirname(childInTrash), { recursive: true });
        await rename(childDir, childInTrash);
      }
    } catch (error) {
      // Best-effort rollback so a failed delete never loses the page.
      await rename(pageInTrash, record.filePath).catch(() => undefined);
      await rename(childInTrash, childDir).catch(() => undefined);
      await rm(trashDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }

    for (const deletedId of deleted) this.pages.delete(deletedId);
    this.reindexAll();
    return { trashId, deleted };
  }

  private async restoreNow(trashId: string): Promise<PageMeta[]> {
    if (!/^[A-Za-z0-9-]+$/.test(trashId)) throw badRequest("Invalid trash id");

    const trashRoot = resolve(this.root, ".trash");
    const trashDir = resolve(trashRoot, trashId);
    if (!trashDir.startsWith(`${trashRoot}${sep}`)) throw badRequest("Invalid trash id");

    let manifest: TrashManifest;
    try {
      const raw = await readFile(join(trashDir, "meta.json"), "utf8");
      manifest = JSON.parse(raw) as TrashManifest;
    } catch {
      throw notFound("Trash entry not found");
    }

    if (
      !manifest ||
      typeof manifest.id !== "string" ||
      !isValidPageId(manifest.id) ||
      !Array.isArray(manifest.deleted)
    ) {
      throw notFound("Trash entry not found");
    }

    const pageSource = join(trashDir, `${manifest.id}.md`);
    const pageTarget = this.filePathFor(manifest.id);
    const childSource = join(trashDir, manifest.id);
    const childTarget = join(this.root, manifest.id);

    if (!(await pathExists(pageSource))) throw notFound("Trash entry not found");
    if ((await pathExists(pageTarget)) || (await pathExists(childTarget))) {
      throw conflict(`A page already exists at ${manifest.id}`);
    }

    await mkdir(dirname(pageTarget), { recursive: true });
    await rename(pageSource, pageTarget);

    if (await pathExists(childSource)) {
      await mkdir(dirname(childTarget), { recursive: true });
      try {
        await rename(childSource, childTarget);
      } catch (error) {
        await rename(pageTarget, pageSource).catch(() => undefined);
        throw error;
      }
    }

    await rm(trashDir, { recursive: true, force: true });
    await this.rebuild();

    const restored = new Set(manifest.deleted);
    return this.list().filter((meta) => restored.has(meta.id));
  }

  private async moveNow(id: PageId, parentId: PageId | null): Promise<Page> {
    const record = this.require(id);

    if (parentId !== null) {
      if (typeof parentId !== "string" || !isValidPageId(parentId)) {
        throw badRequest("parentId must be a valid page id or null");
      }
      this.require(parentId);
      if (parentId === id || parentId.startsWith(`${id}/`)) {
        throw badRequest("cannot move a page into itself or one of its children");
      }
    }

    const segment = id.split("/").pop() ?? id;
    const newId = parentId ? `${parentId}/${segment}` : segment;
    if (newId === id) return this.get(id);

    if (this.pages.has(newId) || (await pathExists(this.filePathFor(newId)))) {
      throw conflict(`A page already exists at ${newId}`);
    }

    const oldDir = join(this.root, id);
    const newDir = join(this.root, newId);
    const hasChildren = [...this.pages.keys()].some((key) => key.startsWith(`${id}/`));

    await mkdir(dirname(this.filePathFor(newId)), { recursive: true });
    if (hasChildren) {
      await mkdir(dirname(newDir), { recursive: true });
      await rename(oldDir, newDir);
    }

    try {
      await rename(record.filePath, this.filePathFor(newId));
    } catch (error) {
      if (hasChildren) await rename(newDir, oldDir).catch(() => undefined);
      throw error;
    }

    const moved: PageRecord[] = [];
    for (const [key, value] of [...this.pages]) {
      if (key !== id && !key.startsWith(`${id}/`)) continue;
      this.pages.delete(key);
      const suffix = key.slice(id.length);
      const movedId = `${newId}${suffix}`;
      moved.push({ ...value, id: movedId, filePath: this.filePathFor(movedId) });
    }
    for (const value of moved) this.pages.set(value.id, value);

    const movedRoot = this.pages.get(newId);
    if (movedRoot) movedRoot.parentId = parentId;

    for (const [key, value] of this.pages) {
      const parent = parentOf(key);
      value.parentId = parent !== null && this.pages.has(parent) ? parent : null;
    }

    this.reindexAll();
    return this.get(newId);
  }

  // --- index -------------------------------------------------------------

  private async rebuild(): Promise<void> {
    this.pages.clear();
    this.edgesBySource.clear();

    for (const absolute of await this.scan(this.root)) {
      const rel = relative(this.root, absolute).split(sep).join("/");
      const id = pathToPageId(rel);
      if (!isValidPageId(id)) continue;

      const record = await this.readRecord(absolute, id);
      this.pages.set(id, record);
      this.refreshTags(record);
    }

    for (const [key, value] of this.pages) {
      const parent = parentOf(key);
      value.parentId = parent !== null && this.pages.has(parent) ? parent : null;
    }

    this.reindexAll();
  }

  private reindexAll(): void {
    const metas = this.list();
    this.edgesBySource.clear();
    for (const meta of metas) {
      const record = this.pages.get(meta.id);
      if (!record) continue;
      this.edgesBySource.set(meta.id, collectLinkEdges(meta.id, record.content, metas));
    }
  }

  private recomputeSource(id: PageId): void {
    const record = this.pages.get(id);
    if (!record) {
      this.edgesBySource.delete(id);
      return;
    }
    this.edgesBySource.set(id, collectLinkEdges(id, record.content, this.list()));
  }

  private allEdges(): LinkEdge[] {
    return [...this.edgesBySource.values()].flat();
  }

  private adjacency(): Map<PageId, Set<PageId>> {
    const map = new Map<PageId, Set<PageId>>();
    const link = (from: PageId, to: PageId): void => {
      const set = map.get(from) ?? new Set<PageId>();
      set.add(to);
      map.set(from, set);
    };

    for (const edge of this.allEdges()) {
      if (!edge.target) continue;
      link(edge.source, edge.target);
      link(edge.target, edge.source);
    }
    return map;
  }

  private refreshTags(record: PageRecord): void {
    record.tags = normalizeTags([...record.fmTags, ...extractTags(record.content)]).slice(0, MAX_TAGS);
  }

  private linkSnippet(record: PageRecord, targetTitle: string): string {
    const link = extractWikilinks(record.content).find(
      (candidate) => candidate.targetTitle.toLowerCase() === targetTitle.toLowerCase(),
    );
    if (!link) return makeSnippet(record.content, targetTitle, 60);

    const start = Math.max(0, link.index - 60);
    const end = Math.min(record.content.length, link.index + link.raw.length + 60);
    const text = record.content.slice(start, end).replace(/\s+/g, " ").trim();
    return `${start > 0 ? "…" : ""}${text}${end < record.content.length ? "…" : ""}`;
  }

  // --- files -------------------------------------------------------------

  private async readRecord(absolute: string, id: PageId): Promise<PageRecord> {
    const raw = await readFile(absolute, "utf8");
    const { frontmatter, content } = parseFrontmatter(raw);
    const stats = await stat(absolute);

    const created = toIso(frontmatter.created) ?? stats.birthtime.toISOString();
    const updated = toIso(frontmatter.updated) ?? stats.mtime.toISOString();
    const title =
      typeof frontmatter.title === "string" && frontmatter.title.trim().length > 0
        ? frontmatter.title.trim()
        : titleFromId(id);
    const icon =
      typeof frontmatter.icon === "string" && frontmatter.icon.trim().length > 0
        ? frontmatter.icon.trim()
        : undefined;

    const record: PageRecord = {
      id,
      title,
      tags: [],
      parentId: null,
      created,
      updated,
      content,
      filePath: absolute,
      fmTags: normalizeTags(frontmatter.tags),
    };
    if (icon) record.icon = icon;
    return record;
  }

  private async writePage(
    filePath: string,
    frontmatter: Frontmatter,
    content: string,
  ): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temporary, serializeNote(frontmatter, content), "utf8");
      await rename(temporary, filePath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async scan(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      if (entry.isSymbolicLink()) continue;

      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) files.push(...(await this.scan(absolute)));
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) files.push(absolute);
    }

    return files;
  }

  private async freeId(baseId: string): Promise<PageId> {
    let candidate = baseId;
    let suffix = 2;
    while (this.pages.has(candidate) || (await pathExists(this.filePathFor(candidate)))) {
      candidate = `${baseId}-${suffix}`;
      suffix += 1;
    }
    return candidate;
  }

  private async freeTrashId(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = randomUUID();
      if (!(await pathExists(join(this.root, ".trash", candidate)))) return candidate;
    }
    throw new Error("Could not allocate a trash id");
  }

  private subtreeIds(id: PageId): PageId[] {
    const ids = [...this.pages.keys()].filter(
      (key) => key === id || key.startsWith(`${id}/`),
    );
    return ids.sort((a, b) => {
      if (a === id) return -1;
      if (b === id) return 1;
      return a.localeCompare(b);
    });
  }

  private directChildCount(id: PageId): number {
    let count = 0;
    for (const record of this.pages.values()) {
      if (record.parentId === id) count += 1;
    }
    return count;
  }

  private filePathFor(id: PageId): string {
    if (!isValidPageId(id)) throw badRequest("Invalid page id");
    const absolute = resolve(this.root, `${id}.md`);
    if (!absolute.startsWith(`${this.root}${sep}`)) {
      throw badRequest("Page id escapes the vault");
    }
    return absolute;
  }

  private require(id: PageId): PageRecord {
    if (typeof id !== "string" || !isValidPageId(id)) throw badRequest("Invalid page id");
    const record = this.pages.get(id);
    if (!record) throw notFound(`Page not found: ${id}`);
    return record;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(task, task);
    this.writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
