import { randomUUID } from "node:crypto";
import { readdirSync, watch, type FSWatcher } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  childPageId,
  collectLinkEdges,
  extractTags,
  extractWikilinks,
  isValidPageId,
  makeSnippet,
  markdownLinks,
  linkSnippet,
  plainText,
  type MarkdownLink,
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
  canvasLinks,
  canvasMeta,
  canvasText,
  emptyCanvas,
  parseCanvas,
  rewriteCanvas,
  serializeCanvas,
  withCanvasMeta,
  CanvasParseError,
  type CanvasBoard,
  type BoardDocument,
  type PageKind,
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
import {
  buildDemoBoard,
  buildDemoPages,
  DEMO_BOARD_TITLE,
  DEMO_FOLDER_TITLE,
  WELCOME_TITLE,
} from "./demo.js";

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

export interface CreateBoardInput {
  title: string;
  parentId?: string | null;
  icon?: string;
}

export interface UpdateBoardInput {
  board?: unknown;
  title?: string;
  icon?: string | null;
  tags?: string[];
  expectedUpdated?: string;
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
  /** D25: a Markdown page or a JSON Canvas whiteboard. */
  kind: PageKind;
  /**
   * Whiteboards only: the parsed board. `content` then holds its searchable
   * text (`canvasText`), so search, tags and `[[link]]` edges work unchanged.
   */
  board?: CanvasBoard;
  /**
   * Whiteboards only: the file had entries `parseCanvas` drops (duplicate node
   * ids, edges to missing nodes). The first save backs up the original.
   */
  boardRepaired?: boolean;
}

/** `.trash/<trashId>/meta.json` (D11). */
interface TrashManifest {
  id: PageId;
  trashId: string;
  deleted: PageId[];
  deletedAt: string;
  /** Vault-relative file of `id` (v1.7: `.md` or `.canvas`); old manifests: `${id}.md`. */
  file?: string;
}

const BOARD_EXTENSION = ".canvas";

/** D25 (spec/api v1.7): board ids keep their `.canvas` extension. */
export function isBoardId(id: string): boolean {
  return id.toLowerCase().endsWith(BOARD_EXTENSION);
}

/**
 * The name used for collisions across both kinds (D20 + v1.7): a page "Map"
 * and a board "Map.canvas" compete for the same title in a folder.
 */
function collisionKey(id: string): string {
  const lower = id.toLowerCase();
  return lower.endsWith(BOARD_EXTENSION) ? lower.slice(0, -BOARD_EXTENSION.length) : lower;
}

/** A board's file name without folder and `.canvas`: `Projects/Map.canvas` → `Map`. */
function boardStem(id: PageId): string {
  return (id.split("/").pop() ?? id).slice(0, -BOARD_EXTENSION.length);
}

/**
 * #phvu6zt9: a board's display title lives in `gumply.title` when the file
 * name can't hold it ("Roadmap: Q3?" in `Roadmap Q3.canvas`, or "Map" in
 * `Map 2.canvas`). The key is server-owned: set here on every write and
 * removed when the file name says it all.
 */
function withBoardTitle(board: CanvasBoard, title: string, stem: string): CanvasBoard {
  const data = board.gumply && typeof board.gumply === "object" ? { ...board.gumply } : {};
  if (title === stem) delete data.title;
  else data.title = title;
  const next: CanvasBoard = { ...board };
  if (Object.keys(data).length === 0) delete next.gumply;
  else next.gumply = data;
  return next;
}

/**
 * The title to show: `gumply.title` while it still belongs to this file name
 * (it sanitises to the stem, a D20 ` 2` suffix allowed), else the stem. After a
 * rename in Obsidian the old key no longer matches and the new name wins.
 */
function boardDisplayTitle(board: CanvasBoard, stem: string): string {
  const stored = board.gumply && typeof board.gumply.title === "string" ? board.gumply.title.trim() : "";
  if (stored && matchesTitleSegment(stem, pageSegment(stored))) return stored;
  return stem || "Untitled";
}

