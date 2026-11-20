import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
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
  parseNoteTemplate,
  serializeNoteLike,
  pathToPageId,
  resolveWikilink,
  rewriteLinksToPage,
  rewriteWikilinkTargets,
  titleFromId,
  pageSegment,
  ATTACHMENTS_DIR,
  noteFolder,
  relinkAttachments,
  type RelinkOptions,
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
import { buildDemoPages, WELCOME_TITLE } from "./demo.js";

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
  /** Version the client loaded; a mismatch means the file changed on disk. */
  expectedUpdated?: string;
  /** User chose "Keep mine" after a conflict. */
  force?: boolean;
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
  /** File mtime at the last read/write, for conditional saves. */
  fileMtimeMs: number;
  /** Frontmatter tags only; `tags` is this plus inline tags. */
  fmTags: string[];
  /**
   * The title comes from a `title:` key. Otherwise it is derived from the file
   * name (typical Obsidian note), and the file is never renamed to "fix" it.
   */
  explicitTitle: boolean;
}

/** `.trash/<trashId>/meta.json` (D11). */
interface TrashManifest {
  id: PageId;
  trashId: string;
  deleted: PageId[];
  deletedAt: string;
}

/** `segment` is `title` or `title N` (a duplicate suffix), ignoring case. */
function matchesTitleSegment(segment: string, title: string): boolean {
  const a = segment.toLowerCase();
  const b = title.toLowerCase();
  if (a === b) return true;
  if (!a.startsWith(`${b} `)) return false;
  return /^[2-9]\d*$|^1\d+$/.test(a.slice(b.length + 1));
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
  /** Old id -> new id after a rename, for stale URLs/tabs in this session. */
  private readonly redirects = new Map<PageId, PageId>();
  private watcher: FSWatcher | null = null;
  private watchTimer: ReturnType<typeof setTimeout> | null = null;
  /** Page to open once after first-run seeding (consumed by GET /pages). */
  private newVaultPage: PageId | null = null;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await this.rebuild();
  }

  /** Start watching the vault for external create/change/delete events. */
  startWatching(): void {
    if (this.watcher) return;
    try {
      this.watcher = watch(this.root, { recursive: true }, (_event, filename) => {
        const relative = filename === null ? "" : String(filename).replace(/\\/g, "/");
        if (relative.length === 0) return;
        if (
          relative.startsWith(".") ||
          relative.includes("/.") ||
          relative.includes("attachments/") ||
          relative.includes("node_modules") ||
          relative.endsWith(".tmp") ||
          !relative.toLowerCase().endsWith(".md")
        ) {
          return;
        }
        this.scheduleRescan();
      });
      this.watcher.on("error", () => undefined);
    } catch {
      // A platform without recursive watch still works; polling can be added later.
      this.watcher = null;
    }
  }

  /** Stop the vault watcher (used by tests and shutdown). */
  stopWatching(): void {
    if (this.watchTimer !== null) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }
    this.watcher?.close();
    this.watcher = null;
  }

  /** Re-read the vault and return whether the page index actually changed. */
  rescan(): Promise<boolean> {
    return this.enqueue(() => this.refreshFromDisk());
  }

  private scheduleRescan(): void {
    if (this.watchTimer !== null) clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      void this.enqueue(() => this.refreshFromDisk());
    }, 120);
  }

  private async refreshFromDisk(): Promise<boolean> {
    const next = new Map<PageId, PageRecord>();
    for (const absolute of await this.scan(this.root)) {
      const rel = relative(this.root, absolute).split(sep).join("/");
      const id = pathToPageId(rel);
      if (!isValidPageId(id)) continue;
      const record = await this.readRecord(absolute, id);
      this.refreshTags(record);
      next.set(id, record);
    }

    for (const [key, value] of next) {
      const parent = parentOf(key);
      value.parentId = parent !== null && next.has(parent) ? parent : null;
    }

    let changed = next.size !== this.pages.size;
    if (!changed) {
      for (const [id, record] of next) {
        const current = this.pages.get(id);
        if (!current || this.recordSignature(current) !== this.recordSignature(record)) {
          changed = true;
          break;
        }
      }
    }
    if (!changed) return false;

    // External renames: remember where an open page went so stale URLs follow.
    const externalMoves: Array<{ from: PageId; to: PageId }> = [];
    for (const [oldId, oldRecord] of this.pages) {
      if (next.has(oldId)) continue;
      const moved = [...next.values()].find(
        (record) => record.title === oldRecord.title && !this.pages.has(record.id),
      );
      if (!moved) continue;
      this.addRedirect(oldId, moved.id);
      // Same file, moved: identical content (a rename that also edits it is
      // left alone, we can't tell what the other tool meant).
      if (moved.content === oldRecord.content) externalMoves.push({ from: oldId, to: moved.id });
    }
    for (const id of next.keys()) this.redirects.delete(id);

    this.pages.clear();
    for (const [id, record] of next) this.pages.set(id, record);
    // D23: a file moved to another folder outside Gumply keeps working
    // attachment links. Links the other tool already fixed are kept.
    await this.relinkMoved(externalMoves, { keepValidAtDestination: true });
    this.reindexAll();
    return true;
  }

  private recordSignature(record: PageRecord): string {
    return JSON.stringify([
      record.title,
      record.icon ?? null,
      record.content,
      record.fmTags,
      record.parentId,
    ]);
  }

  /**
   * Seed the demo vault on a truly empty first run only (D10, spec/ux §2).
   * A marker in `.gumply/` makes this once-per-vault: deleting the demo (or
   * every page) never brings it back. Returns the Welcome page id when this
   * call did the seeding.
   */
  async seedDemoIfFirstRun(): Promise<PageId | null> {
    const marker = join(this.root, ".gumply", "demo-seeded.json");
    if (await pathExists(marker)) return null;

    if (this.pages.size > 0) {
      // Existing vault (created before server-side seeding, e.g. by the old
      // client-side demo): never inject demo pages, but remember that this
      // vault has had its first run. If it already has a Welcome page, announce
      // it once so the first browser after the upgrade lands on Welcome instead
      // of the alphabetically-first "Gumply demo" folder (#8w7r7nnc).
      await this.writeDemoMarker();
      const welcome = [...this.pages.values()]
        .filter(
          (record) =>
            record.parentId === null &&
            record.title.trim().toLowerCase() === WELCOME_TITLE.toLowerCase(),
        )
        .sort((a, b) => a.id.localeCompare(b.id))[0];
      if (welcome) this.newVaultPage = welcome.id;
      return null;
    }

    let welcomeId: PageId | null = null;
    for (const demo of buildDemoPages()) {
      const created = await this.create(demo);
      if (demo.title === WELCOME_TITLE) welcomeId = created.id;
    }
    await this.writeDemoMarker();
    this.newVaultPage = welcomeId;
    return welcomeId;
  }

  /** One-shot signal for the first browser: which page to open. */
  consumeNewVaultPage(): PageId | null {
    const page = this.newVaultPage;
    this.newVaultPage = null;
    return page;
  }

  private async writeDemoMarker(): Promise<void> {
    const dir = join(this.root, ".gumply");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "demo-seeded.json"),
      JSON.stringify({ demoSeededAt: new Date().toISOString() }, null, 2),
      "utf8",
    );
  }

  /**
   * D20 migration: rename files (and their sub-page folders) so every file
   * name follows its page title. Returns the plan; with `apply: false` nothing
   * is written (dry run), and the dry run always shows exactly what `apply`
   * does.
   *
   * - Only pages with an explicit `title:` are renamed. A note without one
   *   takes its title from the file name already, and renaming it would break
   *   Obsidian `[[file-name]]` links.
   * - Stable: a file already named after its title, or its title plus a
   *   duplicate suffix (`Dup 2`), is left alone, so a second run is a no-op.
   */
  syncFilenames(apply: boolean): Promise<Array<{ from: PageId; to: PageId }>> {
    return this.enqueue(async () => {
      const plans = await this.planFilenameSync();
      if (!apply || plans.length === 0) return plans;

      // Parents come first; later entries may live under an already-moved
      // folder, so translate their ids through the moves done so far.
      const moves: Array<{ from: PageId; to: PageId }> = [];
      const current = (id: PageId): PageId => {
        let result = id;
        for (const move of moves) {
          if (result === move.from) result = move.to;
          else if (result.startsWith(`${move.from}/`)) {
            result = `${move.to}${result.slice(move.from.length)}`;
          }
        }
        return result;
      };
      for (const plan of plans) {
        const from = current(plan.from);
        await this.relocateNow(from, plan.to);
        moves.push({ from, to: plan.to });
      }
      this.reindexAll();
      return plans;
    });
  }

  private async planFilenameSync(): Promise<Array<{ from: PageId; to: PageId }>> {
    const plans: Array<{ from: PageId; to: PageId }> = [];
    const planned = new Map<PageId, PageId>();
    const taken = new Set([...this.pages.keys()].map((id) => id.toLowerCase()));
    const records = [...this.pages.values()].sort(
      (a, b) => a.id.split("/").length - b.id.split("/").length || a.id.localeCompare(b.id),
    );

    for (const record of records) {
      // Folder path, following a planned move of the parent page (folders
      // without a page of their own stay where they are).
      const folder = parentOf(record.id);
      const plannedFolder = folder === null ? null : (planned.get(folder) ?? folder);
      const segment = record.id.slice(folder === null ? 0 : folder.length + 1);
      const here = plannedFolder === null ? segment : `${plannedFolder}/${segment}`;

      let target = here;
      if (record.explicitTitle) {
        const desired = pageSegment(record.title);
        if (!matchesTitleSegment(segment, desired)) {
          taken.delete(here.toLowerCase());
          const hasChildren = this.hasChildren(record.id);
          target = await this.freeTarget(
            childPageId(plannedFolder, record.title),
            hasChildren,
            taken,
          );
          plans.push({ from: record.id, to: target });
        }
      }
      taken.add(target.toLowerCase());
      planned.set(record.id, target);
    }
    return plans;
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
    const resolved = this.resolveId(id);
    const record = this.require(resolved);
    return {
      ...metaOf(record, this.directChildCount(resolved)),
      content: record.content,
    };
  }

  create(input: CreatePageInput): Promise<Page> {
    return this.enqueue(() => this.createNow(input));
  }

  update(id: PageId, patch: UpdatePageInput): Promise<Page & { rewrittenPages: PageId[] }> {
    return this.enqueue(() => this.updateNow(this.resolveId(id), patch));
  }

  remove(id: PageId): Promise<DeletePageResult> {
    return this.enqueue(() => this.removeNow(this.resolveId(id)));
  }

  restore(trashId: string): Promise<PageMeta[]> {
    return this.enqueue(() => this.restoreNow(trashId));
  }

  move(id: PageId, parentId: PageId | null): Promise<Page> {
    return this.enqueue(() => this.moveNow(this.resolveId(id), parentId));
  }

  backlinks(id: PageId): Backlink[] {
    id = this.resolveId(id);
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

    // v1.2 ghost nodes: unresolved links from pages in the current view. One
    // pair per source + missing title (case-insensitive); ghosts are not nodes,
    // so they never take part in the BFS above.
    const seenMissing = new Set<string>();
    const unresolved: GraphData["unresolved"] = [];
    for (const edge of this.allEdges()) {
      if (edge.target !== null || !included.has(edge.source)) continue;
      const key = `${edge.source}\u0000${edge.targetTitle.toLowerCase()}`;
      if (seenMissing.has(key)) continue;
      seenMissing.add(key);
      unresolved.push({ source: edge.source, targetTitle: edge.targetTitle });
    }
    unresolved.sort(
      (a, b) => a.source.localeCompare(b.source) || a.targetTitle.localeCompare(b.targetTitle),
    );

    return {
      nodes,
      links: edges.map((edge) => ({ source: edge.source, target: edge.target as PageId })),
      tags,
      unresolved,
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

  private resolveId(id: PageId): PageId {
    let current = id;
    const seen = new Set<PageId>();
    // A real page always wins over a stale redirect for the same id.
    while (!this.pages.has(current) && this.redirects.has(current) && !seen.has(current)) {
      seen.add(current);
      current = this.redirects.get(current) as PageId;
    }
    return current;
  }

  private addRedirect(from: PageId, to: PageId): void {
    if (from === to) return;
    this.redirects.set(from, to);
    // Keep chains short: everything that pointed at `from` now points at `to`.
    for (const [key, value] of [...this.redirects]) {
      if (value === from) this.redirects.set(key, to);
    }
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
    this.redirects.delete(id);
    const now = new Date().toISOString();
    const filePath = this.filePathFor(id);

    const { mtimeMs: fileMtimeMs } = await this.writePage(
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
      fileMtimeMs,
      fmTags: [],
      explicitTitle: true,
    };
    if (icon) record.icon = icon;

    this.pages.set(id, record);
    this.refreshTags(record);
    this.reindexAll();
    return this.get(id);
  }

  private async updateNow(
    id: PageId,
    patch: UpdatePageInput,
  ): Promise<Page & { rewrittenPages: PageId[]; conflictBackup?: string }> {
    let record = this.require(id);

    let info;
    try {
      info = await stat(record.filePath);
    } catch {
      info = null;
    }
    const mtimeChanged = info === null || Math.abs(info.mtimeMs - record.fileMtimeMs) > 1;
    const versionChanged =
      patch.expectedUpdated !== undefined && patch.expectedUpdated !== record.updated;
    const changedOnDisk = mtimeChanged || versionChanged;

    let conflictBackup: string | undefined;
    if (patch.force) {
      // Keep mine still preserves the version it is replacing, outside the page
      // index, so an accidental overwrite can be recovered.
      if (changedOnDisk) conflictBackup = await this.backupConflict(record);
    } else if (changedOnDisk) {
      throw conflict("This page changed on disk.");
    }

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

    // D20: only a title change renames the file; body/icon saves never move
    // it (old slug-named files are renamed the next time their title changes).
    const targetId = titleChanged ? await this.renameTarget(id, record.parentId, nextTitle) : id;

    const changes = ["updated"];
    if (nextTitle !== previousTitle) changes.push("title");
    if (nextIcon !== record.icon) changes.push("icon");
    if (JSON.stringify(fmTags) !== JSON.stringify(record.fmTags)) changes.push("tags");

    const written = await this.writePage(
      record.filePath,
      frontmatter,
      nextContent,
      changes,
      titleFromId(targetId),
    );
    const fileMtimeMs = written.mtimeMs;

    // Update the record before relocating so the moved copy carries the new
    // title/content; relocate then swaps the map entries and the object.
    record.title = nextTitle;
    record.content = nextContent;
    // A plain note has no `updated:` key; its version is the file time.
    record.updated = written.frontmatter ? updated : new Date(fileMtimeMs).toISOString();
    record.fileMtimeMs = fileMtimeMs;
    record.explicitTitle = record.explicitTitle || written.titleKey;
    record.fmTags = fmTags;
    if (nextIcon) record.icon = nextIcon;
    else delete record.icon;

    let relinked: PageId[] = [];
    if (targetId !== id) {
      relinked = await this.relocateNow(id, targetId);
      const moved = this.pages.get(targetId);
      if (moved) record = moved;
    }
    this.refreshTags(record);

    const rewrittenPages: PageId[] = [];

    if (titleChanged) {
      // D12: keep link text truthful by rewriting `[[Old…]]` in other pages.
      // #mp8eadhk: when the title and file name differ, links become
      // `[[file name|Title]]` so Obsidian (by file name) resolves them too.
      const afterMetas = this.list();
      const renamedMeta = afterMetas.find((meta) => meta.id === record.id);
      for (const other of [...this.pages.values()]) {
        if (other.id === id || other.id === targetId) continue;

        const isTarget = (link: { targetTitle: string }) =>
          resolveWikilink(link.targetTitle, beforeMetas)?.id === id;
        const result = renamedMeta
          ? rewriteLinksToPage(other.content, isTarget, renamedMeta, afterMetas, previousTitle)
          : rewriteWikilinkTargets(other.content, isTarget, nextTitle);
        if (result.count === 0) continue;

        const rewrittenAt = new Date().toISOString();
        const otherWritten = await this.writePage(
          other.filePath,
          {
            title: other.title,
            ...(other.icon ? { icon: other.icon } : {}),
            tags: other.fmTags,
            created: other.created,
            updated: rewrittenAt,
          },
          result.content,
          ["updated"],
          titleFromId(other.id),
        );
        other.content = result.content;
        other.updated = otherWritten.frontmatter
          ? rewrittenAt
          : new Date(otherWritten.mtimeMs).toISOString();
        other.fileMtimeMs = otherWritten.mtimeMs;
        this.refreshTags(other);
        rewrittenPages.push(other.id);
      }

      // D23: sub-pages whose attachment links moved with their folder.
      for (const relinkedId of relinked) {
        if (!rewrittenPages.includes(relinkedId)) rewrittenPages.push(relinkedId);
      }
      rewrittenPages.sort((a, b) => a.localeCompare(b));
      this.reindexAll();
    } else {
      this.recomputeSource(targetId);
    }

    return {
      ...this.get(targetId),
      rewrittenPages,
      ...(conflictBackup ? { conflictBackup } : {}),
    };
  }

  /** D20: the id (and therefore file path) follows the title. */
  private async renameTarget(
    id: PageId,
    parentId: PageId | null,
    title: string,
  ): Promise<PageId> {
    const folder = parentOf(id) ?? parentId;
    const desired = childPageId(folder, title);
    if (desired === id) return id;
    // Case-only change: same file on case-insensitive file systems.
    if (desired.toLowerCase() === id.toLowerCase()) return desired;
    const taken = new Set(
      [...this.pages.keys()].filter((key) => key !== id).map((key) => key.toLowerCase()),
    );
    return this.freeTarget(desired, this.hasChildren(id), taken);
  }

  private hasChildren(id: PageId): boolean {
    const prefix = `${id}/`;
    for (const key of this.pages.keys()) if (key.startsWith(prefix)) return true;
    return false;
  }

  /**
   * First of `base`, `base 2`, `base 3`, … that no other page uses (compared
   * case-insensitively) and that is free on disk. A page with sub-pages also
   * needs its folder name free.
   */
  private async freeTarget(
    base: PageId,
    withFolder: boolean,
    taken: ReadonlySet<string>,
  ): Promise<PageId> {
    for (let suffix = 1; ; suffix += 1) {
      const candidate = suffix === 1 ? base : `${base} ${suffix}`;
      if (taken.has(candidate.toLowerCase())) continue;
      if (await pathExists(this.filePathFor(candidate))) continue;
      if (withFolder && (await pathExists(join(this.root, candidate)))) continue;
      return candidate;
    }
  }

  /** Move a page file and its child folder, remapping ids without rewriting content. */
  private async relocateNow(id: PageId, newId: PageId): Promise<PageId[]> {
    const record = this.pages.get(id);
    if (!record) throw notFound("Page not found");
    if (id === newId) return [];

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

    const moved: Array<{ oldId: PageId; record: PageRecord }> = [];
    for (const [key, value] of [...this.pages]) {
      if (key !== id && !key.startsWith(`${id}/`)) continue;
      this.pages.delete(key);
      const movedId = `${newId}${key.slice(id.length)}`;
      moved.push({
        oldId: key,
        record: { ...value, id: movedId, filePath: this.filePathFor(movedId) },
      });
    }
    for (const { oldId, record: value } of moved) {
      this.pages.set(value.id, value);
      this.redirects.delete(value.id);
      this.addRedirect(oldId, value.id);
    }

    for (const [key, value] of this.pages) {
      const parent = parentOf(key);
      value.parentId = parent !== null && this.pages.has(parent) ? parent : null;
    }

    // D23: sub-pages now live in another folder; fix their attachment links.
    return this.relinkMoved(moved.map(({ oldId, record: value }) => ({ from: oldId, to: value.id })));
  }

  /**
   * D23 "On move": rewrite the attachment links of pages whose folder changed
   * so they stay note-relative. Returns the ids of pages whose file changed.
   */
  private async relinkMoved(
    moves: ReadonlyArray<{ from: PageId; to: PageId }>,
    options: RelinkOptions = {},
  ): Promise<PageId[]> {
    const relevant = moves.filter(({ from, to }) => noteFolder(from) !== noteFolder(to));
    if (relevant.length === 0) return [];
    const files = await this.attachmentFiles();
    const exists = (path: string) => files.has(path);
    const changed: PageId[] = [];
    for (const { from, to } of relevant) {
      const record = this.pages.get(to);
      if (!record) continue;
      const next = relinkAttachments(record.content, from, to, exists, options);
      if (next === record.content) continue;
      const at = new Date().toISOString();
      const written = await this.writePage(
        record.filePath,
        {
          title: record.title,
          ...(record.icon ? { icon: record.icon } : {}),
          tags: record.fmTags,
          created: record.created,
          updated: at,
        },
        next,
        ["updated"],
        titleFromId(record.id),
      );
      record.content = next;
      record.updated = written.frontmatter ? at : new Date(written.mtimeMs).toISOString();
      record.fileMtimeMs = written.mtimeMs;
      changed.push(record.id);
    }
    return changed;
  }

  /** Vault paths of every file under `attachments/` (any depth). */
  private async attachmentFiles(): Promise<Set<string>> {
    const out = new Set<string>();
    const walk = async (dir: string, prefix: string) => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const path = `${prefix}/${entry.name}`;
        if (entry.isDirectory()) await walk(join(dir, entry.name), path);
        else out.add(path);
      }
    };
    await walk(join(this.root, ATTACHMENTS_DIR), ATTACHMENTS_DIR);
    return out;
  }

  private async removeNow(id: PageId): Promise<DeletePageResult> {
    const record = this.require(id);
    const deleted = this.subtreeIds(id);
    const trashId = await this.freeTrashId();
    const trashDir = join(this.root, ".trash", trashId);
    const pageInTrash = join(trashDir, `${id}.md`);
    const childDir = join(this.root, id);
    const childInTrash = join(trashDir, id);
    const pageExists = await pathExists(record.filePath);
    const childExists = await pathExists(childDir);

    // The in-memory index can briefly outlive the files (e.g. a late autosave
    // racing a delete, or a partially completed trash move). If the page and
    // its child folder are both gone, the delete already happened: drop the
    // stale index entries instead of failing with ENOENT (#fny35jmn).
    if (!pageExists && !childExists) {
      console.warn(
        `[gumply] delete ${id}: file already missing (${record.filePath}); dropping stale index entry`,
      );
      for (const deletedId of deleted) this.pages.delete(deletedId);
      this.reindexAll();
      return { trashId: "", deleted };
    }

    const manifest: TrashManifest = {
      id,
      trashId,
      deleted,
      deletedAt: new Date().toISOString(),
    };

    try {
      await mkdir(dirname(pageInTrash), { recursive: true });
      await writeFile(join(trashDir, "meta.json"), JSON.stringify(manifest, null, 2), "utf8");
      if (pageExists) await rename(record.filePath, pageInTrash);
      if (childExists) {
        await mkdir(dirname(childInTrash), { recursive: true });
        await rename(childDir, childInTrash);
      }
    } catch (error) {
      const code = (error as { code?: string }).code ?? "unknown";
      console.error(
        `[gumply] delete ${id} failed (path=${record.filePath}, code=${code}):`,
        error,
      );
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

    // D23: the moved page and its sub-pages are in another folder now.
    await this.relinkMoved(
      moved.map((value) => ({ from: `${id}${value.id.slice(newId.length)}`, to: value.id })),
    );

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
    const mtime = stats.mtime.toISOString();
    const fmUpdated = toIso(frontmatter.updated);
    // External editors don't rewrite frontmatter. The newer of frontmatter and
    // file mtime is the version clients use for conditional saves.
    const updated = fmUpdated !== undefined && fmUpdated > mtime ? fmUpdated : mtime;
    const explicitTitle =
      typeof frontmatter.title === "string" && frontmatter.title.trim().length > 0;
    const title = explicitTitle ? (frontmatter.title as string).trim() : titleFromId(id);
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
      fileMtimeMs: stats.mtimeMs,
      fmTags: normalizeTags(frontmatter.tags),
      explicitTitle,
    };
    if (icon) record.icon = icon;
    return record;
  }

  private async backupConflict(record: PageRecord): Promise<string | undefined> {
    let raw: string;
    try {
      raw = await readFile(record.filePath, "utf8");
    } catch {
      return undefined;
    }
    const dir = join(this.root, ".gumply", "conflicts");
    await mkdir(dir, { recursive: true });
    const safeId = record.id.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 120);
    const file = join(dir, `${safeId}-${Date.now()}.md`);
    await writeFile(file, raw, "utf8");
    const relativePath = relative(this.root, file).split(sep).join("/");
    console.warn(`[gumply] conflict backup for ${record.id}: ${file}`);
    return relativePath;
  }

  private async writePage(
    filePath: string,
    frontmatter: Frontmatter,
    content: string,
    changes?: readonly string[],
    /** Title the file name gives (after any rename); enables plain-note mode. */
    implicitTitle?: string,
  ): Promise<{ mtimeMs: number; frontmatter: boolean; titleKey: boolean }> {
    await mkdir(dirname(filePath), { recursive: true });
    // Use the current file as the byte template so unknown frontmatter keys,
    // comments, key order, flow style, CRLF and the trailing newline survive
    // (#tterskg4). Only the keys in `changes` are touched.
    let template = null;
    try {
      template = parseNoteTemplate(await readFile(filePath, "utf8"));
    } catch {
      // New file: write canonical frontmatter.
    }
    // A note without frontmatter (the Obsidian default) stays without it
    // unless it now needs a key: an icon, tags, or a title the file name
    // can't express.
    let plain = false;
    if (template !== null && template.yaml === null && implicitTitle !== undefined) {
      const tags = Array.isArray(frontmatter.tags) ? frontmatter.tags : [];
      plain = !frontmatter.icon && tags.length === 0 && frontmatter.title === implicitTitle;
    }
    const text = plain
      ? serializeNoteLike(template, {}, content, [])
      : serializeNoteLike(template, frontmatter, content, changes);
    const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temporary, text, "utf8");
      await rename(temporary, filePath);
      return {
        mtimeMs: (await stat(filePath)).mtimeMs,
        frontmatter: !plain,
        // A new block always has `title:`; an edited one only if it changed.
        titleKey:
          !plain && (template === null || template.yaml === null || (changes ?? []).includes("title")),
      };
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
      // Attachments are files, never pages (D18). Skip the root attachments dir.
      if (dir === this.root && entry.name === "attachments") continue;
      if (entry.isSymbolicLink()) continue;

      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) files.push(...(await this.scan(absolute)));
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) files.push(absolute);
    }

    return files;
  }

  private async freeId(baseId: string): Promise<PageId> {
    const taken = new Set([...this.pages.keys()].map((key) => key.toLowerCase()));
    return this.freeTarget(baseId, false, taken);
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