/** How many entries `parseCanvas` would drop from this file (0 when unsure). */
function droppedCanvasEntries(source: string, board: CanvasBoard): number {
  try {
    const raw = JSON.parse(source) as { nodes?: unknown; edges?: unknown };
    const nodes = Array.isArray(raw.nodes) ? raw.nodes.length : 0;
    const edges = Array.isArray(raw.edges) ? raw.edges.length : 0;
    return Math.max(0, nodes - board.nodes.length) + Math.max(0, edges - board.edges.length);
  } catch {
    return 0;
  }
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
    kind: record.kind,
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
  /**
   * One non-recursive watcher per vault directory (#3ugdxhzu). Node 20/22's
   * recursive watch on Linux follows file inodes and loses a file once it is
   * replaced atomically (every app save); a directory watch sees the rename
   * into the directory on every Node version and platform.
   */
  private readonly directoryWatchers = new Map<string, FSWatcher>();
  private watching = false;
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
    if (this.watching) return;
    this.watching = true;
    // Synchronous, so edits made right after start are already seen.
    this.syncDirectoryWatchers();
  }

  /** Stop the vault watcher (used by tests and shutdown). */
  stopWatching(): void {
    this.watching = false;
    if (this.watchTimer !== null) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }
    for (const watcher of this.directoryWatchers.values()) watcher.close();
    this.directoryWatchers.clear();
  }

  /** Every directory the index reads pages from (no dot dirs, attachments, node_modules). */
  private vaultDirectories(dir: string = this.root): string[] {
    const found = [dir];
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return found;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      if (dir === this.root && entry.name === "attachments") continue;
      found.push(...this.vaultDirectories(join(dir, entry.name)));
    }
    return found;
  }

  /** Watch new directories and stop watching removed ones. */
  private syncDirectoryWatchers(): void {
    if (!this.watching) return;
    const wanted = new Set(this.vaultDirectories());
    for (const [dir, watcher] of this.directoryWatchers) {
      if (wanted.has(dir)) continue;
      watcher.close();
      this.directoryWatchers.delete(dir);
    }
    for (const dir of wanted) {
      if (this.directoryWatchers.has(dir)) continue;
      try {
        const watcher = watch(dir, (_event, filename) => this.onWatchEvent(dir, filename));
        watcher.on("error", () => {
          watcher.close();
          this.directoryWatchers.delete(dir);
          this.scheduleRescan();
        });
        this.directoryWatchers.set(dir, watcher);
      } catch {
        // Gone already (or no permission): the next rescan settles it.
      }
    }
  }

  private onWatchEvent(dir: string, filename: string | Buffer | null): void {
    const name = filename === null ? "" : String(filename);
    // Unknown name (some platforms): rescan to be safe.
    if (name.length === 0) return this.scheduleRescan();
    if (name.startsWith(".") || name.endsWith(".tmp") || name === "node_modules") return;
    // A page/board changed, or a folder appeared or went away.
    if (/\.(md|canvas)$/i.test(name) || !name.includes(".")) this.scheduleRescan();
    else if (this.directoryWatchers.has(join(dir, name))) this.scheduleRescan();
  }

  /** Re-read the vault and return whether the page index actually changed. */
  rescan(): Promise<boolean> {
    return this.enqueue(() => this.refreshFromDisk());
  }

  private scheduleRescan(): void {
    if (this.watchTimer !== null) clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      void this.enqueue(async () => {
        const changed = await this.refreshFromDisk();
        // Folders may have appeared or gone: keep one watcher per directory.
        this.syncDirectoryWatchers();
        return changed;
      });
    }, 120);
  }

  /**
   * Read every page and board (D25). Ids: pages are paths without `.md`,
   * boards keep `.canvas`. A page whose id would equal a board's (a file
   * `Map.canvas.md` next to `Map.canvas`) keeps its `.md` so both stay.
   */
  private async scanRecords(): Promise<Map<PageId, PageRecord>> {
    const next = new Map<PageId, PageRecord>();
    const files = (await this.scan(this.root)).map((absolute) => ({
      absolute,
      rel: relative(this.root, absolute).split(sep).join("/"),
    }));
    const boards = new Set(files.filter((file) => isBoardId(file.rel)).map((file) => file.rel.toLowerCase()));
    for (const { absolute, rel } of files) {
      let id = isBoardId(rel) ? rel : pathToPageId(rel);
      if (!isBoardId(rel) && boards.has(id.toLowerCase())) id = rel;
      if (!isValidPageId(id)) continue;
      const record = await this.readRecord(absolute, id);
      this.refreshTags(record);
      next.set(id, record);
    }
    VaultStore.assignParents(next);
    return next;
  }

  /** Folder pages are parents; boards never have sub-pages (v0.4). */
  private static assignParents(records: Map<PageId, PageRecord>): void {
    for (const [key, value] of records) {
      const parent = parentOf(key);
      value.parentId = parent !== null && records.get(parent)?.kind === "page" ? parent : null;
    }
  }

  private async refreshFromDisk(): Promise<boolean> {
    const next = await this.scanRecords();

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
      // Pages keep their frontmatter title across a rename; a board's title
      // is its file name, so a renamed board is recognised by its content.
      const oldBoard = oldRecord.board ? serializeCanvas(oldRecord.board) : null;
      const moved = [...next.values()].find(
        (record) =>
          !this.pages.has(record.id) &&
          record.kind === oldRecord.kind &&
          (oldBoard !== null
            ? record.board !== undefined && serializeCanvas(record.board) === oldBoard
            : record.title === oldRecord.title),
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
      record.kind,
      record.board ? serializeCanvas(record.board) : null,
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

    // #pc3wvc2u: no notes isn't the same as empty. A folder that already
    // holds the user's files (PDFs, images, scripts…) is opened as it is:
    // no demo, and nothing written into it, not even the marker. Only dot
    // entries (.DS_Store, .obsidian, .gumply) don't count.
    if (await this.hasVisibleEntries()) return null;

    let welcomeId: PageId | null = null;
    for (const demo of buildDemoPages()) {
      const created = await this.create(demo);
      if (demo.title === WELCOME_TITLE) welcomeId = created.id;
    }
    // D25: one example whiteboard linking the demo pages (#dvnb8n2n).
    const board = await this.createBoard({
      title: DEMO_BOARD_TITLE,
      parentId: childPageId(null, DEMO_FOLDER_TITLE),
      icon: "🗺️",
    });
    await this.updateBoard(board.meta.id, {
      board: { ...buildDemoBoard(), gumply: board.board.gumply },
    });
    await this.writeDemoMarker();
    this.newVaultPage = welcomeId;
    return welcomeId;
  }

  private async hasVisibleEntries(): Promise<boolean> {
    try {
      return (await readdir(this.root)).some((name) => !name.startsWith("."));
    } catch {
      return false;
    }
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
    const taken = new Set([...this.pages.keys()].map(collisionKey));
    const records = [...this.pages.values()].filter((record) => record.kind === "page").sort(
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
          taken.delete(collisionKey(here));
          const hasChildren = this.hasChildren(record.id);
          target = await this.freeTarget(
            childPageId(plannedFolder, record.title),
            hasChildren,
            taken,
          );
          plans.push({ from: record.id, to: target });
        }
      }
      taken.add(collisionKey(target));
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
    if (record.kind === "whiteboard") {
      throw notFound("This is a whiteboard; read it with GET /api/boards/:id");
    }
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

  // --- whiteboards (D25, spec/api v1.7) -----------------------------------

  getBoard(id: PageId): BoardDocument {
    const resolved = this.resolveId(id);
    const record = this.requireBoard(resolved);
    return { meta: metaOf(record, 0), board: record.board as CanvasBoard };
  }

  createBoard(input: CreateBoardInput): Promise<BoardDocument> {
    return this.enqueue(() => this.createBoardNow(input));
  }

  updateBoard(
    id: PageId,
    patch: UpdateBoardInput,
  ): Promise<BoardDocument & { rewrittenPages: PageId[]; conflictBackup?: string; repairBackup?: string }> {
    return this.enqueue(() => this.updateBoardNow(this.resolveId(id), patch));
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

      // #6zifz7da: match what the page reads as, not its Markdown, so a
      // phrase across formatting or a link is found; snippets are plain too.
      const { text, links } = this.searchText(record);
      const inText = countOccurrences(text.toLowerCase(), needle);
      // Pasted URLs and link targets stay searchable ("figma.com").
      const linkHits = links.filter((link) => link.target.toLowerCase().includes(needle));
      const occurrences = inText + linkHits.length;
      if (titleScore === 0 && occurrences === 0) continue;

      const bodyBoost = Math.min(occurrences, 10);
      // The snippet is always plain text: around the hit, or around the text
      // of the link whose URL matched.
      const around = inText > 0 ? trimmed : (linkHits[0]?.text ?? "");
      results.push({
        page: metaOf(record, this.directChildCount(record.id)),
        snippet: makeSnippet(text, around, 80),
        score: titleScore > 0 ? titleScore + bodyBoost : bodyBoost + 1,
      });
    }

    return results.sort(
      (a, b) => b.score - a.score || a.page.title.localeCompare(b.page.title),
    );
  }

  /** Plain text and link targets of a page for search, cached until its content changes. */
  private readonly searchTexts = new Map<PageId, { content: string; text: string; links: MarkdownLink[] }>();
  private searchText(record: PageRecord): { text: string; links: MarkdownLink[] } {
    const cached = this.searchTexts.get(record.id);
    if (cached && cached.content === record.content) return cached;
    // Boards: `content` is already plain board text (canvasText) apart from
    // the Markdown inside stickies, which plainText handles the same way.
    const entry = { content: record.content, text: plainText(record.content), links: markdownLinks(record.content) };
    this.searchTexts.set(record.id, entry);
    if (this.searchTexts.size > this.pages.size * 2 + 100) {
      for (const id of this.searchTexts.keys()) if (!this.pages.has(id)) this.searchTexts.delete(id);
    }
    return entry;
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
      kind: "page",
    };
    if (icon) record.icon = icon;

    this.pages.set(id, record);
    this.refreshTags(record);
    this.reindexAll();
    return this.get(id);
  }

  private async createBoardNow(input: CreateBoardInput): Promise<BoardDocument> {
    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (title.length === 0) throw badRequest("title is required");
    if (title.length > MAX_TITLE_LENGTH) {
      throw badRequest(`title is too long (max ${MAX_TITLE_LENGTH} characters)`);
    }
    const parentId = input.parentId ?? null;
    if (parentId !== null) {
      if (typeof parentId !== "string" || !isValidPageId(parentId)) {
        throw badRequest("parentId must be a valid page id or null");
      }
      if (this.require(parentId).kind !== "page") throw badRequest("Whiteboards can't have sub-pages");
    }
    const icon = typeof input.icon === "string" && input.icon.trim().length > 0 ? input.icon.trim() : undefined;

    const id = await this.freeId(childPageId(parentId, title), "whiteboard");
    this.redirects.delete(id);
    const filePath = this.filePathFor(id);
    const board = withBoardTitle(emptyCanvas(icon ? { icon } : undefined), title, boardStem(id));
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, serializeCanvas(board), { encoding: "utf8", flag: "wx" });
    const record = await this.readBoardRecord(filePath, id);
    record.parentId = parentId;
    this.pages.set(id, record);
    this.refreshTags(record);
    this.reindexAll();
    return this.getBoard(id);
  }

  /**
   * Save a board (and/or rename it, set icon/tags). Conditional like pages
   * (D22): a file changed on disk is a 409 unless `force` (Keep mine), which
   * backs up the disk version first.
   */
  private async updateBoardNow(
    id: PageId,
    patch: UpdateBoardInput,
  ): Promise<BoardDocument & { rewrittenPages: PageId[]; conflictBackup?: string; repairBackup?: string }> {
    let record = this.requireBoard(id);

    let info;
    try {
      info = await stat(record.filePath);
    } catch {
      info = null;
    }
    const mtimeChanged = info === null || Math.abs(info.mtimeMs - record.fileMtimeMs) > 1;
    const versionChanged = patch.expectedUpdated !== undefined && patch.expectedUpdated !== record.updated;
    let conflictBackup: string | undefined;
    if (mtimeChanged || versionChanged) {
      if (!patch.force) throw conflict("This whiteboard changed on disk.");
      conflictBackup = await this.backupConflict(record);
    }

    // Validate the new board through the same parser the files go through.
    let board = record.board as CanvasBoard;
    if (patch.board !== undefined) {
      if (typeof patch.board !== "object" || patch.board === null || Array.isArray(patch.board)) {
        throw badRequest("board must be a JSON Canvas object");
      }
      const text = JSON.stringify(patch.board);
      if (text.length > MAX_CONTENT_LENGTH) throw badRequest("board is too large");
      try {
        board = parseCanvas(text);
      } catch (error) {
        throw badRequest(error instanceof Error ? error.message : "Invalid board");
      }
    }
    if (patch.icon !== undefined || patch.tags !== undefined) {
      if (patch.icon !== undefined && patch.icon !== null && typeof patch.icon !== "string") {
        throw badRequest("icon must be a string or null");
      }
      board = withCanvasMeta(board, {
        ...(patch.icon !== undefined ? { icon: patch.icon } : {}),
        ...(patch.tags !== undefined ? { tags: normalizeTags(patch.tags).slice(0, MAX_TAGS) } : {}),
      });
    }

    const previousTitle = record.title;
    const nextTitle = patch.title === undefined ? record.title : String(patch.title).trim();
    if (nextTitle.length === 0) throw badRequest("title must not be empty");
    if (nextTitle.length > MAX_TITLE_LENGTH) {
      throw badRequest(`title is too long (max ${MAX_TITLE_LENGTH} characters)`);
    }
    const titleChanged = nextTitle !== previousTitle;
    const beforeMetas = titleChanged ? this.list() : [];

    // D20: the file name follows the title; the id keeps `.canvas`. The full
    // title is (re)applied to `gumply.title` on every save, so a client that
    // drops the key can't lose it (#phvu6zt9).
    const targetId = titleChanged ? await this.renameTarget(id, record.parentId, nextTitle, "whiteboard") : id;
    board = withBoardTitle(board, nextTitle, boardStem(targetId));

    const repairBackup = await this.saveBoardRecord(record, board);

    const rewrittenPages: PageId[] = [];
    if (titleChanged) {
      if (targetId !== id) {
        rewrittenPages.push(...(await this.relocateNow(id, targetId)));
        record = this.pages.get(targetId) ?? record;
      }
      record.title = nextTitle;
      rewrittenPages.push(...(await this.rewriteLinksTo(id, record, previousTitle, beforeMetas)));
      this.reindexAll();
    } else {
      this.recomputeSource(id);
    }

    return {
      ...this.getBoard(targetId),
      rewrittenPages: [...new Set(rewrittenPages)].sort((a, b) => a.localeCompare(b)),
      ...(conflictBackup ? { conflictBackup } : {}),
      ...(repairBackup ? { repairBackup } : {}),
    };
  }

  /**
   * Write a board file atomically and refresh its record. When the file had
   * entries a board can't keep (or wasn't valid JSON Canvas), the original is
   * copied to `.gumply/conflicts/` first, once. Returns that backup path.
   */
  private async saveBoardRecord(record: PageRecord, board: CanvasBoard): Promise<string | undefined> {
    let repairBackup: string | undefined;
    if (record.boardRepaired) {
      repairBackup = await this.backupConflict(record);
      record.boardRepaired = false;
    }
    const temporary = `${record.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await mkdir(dirname(record.filePath), { recursive: true });
      await writeFile(temporary, serializeCanvas(board), "utf8");
      await rename(temporary, record.filePath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    const stats = await stat(record.filePath);
    const meta = canvasMeta(board);
    record.board = board;
    record.content = canvasText(board);
    record.fileMtimeMs = stats.mtimeMs;
    record.updated = stats.mtime.toISOString();
    record.fmTags = normalizeTags(meta.tags);
    if (meta.icon) record.icon = meta.icon;
    else delete record.icon;
    this.refreshTags(record);
    return repairBackup;
  }

  private async updateNow(
    id: PageId,
    patch: UpdatePageInput,
  ): Promise<Page & { rewrittenPages: PageId[]; conflictBackup?: string }> {
    let record = this.require(id);
    if (record.kind === "whiteboard") {
      throw notFound("This is a whiteboard; save it with PUT /api/boards/:id");
    }

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
      rewrittenPages.push(...(await this.rewriteLinksTo(id, record, previousTitle, beforeMetas)));

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

  /**
   * D12: after `oldId` was renamed to `record` (title `previousTitle` before),
   * rewrite `[[links]]` to it in every other page and board. #mp8eadhk: when
   * title and file name differ, links become `[[file name|Title]]` (for a
   * board always `[[Map.canvas|Map]]`, v1.7) so Obsidian resolves them too.
   */
  private async rewriteLinksTo(
    oldId: PageId,
    record: PageRecord,
    previousTitle: string,
    beforeMetas: readonly PageMeta[],
  ): Promise<PageId[]> {
    const rewritten: PageId[] = [];
    const afterMetas = this.list();
    const renamedMeta = afterMetas.find((meta) => meta.id === record.id);
    const isTarget = (link: { targetTitle: string }) =>
      resolveWikilink(link.targetTitle, beforeMetas)?.id === oldId;
    const rewriteText = (markdown: string) =>
      renamedMeta
        ? rewriteLinksToPage(markdown, isTarget, renamedMeta, afterMetas, previousTitle)
        : rewriteWikilinkTargets(markdown, isTarget, record.title);

    for (const other of [...this.pages.values()]) {
      if (other.id === oldId || other.id === record.id) continue;

      if (other.board) {
        const result = rewriteCanvas(other.board, { text: (markdown) => rewriteText(markdown).content });
        if (result.count === 0) continue;
        await this.saveBoardRecord(other, result.board);
        rewritten.push(other.id);
        continue;
      }

      const result = rewriteText(other.content);
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
      rewritten.push(other.id);
    }
    return rewritten;
  }

  /** D20: the id (and therefore file path) follows the title. Boards keep `.canvas`. */
  private async renameTarget(
    id: PageId,
    parentId: PageId | null,
    title: string,
    kind: PageKind = "page",
  ): Promise<PageId> {
    const folder = parentOf(id) ?? parentId;
    const stem = childPageId(folder, title);
    const desired = kind === "whiteboard" ? `${stem}${BOARD_EXTENSION}` : stem;
    if (desired === id) return id;
    // Case-only change: same file on case-insensitive file systems.
    if (desired.toLowerCase() === id.toLowerCase()) return desired;
    const taken = new Set([...this.pages.keys()].filter((key) => key !== id).map(collisionKey));
    return this.freeTarget(stem, this.hasChildren(id), taken, kind);
  }

  private hasChildren(id: PageId): boolean {
    const prefix = `${id}/`;
    for (const key of this.pages.keys()) if (key.startsWith(prefix)) return true;
    return false;
  }

  /**
   * First of `base`, `base 2`, `base 3`, … that no other page **or board**
   * uses (compared case-insensitively, v1.7) and that is free on disk as both
   * `.md` and `.canvas`. A page with sub-pages also needs its folder name free.
   * `base` is the id without extension; boards get `.canvas` appended.
   */
  private async freeTarget(
    base: PageId,
    withFolder: boolean,
    taken: ReadonlySet<string>,
    kind: PageKind = "page",
  ): Promise<PageId> {
    for (let suffix = 1; ; suffix += 1) {
      const candidate = suffix === 1 ? base : `${base} ${suffix}`;
      if (taken.has(candidate.toLowerCase())) continue;
      // A page id ending in `.canvas` would read as a board id.
      if (kind === "page" && isBoardId(candidate)) continue;
      if (await pathExists(this.filePathFor(candidate))) continue;
      if (await pathExists(this.filePathFor(`${candidate}${BOARD_EXTENSION}`))) continue;
      if (withFolder && (await pathExists(join(this.root, candidate)))) continue;
      return kind === "whiteboard" ? `${candidate}${BOARD_EXTENSION}` : candidate;
    }
  }

  /** Where a record's file goes when its id becomes `newId` (same extension). */
  private movedFilePath(record: PageRecord, newId: PageId): string {
    const suffix = record.filePath.slice(resolve(this.root, record.id).length);
    const absolute = resolve(this.root, `${newId}${suffix}`);
    if (!absolute.startsWith(`${this.root}${sep}`)) throw badRequest("Page id escapes the vault");
    return absolute;
  }

  /** Move a page file and its child folder, remapping ids without rewriting content. */
  private async relocateNow(id: PageId, newId: PageId): Promise<PageId[]> {
    const record = this.pages.get(id);
    if (!record) throw notFound("Page not found");
    if (id === newId) return [];

    const oldDir = join(this.root, id);
    const newDir = join(this.root, newId);
    const hasChildren = [...this.pages.keys()].some((key) => key.startsWith(`${id}/`));

    const newFile = this.movedFilePath(record, newId);
    await mkdir(dirname(newFile), { recursive: true });
    if (hasChildren) {
      await mkdir(dirname(newDir), { recursive: true });
      await rename(oldDir, newDir);
    }

    try {
      await rename(record.filePath, newFile);
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
        record: { ...value, id: movedId, filePath: this.movedFilePath(value, movedId) },
      });
    }
    for (const { oldId, record: value } of moved) {
      this.pages.set(value.id, value);
      this.redirects.delete(value.id);
      this.addRedirect(oldId, value.id);
    }

    VaultStore.assignParents(this.pages);

    const moves = moved.map(({ oldId, record: value }) => ({ from: oldId, to: value.id }));
    // D23: sub-pages now live in another folder; fix their attachment links.
    const relinked = await this.relinkMoved(moves);
    // D25: board cards pointing at moved pages/boards follow them.
    const boards = await this.rewriteBoardCards(moves);
    return [...new Set([...relinked, ...boards])];
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
      // Boards reference attachments vault-root (JSON Canvas), never relative.
      if (!record || record.kind !== "page") continue;
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
    const file = relative(this.root, record.filePath).split(sep).join("/");
    const pageInTrash = join(trashDir, file);
    const childDir = join(this.root, id);
    const childInTrash = join(trashDir, id);
    const pageExists = await pathExists(record.filePath);
    // Only pages have a sub-page folder; for a board `id` is the file itself.
    const childExists = record.kind === "page" && (await pathExists(childDir));

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
      file,
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

    // v1.7 manifests name the file (`.md` or `.canvas`); older ones mean `.md`.
    const file =
      typeof manifest.file === "string" && manifest.file.length > 0 ? manifest.file : `${manifest.id}.md`;
    const pageSource = resolve(trashDir, file);
    const pageTarget = resolve(this.root, file);
    if (!pageSource.startsWith(`${trashDir}${sep}`) || !pageTarget.startsWith(`${this.root}${sep}`)) {
      throw notFound("Trash entry not found");
    }
    // Boards (`.canvas`) have no sub-page folder.
    const hasFolder = !isBoardId(file);
    const childSource = join(trashDir, manifest.id);
    const childTarget = join(this.root, manifest.id);

    if (!(await pathExists(pageSource))) throw notFound("Trash entry not found");
    if ((await pathExists(pageTarget)) || (hasFolder && (await pathExists(childTarget)))) {
      throw conflict(`A page already exists at ${manifest.id}`);
    }

    await mkdir(dirname(pageTarget), { recursive: true });
    await rename(pageSource, pageTarget);

    if (hasFolder && (await pathExists(childSource))) {
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
      if (this.require(parentId).kind !== "page") throw badRequest("Whiteboards can't have sub-pages");
      if (parentId === id || parentId.startsWith(`${id}/`)) {
        throw badRequest("cannot move a page into itself or one of its children");
      }
    }

    const segment = id.split("/").pop() ?? id;
    const newId = parentId ? `${parentId}/${segment}` : segment;
    if (newId === id) return this.getAny(id);

    const newFile = this.movedFilePath(record, newId);
    const clash = [...this.pages.keys()].some(
      (key) => key !== id && collisionKey(key) === collisionKey(newId),
    );
    if (this.pages.has(newId) || clash || (await pathExists(newFile))) {
      throw conflict(`A page already exists at ${newId}`);
    }

    const oldDir = join(this.root, id);
    const newDir = join(this.root, newId);
    const hasChildren = [...this.pages.keys()].some((key) => key.startsWith(`${id}/`));

    await mkdir(dirname(newFile), { recursive: true });
    if (hasChildren) {
      await mkdir(dirname(newDir), { recursive: true });
      await rename(oldDir, newDir);
    }

    try {
      await rename(record.filePath, newFile);
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
      moved.push({ ...value, id: movedId, filePath: this.movedFilePath(value, movedId) });
    }
    for (const value of moved) this.pages.set(value.id, value);

    const movedRoot = this.pages.get(newId);
    if (movedRoot) movedRoot.parentId = parentId;

    VaultStore.assignParents(this.pages);

    const moves = moved.map((value) => ({ from: `${id}${value.id.slice(newId.length)}`, to: value.id }));
    // D23: the moved page and its sub-pages are in another folder now.
    await this.relinkMoved(moves);
    // D25: board cards pointing at them follow.
    await this.rewriteBoardCards(moves);

    this.reindexAll();
    return this.getAny(newId);
  }

  /** A page, or a board's meta with empty content (shared endpoints: move). */
  private getAny(id: PageId): Page {
    const record = this.require(id);
    if (record.kind === "whiteboard") return { ...metaOf(record, 0), content: "" };
    return this.get(id);
  }

  // --- index -------------------------------------------------------------

  private async rebuild(): Promise<void> {
    const next = await this.scanRecords();
    this.pages.clear();
    this.edgesBySource.clear();
    for (const [id, record] of next) this.pages.set(id, record);
    this.reindexAll();
  }

  private reindexAll(): void {
    const metas = this.list();
    this.edgesBySource.clear();
    for (const meta of metas) {
      const record = this.pages.get(meta.id);
      if (!record) continue;
      this.edgesBySource.set(meta.id, this.edgesFor(record, metas));
    }
  }

  private recomputeSource(id: PageId): void {
    const record = this.pages.get(id);
    if (!record) {
      this.edgesBySource.delete(id);
      return;
    }
    this.edgesBySource.set(id, this.edgesFor(record, this.list()));
  }

  /**
   * Link edges from a page (`[[links]]`) or a board (D25: `[[links]]` in its
   * text plus page/board cards, i.e. file nodes).
   */
  private edgesFor(record: PageRecord, metas: readonly PageMeta[]): LinkEdge[] {
    const edges = collectLinkEdges(record.id, record.content, metas);
    if (!record.board) return edges;
    const seen = new Set(edges.map((edge) => edge.target ?? `?${edge.targetTitle.toLowerCase()}`));
    for (const link of canvasLinks(record.board)) {
      if (link.kind !== "file") continue;
      const id = this.idForFile(link.path);
      if (id === record.id) continue;
      const target = id === null ? null : (this.pages.get(id) ?? null);
      const name = link.path.split("/").pop() ?? link.path;
      const targetTitle = target?.title ?? name.replace(/\.(md|canvas)$/i, "");
      const key = target?.id ?? `?${targetTitle.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source: record.id, target: target?.id ?? null, targetTitle });
    }
    return edges;
  }

  /** Page/board id for a vault file path on a board card (`Projects/Q1 plan.md`). */
  private idForFile(path: string): PageId | null {
    const clean = path.replace(/^\/+/, "");
    const candidates = isBoardId(clean) ? [clean] : [clean.replace(/\.md$/i, ""), clean];
    for (const candidate of candidates) {
      if (this.pages.has(candidate)) return candidate;
    }
    const lower = candidates.map((candidate) => candidate.toLowerCase());
    for (const id of this.pages.keys()) if (lower.includes(id.toLowerCase())) return id;
    return null;
  }

  /** The vault path a board card uses for a page/board (JSON Canvas: vault-root). */
  private fileForId(id: PageId): string {
    const record = this.pages.get(id);
    return record ? relative(this.root, record.filePath).split(sep).join("/") : `${id}.md`;
  }

  /**
   * After pages/boards moved (rename, Move to…, a parent's rename), point
   * board cards at their new files. Returns the boards that changed.
   */
  private async rewriteBoardCards(moves: ReadonlyArray<{ from: PageId; to: PageId }>): Promise<PageId[]> {
    if (moves.length === 0) return [];
    const byOldFile = new Map<string, string>();
    for (const { from, to } of moves) {
      const record = this.pages.get(to);
      if (!record) continue;
      const newFile = relative(this.root, record.filePath).split(sep).join("/");
      const suffix = newFile.slice(to.length);
      byOldFile.set(`${from}${suffix}`.toLowerCase(), newFile);
    }
    const changed: PageId[] = [];
    for (const board of [...this.pages.values()]) {
      if (!board.board) continue;
      const result = rewriteCanvas(board.board, {
        file: (path) => byOldFile.get(path.replace(/^\/+/, "").toLowerCase()) ?? null,
      });
      if (result.count === 0) continue;
      await this.saveBoardRecord(board, result.board);
      changed.push(board.id);
    }
    return changed;
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
    // Plain text around the raw link, as Cmd+K shows it (#zrxjbn6e).
    if (!link) return makeSnippet(plainText(record.content), targetTitle, 60);
    return linkSnippet(record.content, link.index, link.raw.length, 60);
  }

  // --- files -------------------------------------------------------------

  private async readRecord(absolute: string, id: PageId): Promise<PageRecord> {
    if (isBoardId(absolute)) return this.readBoardRecord(absolute, id);
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
      kind: "page",
    };
    if (icon) record.icon = icon;
    return record;
  }

  /**
   * A `.canvas` file (D25). Title = file name; icon/tags from the top-level
   * `gumply` object; dates from the file. A file that isn't valid JSON Canvas
   * still shows in the tree (as an empty board) and is never overwritten
   * without a backup: saving it backs up the original first.
   */
  private async readBoardRecord(absolute: string, id: PageId): Promise<PageRecord> {
    const raw = await readFile(absolute, "utf8");
    const stats = await stat(absolute);
    let board: CanvasBoard;
    let repaired = false;
    try {
      board = parseCanvas(raw);
      repaired = droppedCanvasEntries(raw, board) > 0;
    } catch (error) {
      if (!(error instanceof CanvasParseError)) throw error;
      console.warn(`[gumply] ${id}: ${error.message}; shown as an empty board`);
      board = emptyCanvas();
      repaired = true;
    }
    if (repaired) console.warn(`[gumply] ${id}: has entries a whiteboard can't keep; the first save backs up the original`);
    const meta = canvasMeta(board);
    const name = id.split("/").pop() ?? id;
    const record: PageRecord = {
      id,
      title: boardDisplayTitle(board, name.slice(0, -BOARD_EXTENSION.length)),
      tags: [],
      parentId: null,
      created: stats.birthtime.toISOString(),
      updated: stats.mtime.toISOString(),
      content: canvasText(board),
      filePath: absolute,
      fileMtimeMs: stats.mtimeMs,
      fmTags: normalizeTags(meta.tags),
      explicitTitle: true,
      kind: "whiteboard",
      board,
      boardRepaired: repaired,
    };
    if (meta.icon) record.icon = meta.icon;
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
    const extension = record.kind === "whiteboard" ? BOARD_EXTENSION : ".md";
    const file = join(dir, `${safeId}-${Date.now()}${extension}`);
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
      else if (entry.isFile() && /\.(md|canvas)$/i.test(entry.name)) files.push(absolute);
    }

    return files;
  }

  private async freeId(baseId: string, kind: PageKind = "page"): Promise<PageId> {
    const taken = new Set([...this.pages.keys()].map(collisionKey));
    return this.freeTarget(baseId, false, taken, kind);
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
    // Boards keep their extension in the id (v1.7); pages add `.md`.
    const absolute = resolve(this.root, isBoardId(id) ? id : `${id}.md`);
    if (!absolute.startsWith(`${this.root}${sep}`)) {
      throw badRequest("Page id escapes the vault");
    }
    return absolute;
  }

  private requireBoard(id: PageId): PageRecord {
    const record = this.require(id);
    if (record.kind !== "whiteboard" || !record.board) throw notFound(`Whiteboard not found: ${id}`);
    return record;
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
