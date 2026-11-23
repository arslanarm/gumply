import { randomUUID } from "node:crypto";
import { readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  coercePropertyValue,
  frontmatterKeys,
  HEADER_KEYS,
  inferPropertyType,
  isPropertyType,
  isValidPropertyKey,
  YAML_EMPTY,
  type PropertiesPatch,
  type Property,
  type PropertyInfo,
  type PropertyType,
  childPageId,
  collectLinkEdges,
  extractTags,
  findInlineTags,
  extractWikilinks,
  isValidPageId,
  makeSnippet,
  markdownLinks,
  linkSnippet,
  plainText,
  type MarkdownLink,
  frontmatterKey,
  frontmatterValue,
  isTagsKey,
  normalizeTags,
  parentOf,
  parseFrontmatter,
  parseNoteTemplate,
  serializeNoteLike,
  pathToPageId,
  resolveWikilink,
  rewriteLinksToPage,
  findMentions,
  linkMentions as linkMentionsIn,
  mentionLink,
  linkTargetFor,
  mentionableText,
  mentionSnippet,
  mentionTerms,
  mentionWords,
  type LinkMentionsInput,
  type LinkMentionsResult,
  type PageMentions,
  headingRenames,
  rewriteHeadingLinks,
  rewriteHeadingSubpath,
  type HeadingRename,
  rewriteWikilinkFolder,
  rewriteWikilinkTargets,
  renderTemplate,
  dailyNoteId,
  dateFromDay,
  type DailyNoteSettings,
  titleFromId,
  pageSegment,
  ATTACHMENTS_DIR,
  noteFolder,
  relinkAttachments,
  type RelinkOptions,
  canvasLinks,
  canvasMeta,
  isValidTagName,
  renameInlineTag,
  renameTagList,
  canvasText,
  emptyCanvas,
  parseCanvas,
  patchCanvasFile,
  rewriteCanvas,
  type CanvasRewrite,
  serializeCanvas,
  withCanvasMeta,
  CanvasParseError,
  BaseParseError,
  LinkFileIndex,
  shortestLinkText,
  hasAttachmentExtension,
  maskCode,
  obsidianFileLinks,
  parseEmbeds,
  propertyLinks,
  type PropertyLinks,
  type WikiLink,
  newBaseSource,
  parseBase,
  updateBaseSource,
  type BaseConfig,
  type CanvasBoard,
  type TagCount,
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
  type RestoreResult,
  type SearchResult,
  type TrashedDocument,
  type TrashedPage,
  type TrashItem,
  conflictCopyOf,
  possibleCopyOf,
  sharedRatio,
  POSSIBLE_COPY_MIN_SHARED,
  type ConflictAttachment,
  type ConflictCopy,
  type ConflictCopyName,
  type ConflictDiff,
  type ConflictResolveInput,
  type ConflictResolveResult,
  type ConflictsList,
  type PossibleCopy,
} from "@gumply/core";
import { badRequest, conflict, notFound } from "./errors.js";
import {
  boardDiff,
  budgetFor,
  HISTORY_DIR,
  historyDir,
  historyKeys,
  keyToId,
  lineDiff,
  markRecreated,
  moveHistory,
  moveHistoryDir,
  newestVersion,
  pageKey,
  pruneVault,
  readHistory,
  saveVersion,
  setAsideHistory,
  setPinned,
  sha256,
  usage,
  type DiffLine,
  type HistoryEntry,
  type HistoryMove,
  type HistoryReason,
  type HistorySource,
  type HistoryUsage,
} from "./history.js";

/** One version in `GET /api/history/:id` (spec/version-history §7). */
export interface HistoryItem {
  file: string;
  at: string;
  source: HistorySource;
  reason?: HistoryReason;
  client?: string;
  tool?: string;
  bytes: number;
  /** The version's sha256 (the panel marks the one equal to the current file). */
  sha256: string;
  /** The page's version (`updated`) these bytes had: an MCP audit row's `before` names it. */
  version: string;
  pinned: boolean;
  restoredFrom?: string;
  /** The page's title when this version was made, when it differs from now. */
  title?: string;
  /** Its folder then ("" for the top level), when it differs from now. */
  folder?: string;
}

export interface HistoryList {
  items: HistoryItem[];
  /** Pass as `cursor` for the next (older) page of items. */
  nextCursor?: string;
  /** The file as it is now. */
  current: { version: string; sha256: string | null };
  /** Renames and moves, oldest first. */
  moves: HistoryMove[];
}

export type HistoryDiff =
  | { kind: "page"; lines: DiffLine[] }
  | { kind: "whiteboard"; added: string[]; removed: string[]; changed: string[] };

/** `GET /api/history-orphans`: the history of a page that no longer exists (§2.3). */
export interface HistoryOrphan {
  key: string;
  /** The page's id at its last version. */
  lastId: PageId;
  title: string;
  lastAt: string;
  versions: number;
  /** Its newest version's file (what "Restore" brings back by default). */
  newest: string;
}

/** The kept last-written bytes (#yikrbg7h) stay under this in total; the oldest are saved early. */
const SESSION_BYTES_CAP = 64 * 1024 * 1024;

/** App versions while typing: at most one per 5 min (D41). */
const HISTORY_COALESCE_MS = 5 * 60_000;
/** An editing session ends 10 min after the last app save (D41). */
const HISTORY_SESSION_MS = 10 * 60_000;
import { PropertyTypesStore, readRawProperties, rewritePropertyLinks, typedProperties, type RawProperty } from "./properties.js";
import { readDailySettings, readTemplateSettings } from "./note-settings.js";
import { sweepTempFiles, tempPathBeside, writeAtomic } from "./temp-files.js";
import {
  buildDemoBoard,
  buildDemoPages,
  DEMO_LANGUAGES,
  demoCopy,
} from "./demo.js";

/** `POST /api/tags/rename` (#9bx3aznb). */
export interface TagRenameResult {
  /** Pages and boards rewritten. */
  renamed: number;
  rewrittenPages: PageId[];
  /** Left alone: changed on disk since it was read, or open with unsaved edits (`skip`). */
  skippedPages: PageId[];
}

export interface CreatePageInput {
  title: string;
  parentId?: string | null;
  content?: string;
  icon?: string;
  /** v0.7 C: a template page to start from (variables filled, properties copied). */
  template?: string;
}

/** `POST /daily`: today's (or any day's) note, opened or made. */
export interface DailyNoteResult {
  page: PageMeta;
  created: boolean;
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
  /** Opaque id of the editor sending this (see `ownWrite`). */
  writer?: string;
  /** v1.12 (D34): change frontmatter properties; only those key lines are written. */
  properties?: PropertiesPatch;
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
  writer?: string;
  /**
   * #3c86ify2: write only what changed in the file's own layout (MCP
   * `add_to_board` appends a node). `base` is the file as the caller read it
   * (MCP keeps those exact bytes as its history snapshot); without it the
   * file is read here. Not part of the HTTP API.
   */
  minimal?: boolean | { base: string };
}

/** D34 (spec/api-bases): a new database view, optionally sourced from a folder or tag. */
export interface CreateBaseInput {
  title: string;
  parentId?: string | null;
  source?: { folder?: PageId | null; tag?: string };
}

export interface UpdateBaseInput {
  config?: unknown;
  title?: string;
  expectedUpdated?: string;
  force?: boolean;
  writer?: string;
}

/** A base file as the API returns it. `error`: the YAML couldn't be read (never written then). */
export interface BaseDocument {
  meta: PageMeta;
  config: BaseConfig;
  error?: string;
}

/** What a base view's expressions may know about one page (spec/api-bases). */
export interface BaseIndexEntry {
  meta: PageMeta;
  /** Vault-relative file path with extension. */
  path: string;
  /** Absolute path (the server reads frontmatter from it). */
  filePath: string;
  fileMtimeMs: number;
  /** Vault-relative paths of the pages and boards it links to. */
  links: string[];
}

export interface GraphOptions {
  center?: PageId;
  /** BFS radius around `center`; defaults to 1 when `center` is set. */
  depth?: number;
  /** v1.19 (E1): add `attachments`, each page's links to attachment files. */
  attachments?: boolean;
}

const MAX_TITLE_LENGTH = 300;
const MAX_CONTENT_LENGTH = 5_000_000;
const MAX_GRAPH_DEPTH = 5;
const MAX_TAGS = 200;

/** Page plus the bits of on-disk state the index needs. */
interface PageRecord extends Omit<Page, "childCount"> {
  filePath: string;
  /**
   * Our last write of this file (#3t6v62cb, #d5e4mawv): its version, the
   * version it replaced, and which editor sent it. That editor may still send
   * the replaced version (its save that went out while this one was in
   * flight, e.g. on page exit); nobody else may.
   */
  ownWrite?: { version: string; replaced: string; writer: string };
  /** File mtime at the last read/write, for conditional saves. */
  fileMtimeMs: number;
  /** Frontmatter tags only; `tags` is this plus inline tags. */
  fmTags: string[];
  /** #rpugpydh: the frontmatter's `[[links]]` (core `propertyLinks`); absent when none. */
  propertyLinks?: PropertyLinks;
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
  /**
   * Database views only (D34, spec/api-bases): the `.base` file as it is on
   * disk; it is parsed per request and written only through `updateBaseSource`.
   */
  baseSource?: string;
}

/** D33: a directory with no `<Folder>.md` beside it (a typical Obsidian folder). */
interface FolderRecord {
  id: PageId;
  /** The directory name, as on disk. */
  title: string;
  parentId: PageId | null;
  /** Files inside (any depth) that aren't pages or boards: PDFs, images, … */
  otherFiles: number;
}

/** Directories met while scanning, with the non-page files directly in each. */
type DirectoryScan = Map<PageId, number>;

/**
 * What a refresh re-reads (#g95wkd9y): everything (still served from the read
 * cache while a file's stat is unchanged), or a set of files the watcher
 * reported, which are always read again.
 */
type RefreshScope = { kind: "all" } | { kind: "paths"; paths: ReadonlySet<string> };

/** More touched paths than this in one burst: refresh "all" (the read cache still applies). */
const MAX_REFRESH_PATHS = 200;
/** A watcher rescan that failed is tried again (as a full rescan) this many times in a row. */
const RESCAN_RETRIES = 3;

/** #g95wkd9y: pages per batch when warming the mention and search caches. */
const WARM_BATCH = 200;

/** #g95wkd9y: files a scan stats and reads at once. */
export const SCAN_CONCURRENCY = 32;

type ScanOutcome =
  | { kind: "gone" }
  | { kind: "keep" }
  | { kind: "cached" | "read"; key: string; record: PageRecord };

/**
 * `fn` over `items` with at most `limit` running at once; the results come
 * back in the items' order. A rejection rejects the whole (as `Promise.all`).
 */
export async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** #35q6kt6e: a read that failed for this file only (the rest of a rescan goes on). */
const UNREADABLE = Symbol("unreadable");

/** This file can't be read right now (permissions, a lock, a folder where a file was). */
function isPerFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  // Not EMFILE/ENFILE (out of file handles): that's temporary and not about
  // this file; the scan fails and the next one retries (#35q6kt6e, @lead).
  return code === "EACCES" || code === "EPERM" || code === "EBUSY" || code === "EISDIR";
}

/** A file or folder that went away under us: removed, or a parent replaced by a file. */
function isGoneError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** A folder named like a file ("v1.2") that appeared: not watched yet, so only a stat tells. */
function isDirectorySync(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A file's identity for the read cache. mtime and size alone miss a same-size
 * edit within the mtime granularity (2 s on FAT/exFAT, coarse on some network
 * and sync mounts); ctime moves on any write and ino on an atomic replace.
 */
function statKey(stats: { mtimeMs: number; size: number; ino: number; ctimeMs: number }): string {
  return `${stats.mtimeMs}:${stats.size}:${stats.ino}:${stats.ctimeMs}`;
}

/** Folders have no timestamps of their own (no file, no extra stat per folder). */
const FOLDER_TIME = new Date(0).toISOString();

/** spec/sync-conflicts §8 (D43): the watcher's rescan waits for a quiet gap, but never longer than this. */
const RESCAN_QUIET_MS = 120;
const RESCAN_MAX_WAIT_MS = 2000;
/** More watcher events than this within the window is a sync burst ("Syncing changes…"). */
const SYNC_BURST_EVENTS = 50;
const SYNC_WINDOW_MS = 2000;

/** A validated `.trash/<trashId>/` entry. */
interface TrashEntry {
  trashId: string;
  dir: string;
  /** The deleted page or board (its id before the delete). */
  id: PageId;
  /** Its file inside the entry, vault-relative as it was. */
  file: string;
  /** It and its sub-pages. */
  deleted: PageId[];
  deletedAt: string;
  /** A plain folder (D33): `file` is its directory. */
  folder: boolean;
}

/** `.trash/<trashId>/meta.json` (D11). */
interface TrashManifest {
  id: PageId;
  trashId: string;
  deleted: PageId[];
  deletedAt: string;
  /** Vault-relative file of `id` (v1.7: `.md` or `.canvas`); old manifests: `${id}.md`. */
  file?: string;
  /** "folder" for a plain folder (D33); `file` is then the directory. */
  kind?: string;
}

const BOARD_EXTENSION = ".canvas";

/** D25 (spec/api v1.7): board ids keep their `.canvas` extension. */
export function isBoardId(id: string): boolean {
  return id.toLowerCase().endsWith(BOARD_EXTENSION);
}

const BASE_EXTENSION = ".base";

/** D34 (spec/api-bases): database view ids keep their `.base` extension. */
export function isBaseId(id: string): boolean {
  return id.toLowerCase().endsWith(BASE_EXTENSION);
}

/** Boards and bases keep their extension in the id; pages don't. */
function keepsExtension(id: string): boolean {
  return isBoardId(id) || isBaseId(id);
}

/** The extension a kind's id keeps (`""` for pages). */
function idExtension(kind: PageKind): string {
  return kind === "whiteboard" ? BOARD_EXTENSION : kind === "base" ? BASE_EXTENSION : "";
}

/** The kind a vault file is, by its extension. */
function kindOfFile(path: string): PageKind {
  return isBoardId(path) ? "whiteboard" : isBaseId(path) ? "base" : "page";
}

/** Files that are tree items: pages, boards and bases. */
const ITEM_FILE = /\.(md|canvas|base)$/i;

/**
 * The name used for collisions across kinds (D20 + v1.7 + D34): a page "Map",
 * a board "Map.canvas" and a base "Map.base" compete for the same title.
 */
function collisionKey(id: string): string {
  const lower = id.toLowerCase();
  if (lower.endsWith(BOARD_EXTENSION)) return lower.slice(0, -BOARD_EXTENSION.length);
  return lower.endsWith(BASE_EXTENSION) ? lower.slice(0, -BASE_EXTENSION.length) : lower;
}

/** A base's file name without folder and `.base`: `Projects/Tasks.base` → `Tasks`. */
function baseStem(id: PageId): string {
  return (id.split("/").pop() ?? id).slice(0, -BASE_EXTENSION.length);
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

/**
 * A file's version string from its mtime (#d5e4mawv). One rule everywhere:
 * `new Date(ms)` truncates the sub-millisecond part, while Node's
 * `stats.mtime` rounds it, so mixing the two made our own write look like an
 * outside change whenever the fraction was ≥ 0.5 ms.
 */
/**
 * A note body as the index keeps it: what `parseFrontmatter` gives on read
 * (LF, no final newline or trailing blank lines), so `content` reads the same
 * whether it was just written or read from disk (#5fv7c25w). The file keeps
 * its own ending; this is only the cached body.
 */
function noteBody(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\s+$/, "");
}

/**
 * A file's text and its stat, **from the same open file** (D22). Reading the
 * path and then stat-ing it can pair the old text with the new mtime when
 * another program atomically replaces the file in between; the conflict check
 * (disk mtime vs the record's) would then pass, and the next save would erase
 * that program's write (a lost update). An open handle keeps the inode, so
 * the text and the mtime always belong together; a replace after this is a
 * real mtime change, which the check catches.
 */
async function readConsistent(absolute: string): Promise<{ raw: string; stats: import("node:fs").Stats }> {
  const handle = await open(absolute, "r");
  try {
    const stats = await handle.stat();
    const raw = await handle.readFile("utf8");
    return { raw, stats };
  } finally {
    await handle.close();
  }
}

/**
 * The stat to keep for a file the store has just renamed into place (#a76d3php).
 * `temp` is the temp file's stat, taken before the rename, so it is always ours.
 * Prefer the path's stat after the rename when the path still holds our file,
 * because on some filesystems (SMB/NFS shares, cloud-sync folders, FAT/exFAT with
 * 2 s mtimes) a rename can change the reported mtime, and keeping the temp's would
 * make every next save a false "changed on disk" 409. If the inode and device are
 * the same and non-zero, it is our file, so use the path's stat. Otherwise another
 * program replaced it in between: keep the temp's, so the next conditional save
 * sees that change instead of erasing it.
 */
async function statAfterRename(path: string, temp: import("node:fs").Stats): Promise<import("node:fs").Stats> {
  const now = await stat(path).catch(() => null);
  if (now !== null && now.ino !== 0 && now.ino === temp.ino && now.dev === temp.dev) return now;
  return temp;
}

function mtimeVersion(mtimeMs: number): string {
  return new Date(Math.floor(mtimeMs)).toISOString();
}

/**
 * Does a save's `expectedUpdated` match the file as it is? The current
 * version, or — for the editor that made our last write, while the file is
 * still exactly that write — the version that write replaced.
 */
function versionMatches(record: { updated: string; ownWrite?: { version: string; replaced: string; writer: string } }, expected: string | undefined, writer: string | undefined): boolean {
  if (expected === undefined || expected === record.updated) return true;
  const own = record.ownWrite;
  return own !== undefined && writer !== undefined && own.writer === writer && own.version === record.updated && own.replaced === expected;
}

function toIso(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** #g95wkd9y: search results per page by default, and at most. */
export const SEARCH_LIMIT = 50;
export const SEARCH_LIMIT_MAX = 200;

export interface SearchOptions {
  limit?: number;
  /** From the previous page's `nextCursor`. */
  cursor?: string;
  /** Only these kinds (the MCP tool's `kind`); filtered before the page is cut. */
  kinds?: ReadonlyArray<NonNullable<PageMeta["kind"]>>;
}

/** One page of ranked search results; `nextCursor` when more follow. */
export interface SearchPage {
  items: SearchResult[];
  nextCursor?: string;
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

/** Two files hold the same bytes (missing files never do). */
async function sameBytes(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([readFile(a).catch(() => null), readFile(b).catch(() => null)]);
  return left !== null && right !== null && left.equals(right);
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
/**
 * The store's page index. `generation` moves only when the set of files
 * changes (a new id, a removed one, or a record now at another path), never
 * for a content update, so what is derived from file names alone (the
 * conflict-copy map, D43) is computed once per generation (#3jkf2gf6).
 */
class PageIndex extends Map<PageId, PageRecord> {
  generation = 0;

  override set(id: PageId, record: PageRecord): this {
    const previous = super.get(id);
    if (!previous || previous.filePath !== record.filePath) this.generation = (this.generation ?? 0) + 1;
    return super.set(id, record);
  }

  override delete(id: PageId): boolean {
    const removed = super.delete(id);
    if (removed) this.generation += 1;
    return removed;
  }

  override clear(): void {
    if (this.size > 0) this.generation += 1;
    super.clear();
  }
}

export class VaultStore {
  readonly root: string;

  private readonly pages = new PageIndex();
  /** The conflict-copy map of one `pages.generation` (D43). */
  private conflictCache: { generation: number; names: ReadonlyMap<PageId, { of: PageId | null; name: ConflictCopyName }>; copies: ReadonlySet<PageId> } | null = null;
  /**
   * #8k4ssrkb: every linkable non-page file (images, PDFs… outside dot
   * folders, root `attachments/` included), for Obsidian-style `![[x.png]]`
   * links. Rebuilt from the names each scan already reads (no stat per file).
   */
  private linkIndex = new LinkFileIndex([]);
  /**
   * Goes up whenever the set of linkable files changes: a rescan found
   * other files, or the app saved one (#jxww67d9). `GET /pages` sends it, so
   * an open page asks again about links that had no file.
   */
  private fileIndexEpoch = 0;
  /** D33: plain folders (no `<Folder>.md`); never link targets or graph nodes. */
  private folders = new Map<PageId, FolderRecord>();
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
  /**
   * spec/sync-conflicts §8 (D43): when the first event of the pending rescan
   * came, so a long burst still refreshes at least every `RESCAN_MAX_WAIT_MS`.
   */
  private watchFirstEventAt: number | null = null;
  /** Recent watcher event times, for the "Syncing changes…" state (§8). */
  private watchEventTimes: number[] = [];
  /** The check after a burst (#35q6kt6e), armed while "Syncing" is on. */
  private burstCheckTimer: ReturnType<typeof setTimeout> | null = null;
  /** Test hook: arm the burst check even with no directory watchers. */
  private burstCheckWithoutWatchers = false;
  /** Ids the last refresh added, changed or removed (the burst check reports them). */
  private lastRefreshChanges: PageId[] = [];
  private syncingUntil = 0;
  /** Queued tasks that aren't rescans: a pending rescan waits for them (save priority, §8). */
  private pendingWrites = 0;
  /** Page to open once after first-run seeding (consumed by GET /pages). */
  private newVaultPage: PageId | null = null;

  /** v1.12 (D34): property types, shared with Obsidian when the vault has `.obsidian/`. */
  private readonly propertyTypes: PropertyTypesStore;
  /**
   * Version history (spec/version-history, D41): who this store writes for.
   * The app's server is "app"; the MCP process is "mcp" (its versions are
   * labelled as the AI app's, and it keeps no editing-session timer).
   */
  private readonly historySource: HistorySource;
  /** The reason the current queued operation's writes get in history (default "edit"). */
  private historyReason: HistoryReason | null = null;
  /** Per page: the editing session's end (10 min without an app save). */
  private readonly sessionTimers = new Map<PageId, ReturnType<typeof setTimeout>>();
  /**
   * #yikrbg7h: the last bytes Gumply wrote to each page or board since its
   * last version, byte-exact. An outside change or delete saves them first
   * (`app` / `session`), so "the version before Obsidian changed it" is the
   * user's last save, not the one before it.
   */
  private readonly sessionBytes = new Map<PageId, Buffer>();
  /** Their total size, capped: past it the oldest are saved as versions early. */
  private sessionBytesTotal = 0;
  private readonly sessionBytesCap: number;
  private pruneTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * #g95wkd9y: the record last read from each file (absolute path), reused by
   * a refresh while the file's `statKey` is unchanged: a 10,000-note rescan
   * is then a directory walk plus stats, not 10,000 reads and parses.
   */
  private readCache = new Map<string, { key: string; id: PageId; record: PageRecord }>();
  /** Files the watcher reported since the last refresh (absolute paths). */
  private readonly pendingPaths = new Set<string>();
  /** The watcher saw something a path list can't describe (a directory, an unknown name, an error). */
  private pendingFull = false;
  /** #g95wkd9y: the background index after a cold open. */
  private indexingNow = false;
  /** Set by `stopWatching` (the server closing): background warming stops. */
  private stopped = false;
  private indexDone: Promise<void> = Promise.resolve();
  /** The background cache warm-up after the index (tests await it). */
  warmed: Promise<void> = Promise.resolve();
  /** Test hook: runs (and may wait) right before the background index. */
  private beforeIndex: (() => Promise<void>) | undefined;
  /** Files a scan reads at once (#g95wkd9y); tests set 1 for a sequential baseline. */
  private scanConcurrency = SCAN_CONCURRENCY;
  /** Files that couldn't be read, already logged once (#35q6kt6e); cleared when one reads again. */
  private readonly unreadableLogged = new Set<string>();
  /** Watcher rescans that failed in a row (reset by one that succeeds). */
  private rescanFailures = 0;
  /** Parsed properties per file, valid while the file's mtime is unchanged. */
  private readonly rawPropertyCache = new Map<string, { mtimeMs: number; raw: RawProperty[] }>();

  constructor(root: string, options: { historySource?: HistorySource; sessionBytesCap?: number } = {}) {
    this.root = resolve(root);
    this.propertyTypes = new PropertyTypesStore(this.root);
    this.historySource = options.historySource ?? "app";
    this.sessionBytesCap = options.sessionBytesCap ?? SESSION_BYTES_CAP;
  }

  /**
   * Read the vault and index it. With `background` (#g95wkd9y, the server's
   * start), it returns once every file is read (the tree, titles, a page's
   * text) and the link index is built right after, in one synchronous pass
   * over the records as they are then (saves and outside edits before it
   * compute their own links; it recomputes them all, so nothing is lost or
   * read against a stale index). `indexing` is true until it's done, and
   * whatever reads links (`graph`, `backlinks`, base views) awaits
   * `whenIndexed()`. After it, the mention and search caches warm in the
   * background, so the first mentions or search request isn't the slow one.
   */
  async init(options: { background?: boolean } = {}): Promise<void> {
    await mkdir(this.root, { recursive: true });
    if (options.background) {
      await this.readAll();
      this.indexingNow = true;
      // Not in the store's queue: a page read (its properties go through the
      // queue) must not wait for the index. `reindexAll` is synchronous, so it
      // runs as one block over the records as they are then; a save or rescan
      // that ran before it recomputed its own links, and it recomputes them all.
      // Scheduled after `init` returns, so the server starts answering first.
      this.indexDone = new Promise<void>((resolve) => setImmediate(resolve)).then(async () => {
        try {
          await this.beforeIndex?.();
          this.reindexAll();
        } catch (error) {
          // Never stuck: logged, and links are recomputed by the next change.
          console.error("[gumply] indexing the vault's links failed:", error);
        } finally {
          this.indexingNow = false;
        }
      });
      // After the index, never part of it: links don't wait for the warm-up.
      this.warmed = this.indexDone.then(() => this.warmCaches());
    } else {
      await this.rebuild();
    }
    // #e9hs2zgq: our own temp files a crash left behind, once a day old. In the
    // background (never delays opening the vault); tests await `tempSweep`.
    this.tempSweep = sweepTempFiles(this.root).catch(() => []);
  }

  /** The startup sweep of Gumply's own leftover temp files (#e9hs2zgq). */
  tempSweep: Promise<string[]> = Promise.resolve([]);

  /** Start watching the vault for external create/change/delete events. */
  startWatching(): void {
    if (this.watching) return;
    this.watching = true;
    this.stopped = false;
    // Synchronous, so edits made right after start are already seen.
    this.syncDirectoryWatchers();
    // The app that watches the vault also keeps its history in budget (§2.5).
    this.schedulePrune();
  }

  /** Stop the vault watcher (used by tests and shutdown). */
  stopWatching(): void {
    this.watching = false;
    this.stopped = true;
    if (this.watchTimer !== null) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }
    if (this.burstCheckTimer !== null) {
      clearTimeout(this.burstCheckTimer);
      this.burstCheckTimer = null;
    }
    for (const watcher of this.directoryWatchers.values()) watcher.close();
    this.directoryWatchers.clear();
    if (this.pruneTimer) clearTimeout(this.pruneTimer);
    this.pruneTimer = null;
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
      // `attachments/` holds no pages, but its files are link targets (#8k4ssrkb).
      found.push(...this.vaultDirectories(join(dir, entry.name)));
    }
    return found;
  }

  /**
   * Watch new directories and stop watching removed ones. Returns how many
   * directories it started watching.
   */
  private syncDirectoryWatchers(): number {
    if (!this.watching) return 0;
    let added = 0;
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
          this.pendingFull = true;
          this.scheduleRescan();
        });
        this.directoryWatchers.set(dir, watcher);
        added += 1;
      } catch {
        // Gone already (or no permission): the next rescan settles it.
      }
    }
    return added;
  }

  private onWatchEvent(dir: string, filename: string | Buffer | null): void {
    const name = filename === null ? "" : String(filename);
    // Unknown name (some platforms): rescan to be safe.
    if (name.length === 0) {
      this.pendingFull = true;
      return this.scheduleRescan();
    }
    if (name.startsWith(".") || name.endsWith(".tmp") || name === "node_modules") return;
    // A page/board changed: re-read that file (#g95wkd9y).
    if (ITEM_FILE.test(name)) this.pendingPaths.add(join(dir, name));
    // #8k4ssrkb: an attachment added, renamed or removed changes what links resolve to;
    // a folder appeared or went away. Both are settled by a full walk.
    else if (hasAttachmentExtension(name) || !name.includes(".") || this.directoryWatchers.has(join(dir, name)) || isDirectorySync(join(dir, name)))
      this.pendingFull = true;
    else return;
    this.scheduleRescan();
    this.noteWatchEvent();
  }

  /** §8: over `SYNC_BURST_EVENTS` events within `SYNC_WINDOW_MS`, the vault is "syncing" until it settles. */
  private noteWatchEvent(now = Date.now()): void {
    this.watchEventTimes.push(now);
    while (this.watchEventTimes.length > 0 && now - this.watchEventTimes[0]! > SYNC_WINDOW_MS) this.watchEventTimes.shift();
    if (this.watchEventTimes.length > SYNC_BURST_EVENTS) {
      this.syncingUntil = now + SYNC_WINDOW_MS;
      this.armBurstCheck();
    }
  }

  /**
   * #35q6kt6e: when a burst ends ("Syncing" turns off), one full stat walk
   * checks the watcher's work. Network shares and sync mounts can drop events;
   * anything this walk changes is a change the watcher missed, and it is
   * logged by path, so a gap shows up in logs and tests instead of staying
   * silent. It waits for the watcher's own pending rescans first, so it never
   * reports a change those were about to pick up.
   */
  private armBurstCheck(delay = Math.max(0, this.syncingUntil - Date.now()) + 50): void {
    if (!this.watching && !this.burstCheckWithoutWatchers) return;
    if (this.burstCheckTimer !== null) clearTimeout(this.burstCheckTimer);
    this.burstCheckTimer = setTimeout(() => {
      this.burstCheckTimer = null;
      void this.runBurstCheck().catch((error: unknown) => console.warn("[gumply] the check after a burst of outside changes failed:", error));
    }, delay);
    this.burstCheckTimer.unref?.();
  }

  private watcherBusy(): boolean {
    return this.watchTimer !== null || this.pendingFull || this.pendingPaths.size > 0;
  }

  private async runBurstCheck(): Promise<void> {
    if (this.syncing) return this.armBurstCheck();
    if (this.watcherBusy()) return this.armBurstCheck(RESCAN_QUIET_MS + 100);
    await this.enqueue(
      async () => {
        // Events that came in since: let their own rescan run first, then check again.
        if (this.watcherBusy() || this.syncing) {
          this.armBurstCheck(RESCAN_QUIET_MS + 100);
          return;
        }
        await this.refreshFromDisk({ kind: "all" });
        const missed = this.lastRefreshChanges;
        if (missed.length > 0) {
          const shown = missed.slice(0, 10).join(", ");
          console.warn(`[gumply] watcher missed ${missed.length} change${missed.length === 1 ? "" : "s"}: ${shown}${missed.length > 10 ? ", …" : ""}`);
        }
        if (this.syncDirectoryWatchers() > 0) {
          this.pendingFull = true;
          this.scheduleRescan();
        }
      },
      { rescan: true },
    );
  }

  /** v1.29 (§8): another app (a sync tool) is changing many files right now. */
  get syncing(): boolean {
    return Date.now() < this.syncingUntil;
  }

  /** Re-read the vault and return whether the page index actually changed. */
  rescan(): Promise<boolean> {
    return this.enqueue(() => this.refreshFromDisk({ kind: "all" }));
  }

  /** What the watcher reported since the last refresh, as a scope (and cleared). */
  private takePendingScope(): RefreshScope {
    const full = this.pendingFull || this.pendingPaths.size === 0 || this.pendingPaths.size > MAX_REFRESH_PATHS;
    const scope: RefreshScope = full ? { kind: "all" } : { kind: "paths", paths: new Set(this.pendingPaths) };
    this.pendingFull = false;
    this.pendingPaths.clear();
    return scope;
  }

  private scheduleRescan(): void {
    const now = Date.now();
    if (this.watchTimer !== null) clearTimeout(this.watchTimer);
    else this.watchFirstEventAt = now;
    // A 120 ms quiet gap, but never more than RESCAN_MAX_WAIT_MS after the burst's first event (§8).
    const deadline = (this.watchFirstEventAt ?? now) + RESCAN_MAX_WAIT_MS;
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      this.watchFirstEventAt = null;
      // #g95wkd9y: a rescan the watcher started must never end the process (an
      // unhandled rejection exits Node). A failure is logged, and a full rescan
      // tried again, at most RESCAN_RETRIES times in a row.
      this.runScheduledRescan().then(
        () => {
          this.rescanFailures = 0;
        },
        (error: unknown) => {
          this.rescanFailures += 1;
          console.warn(`[gumply] rescan after outside changes failed (${this.rescanFailures}):`, error);
          this.pendingFull = true;
          if (this.rescanFailures <= RESCAN_RETRIES) this.scheduleRescan();
        },
      );
    }, Math.max(0, Math.min(RESCAN_QUIET_MS, deadline - now)));
  }

  /**
   * §8 save priority: a rescan the watcher asked for joins the queue only once
   * no save (or other write) is waiting in it, so a pending rescan never
   * delays a save. It waits at most RESCAN_MAX_WAIT_MS, so steady typing
   * can't starve it.
   */
  private async runScheduledRescan(): Promise<boolean> {
    const giveUpAt = Date.now() + RESCAN_MAX_WAIT_MS;
    while (this.pendingWrites > 0 && Date.now() < giveUpAt) {
      await this.writeQueue;
      // Let a save that was just handed in reach the queue first.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return this.enqueue(
      async () => {
        // #g95wkd9y: the scope is taken when the job runs, so events that came in
        // while it waited for saves are part of it.
        const changed = await this.refreshFromDisk(this.takePendingScope());
        // Folders may have appeared or gone: keep one watcher per directory.
        // #35q6kt6e: a folder watched only now may have got files after this
        // refresh walked it and before its watcher existed (a repo created, a
        // folder a git checkout re-creates): those made no events. One more full
        // rescan picks them up; anything later makes events. It settles, since
        // the next sync finds no new folder.
        if (this.syncDirectoryWatchers() > 0) {
          this.pendingFull = true;
          this.scheduleRescan();
        }
        return changed;
      },
      { rescan: true },
    );
  }

  /**
   * Read every page and board (D25). Ids: pages are paths without `.md`,
   * boards keep `.canvas`. A page whose id would equal a board's (a file
   * `Map.canvas.md` next to `Map.canvas`) keeps its `.md` so both stay.
   */
  private async scanRecords(reread?: ReadonlySet<string>): Promise<{ pages: Map<PageId, PageRecord>; folders: Map<PageId, FolderRecord> }> {
    const next = new Map<PageId, PageRecord>();
    const nextCache = new Map<string, { key: string; id: PageId; record: PageRecord }>();
    const directories: DirectoryScan = new Map();
    const others: string[] = [];
    const unreadableDirs: string[] = [];
    const files = (await this.scan(this.root, directories, others, unreadableDirs)).map((absolute) => ({
      absolute,
      rel: relative(this.root, absolute).split(sep).join("/"),
    }));
    const boards = new Set(files.filter((file) => keepsExtension(file.rel)).map((file) => file.rel.toLowerCase()));
    // Ids in walk order (cheap, and the collision rules depend on it).
    const items: Array<{ absolute: string; id: PageId }> = [];
    for (const { absolute, rel } of files) {
      let id = keepsExtension(rel) ? rel : pathToPageId(rel);
      if (!keepsExtension(rel) && boards.has(id.toLowerCase())) id = rel;
      if (isValidPageId(id)) items.push({ absolute, id });
    }
    // #g95wkd9y: stat and read up to SCAN_CONCURRENCY files at once (10k files
    // one after another were most of a cold open); the outcomes are applied
    // below in walk order, so ids, the index order and every side effect are
    // exactly those of a sequential read.
    const outcomes = await mapBounded(items, this.scanConcurrency, async ({ absolute, id }): Promise<ScanOutcome> => {
      let stats;
      try {
        stats = await stat(absolute);
      } catch (error) {
        // #35q6kt6e: listed but can't be looked at now (a folder without search
        // permission): it keeps the record it had, logged once. Otherwise gone
        // since the listing.
        if (isPerFileError(error)) {
          this.noteUnreadable(absolute, error);
          return { kind: "keep" };
        }
        return { kind: "gone" };
      }
      const key = statKey(stats);
      const cached = this.readCache.get(absolute);
      // #g95wkd9y: an unchanged file keeps its record; a file the watcher named is always read.
      if (cached && cached.key === key && cached.id === id && !reread?.has(absolute)) return { kind: "cached", key, record: cached.record };
      const read = await this.readIfPresent(absolute, id);
      if (read === null) return { kind: "gone" }; // Deleted between the stat and the read.
      // #35q6kt6e: this one file can't be read right now (permissions, a lock
      // held by antivirus or a sync tool). It keeps the
      // record it had, if any, and isn't cached, so the next rescan tries it
      // again; the rest of the rescan goes on.
      if (read === UNREADABLE) return { kind: "keep" };
      return { kind: "read", key, record: read };
    });
    items.forEach(({ absolute, id }, index) => {
      const outcome = outcomes[index]!;
      if (outcome.kind === "gone") return;
      if (outcome.kind === "keep") {
        const previous = this.pages.get(id);
        if (previous) next.set(id, previous);
        return;
      }
      if (outcome.kind === "read") this.refreshTags(outcome.record);
      nextCache.set(absolute, { key: outcome.key, id, record: outcome.record });
      next.set(id, outcome.record);
    });
    // #35q6kt6e: a folder that couldn't be listed keeps the pages and boards it
    // had (they aren't deleted, just out of reach), with their cached reads.
    if (unreadableDirs.length > 0) {
      const inside = (absolute: string) => unreadableDirs.some((dir) => absolute.startsWith(dir + sep));
      for (const [id, record] of this.pages) {
        if (next.has(id) || !inside(record.filePath)) continue;
        next.set(id, record);
        const cached = this.readCache.get(record.filePath);
        if (cached) nextCache.set(record.filePath, cached);
      }
    }
    this.readCache = nextCache;
    const folders = VaultStore.foldersFrom(directories, next);
    VaultStore.assignParents(next, folders);
    const linkIndex = new LinkFileIndex([...others, ...(await this.attachmentFiles())]);
    if (!linkIndex.sameFiles(this.linkIndex)) this.fileIndexEpoch += 1;
    this.linkIndex = linkIndex;
    return { pages: next, folders };
  }

  /**
   * #g95wkd9y: the watcher named only files the index already has, and they
   * all still exist (edits, the usual case): re-read just those, without
   * walking the vault. Anything else (a new or deleted file, a name the
   * index doesn't know) returns null, and the caller walks.
   */
  private async rereadKnownFiles(paths: ReadonlySet<string>): Promise<{ pages: Map<PageId, PageRecord>; folders: Map<PageId, FolderRecord> } | null> {
    const reads: Array<{ absolute: string; id: PageId; key: string }> = [];
    for (const absolute of paths) {
      const cached = this.readCache.get(absolute);
      if (!cached || !this.pages.has(cached.id)) return null;
      try {
        reads.push({ absolute, id: cached.id, key: statKey(await stat(absolute)) });
      } catch {
        return null; // Deleted: the walk settles ids, parents and folders.
      }
    }
    const next = new Map(this.pages);
    for (const { absolute, id, key } of reads) {
      const record = await this.readIfPresent(absolute, id);
      if (record === null) return null; // Deleted after its stat: the walk settles it.
      // #35q6kt6e: unreadable right now: it keeps its record (already in `next`).
      if (record === UNREADABLE) continue;
      this.refreshTags(record);
      // The layout didn't change, so neither did the parent.
      record.parentId = this.pages.get(id)!.parentId;
      next.set(id, record);
      this.readCache.set(absolute, { key, id, record });
    }
    return { pages: next, folders: this.folders };
  }

  /**
   * `readRecord`, or null when the file is gone (deleted mid-refresh), or
   * UNREADABLE when this one file can't be read now (#35q6kt6e: EACCES, EPERM,
   * EBUSY, EISDIR), logged once per file until it reads again. Anything else
   * (EMFILE: the process is out of handles) fails the rescan, which retries.
   */
  private async readIfPresent(absolute: string, id: PageId): Promise<PageRecord | null | typeof UNREADABLE> {
    try {
      const record = await this.readRecord(absolute, id);
      this.unreadableLogged.delete(absolute);
      return record;
    } catch (error) {
      // Gone, or its folder was replaced by a file, since the walk listed it.
      if (isGoneError(error)) return null;
      if (isPerFileError(error)) {
        this.noteUnreadable(absolute, error);
        return UNREADABLE;
      }
      throw error;
    }
  }

  /** Log a file that can't be read, once until it reads again (#35q6kt6e). */
  private noteUnreadable(absolute: string, error: unknown): void {
    if (this.unreadableLogged.has(absolute)) return;
    this.unreadableLogged.add(absolute);
    console.warn(`[gumply] can't read ${relative(this.root, absolute)} (${(error as NodeJS.ErrnoException).code}); keeping what was there and reading the rest`);
  }

  /**
   * D33: every scanned directory that isn't a page's own sub-page folder (no
   * `<Folder>.md` beside it), from the same walk that finds the pages.
   */
  private static foldersFrom(
    directories: DirectoryScan,
    pages: ReadonlyMap<PageId, PageRecord>,
  ): Map<PageId, FolderRecord> {
    const folders = new Map<PageId, FolderRecord>();
    for (const id of directories.keys()) {
      if (!isValidPageId(id) || keepsExtension(id) || pages.get(id)?.kind === "page") continue;
      const title = id.slice(id.lastIndexOf("/") + 1);
      folders.set(id, { id, title, parentId: null, otherFiles: 0 });
    }
    // Other files count toward every plain folder above them.
    for (const [dir, count] of directories) {
      if (count === 0) continue;
      for (let at: PageId | null = dir; at !== null; at = parentOf(at)) {
        const folder = folders.get(at);
        if (folder) folder.otherFiles += count;
      }
    }
    return folders;
  }

  /** Folder pages and plain folders (D33) are parents; boards never have sub-pages. */
  private static assignParents(
    records: Map<PageId, PageRecord>,
    folders: ReadonlyMap<PageId, FolderRecord> = new Map(),
  ): void {
    const parentFor = (key: PageId): PageId | null => {
      const parent = parentOf(key);
      if (parent === null) return null;
      if (records.get(parent)?.kind === "page" || folders.has(parent)) return parent;
      return null;
    };
    for (const [key, value] of records) value.parentId = parentFor(key);
    for (const [key, value] of folders) value.parentId = parentFor(key);
  }

  /** Re-read the plain folders after a structural change and re-link parents. */
  private async syncFolders(): Promise<void> {
    const directories: DirectoryScan = new Map();
    await this.scan(this.root, directories);
    this.folders = VaultStore.foldersFrom(directories, this.pages);
    VaultStore.assignParents(this.pages, this.folders);
  }

  private static folderSignature(folders: ReadonlyMap<PageId, FolderRecord>): string {
    return JSON.stringify([...folders.values()].map((folder) => [folder.id, folder.parentId]).sort());
  }

  private async refreshFromDisk(scope: RefreshScope = { kind: "all" }): Promise<boolean> {
    const epochBefore = this.fileIndexEpoch;
    // #3c444g85: each page's inode before this rescan (the read cache is replaced by it).
    const inodesBefore = this.inodesById();
    const { pages: next, folders } =
      (scope.kind === "paths" ? await this.rereadKnownFiles(scope.paths) : null) ??
      (await this.scanRecords(scope.kind === "paths" ? scope.paths : undefined));

    // #g95wkd9y: which records differ (a reused record is the same object: no compare).
    const changedIds: PageId[] = [];
    for (const [id, record] of next) {
      const current = this.pages.get(id);
      if (current !== record && (!current || this.recordSignature(current) !== this.recordSignature(record))) changedIds.push(id);
    }
    const removedIds: PageId[] = [];
    for (const id of this.pages.keys()) if (!next.has(id)) removedIds.push(id);
    const removed = removedIds.length > 0;
    this.lastRefreshChanges = [...changedIds, ...removedIds];
    const changed = changedIds.length > 0 || removed;
    const foldersChanged = VaultStore.folderSignature(folders) !== VaultStore.folderSignature(this.folders);
    this.folders = folders;
    if (!changed) return foldersChanged;

    // External renames: remember where an open page went so stale URLs follow.
    const externalMoves: Array<{ from: PageId; to: PageId }> = [];
    // D20: a page renamed outside Gumply, matched as below, keeps its history.
    const historyMoves: Array<{ from: PageId; to: PageId }> = [];
    const inodesAfter = removed ? this.inodesById() : new Map<PageId, string>();
    const fresh = [...next.values()].filter((record) => !this.pages.has(record.id));
    const claimed = new Set<PageId>();
    for (const [oldId, oldRecord] of this.pages) {
      if (next.has(oldId)) continue;
      const candidates = fresh.filter((record) => !claimed.has(record.id) && record.kind === oldRecord.kind);
      if (candidates.length === 0) continue;
      // #3c444g85, in order:
      // 1. the same inode and mtime: a rename keeps both (POSIX, and NTFS), exact even for empty or
      //    identical notes; the mtime rules out an inode the file system reused for a new file;
      // 2. pages keep their frontmatter title across a rename; a board's title is its file name, so a
      //    renamed board is recognised by its content;
      // 3. where inodes aren't stable (some network or sync mounts): the one new page with exactly the
      //    same content, never an empty one (two empty notes must not pair).
      const inode = inodesBefore.get(oldId);
      const oldBoard = oldRecord.board ? serializeCanvas(oldRecord.board) : null;
      const sameContent = candidates.filter((record) =>
        oldBoard !== null ? record.board !== undefined && serializeCanvas(record.board) === oldBoard : record.content === oldRecord.content,
      );
      const moved =
        (inode ? candidates.find((record) => inodesAfter.get(record.id) === inode) : undefined) ??
        (oldBoard !== null ? sameContent[0] : candidates.find((record) => record.title === oldRecord.title)) ??
        (oldBoard === null && oldRecord.content.trim() !== "" && sameContent.length === 1 ? sameContent[0] : undefined);
      if (!moved) continue;
      claimed.add(moved.id);
      this.addRedirect(oldId, moved.id);
      historyMoves.push({ from: oldId, to: moved.id });
      // Same file, moved: identical content (a rename that also edits it is
      // left alone, we can't tell what the other tool meant).
      if (moved.content === oldRecord.content) externalMoves.push({ from: oldId, to: moved.id });
    }
    for (const id of next.keys()) this.redirects.delete(id);
    // A re-read of our own last write (unchanged on disk) keeps knowing it.
    // §3: a page or board changed outside Gumply (not our own write) gets its new bytes as a version.
    const editedOutside: PageRecord[] = [];
    for (const [id, record] of next) {
      const previous = this.pages.get(id);
      const own = previous?.ownWrite;
      if (own && own.version === record.updated) record.ownWrite = own;
      else if (previous && this.recordSignature(previous) !== this.recordSignature(record)) editedOutside.push(record);
    }

    const previousIds = new Set(this.pages.keys());
    const previous = new Map(this.pages);
    this.pages.clear();
    for (const [id, record] of next) this.pages.set(id, record);
    for (const { from, to } of historyMoves) {
      const record = this.pages.get(to);
      if (record && (record.kind === "page" || record.kind === "whiteboard")) await this.followHistory(from, to);
    }
    // #yikrbg7h: a page deleted outside Gumply keeps the user's last save in its (orphaned) history.
    const movedAway = new Set(historyMoves.map(({ from }) => from));
    for (const id of previousIds) {
      if (!next.has(id) && !movedAway.has(id)) await this.saveSessionBytes(id);
    }
    // A page or board that appeared outside Gumply where an earlier one had history: marked, so
    // the panel shows which versions came before it (Gumply's own creates set it aside instead).
    if (this.historySource === "app") {
      const movedIn = new Set(historyMoves.map(({ to }) => to));
      for (const [id, record] of next) {
        if (previousIds.has(id) || movedIn.has(id) || (record.kind !== "page" && record.kind !== "whiteboard")) continue;
        await markRecreated(this.root, id).catch(() => false);
      }
    }
    for (const record of editedOutside) await this.versionFromOutside(record);
    // D23: a file moved to another folder outside Gumply keeps working
    // attachment links. Links the other tool already fixed are kept.
    await this.relinkMoved(externalMoves, { keepValidAtDestination: true });
    // #g95wkd9y: a change that leaves every link target where it was (same ids,
    // titles and kinds, same linkable files) only changes the changed pages'
    // own links. Anything else can change what other pages' links resolve to.
    const targetsMoved =
      removed ||
      externalMoves.length > 0 ||
      this.fileIndexEpoch !== epochBefore ||
      changedIds.some((id) => {
        const before = previous.get(id);
        const after = this.pages.get(id);
        return !before || !after || before.title !== after.title || before.kind !== after.kind;
      });
    if (targetsMoved) this.reindexAll();
    else this.recomputeSources(changedIds);
    return true;
  }

  /**
   * Each page's or board's file identity from the read cache: `inode:mtime`
   * (absent when the file system reports no inode). A rename keeps both.
   */
  private inodesById(): Map<PageId, string> {
    const out = new Map<PageId, string>();
    for (const { key, id } of this.readCache.values()) {
      const [mtime, , inode] = key.split(":");
      if (inode && Number(inode) > 0) out.set(id, `${inode}:${mtime}`);
    }
    return out;
  }

  private recordSignature(record: PageRecord): string {
    return JSON.stringify([
      record.kind,
      record.board ? serializeCanvas(record.board) : null,
      // A base's file text: an edit made outside Gumply is a change (#armmzdrx).
      record.baseSource ?? null,
      record.title,
      record.icon ?? null,
      record.content,
      record.fmTags,
      // #rpugpydh: an outside edit to the frontmatter's links alone is a change.
      record.propertyLinks ?? null,
      record.parentId,
    ]);
  }

  /**
   * Seed the demo vault on a truly empty first run only (D10, spec/ux §2).
   * A marker in `.gumply/` makes this once-per-vault: deleting the demo (or
   * every page) never brings it back. Returns the Welcome page id when this
   * call did the seeding.
   */
  async seedDemoIfFirstRun(language = "en"): Promise<PageId | null> {
    const copy = demoCopy(language);
    // Any language's Welcome counts for a vault seeded before (#93yv3ban).
    const welcomeTitles = new Set(DEMO_LANGUAGES.map((code) => demoCopy(code).welcome.toLowerCase()));
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
            welcomeTitles.has(record.title.trim().toLowerCase()),
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
    for (const demo of buildDemoPages(language)) {
      const created = await this.create(demo);
      if (demo.title === copy.welcome) welcomeId = created.id;
    }
    // D25: one example whiteboard linking the demo pages (#dvnb8n2n).
    const board = await this.createBoard({
      title: copy.board,
      parentId: childPageId(null, copy.folder),
      icon: "🗺️",
    });
    await this.updateBoard(board.meta.id, {
      board: { ...buildDemoBoard(language), gumply: board.board.gumply },
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

  /**
   * #93yv3ban: the demo is seeded on the first `GET /pages`, not at start,
   * so it can be in the interface language that request asks for. `arm`
   * at start; every list waits for a seeding in progress.
   */
  armDemo(log: (message: string) => void = console.log): void {
    this.demoArmed = log;
  }

  async seedDemoOnFirstList(language: string): Promise<void> {
    const log = this.demoArmed;
    if (log) {
      this.demoArmed = null;
      this.demoSeeding = this.seedDemoIfFirstRun(language).then(
        (welcomeId) => {
          if (welcomeId) log(`[gumply] demo vault seeded in "${language}" (open ${welcomeId})`);
        },
        // A failed seed must not break the list; the next start retries on an empty vault.
        (error: unknown) => console.error("[gumply] demo seeding failed:", error),
      );
    }
    await this.demoSeeding;
  }

  private demoArmed: ((message: string) => void) | null = null;
  private demoSeeding: Promise<void> | null = null;

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
    const copies = this.copyIds();
    const records = [...this.pages.values()].filter((record) => record.kind === "page" && !copies.has(record.id)).sort(
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

  /** Flat list of every tree item (pages, boards and D33 plain folders), sorted by id. */
  list(): PageMeta[] {
    const counts = this.childCounts();
    const copies = this.conflictNames();
    const copyCounts = new Map<PageId, number>();
    for (const { of } of copies.values()) if (of !== null) copyCounts.set(of, (copyCounts.get(of) ?? 0) + 1);
    const metas = [...this.pages.values()].map((record) => {
      const meta = metaOf(record, counts.get(record.id) ?? 0);
      const copy = copies.get(record.id);
      if (copy) meta.conflictOf = copy.of;
      const own = copyCounts.get(record.id);
      if (own) meta.conflicts = own;
      return meta;
    });
    for (const folder of this.folders.values()) {
      metas.push({
        id: folder.id,
        kind: "folder",
        title: folder.title,
        tags: [],
        parentId: folder.parentId,
        childCount: counts.get(folder.id) ?? 0,
        created: FOLDER_TIME,
        updated: FOLDER_TIME,
        otherFiles: folder.otherFiles,
      });
    }
    return metas.sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Pages and boards only: what links, the graph and search resolve against (D33).
   * D43: without conflict copies that have their original beside them (they're
   * no link source or target), unless `withCopies`.
   */
  private pageMetas(options: { withCopies?: boolean } = {}): PageMeta[] {
    return this.list().filter((meta) => meta.kind !== "folder" && (options.withCopies || typeof meta.conflictOf !== "string"));
  }

  /**
   * spec/sync-conflicts §3 (D43): every page, board and base whose file name is
   * a sync tool's conflict copy, with the id of its original in the same
   * folder, or null when that's gone (an orphan copy, treated as a page).
   */
  private conflictNames(): ReadonlyMap<PageId, { of: PageId | null; name: ConflictCopyName }> {
    return this.conflictState().names;
  }

  /** Ids of conflict copies whose original is beside them: never indexed or rewritten (D37, D43). */
  private copyIds(): ReadonlySet<PageId> {
    return this.conflictState().copies;
  }

  /** Computed once per set of files (`pages.generation`): every caller, in any loop, reads the same map. */
  private conflictState(): { names: ReadonlyMap<PageId, { of: PageId | null; name: ConflictCopyName }>; copies: ReadonlySet<PageId> } {
    const generation = this.pages.generation;
    if (this.conflictCache && this.conflictCache.generation === generation) return this.conflictCache;
    const byPath = new Map<string, PageId>();
    for (const record of this.pages.values()) byPath.set(record.filePath, record.id);
    const names = new Map<PageId, { of: PageId | null; name: ConflictCopyName }>();
    const copies = new Set<PageId>();
    for (const record of this.pages.values()) {
      const name = conflictCopyOf(basename(record.filePath));
      if (!name) continue;
      const found = byPath.get(join(dirname(record.filePath), name.originalName)) ?? null;
      const of = found === record.id ? null : found;
      names.set(record.id, { of, name });
      if (of !== null) copies.add(record.id);
    }
    this.conflictCache = { generation, names, copies };
    return this.conflictCache;
  }

  // --- properties (v0.7 A, D34, spec/api v1.12) ----------------------------

  /** A page's properties, typed (stored type, else inferred across the vault); null for anything but a page. */
  pageProperties(id: PageId): Promise<Property[] | null> {
    return this.enqueue(async () => {
      const record = this.pages.get(this.resolveId(id));
      if (!record || record.kind !== "page") return null;
      const index = await this.propertyIndex();
      return typedProperties(await this.rawPropertiesOf(record), (key) => index.typeOf(key));
    });
  }

  /** Every page with its properties (`GET /pages?include=properties`). */
  listWithProperties(): Promise<Array<PageMeta & { properties?: Property[] }>> {
    return this.enqueue(async () => {
      const index = await this.propertyIndex();
      const out: Array<PageMeta & { properties?: Property[] }> = [];
      for (const meta of this.list()) {
        const record = this.pages.get(meta.id);
        if (!record || record.kind !== "page") out.push(meta);
        else out.push({ ...meta, properties: typedProperties(await this.rawPropertiesOf(record), (key) => index.typeOf(key)) });
      }
      return out;
    });
  }

  /**
   * Every key's type: types.json merged with the inferred types (the same
   * resolution as a page's properties). For database views (#sg36ng2d).
   */
  propertyTypeMap(): Promise<Map<string, PropertyType>> {
    return this.enqueue(async () => {
      const index = await this.propertyIndex();
      return new Map(index.infos().map((info) => [info.key, info.type]));
    });
  }

  /** Every property key used in the vault: type and how many pages use it. */
  listProperties(): Promise<PropertyInfo[]> {
    return this.enqueue(async () => (await this.propertyIndex()).infos());
  }

  /** The types stored in types.json (Notion import B3: they win over its guesses). */
  storedPropertyTypes(): Promise<Record<string, PropertyType>> {
    return this.enqueue(async () => ({ ...(await this.propertyTypes.read()) }));
  }

  /** Record types for keys that have none yet; existing bytes of types.json stay (B3, D37). */
  addPropertyTypes(types: Readonly<Record<string, PropertyType>>): Promise<string[]> {
    return this.enqueue(async () => {
      const valid = Object.fromEntries(
        Object.entries(types).filter(([key, type]) => isValidPropertyKey(key) && !HEADER_KEYS.includes(key) && isPropertyType(type)),
      );
      return this.propertyTypes.addMissing(valid);
    });
  }

  /** Change a key's type vault-wide (types.json only; files keep their values, as in Obsidian). */
  setPropertyType(key: string, type: PropertyType): Promise<PropertyInfo[]> {
    return this.enqueue(async () => {
      if (!isValidPropertyKey(key) || HEADER_KEYS.includes(key)) throw badRequest("Not a property key");
      if (!isPropertyType(type)) throw badRequest("Unknown property type");
      await this.propertyTypes.set(key, type);
      return (await this.propertyIndex()).infos();
    });
  }

  private async rawPropertiesOf(record: PageRecord): Promise<RawProperty[]> {
    const cached = this.rawPropertyCache.get(record.filePath);
    if (cached && cached.mtimeMs === record.fileMtimeMs) return cached.raw;
    let raw: RawProperty[] = [];
    try {
      raw = readRawProperties(parseNoteTemplate(await readFile(record.filePath, "utf8")).yaml);
    } catch {
      raw = [];
    }
    this.rawPropertyCache.set(record.filePath, { mtimeMs: record.fileMtimeMs, raw });
    return raw;
  }

  /** Types and counts across the vault's pages. */
  private async propertyIndex(): Promise<{ typeOf: (key: string, extra?: unknown) => PropertyType; infos: () => PropertyInfo[] }> {
    const stored = await this.propertyTypes.read();
    const values = new Map<string, unknown[]>();
    const counts = new Map<string, number>();
    const copies = this.copyIds();
    for (const record of this.pages.values()) {
      if (record.kind !== "page" || copies.has(record.id)) continue;
      for (const property of await this.rawPropertiesOf(record)) {
        counts.set(property.key, (counts.get(property.key) ?? 0) + 1);
        const list = values.get(property.key) ?? [];
        list.push(property.value);
        values.set(property.key, list);
      }
    }
    const typeOf = (key: string, extra?: unknown): PropertyType =>
      stored[key] ?? inferPropertyType(key, extra === undefined ? (values.get(key) ?? []) : [...(values.get(key) ?? []), extra]);
    return {
      typeOf,
      infos: () =>
        [...counts.entries()]
          .map(([key, count]) => ({ key, type: typeOf(key), count }))
          .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)),
    };
  }

  /**
   * Validate a properties patch against the page's frontmatter and turn it
   * into frontmatter values, the changed keys and the renames.
   */
  private async preparePropertiesPatch(
    record: PageRecord,
    patch: PropertiesPatch,
  ): Promise<{ values: Record<string, unknown>; changed: string[]; renames: Array<{ from: string; to: string }> }> {
    if (!patch || typeof patch !== "object") throw badRequest("properties must be an object");
    const raw = await this.rawPropertiesOf(record);
    const byKey = new Map(raw.map((property) => [property.key, property]));
    let template: string | null = null;
    try {
      template = parseNoteTemplate(await readFile(record.filePath, "utf8")).yaml;
    } catch {
      template = null;
    }
    const present = new Set(frontmatterKeys(template));
    const index = await this.propertyIndex();
    const values: Record<string, unknown> = {};
    const changed = new Set<string>();
    const renames: Array<{ from: string; to: string }> = [];
    const editableKey = (key: unknown, what: string): string => {
      if (!isValidPropertyKey(key)) throw badRequest(`${what}: not a property name`);
      if (HEADER_KEYS.includes(key)) throw badRequest(`${what}: "${key}" is part of the page header`);
      return key;
    };

    if (patch.rename !== undefined && !Array.isArray(patch.rename)) throw badRequest("rename must be a list");
    for (const rename of patch.rename ?? []) {
      const from = editableKey(rename?.from, "rename");
      const to = editableKey(rename?.to, "rename");
      if (isTagsKey(from) || isTagsKey(to)) throw badRequest("rename: tags can't be renamed");
      if (!present.has(from)) throw badRequest(`rename: no property "${from}"`);
      if (from === to) continue;
      if (present.has(to)) throw badRequest(`rename: "${to}" already exists`);
      present.delete(from);
      present.add(to);
      renames.push({ from, to });
      const property = byKey.get(from);
      if (property) byKey.set(to, { ...property, key: to });
    }

    if (patch.remove !== undefined && !Array.isArray(patch.remove)) throw badRequest("remove must be a list");
    for (const key of patch.remove ?? []) {
      editableKey(key, "remove");
      if (!present.has(key)) continue;
      values[key] = null;
      changed.add(key);
    }

    if (patch.set !== undefined && (typeof patch.set !== "object" || patch.set === null || Array.isArray(patch.set))) {
      throw badRequest("set must be an object");
    }
    for (const [key, value] of Object.entries(patch.set ?? {})) {
      editableKey(key, "set");
      const existing = byKey.get(key);
      if (existing && !existing.editable) throw badRequest(`"${key}" holds YAML Gumply can't edit; change it in another editor`);
      // No stored type and nothing to infer from yet (new, or still empty): the value decides.
      const blank = existing === undefined || existing.value === null || existing.value === "" || (Array.isArray(existing.value) && existing.value.length === 0);
      const type = index.typeOf(key, present.has(key) && !blank ? undefined : value);
      const coerced = coercePropertyValue(type, value);
      if (coerced === undefined) throw badRequest(`"${key}" is a ${type} property`);
      // An empty value is written as `key:` (YAML null), like Obsidian does.
      values[key] = coerced === null || (Array.isArray(coerced) && coerced.length === 0 && !present.has(key))
        ? YAML_EMPTY
        : isTagsKey(key)
          ? normalizeTags(coerced)
          : coerced;
      changed.add(key);
    }
    return { values, changed: [...changed], renames };
  }

  get(id: PageId): Page {
    const resolved = this.resolveId(id);
    if (this.folders.has(resolved)) throw notFound("This is a folder; it has no page of its own");
    const record = this.require(resolved);
    if (record.kind === "whiteboard") {
      throw notFound("This is a whiteboard; read it with GET /api/boards/:id");
    }
    if (record.kind === "base") throw notFound("This is a database view; read it with GET /api/bases/:id");
    const fileLinks = this.fileLinksOf(record);
    return {
      ...metaOf(record, this.directChildCount(resolved)),
      content: record.content,
      ...(fileLinks ? { fileLinks } : {}),
    };
  }

  /**
   * #8k4ssrkb: what each Obsidian-style file link in a page or board resolves
   * to, from that note (`![[photo.png]]` → `assets/photo.png`, or null).
   */
  private fileLinksOf(record: PageRecord): Record<string, string | null> | undefined {
    const links = obsidianFileLinks(record.content, maskCode);
    if (!links.length) return undefined;
    const from = relative(this.root, record.filePath).split(sep).join("/");
    const out: Record<string, string | null> = {};
    for (const link of links) out[link] = this.linkIndex.resolve(link, from);
    return out;
  }

  /** One Obsidian-style file link from a page or board (`from`; unknown: the vault root). */
  resolveFileLink(link: string, from: PageId | null): string | null {
    return this.linkIndex.resolve(link, this.notePathOf(from));
  }

  /** The link text Obsidian would write for `path` from note `from` (#4usgpjh8). */
  linkTextFor(path: string, from: PageId | null): string {
    return shortestLinkText(path, this.linkIndex, this.notePathOf(from));
  }

  /** A note's vault path (`Projects/Plan.md`), or null for an unknown id. */
  private notePathOf(from: PageId | null): string | null {
    const record = from ? this.pages.get(this.resolveId(from)) : undefined;
    return record ? relative(this.root, record.filePath).split(sep).join("/") : null;
  }

  /**
   * A file the app just saved (upload, image import): linkable at once, not
   * only after the watcher's next rescan (#zawz963a).
   */
  fileSaved(vaultPath: string): void {
    if (this.linkIndex.add(vaultPath)) this.fileIndexEpoch += 1;
  }

  /** See `fileIndexEpoch` (#jxww67d9). */
  get fileIndexVersion(): number {
    return this.fileIndexEpoch;
  }

  /** The vault path of a page's file, for resolving links from it (null: unknown). */
  filePathOf(id: PageId): string | null {
    const record = this.pages.get(id);
    return record ? relative(this.root, record.filePath).split(sep).join("/") : null;
  }

  /** The shared index (database views resolve cover links with it). */
  get fileIndex(): LinkFileIndex {
    return this.linkIndex;
  }

  create(input: CreatePageInput): Promise<Page> {
    return this.enqueue(() => this.createNow(input));
  }

  update(id: PageId, patch: UpdatePageInput): Promise<Page & { rewrittenPages: PageId[] }> {
    return this.enqueue(() => this.updateNow(this.resolveId(id), patch));
  }

  /**
   * Rename tag `from` everywhere (#9bx3aznb): frontmatter `tags`, inline
   * `#tags` and nested `#from/…`, in pages and boards. Trashed files are left
   * alone; a file that changed on disk since it was read is skipped, and so
   * are the `skip` ids (an open editor whose edits couldn't be saved).
   */
  renameTag(from: string, to: string, skip: readonly PageId[] = []): Promise<TagRenameResult> {
    return this.enqueue(() => this.renameTagNow(from, to, skip));
  }

  remove(id: PageId): Promise<DeletePageResult> {
    return this.enqueue(() => this.removeNow(this.resolveId(id)));
  }

  restore(trashId: string): Promise<RestoreResult> {
    return this.enqueue(() => this.restoreNow(trashId));
  }

  /** Every trash entry Gumply made (D11), newest first (#ppag3ugh). */
  listTrash(): Promise<TrashItem[]> {
    return this.enqueue(() => this.listTrashNow());
  }

  /** A trashed page or board (the entry's top one, or sub-page `id`), read-only. */
  getTrashed(trashId: string, id?: PageId): Promise<TrashedDocument> {
    return this.enqueue(() => this.getTrashedNow(trashId, id));
  }

  /** Delete one trash entry for good. */
  deleteTrashed(trashId: string): Promise<void> {
    return this.enqueue(async () => {
      const entry = await this.openTrashEntry(trashId);
      await rm(entry.dir, { recursive: true, force: true });
      await this.dropTrashedHistory(entry);
    });
  }

  /**
   * Delete forever / Empty trash (@lead, D41 follow-up): the pages' version
   * history goes too, unless a live page has that id now (then it's that page's).
   */
  private async dropTrashedHistory(entry: TrashEntry): Promise<void> {
    for (const id of entry.deleted) {
      if (this.pages.has(id)) continue;
      await rm(historyDir(this.root, id), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Empty the trash: every entry Gumply made. Anything else in `.trash/`
   * (e.g. Obsidian's own trashed files) is left alone. Returns the count.
   */
  emptyTrash(): Promise<number> {
    return this.enqueue(async () => {
      const entries = await this.trashEntries();
      for (const entry of entries) {
        await rm(entry.dir, { recursive: true, force: true });
        await this.dropTrashedHistory(entry);
      }
      return entries.length;
    });
  }

  move(id: PageId, parentId: PageId | null): Promise<Page> {
    return this.enqueue(() => this.moveNow(this.resolveId(id), parentId));
  }

  // --- whiteboards (D25, spec/api v1.7) -----------------------------------

  getBoard(id: PageId): BoardDocument {
    const resolved = this.resolveId(id);
    const record = this.requireBoard(resolved);
    const fileLinks = this.fileLinksOf(record);
    return { meta: metaOf(record, 0), board: record.board as CanvasBoard, ...(fileLinks ? { fileLinks } : {}) };
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

  /** #rpugpydh: the page links in a page's frontmatter that count (core `propertyLinks`), in file order. */
  propertyLinksOf(id: PageId): WikiLink[] {
    return this.pages.get(this.resolveId(id))?.propertyLinks?.pages.map((entry) => entry.link) ?? [];
  }

  backlinks(id: PageId): Backlink[] {
    id = this.resolveId(id);
    this.require(id);

    const out: Backlink[] = [];
    let counts: Map<PageId, number> | undefined;
    for (const [sourceId, edges] of this.edgesBySource) {
      if (sourceId === id) continue;
      const edge = edges.find((candidate) => candidate.target === id);
      if (!edge) continue;

      const source = this.pages.get(sourceId);
      if (!source) continue;
      out.push({
        page: metaOf(source, (counts ??= this.childCounts()).get(sourceId) ?? 0),
        snippet: this.linkSnippet(source, edge),
      });
    }

    return out.sort(
      (a, b) => a.page.title.localeCompare(b.page.title) || a.page.id.localeCompare(b.page.id),
    );
  }

  /**
   * Every tag with its occurrences and pages (#9bx3aznb), like Obsidian's
   * tags pane: inline repeats count, each frontmatter entry once, case
   * folded, first spelling (in id order) kept. Nested tags are their own
   * entries; the web app adds them up under their parents.
   */
  tags(): TagCount[] {
    const byKey = new Map<string, { tag: string; count: number; pages: Set<PageId> }>();
    const copies = this.copyIds();
    const records = [...this.pages.values()].filter((record) => !copies.has(record.id)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const record of records) {
      for (const tag of [...record.fmTags, ...this.inlineTags(record)]) {
        const key = tag.toLowerCase();
        let entry = byKey.get(key);
        if (!entry) {
          entry = { tag, count: 0, pages: new Set() };
          byKey.set(key, entry);
        }
        entry.count += 1;
        entry.pages.add(record.id);
      }
    }
    return [...byKey.values()].map((entry) => ({ tag: entry.tag, count: entry.count, pages: [...entry.pages] }));
  }

  /** Inline tags of a page or board text, repeats included; cached until its content changes. */
  private readonly inlineTagCache = new Map<PageId, { content: string; tags: string[] }>();
  private inlineTags(record: PageRecord): string[] {
    const cached = this.inlineTagCache.get(record.id);
    if (cached && cached.content === record.content) return cached.tags;
    const tags = findInlineTags(record.content).map((hit) => hit.tag);
    this.inlineTagCache.set(record.id, { content: record.content, tags });
    if (this.inlineTagCache.size > this.pages.size * 2 + 100) {
      for (const id of this.inlineTagCache.keys()) if (!this.pages.has(id)) this.inlineTagCache.delete(id);
    }
    return tags;
  }

  graph(options: GraphOptions = {}): GraphData {
    const allMetas = this.pageMetas();
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
      ...(options.attachments ? { attachments: this.attachmentEdges(included) } : {}),
    };
  }

  /** Attachment links per page, cached until the page's content changes. */
  private readonly attachmentLinks = new Map<PageId, { content: string; fromProperties: string; paths: string[] }>();

  /**
   * v1.19: each included page's links to attachment files (`![[pic.png]]`,
   * `[[report.pdf]]`, `![](attachments/pic.png)`), resolved from that page
   * like Obsidian (#8k4ssrkb). Links to missing files are left out.
   */
  private attachmentEdges(included: ReadonlySet<PageId>): Array<{ source: PageId; path: string }> {
    const out: Array<{ source: PageId; path: string }> = [];
    for (const id of included) {
      const record = this.pages.get(id);
      if (!record) continue;
      // #rpugpydh: a frontmatter value that is one whole file link (`"[[report.pdf]]"`) counts too.
      const fromProperties = record.propertyLinks?.files.map((entry) => entry.name) ?? [];
      const propertyKey = fromProperties.join("\u0000");
      let cached = this.attachmentLinks.get(id);
      if (!cached || cached.content !== record.content || cached.fromProperties !== propertyKey) {
        const from = relative(this.root, record.filePath).split(sep).join("/");
        const links = new Set(obsidianFileLinks(record.content, maskCode));
        for (const embed of parseEmbeds(record.content)) if (embed.syntax !== "obsidian") links.add(embed.path);
        for (const name of fromProperties) links.add(name);
        const paths = new Set<string>();
        for (const link of links) {
          const path = this.linkIndex.resolve(link, from);
          if (path) paths.add(path);
        }
        cached = { content: record.content, fromProperties: propertyKey, paths: [...paths].sort() };
        this.attachmentLinks.set(id, cached);
      }
      for (const path of cached.paths) out.push({ source: id, path });
    }
    if (this.attachmentLinks.size > this.pages.size * 2 + 100) {
      for (const id of this.attachmentLinks.keys()) if (!this.pages.has(id)) this.attachmentLinks.delete(id);
    }
    return out.sort((a, b) => a.source.localeCompare(b.source) || a.path.localeCompare(b.path));
  }

  /**
   * D13 full-text search, ranked (score, then title), one page of results at
   * a time (#g95wkd9y): every page is scored, but metas and snippets are only
   * built for the returned slice. `cursor` is the opaque value from the
   * previous page's `nextCursor` (an offset into the ranking).
   */
  search(query: string, options: SearchOptions = {}): SearchResult[] {
    return this.searchPage(query, options).items;
  }

  /** `search`, with the cursor of the next page when more results follow. */
  searchPage(query: string, options: SearchOptions = {}): SearchPage {
    const trimmed = query.trim();
    if (trimmed.length === 0) return { items: [] };
    const needle = trimmed.toLowerCase();
    // Titles match with `-`, `_` and spaces as one, so "meeting notes" finds
    // a plain note `meeting-notes` (#bayuasqq), as Obsidian's search does.
    const fold = (value: string) => value.toLowerCase().replace(/[-_\s]+/g, " ").trim();
    const titleNeedle = fold(trimmed);

    const hits: Array<{ record: PageRecord; text: string; around: string; score: number }> = [];
    for (const record of this.pages.values()) {
      if (options.kinds && !options.kinds.includes(record.kind ?? "page")) continue;
      const title = fold(record.title);
      let titleScore = 0;
      if (title === titleNeedle) titleScore = 100;
      else if (title.startsWith(titleNeedle)) titleScore = 80;
      else if (title.includes(titleNeedle)) titleScore = 60;

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
      hits.push({ record, text, around, score: titleScore > 0 ? titleScore + bodyBoost : bodyBoost + 1 });
    }
    hits.sort((a, b) => b.score - a.score || a.record.title.localeCompare(b.record.title));

    // D43: a conflict copy goes right after its page when the page is a hit too
    // (one grouping pass, one emit pass); a copy whose page isn't a hit keeps its rank.
    // Paging runs on this final order, so the cursor stays stable.
    const copies = this.conflictNames();
    const hitIds = new Set(hits.map((hit) => hit.record.id));
    const copiesOf = new Map<PageId, typeof hits>();
    for (const hit of hits) {
      const of = copies.get(hit.record.id)?.of;
      if (typeof of === "string" && hitIds.has(of)) {
        const list = copiesOf.get(of);
        if (list) list.push(hit);
        else copiesOf.set(of, [hit]);
      }
    }
    const ordered: typeof hits = [];
    // Emit a hit, then its copies, then their copies (a copy of a copy, #3jkf2gf6): every hit once.
    const emit = (root: (typeof hits)[number]) => {
      const stack = [root];
      while (stack.length > 0) {
        const hit = stack.pop()!;
        ordered.push(hit);
        const own = copiesOf.get(hit.record.id);
        if (own) for (let index = own.length - 1; index >= 0; index -= 1) stack.push(own[index]!);
      }
    };
    for (const hit of hits) {
      const of = copies.get(hit.record.id)?.of;
      if (typeof of === "string" && hitIds.has(of)) continue;
      emit(hit);
    }

    const start = Math.max(0, Math.floor(Number(options.cursor ?? 0)) || 0);
    const limit = Math.min(Math.max(Math.floor(options.limit ?? SEARCH_LIMIT) || SEARCH_LIMIT, 1), SEARCH_LIMIT_MAX);
    const page = ordered.slice(start, start + limit);
    const counts = page.length > 0 ? this.childCounts() : new Map<PageId, number>();
    const items = page.map((hit) => this.searchItem(hit, counts, copies));
    return start + limit < ordered.length ? { items, nextCursor: String(start + limit) } : { items };
  }

  /** One returned result: its meta and snippet (built only for the page returned); D43 marks a conflict copy. */
  private searchItem(
    hit: { record: PageRecord; text: string; around: string; score: number },
    counts: ReadonlyMap<PageId, number>,
    copies: ReadonlyMap<PageId, { of: PageId | null }>,
  ): SearchResult {
    const page = metaOf(hit.record, counts.get(hit.record.id) ?? 0);
    const copy = copies.get(hit.record.id);
    if (copy) page.conflictOf = copy.of;
    return {
      page,
      snippet: makeSnippet(hit.text, hit.around, 80),
      score: hit.score,
    };
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
    while (!this.pages.has(current) && !this.folders.has(current) && this.redirects.has(current) && !seen.has(current)) {
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
      this.requireParent(parentId);
    }

    const icon = typeof input.icon === "string" && input.icon.trim().length > 0
      ? input.icon.trim()
      : undefined;

    const baseId = childPageId(parentId, title);
    const id = await this.freeId(baseId);
    this.redirects.delete(id);
    const now = new Date().toISOString();
    const filePath = this.filePathFor(id);

    if (input.template !== undefined) {
      if (typeof input.template !== "string") throw badRequest("template must be a page id");
      // v0.7 C: the template's own frontmatter keys, order and comments stay as
      // the template wrote them (e.g. `created: {{date}}`); Gumply only adds
      // the title, and tags/created/updated when the template has none.
      const seed = await this.renderTemplateFile(input.template, title, new Date());
      const parsed = parseFrontmatter(seed);
      const keys = Object.keys(parsed.frontmatter);
      const changes = [
        "title",
        ...(icon ? ["icon"] : []),
        ...(frontmatterKey(keys, "tags") === undefined ? ["tags"] : []),
        ...["created", "updated"].filter((key) => !(key in parsed.frontmatter)),
      ];
      await this.writePage(
        filePath,
        { title, ...(icon ? { icon } : {}), tags: [], created: now, updated: now },
        parsed.content,
        changes,
        undefined,
        seed,
      );
      const fromTemplate = await this.readRecord(filePath, id);
      fromTemplate.parentId = parentId;
      this.pages.set(id, fromTemplate);
      this.refreshTags(fromTemplate);
      this.reindexAll();
      return this.get(id);
    }

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
      content: noteBody(content),
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
      this.requireParent(parentId);
    }
    const icon = typeof input.icon === "string" && input.icon.trim().length > 0 ? input.icon.trim() : undefined;

    const id = await this.freeId(childPageId(parentId, title), "whiteboard");
    this.redirects.delete(id);
    const filePath = this.filePathFor(id);
    // #ux5cukze: a collision suffix belongs to the title too, so three new
    // boards read "Untitled whiteboard", "… 2", "… 3" in the tree, not the
    // same label three times.
    const stem = boardStem(id);
    const segment = pageSegment(title);
    const suffix =
      stem.toLowerCase().startsWith(segment.toLowerCase()) && / \d+$/.test(stem.slice(segment.length))
        ? stem.slice(segment.length)
        : "";
    const board = withBoardTitle(emptyCanvas(icon ? { icon } : undefined), `${title}${suffix}`, stem);
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
    const versionChanged = !versionMatches(record, patch.expectedUpdated, patch.writer);
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
    const beforeMetas = titleChanged ? this.pageMetas() : [];

    // D20: the file name follows the title; the id keeps `.canvas`. The full
    // title is (re)applied to `gumply.title` on every save, so a client that
    // drops the key can't lose it (#phvu6zt9).
    const targetId = titleChanged ? await this.renameTarget(id, record.parentId, nextTitle, "whiteboard") : id;
    board = withBoardTitle(board, nextTitle, boardStem(targetId));

    const replaced = record.updated;
    const repairBackup = await this.saveBoardRecord(record, board, {
      minimal: patch.minimal !== undefined && patch.minimal !== false,
      ...(typeof patch.minimal === "object" ? { base: patch.minimal.base } : {}),
    });
    if (patch.writer) record.ownWrite = { version: record.updated, replaced, writer: patch.writer };
    else delete record.ownWrite;

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
   *
   * `minimal` (#3c86ify2, D37): link rewrites, folder moves and MCP
   * `add_to_board` change only the strings that changed (and append new
   * nodes) in the file's own layout. Anything else, a repaired board, or a
   * file that no longer matches the record, is written whole as before.
   */
  private async saveBoardRecord(
    record: PageRecord,
    board: CanvasBoard,
    options: { minimal?: boolean; base?: string } = {},
  ): Promise<string | undefined> {
    let repairBackup: string | undefined;
    let text: string | null = null;
    if (options.minimal && !record.boardRepaired && record.board) {
      const raw = options.base ?? (await readFile(record.filePath, "utf8").catch(() => null));
      text = raw === null ? null : patchCanvasFile(raw, record.board, board);
    }
    if (record.boardRepaired) {
      repairBackup = await this.backupConflict(record);
      record.boardRepaired = false;
    }
    const temporary = tempPathBeside(record.filePath);
    let stats: import("node:fs").Stats;
    try {
      await mkdir(dirname(record.filePath), { recursive: true });
      const next = text ?? serializeCanvas(board);
      await writeFile(temporary, next, "utf8");
      // Stat the temp before the rename: the path's stat after it could be
      // another program's file (see statAfterRename, #a76d3php).
      stats = await stat(temporary);
      const previous = await readFile(record.filePath).catch(() => null);
      if (previous !== null && !previous.equals(Buffer.from(next, "utf8"))) await this.versionBeforeWrite(record.filePath, previous);
      if (previous === null) await this.freshHistory(record.filePath);
      await rename(temporary, record.filePath);
      await this.rememberWrite(record.filePath, next);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    stats = await statAfterRename(record.filePath, stats);
    const meta = canvasMeta(board);
    record.board = board;
    record.content = canvasText(board);
    record.fileMtimeMs = stats.mtimeMs;
    record.updated = mtimeVersion(stats.mtimeMs);
    record.fmTags = normalizeTags(meta.tags);
    if (meta.icon) record.icon = meta.icon;
    else delete record.icon;
    this.refreshTags(record);
    return repairBackup;
  }

  // --- database views (D34, spec/api-bases) ------------------------------

  getBase(id: PageId): BaseDocument {
    const record = this.requireBase(this.resolveId(id));
    const meta = metaOf(record, 0);
    try {
      return { meta, config: parseBase(record.baseSource ?? "") };
    } catch (error) {
      return { meta, config: { views: [] }, error: error instanceof Error ? error.message : "Invalid base" };
    }
  }

  createBase(input: CreateBaseInput): Promise<BaseDocument> {
    return this.enqueue(() => this.createBaseNow(input));
  }

  updateBase(id: PageId, patch: UpdateBaseInput): Promise<BaseDocument & { rewrittenPages: PageId[]; conflictBackup?: string }> {
    return this.enqueue(() => this.updateBaseNow(this.resolveId(id), patch));
  }

  /** Pages (not boards, bases or folders) with what base expressions read. */
  baseIndex(): BaseIndexEntry[] {
    const entries: BaseIndexEntry[] = [];
    const counts = this.childCounts();
    const copies = this.copyIds();
    for (const record of this.pages.values()) {
      if (record.kind !== "page" || copies.has(record.id)) continue;
      const links: string[] = [];
      for (const edge of this.edgesBySource.get(record.id) ?? []) {
        const target = edge.target === null ? undefined : this.pages.get(edge.target);
        if (target) links.push(relative(this.root, target.filePath).split(sep).join("/"));
      }
      entries.push({
        meta: metaOf(record, counts.get(record.id) ?? 0),
        path: relative(this.root, record.filePath).split(sep).join("/"),
        filePath: record.filePath,
        fileMtimeMs: record.fileMtimeMs,
        links,
      });
    }
    return entries;
  }

  /** The vault path of a page or folder id, for `file.inFolder` and `this`. */
  vaultPathOf(id: PageId): string | null {
    const record = this.pages.get(this.resolveId(id));
    return record ? relative(this.root, record.filePath).split(sep).join("/") : null;
  }

  private async createBaseNow(input: CreateBaseInput): Promise<BaseDocument> {
    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (title.length === 0) throw badRequest("title must not be empty");
    if (title.length > MAX_TITLE_LENGTH) throw badRequest(`title is too long (max ${MAX_TITLE_LENGTH} characters)`);
    const parentId = input.parentId ?? null;
    if (parentId !== null) {
      if (typeof parentId !== "string" || !isValidPageId(parentId)) {
        throw badRequest("parentId must be a valid page id or null");
      }
      this.requireParent(parentId);
    }
    const source = input.source && typeof input.source === "object" ? input.source : {};
    const folder = typeof source.folder === "string" && isValidPageId(source.folder) ? source.folder : null;
    const tag = typeof source.tag === "string" && source.tag.trim() ? source.tag.trim() : undefined;

    const id = await this.freeId(childPageId(parentId, title), "base");
    this.redirects.delete(id);
    const filePath = this.filePathFor(id);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, newBaseSource({ folder, tag }), { encoding: "utf8", flag: "wx" });
    const record = await this.readBaseRecord(filePath, id);
    record.parentId = parentId;
    this.pages.set(id, record);
    this.reindexAll();
    return this.getBase(id);
  }

  /**
   * Save a base's config and/or rename it. Conditional like pages (D22): a
   * file changed on disk is a 409 unless `force`, which backs it up first.
   * Only what changed in the config is written (`updateBaseSource`).
   */
  private async updateBaseNow(
    id: PageId,
    patch: UpdateBaseInput,
  ): Promise<BaseDocument & { rewrittenPages: PageId[]; conflictBackup?: string }> {
    let record = this.requireBase(id);
    let info;
    try {
      info = await stat(record.filePath);
    } catch {
      info = null;
    }
    const mtimeChanged = info === null || Math.abs(info.mtimeMs - record.fileMtimeMs) > 1;
    const versionChanged = !versionMatches(record, patch.expectedUpdated, patch.writer);
    let conflictBackup: string | undefined;
    if (mtimeChanged || versionChanged) {
      if (!patch.force) throw conflict("This database view changed on disk.");
      conflictBackup = await this.backupConflict(record);
      record.baseSource = await readFile(record.filePath, "utf8").catch(() => record.baseSource ?? "");
    }

    if (patch.config !== undefined) {
      const config = patch.config;
      if (typeof config !== "object" || config === null || Array.isArray(config) || !Array.isArray((config as BaseConfig).views)) {
        throw badRequest("config must be an object with a views list");
      }
      if (JSON.stringify(config).length > MAX_CONTENT_LENGTH) throw badRequest("config is too large");
      let text: string;
      try {
        text = updateBaseSource(record.baseSource ?? "", config as BaseConfig);
      } catch (error) {
        if (error instanceof BaseParseError) throw badRequest(`This base file isn't valid YAML: ${error.message}`);
        throw error;
      }
      if (text !== record.baseSource) {
        const replaced = record.updated;
        await this.writeBaseFile(record, text);
        if (patch.writer) record.ownWrite = { version: record.updated, replaced, writer: patch.writer };
        else delete record.ownWrite;
      }
    }

    const rewrittenPages: PageId[] = [];
    const previousTitle = record.title;
    const nextTitle = patch.title === undefined ? record.title : String(patch.title).trim();
    if (nextTitle.length === 0) throw badRequest("title must not be empty");
    if (nextTitle.length > MAX_TITLE_LENGTH) throw badRequest(`title is too long (max ${MAX_TITLE_LENGTH} characters)`);
    let targetId = id;
    if (nextTitle !== previousTitle) {
      const beforeMetas = this.pageMetas();
      targetId = await this.renameTarget(id, record.parentId, nextTitle, "base");
      if (targetId !== id) {
        rewrittenPages.push(...(await this.relocateNow(id, targetId)));
        record = this.pages.get(targetId) ?? record;
      }
      // A base's title is its file name (it has nowhere else to keep one).
      record.title = baseStem(targetId);
      rewrittenPages.push(...(await this.rewriteLinksTo(id, record, previousTitle, beforeMetas)));
      this.reindexAll();
    }
    return {
      ...this.getBase(targetId),
      rewrittenPages: [...new Set(rewrittenPages)].sort((a, b) => a.localeCompare(b)),
      ...(conflictBackup ? { conflictBackup } : {}),
    };
  }

  private async writeBaseFile(record: PageRecord, text: string): Promise<void> {
    const temporary = tempPathBeside(record.filePath);
    let stats: import("node:fs").Stats;
    try {
      await writeFile(temporary, text, "utf8");
      // Stat the temp before the rename: the path's stat after it could be
      // another program's file (see statAfterRename, #a76d3php).
      stats = await stat(temporary);
      await rename(temporary, record.filePath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    stats = await statAfterRename(record.filePath, stats);
    record.baseSource = text;
    record.fileMtimeMs = stats.mtimeMs;
    record.updated = mtimeVersion(stats.mtimeMs);
  }

  /** A `.base` file (D34): title = file name, dates from the file, kept as text. */
  private async readBaseRecord(absolute: string, id: PageId): Promise<PageRecord> {
    const { raw, stats } = await readConsistent(absolute);
    return {
      id,
      title: baseStem(id),
      tags: [],
      parentId: null,
      created: stats.birthtime.toISOString(),
      updated: mtimeVersion(stats.mtimeMs),
      content: "",
      filePath: absolute,
      fileMtimeMs: stats.mtimeMs,
      fmTags: [],
      explicitTitle: true,
      kind: "base",
      baseSource: raw,
    };
  }

  private requireBase(id: PageId): PageRecord {
    const record = this.require(id);
    if (record.kind !== "base") throw notFound(`Database view not found: ${id}`);
    return record;
  }

  private async updateNow(
    id: PageId,
    patch: UpdatePageInput,
  ): Promise<Page & { rewrittenPages: PageId[]; conflictBackup?: string }> {
    if (this.folders.has(id)) return this.renameFolderNow(id, patch);
    let record = this.require(id);
    if (record.kind === "whiteboard") {
      throw notFound("This is a whiteboard; save it with PUT /api/boards/:id");
    }
    if (record.kind === "base") throw notFound("This is a database view; save it with PUT /api/bases/:id");

    let info;
    try {
      info = await stat(record.filePath);
    } catch {
      info = null;
    }
    const mtimeChanged = info === null || Math.abs(info.mtimeMs - record.fileMtimeMs) > 1;
    const versionChanged = !versionMatches(record, patch.expectedUpdated, patch.writer);
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

    // v1.12: a properties patch (validated against the file) may set tags too.
    const propertyPatch =
      patch.properties === undefined ? null : await this.preparePropertiesPatch(record, patch.properties);
    let fmTags =
      patch.tags === undefined ? record.fmTags : normalizeTags(patch.tags).slice(0, MAX_TAGS);
    // The tags key under the note's own spelling (`Tags:`, #ippqkgus).
    const patchTagsKey = propertyPatch ? frontmatterKey(Object.keys(propertyPatch.values), "tags") : undefined;
    if (propertyPatch && patchTagsKey !== undefined) {
      const tags = propertyPatch.values[patchTagsKey];
      fmTags = Array.isArray(tags) ? normalizeTags(tags).slice(0, MAX_TAGS) : [];
    }
    const updated = new Date().toISOString();
    const frontmatter: Frontmatter = {
      title: nextTitle,
      ...(nextIcon ? { icon: nextIcon } : {}),
      tags: fmTags,
      created: record.created,
      updated,
      // Last: a property edit of `tags` is written as given (an empty one as
      // a bare `tags:`). Property values never hold the header keys.
      ...(propertyPatch?.values ?? {}),
    };

    const titleChanged = nextTitle !== previousTitle;
    // Snapshot before the rename so link resolution still sees the old title.
    const beforeMetas = titleChanged ? this.pageMetas() : [];

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
      undefined,
      propertyPatch ?? undefined,
    );
    const fileMtimeMs = written.mtimeMs;
    const previousContent = record.content;

    // Update the record before relocating so the moved copy carries the new
    // title/content; relocate then swaps the map entries and the object.
    record.title = nextTitle;
    record.content = noteBody(nextContent);
    // A plain note has no `updated:` key; its version is the file time.
    const replaced = record.updated;
    record.updated = written.frontmatter ? updated : mtimeVersion(fileMtimeMs);
    record.fileMtimeMs = fileMtimeMs;
    if (patch.writer) record.ownWrite = { version: record.updated, replaced, writer: patch.writer };
    else delete record.ownWrite;
    record.explicitTitle = record.explicitTitle || written.titleKey;
    record.fmTags = fmTags;
    this.setPropertyLinks(record, written.text);
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

    // v0.8 C2: a renamed heading takes the links to it along (after a title
    // rename, so they already point at the new name).
    const renames = patch.content === undefined ? [] : headingRenames(previousContent, record.content);
    if (renames.length > 0) {
      const headingPages = await this.rewriteHeadingLinksTo(record.id, renames);
      for (const pageId of headingPages) {
        this.recomputeSource(pageId);
        if (!rewrittenPages.includes(pageId)) rewrittenPages.push(pageId);
      }
      rewrittenPages.sort((a, b) => a.localeCompare(b));
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
    const afterMetas = this.pageMetas();
    const renamedMeta = afterMetas.find((meta) => meta.id === record.id);
    // Resolved from the page the link is written in (#35e42m7v).
    const rewriteText = (markdown: string, source: PageId) => {
      const isTarget = (link: { targetTitle: string }) =>
        resolveWikilink(link.targetTitle, beforeMetas, source)?.id === oldId;
      return renamedMeta
        ? rewriteLinksToPage(markdown, isTarget, renamedMeta, afterMetas, previousTitle)
        : rewriteWikilinkTargets(markdown, isTarget, record.title);
    };
    return this.rewriteEverywhere(new Set([oldId, record.id]), rewriteText, {}, { frontmatter: true });
  }

  /**
   * v1.20, v0.8 C2 (#u84ebtf3): after headings of page `id` were renamed, rewrite
   * `[[Page#Old]]`, `[[Page#Old|alias]]` and `![[Page#Old]]` to them in every
   * other page and board. The page itself is left as the user saved it.
   */
  private async rewriteHeadingLinksTo(id: PageId, renames: readonly HeadingRename[]): Promise<PageId[]> {
    const metas = this.pageMetas();
    const isTargetFrom = (source: PageId) => (link: { targetTitle: string }) =>
      resolveWikilink(link.targetTitle, metas, source)?.id === id;
    // Board cards of the page with a `subpath` follow the heading too (#u84ebtf3).
    const record = this.pages.get(id);
    const file = record ? relative(this.root, record.filePath).split(sep).join("/").toLowerCase() : null;
    const subpath = (value: string, node: { file: string }) =>
      file !== null && node.file.replace(/^\/+/, "").toLowerCase() === file ? rewriteHeadingSubpath(value, renames) : null;
    return this.rewriteEverywhere(new Set([id]), (markdown, source) => rewriteHeadingLinks(markdown, isTargetFrom(source), renames), { subpath }, { frontmatter: true });
  }

  /**
   * The D12 writer: apply `rewriteText` to every page and board text except
   * `skip`, and write only those it changed (D37: a file without a matching
   * link is never written). `rewriteText` gets the id of the page or board
   * the text belongs to, so links resolve from there (#35e42m7v). Returns the
   * ids written.
   */
  private async rewriteEverywhere(
    skip: ReadonlySet<PageId>,
    /** `source`: the page or board the text is in (links resolve from it, #35e42m7v). */
    rewriteText: (markdown: string, source: PageId) => { content: string; count: number },
    boardNodes: Omit<CanvasRewrite, "text"> = {},
    /** #3c86ify2: also rewrite links inside frontmatter values (renames, folder moves, heading renames). */
    options: { frontmatter?: boolean } = {},
  ): Promise<PageId[]> {
    const rewritten: PageId[] = [];
    const reason = this.historyReason;
    this.historyReason = reason ?? "rename";
    try {
      await this.rewriteEach(skip, rewriteText, boardNodes, options, rewritten);
    } finally {
      this.historyReason = reason;
    }
    return rewritten;
  }

  private async rewriteEach(
    skip: ReadonlySet<PageId>,
    rewriteText: (markdown: string, source: PageId) => { content: string; count: number },
    boardNodes: Omit<CanvasRewrite, "text">,
    options: { frontmatter?: boolean },
    rewritten: PageId[],
  ): Promise<void> {
    // D37/D43: a conflict copy is never rewritten; nothing is written until the user resolves it.
    const copies = this.copyIds();
    for (const other of [...this.pages.values()]) {
      if (skip.has(other.id) || copies.has(other.id)) continue;

      if (other.board) {
        const result = rewriteCanvas(other.board, { ...boardNodes, text: (markdown) => rewriteText(markdown, other.id).content });
        if (result.count === 0) continue;
        await this.saveBoardRecord(other, result.board, { minimal: true });
        rewritten.push(other.id);
        continue;
      }

      const result = rewriteText(other.content, other.id);
      const yaml = options.frontmatter ? await this.rewrittenFrontmatter(other, rewriteText) : null;
      if (result.count === 0 && yaml === null) continue;

      await this.writeRewrittenBody(other, result.content, yaml ?? undefined);
      rewritten.push(other.id);
    }
  }

  /**
   * #3c86ify2: the page's frontmatter YAML with `[[links]]` in its values
   * rewritten, or null when no value has a matching link. Only pages whose
   * properties hold `[[` (the cached property read) are read from disk.
   */
  private async rewrittenFrontmatter(
    record: PageRecord,
    rewriteText: (markdown: string, source: PageId) => { content: string; count: number },
  ): Promise<string | null> {
    if (record.kind !== "page") return null;
    const properties = await this.rawPropertiesOf(record);
    if (!properties.some((property) => JSON.stringify(property.value).includes("[["))) return null;
    let yaml: string | null;
    try {
      yaml = parseNoteTemplate(await readFile(record.filePath, "utf8")).yaml;
    } catch {
      return null;
    }
    if (yaml === null) return null;
    // The same check as the body next to it, from the same note (#35e42m7v).
    const result = rewritePropertyLinks(yaml, (text) => rewriteText(text, record.id));
    return result.count === 0 ? null : result.yaml;
  }

  /** Write a page body changed by a rewrite (D12, C1, C2): header keys and every untouched byte kept. */
  private async writeRewrittenBody(other: PageRecord, content: string, frontmatterYaml?: string): Promise<void> {
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
      content,
      ["updated"],
      titleFromId(other.id),
      undefined,
      undefined,
      frontmatterYaml,
    );
    other.content = noteBody(content);
    other.updated = otherWritten.frontmatter
      ? rewrittenAt
      : mtimeVersion(otherWritten.mtimeMs);
    other.fileMtimeMs = otherWritten.mtimeMs;
    this.setPropertyLinks(other, otherWritten.text);
    this.refreshTags(other);
  }

  // --- unlinked mentions (v0.8 C1, #sipu2nxn, spec/api-mentions) ----------

  /** Each page's mentionable words, cached until its content changes. */
  private readonly mentionWordsByPage = new Map<PageId, { content: string; words: Set<string> }>();
  /** Inverted index: word → pages whose mentionable text has it. */
  private readonly mentionPostings = new Map<string, Set<PageId>>();

  /**
   * Bring the word index up to date: only pages whose content changed since
   * the last request are tokenised again (one identity check per page).
   */
  private syncMentionIndex(): void {
    const drop = (id: PageId, words: Set<string>) => {
      for (const word of words) {
        const pages = this.mentionPostings.get(word);
        if (!pages) continue;
        pages.delete(id);
        if (pages.size === 0) this.mentionPostings.delete(word);
      }
    };
    const copies = this.copyIds();
    for (const [id, entry] of this.mentionWordsByPage) {
      const record = this.pages.get(id);
      if (!record || record.kind !== "page" || copies.has(id)) {
        drop(id, entry.words);
        this.mentionWordsByPage.delete(id);
      }
    }
    for (const record of this.pages.values()) {
      if (record.kind !== "page" || copies.has(record.id)) continue;
      this.mentionWordsOf(record);
    }
  }

  /** One page's mention words in the postings, unless they're already there for this content. */
  private mentionWordsOf(record: PageRecord): void {
    const cached = this.mentionWordsByPage.get(record.id);
    if (cached && cached.content === record.content) return;
    if (cached) {
      for (const word of cached.words) {
        const pages = this.mentionPostings.get(word);
        if (!pages) continue;
        pages.delete(record.id);
        if (pages.size === 0) this.mentionPostings.delete(word);
      }
    }
    const words = new Set(mentionWords(mentionableText(record.content)));
    for (const word of words) {
      let pages = this.mentionPostings.get(word);
      if (!pages) this.mentionPostings.set(word, (pages = new Set()));
      pages.add(record.id);
    }
    this.mentionWordsByPage.set(record.id, { content: record.content, words });
  }

  /** The terms page `id` is mentioned by: its title and frontmatter `aliases` (decision 4). */
  private async mentionTermsOf(id: PageId): Promise<string[]> {
    const record = this.pages.get(id);
    if (!record) return [];
    const index = await this.propertyIndex();
    const properties = typedProperties(await this.rawPropertiesOf(record), (key) => index.typeOf(key));
    // `aliases` in any case, the first in file order (#ippqkgus), as Obsidian reads it.
    const aliasKey = frontmatterKey(properties.map((property) => property.key), "aliases");
    const aliases = properties.find((property) => property.key === aliasKey)?.value;
    const list = Array.isArray(aliases) ? aliases : typeof aliases === "string" ? [aliases] : [];
    return mentionTerms(record.title, list.map(String));
  }

  /** `GET /pages/:id/mentions`: pages that mention this one as plain text. */
  mentions(id: PageId): Promise<PageMentions[]> {
    return this.enqueue(async () => {
      const target = this.require(this.resolveId(id));
      if (target.kind !== "page") throw badRequest("Unlinked mentions are for pages");
      const terms = await this.mentionTermsOf(target.id);
      this.syncMentionIndex();
      // Candidates: pages holding every word of some term (posting lists intersected).
      const candidates = new Set<PageId>();
      for (const term of terms) {
        const lists = mentionWords(term).map((word) => this.mentionPostings.get(word) ?? new Set<PageId>());
        lists.sort((a, b) => a.size - b.size);
        const [first, ...rest] = lists;
        for (const page of first ?? []) if (rest.every((list) => list.has(page))) candidates.add(page);
      }
      candidates.delete(target.id);
      const out: PageMentions[] = [];
      let counts: Map<PageId, number> | undefined;
      for (const pageId of candidates) {
        const record = this.pages.get(pageId);
        if (!record) continue;
        const found = findMentions(record.content, terms);
        if (found.length === 0) continue;
        out.push({
          page: metaOf(record, (counts ??= this.childCounts()).get(record.id) ?? 0),
          updated: record.updated,
          mentions: found.map((mention) => ({ ...mention, snippet: mentionSnippet(record.content, mention) })),
        });
      }
      return out.sort((a, b) => a.page.title.localeCompare(b.page.title) || a.page.id.localeCompare(b.page.id));
    });
  }

  /**
   * `POST /pages/:id/mentions/link`: turn mentions of page `id` in `source`
   * into links. Conditional (D22): a changed file, a stale version, or a
   * position that is no longer a mention is a 409 and nothing is written.
   */
  linkMentions(id: PageId, input: LinkMentionsInput): Promise<LinkMentionsResult> {
    return this.enqueue(async () => {
      const target = this.require(this.resolveId(id));
      if (target.kind !== "page") throw badRequest("Unlinked mentions are for pages");
      if (typeof input.source !== "string") throw badRequest("source is required");
      const source = this.require(this.resolveId(input.source));
      if (source.kind !== "page" || source.id === target.id) throw badRequest("source must be another page");
      if (input.all !== true && (!Array.isArray(input.positions) || input.positions.length === 0 || !input.positions.every((position) => Number.isInteger(position)))) {
        throw badRequest("Pass positions (mention offsets) or all: true");
      }
      let info;
      try {
        info = await stat(source.filePath);
      } catch {
        info = null;
      }
      if (info === null || Math.abs(info.mtimeMs - source.fileMtimeMs) > 1 || (input.expectedUpdated !== undefined && input.expectedUpdated !== source.updated)) {
        throw conflict("This page changed on disk.");
      }
      const found = findMentions(source.content, await this.mentionTermsOf(target.id));
      let chosen = found;
      if (input.all !== true) {
        const byIndex = new Map(found.map((mention) => [mention.index, mention]));
        chosen = [];
        for (const position of new Set(input.positions)) {
          const mention = byIndex.get(position);
          if (!mention) throw conflict("That mention changed; reload the mentions.");
          chosen.push(mention);
        }
      }
      if (chosen.length === 0) return { linked: 0, rewrittenPages: [] };
      // As Obsidian 1.14.4 writes it: the text as written when that bare text
      // resolves to the page (a title match), else `[[target|text]]` (an alias,
      // or a title that isn't the file name).
      const metas = this.pageMetas();
      const { target: linkTarget, alias: autoAlias } = linkTargetFor(metaOf(target, this.directChildCount(target.id)), metas);
      // The bare text must resolve in both apps: in Obsidian a link names the
      // file, so a title that isn't the file name (autoAlias) always gets a target.
      const linkFor = (mention: { text: string }) =>
        mentionLink(linkTarget, mention.text, autoAlias === "" && resolveWikilink(mention.text, metas, source.id)?.id === target.id);
      await this.writeRewrittenBody(source, linkMentionsIn(source.content, chosen, linkFor));
      this.recomputeSource(source.id);
      return { linked: chosen.length, rewrittenPages: [source.id] };
    });
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
    const desired = `${stem}${idExtension(kind)}`;
    if (desired === id) return id;
    // Case-only change: same file on case-insensitive file systems.
    if (desired.toLowerCase() === id.toLowerCase()) return desired;
    const taken = new Set(
      [...this.pages.keys(), ...this.folders.keys()].filter((key) => key !== id).map(collisionKey),
    );
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
    /** First suffix to try: 1 = the bare `base`, 2 = `base 2`. */
    startAt = 1,
  ): Promise<PageId> {
    for (let suffix = startAt; ; suffix += 1) {
      const candidate = suffix === 1 ? base : `${base} ${suffix}`;
      if (taken.has(candidate.toLowerCase())) continue;
      // A page id ending in `.canvas` or `.base` would read as a board or base id.
      if (kind === "page" && keepsExtension(candidate)) continue;
      if (await this.itemFileExists(candidate)) continue;
      if (withFolder && (await pathExists(join(this.root, candidate)))) continue;
      return `${candidate}${idExtension(kind)}`;
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
    // D20: each page's history follows it.
    for (const { oldId, record: value } of moved) {
      if (value.kind === "page" || value.kind === "whiteboard") await this.followHistory(oldId, value.id);
    }

    await this.syncFolders();

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
    const reason = this.historyReason;
    this.historyReason = reason ?? "move";
    try {
      return await this.relinkEach(relevant, options);
    } finally {
      this.historyReason = reason;
    }
  }

  private async relinkEach(
    relevant: ReadonlyArray<{ from: PageId; to: PageId }>,
    options: RelinkOptions,
  ): Promise<PageId[]> {
    const files = await this.attachmentFiles();
    const exists = (path: string) => files.has(path);
    const changed: PageId[] = [];
    const copies = this.copyIds();
    for (const { from, to } of relevant) {
      const record = this.pages.get(to);
      // Boards reference attachments vault-root (JSON Canvas), never relative. D43: copies are never rewritten.
      if (!record || record.kind !== "page" || copies.has(record.id)) continue;
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
      record.content = noteBody(next);
      record.updated = written.frontmatter ? at : mtimeVersion(written.mtimeMs);
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
    if (this.folders.has(id)) return this.removeFolderNow(id);
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

    // §3: the last state of each page and board goes into history before the Trash.
    for (const deletedId of deleted) {
      const doomed = this.pages.get(deletedId);
      if (doomed) await this.snapshotRecord(doomed, this.historySource, "trash");
      this.forgetSessionBytes(deletedId);
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
    await this.syncFolders();
    this.reindexAll();
    return { trashId, deleted };
  }

  // --- trash (D11, #ppag3ugh) ---------------------------------------------

  private get trashRoot(): string {
    return join(this.root, ".trash");
  }

  /**
   * A Gumply trash entry, validated: a plain `[A-Za-z0-9-]` id, a real
   * directory directly in `.trash/` (no symlink), and a manifest whose ids are
   * valid and whose file stays inside the entry. Anything else is "not found".
   */
  private async openTrashEntry(trashId: string): Promise<TrashEntry> {
    if (typeof trashId !== "string" || !/^[A-Za-z0-9-]+$/.test(trashId)) throw badRequest("Invalid trash id");
    const entry = await this.readTrashEntry(trashId);
    if (!entry) throw notFound("Trash entry not found");
    return entry;
  }

  private async readTrashEntry(trashId: string): Promise<TrashEntry | null> {
    const dir = join(this.trashRoot, trashId);
    try {
      // Neither `.trash` nor the entry may be a symlink (to somewhere else).
      if (!(await lstat(this.trashRoot)).isDirectory() || !(await lstat(dir)).isDirectory()) return null;
      const manifest = JSON.parse(await readFile(join(dir, "meta.json"), "utf8")) as Partial<TrashManifest>;
      if (!manifest || typeof manifest.id !== "string" || !isValidPageId(manifest.id)) return null;
      const top = manifest.id;
      const deleted = Array.isArray(manifest.deleted)
        ? manifest.deleted.filter(
            (id): id is PageId =>
              typeof id === "string" && isValidPageId(id) && (id === top || id.startsWith(`${top}/`)),
          )
        : [];
      if (!deleted.includes(top)) deleted.unshift(top);
      const folder = manifest.kind === "folder";
      // v1.7 manifests name the file (`.md` or `.canvas`); older ones mean `.md`.
      const file =
        typeof manifest.file === "string" && manifest.file.length > 0 ? manifest.file : folder ? top : `${top}.md`;
      if (!this.insideTrashEntry(dir, file)) return null;
      const deletedAt = typeof manifest.deletedAt === "string" ? manifest.deletedAt : (await stat(dir)).mtime.toISOString();
      return { trashId, dir, id: top, file, deleted, deletedAt, folder };
    } catch {
      return null;
    }
  }

  /** Every valid Gumply entry in `.trash/` (other files there are ignored). */
  private async trashEntries(): Promise<TrashEntry[]> {
    let names: string[];
    try {
      names = await readdir(this.trashRoot);
    } catch {
      return [];
    }
    const entries: TrashEntry[] = [];
    for (const name of names) {
      if (!/^[A-Za-z0-9-]+$/.test(name)) continue;
      const entry = await this.readTrashEntry(name);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  private insideTrashEntry(dir: string, file: string): boolean {
    const absolute = resolve(dir, file);
    return absolute.startsWith(`${resolve(dir)}${sep}`);
  }

  /** The trashed file of `id` within an entry (sub-pages: `<id>.md` / board id). */
  private trashedFileOf(entry: TrashEntry, id: PageId): string {
    if (id === entry.id) return entry.file;
    return keepsExtension(id) || id.toLowerCase().endsWith(".md") ? id : `${id}.md`;
  }

  /**
   * Read a trashed file as a record, only if it is a regular file whose real
   * path is inside the entry (a symlink planted in `.trash/` can't expose
   * anything outside it).
   */
  private async readTrashedRecord(entry: TrashEntry, id: PageId): Promise<PageRecord | null> {
    const rel = this.trashedFileOf(entry, id);
    if (!this.insideTrashEntry(entry.dir, rel)) return null;
    const absolute = resolve(entry.dir, rel);
    try {
      if (!(await lstat(absolute)).isFile()) return null;
      const [real, realDir] = await Promise.all([realpath(absolute), realpath(entry.dir)]);
      if (!real.startsWith(`${realDir}${sep}`)) return null;
      return await this.readRecord(absolute, id);
    } catch {
      return null;
    }
  }

  /**
   * A trashed plain folder (D33): a real directory whose real path is inside
   * the entry. Returns it, or null.
   */
  private async trashedFolderPath(entry: TrashEntry): Promise<string | null> {
    if (!entry.folder || !this.insideTrashEntry(entry.dir, entry.file)) return null;
    const absolute = resolve(entry.dir, entry.file);
    try {
      if (!(await lstat(absolute)).isDirectory()) return null;
      const [real, realDir] = await Promise.all([realpath(absolute), realpath(entry.dir)]);
      return real.startsWith(`${realDir}${sep}`) ? absolute : null;
    } catch {
      return null;
    }
  }

  /** Files in a trashed folder that aren't pages or boards (never follows links). */
  private async countOtherFiles(dir: string): Promise<number> {
    let count = 0;
    const walk = async (path: string) => {
      let entries;
      try {
        entries = await readdir(path, { withFileTypes: true });
      } catch {
        return;
      }
      for (const item of entries) {
        if (item.isDirectory()) await walk(join(path, item.name));
        else if (item.isFile() && !ITEM_FILE.test(item.name)) count += 1;
      }
    };
    await walk(dir);
    return count;
  }

  /** A folder page or a plain folder still at `id` (restore targets). */
  private async folderExists(id: PageId): Promise<boolean> {
    if (this.pages.get(id)?.kind === "page") return true;
    const absolute = resolve(this.root, id);
    if (!absolute.startsWith(`${this.root}${sep}`)) return false;
    return lstat(absolute).then((info) => info.isDirectory(), () => false);
  }

  private async trashItemFor(entry: TrashEntry): Promise<TrashItem | null> {
    const folderPath = entry.folder ? await this.trashedFolderPath(entry) : null;
    if (entry.folder && !folderPath) return null;
    const name = entry.id.split("/").pop() ?? entry.id;
    const top: { kind: TrashItem["kind"]; title: string; icon?: string } | null = folderPath
      ? { kind: "folder", title: name }
      : await this.readTrashedRecord(entry, entry.id);
    if (!top) return null;
    const children: TrashedPage[] = [];
    const ids = entry.deleted.filter((id) => id !== entry.id).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const present = new Set([entry.id]);
    for (const id of ids) {
      const record = await this.readTrashedRecord(entry, id);
      if (!record) continue;
      present.add(id);
      const parent = parentOf(id);
      children.push({
        id,
        kind: record.kind,
        title: record.title,
        ...(record.icon ? { icon: record.icon } : {}),
        parentId: parent !== null && present.has(parent) ? parent : entry.id,
      });
    }
    const originalParentId = parentOf(entry.id);
    const parent = originalParentId === null ? undefined : this.pages.get(originalParentId);
    // The folder it was in: a folder page by its title, a plain folder (D33) by its name.
    const originalParentTitle =
      originalParentId === null
        ? null
        : parent && parent.kind === "page"
          ? parent.title
          : (await this.folderExists(originalParentId))
            ? (originalParentId.split("/").pop() ?? originalParentId)
            : null;
    return {
      trashId: entry.trashId,
      id: entry.id,
      kind: top.kind,
      title: top.title,
      ...(top.icon ? { icon: top.icon } : {}),
      parentId: null,
      deletedAt: entry.deletedAt,
      originalParentId,
      originalParentTitle,
      children,
      ...(folderPath ? { otherFiles: await this.countOtherFiles(folderPath) } : {}),
    };
  }

  private async listTrashNow(): Promise<TrashItem[]> {
    const items: TrashItem[] = [];
    for (const entry of await this.trashEntries()) {
      const item = await this.trashItemFor(entry);
      if (item) items.push(item);
    }
    return items.sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : a.deletedAt > b.deletedAt ? -1 : 0));
  }

  private async getTrashedNow(trashId: string, id?: PageId): Promise<TrashedDocument> {
    const entry = await this.openTrashEntry(trashId);
    const item = await this.trashItemFor(entry);
    if (!item) throw notFound("Trash entry not found");
    const target = id ?? entry.id;
    if (typeof target !== "string" || !entry.deleted.includes(target)) throw notFound("Page not found in this trash entry");
    // A folder has no document of its own: the client shows its children.
    if (entry.folder && target === entry.id) return { item, page: null };
    const record = await this.readTrashedRecord(entry, target);
    if (!record) throw notFound("Page not found in this trash entry");
    const childCount = entry.deleted.filter((other) => parentOf(other) === target).length;
    const meta = metaOf({ ...record, parentId: parentOf(target) }, childCount);
    if (record.kind === "whiteboard" && record.board) {
      return { item, page: { ...meta, content: "" }, board: record.board };
    }
    if (record.kind === "base") return { item, page: { ...meta, content: "" } };
    return { item, page: { ...meta, content: record.content } };
  }

  /**
   * Where a restored item goes (#ppag3ugh): its own name when free, else the
   * next free ` N` of that name without any ` N` it already had ("Alpha 2"
   * taken → "Alpha 3", never "Alpha 2 2"). Compared like D20 collisions.
   */
  private async restoreTarget(
    folder: PageId | null,
    stem: string,
    withFolder: boolean,
    taken: ReadonlySet<string>,
    kind: PageKind,
  ): Promise<PageId> {
    const prefix = folder ? `${folder}/` : "";
    const own = `${prefix}${stem}${idExtension(kind)}`;
    const first = await this.freeTarget(`${prefix}${stem}`, withFolder, taken, kind);
    if (first === own) return own;
    // "Sprint 12" stays a name of its own; only a D20 sibling of an
    // existing "Alpha" counts as "Alpha" + a number.
    const bare = stem.replace(/ \d+$/, "");
    const bareId = `${prefix}${bare}`;
    const family =
      bare !== stem &&
      bare.length > 0 &&
      (taken.has(bareId.toLowerCase()) ||
        (await this.itemFileExists(bareId)) ||
        (await this.folderExists(bareId)));
    return this.freeTarget(`${prefix}${family ? bare : stem}`, withFolder, taken, kind, 2);
  }

  /**
   * A restored page or board that got a new name: its title follows it
   * (D20), so the tree, search and links can tell the two apart. A page only
   * changes a `title:` it already had (a plain note's title is its file name);
   * a board drops a `gumply.title` the new name replaces.
   */
  private async retitleRestored(id: PageId): Promise<void> {
    const record = this.pages.get(id);
    if (!record) return;
    if (record.kind === "whiteboard" && record.board) {
      const stem = boardStem(id);
      if (record.title === stem) return;
      await this.saveBoardRecord(record, withBoardTitle(record.board, stem, stem));
      record.title = stem;
      return;
    }
    const name = titleFromId(id);
    if (!record.explicitTitle || record.title === name) return;
    const written = await this.writePage(
      record.filePath,
      {
        title: name,
        ...(record.icon ? { icon: record.icon } : {}),
        tags: record.fmTags,
        created: record.created,
        updated: record.updated,
      },
      record.content,
      ["title"],
      name,
    );
    record.title = name;
    record.fileMtimeMs = written.mtimeMs;
    if (!written.frontmatter) record.updated = mtimeVersion(written.mtimeMs);
  }

  /**
   * Put an entry back (#ppag3ugh): where it was when its folder page still
   * exists, otherwise at the top level; a taken name gets ` 2`, ` 3`, … (D20).
   * Sub-pages come back inside it. Attachment links and board cards follow a
   * changed location (D23, D25).
   */
  private async restoreNow(trashId: string): Promise<RestoreResult> {
    const entry = await this.openTrashEntry(trashId);
    if (entry.folder) return this.restoreFolderNow(entry);
    const pageSource = resolve(entry.dir, entry.file);
    // Only a real file comes back (never a symlink planted in `.trash/`).
    if (!(await this.readTrashedRecord(entry, entry.id))) throw notFound("Trash entry not found");

    const kind: PageKind = kindOfFile(entry.file);
    // Boards (`.canvas`) have no sub-page folder; a page's must be a real one.
    const childSource = join(entry.dir, entry.id);
    const hasFolder = kind === "page" && (await lstat(childSource).then((info) => info.isDirectory(), () => false));

    const originalParent = parentOf(entry.id);
    // Its folder: a folder page, or a plain folder (D33) that still exists.
    const parentAlive = originalParent === null || (await this.folderExists(originalParent));
    const folder = parentAlive ? originalParent : null;
    const name = entry.id.split("/").pop() ?? entry.id;
    const stem = name.slice(0, name.length - idExtension(kind).length);
    const taken = new Set([...this.pages.keys()].map(collisionKey));
    const newId = await this.restoreTarget(folder, stem, hasFolder, taken, kind);

    const pageTarget = newId === entry.id ? resolve(this.root, entry.file) : this.filePathFor(newId);
    const childTarget = join(this.root, newId);
    if (!pageTarget.startsWith(`${this.root}${sep}`) || !childTarget.startsWith(`${this.root}${sep}`)) {
      throw notFound("Trash entry not found");
    }

    await mkdir(dirname(pageTarget), { recursive: true });
    await rename(pageSource, pageTarget);
    if (hasFolder) {
      await mkdir(dirname(childTarget), { recursive: true });
      try {
        await rename(childSource, childTarget);
      } catch (error) {
        await rename(pageTarget, pageSource).catch(() => undefined);
        throw error;
      }
    }
    await rm(entry.dir, { recursive: true, force: true });
    await this.rebuild();

    const remap = (id: PageId) => (id === entry.id || id.startsWith(`${entry.id}/`) ? `${newId}${id.slice(entry.id.length)}` : id);
    if (newId !== entry.id) {
      const moves = entry.deleted.map((id) => ({ from: id, to: remap(id) })).filter(({ to }) => this.pages.has(to));
      // D20: the history comes back with it, unless another page has that place (and history) now.
      for (const { from, to } of moves) if (!this.pages.has(from)) await this.followHistory(from, to);
      // D23: in another folder now, so attachment links are rewritten.
      await this.relinkMoved(moves);
      // D25: board cards that pointed at its old place follow it, unless
      // another page lives there now.
      await this.rewriteBoardCards(moves.filter(({ from }) => !this.pages.has(from)));
      this.reindexAll();
    }

    const renamed = (newId.split("/").pop() ?? newId) !== name;
    if (renamed) {
      await this.retitleRestored(newId);
      this.reindexAll();
    }
    const restoredIds = new Set(entry.deleted.map(remap));
    return {
      // Pages and boards (v1.9); a restored folder itself is in the tree list (D33).
      restored: this.pageMetas({ withCopies: true }).filter((meta) => restoredIds.has(meta.id)),
      id: newId,
      movedToTopLevel: !parentAlive,
      renamed,
    };
  }

  /**
   * Put a plain folder (D33) back: the directory with everything in it, where
   * it was if its parent folder still exists (else at the top level), with
   * ` 2` when the name is taken by a page, board or folder.
   */
  private async restoreFolderNow(entry: TrashEntry): Promise<RestoreResult> {
    const source = await this.trashedFolderPath(entry);
    if (!source) throw notFound("Trash entry not found");
    const originalParent = parentOf(entry.id);
    const parentAlive = originalParent === null || (await this.folderExists(originalParent));
    const folder = parentAlive ? originalParent : null;
    const name = entry.id.split("/").pop() ?? entry.id;
    const taken = new Set([...this.pages.keys()].map(collisionKey));
    const newId = await this.restoreTarget(folder, name, true, taken, "page");
    const target = join(this.root, newId);
    if (!target.startsWith(`${this.root}${sep}`)) throw notFound("Trash entry not found");

    await mkdir(dirname(target), { recursive: true });
    await rename(source, target);
    await rm(entry.dir, { recursive: true, force: true });
    await this.rebuild();

    const remap = (id: PageId) => (id === entry.id || id.startsWith(`${entry.id}/`) ? `${newId}${id.slice(entry.id.length)}` : id);
    if (newId !== entry.id) {
      const moves = entry.deleted.map((id) => ({ from: id, to: remap(id) })).filter(({ to }) => this.pages.has(to));
      // D20: the history comes back with it, unless another page has that place (and history) now.
      for (const { from, to } of moves) if (!this.pages.has(from)) await this.followHistory(from, to);
      await this.relinkMoved(moves);
      await this.rewriteBoardCards(moves.filter(({ from }) => !this.pages.has(from)));
      this.reindexAll();
    }
    const restoredIds = new Set(entry.deleted.map(remap));
    return {
      // Pages and boards (v1.9); a restored folder itself is in the tree list (D33).
      restored: this.pageMetas({ withCopies: true }).filter((meta) => restoredIds.has(meta.id)),
      id: newId,
      movedToTopLevel: !parentAlive,
      renamed: (newId.split("/").pop() ?? newId) !== name,
    };
  }

  private async moveNow(id: PageId, parentId: PageId | null): Promise<Page> {
    if (this.folders.has(id)) return this.moveFolderNow(id, parentId);
    const record = this.require(id);

    if (parentId !== null) {
      if (typeof parentId !== "string" || !isValidPageId(parentId)) {
        throw badRequest("parentId must be a valid page id or null");
      }
      this.requireParent(parentId);
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

    await this.syncFolders();

    const moves = moved.map((value) => ({ from: `${id}${value.id.slice(newId.length)}`, to: value.id }));
    // D20: each page's history follows it.
    for (const { from, to } of moves) {
      const record = this.pages.get(to);
      if (record && (record.kind === "page" || record.kind === "whiteboard")) await this.followHistory(from, to);
    }
    // D23: the moved page and its sub-pages are in another folder now.
    await this.relinkMoved(moves);
    // D25: board cards pointing at them follow.
    await this.rewriteBoardCards(moves);

    this.reindexAll();
    return this.getAny(newId);
  }

  // --- templates and daily notes (v0.7 C, #5hrsrqsj) ------------------------

  /** The templates folder and the pages in it (Obsidian's Templates plugin settings). */
  async listTemplates(): Promise<{ folder: string; templates: PageMeta[] }> {
    const { folder } = await readTemplateSettings(this.root);
    const prefix = `${folder}/`.toLowerCase();
    const templates = this.pageMetas()
      .filter((meta) => meta.kind !== "whiteboard" && meta.id.toLowerCase().startsWith(prefix))
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
    return { folder, templates };
  }

  dailySettings(): Promise<DailyNoteSettings> {
    return readDailySettings(this.root).then(({ source: _source, ...settings }) => settings);
  }

  /** A template's body with its variables filled, to insert at the caret (`/template` in a page with text). */
  async renderTemplateBody(template: string, title: string): Promise<{ content: string }> {
    const seed = await this.renderTemplateFile(template, title, new Date());
    return { content: parseFrontmatter(seed).content };
  }

  applyTemplate(id: PageId, template: string): Promise<Page> {
    return this.enqueue(() => this.applyTemplateNow(this.resolveId(id), template));
  }

  dailyNote(day: string): Promise<DailyNoteResult> {
    return this.enqueue(() => this.dailyNoteNow(day));
  }

  /**
   * A template page's file with its variables filled (whole file, frontmatter
   * included). `dateFormat` overrides the Templates setting: Obsidian's Daily
   * notes plugin fills a bare `{{date}}` with the daily-note format.
   */
  private async renderTemplateFile(templateId: string, title: string, now: Date, dateFormat?: string): Promise<string> {
    const record = this.pages.get(this.resolveId(templateId));
    if (!record || record.kind !== "page") throw notFound(`Template not found: ${templateId}`);
    const settings = await readTemplateSettings(this.root);
    const raw = (await readFile(record.filePath, "utf8")).replace(/^\uFEFF/, "");
    return renderTemplate(raw, { title, now, dateFormat: dateFormat ?? settings.dateFormat, timeFormat: settings.timeFormat });
  }

  /**
   * `/template` in an empty page: the body becomes the template's, and the
   * template's frontmatter keys the page doesn't have yet are added (tags are
   * merged). Keys the page already has are never changed.
   */
  private async applyTemplateNow(id: PageId, templateId: string): Promise<Page> {
    const record = this.require(id);
    if (record.kind !== "page") throw badRequest("Templates apply to pages");
    if (record.content.trim().length > 0) throw conflict("Templates fill empty pages only.");
    const seed = await this.renderTemplateFile(templateId, record.title, new Date());
    const parsed = parseFrontmatter(seed);
    const existing = parseFrontmatter(await readFile(record.filePath, "utf8")).frontmatter;
    const added: Frontmatter = {};
    for (const [key, value] of Object.entries(parsed.frontmatter)) {
      if (key === "title" || isTagsKey(key) || key in existing) continue;
      added[key] = value;
    }
    const changes = Object.keys(added);
    const templateTagValue = frontmatterValue(parsed.frontmatter, "tags");
    const templateTags = Array.isArray(templateTagValue) ? (templateTagValue as string[]) : [];
    const tags = normalizeTags([...record.fmTags, ...templateTags]);
    if (JSON.stringify(tags) !== JSON.stringify(record.fmTags)) {
      added.tags = tags;
      changes.push("tags");
    }
    // The template's keys are properties the user asked for (e.g. its own
    // `created:`), not Gumply's header: written as given (#vi74zw3s).
    await this.writePage(record.filePath, added, parsed.content, [], undefined, undefined, {
      values: added,
      changed: changes,
      renames: [],
    });
    const fresh = await this.readRecord(record.filePath, id);
    fresh.parentId = record.parentId;
    this.pages.set(id, fresh);
    this.refreshTags(fresh);
    this.reindexAll();
    return this.get(id);
  }

  /**
   * Open or make a day's note (Obsidian's Daily notes plugin settings). A new
   * note is a plain file, like Obsidian's, filled from the daily template if
   * one is set. Asking again for the same day returns the same note.
   */
  private async dailyNoteNow(day: string): Promise<DailyNoteResult> {
    const date = typeof day === "string" ? dateFromDay(day) : null;
    if (!date) throw badRequest("date must be YYYY-MM-DD");
    const settings = await readDailySettings(this.root);
    const id = dailyNoteId(date, settings);
    if (!isValidPageId(id) || isBoardId(id)) throw badRequest("The daily note format doesn't give a valid file name");
    const key = id.toLowerCase();
    const existing = [...this.pages.values()].find((record) => record.kind === "page" && record.id.toLowerCase() === key);
    if (existing) return { page: this.pageMetas().find((meta) => meta.id === existing.id)!, created: false };

    const now = new Date();
    const at = new Date(date.getFullYear(), date.getMonth(), date.getDate(), now.getHours(), now.getMinutes(), now.getSeconds());
    const name = id.slice(id.lastIndexOf("/") + 1);
    let text = "";
    if (settings.template) {
      try {
        // As Obsidian's Daily notes plugin: a bare {{date}} uses the daily-note format.
        text = await this.renderTemplateFile(settings.template, name, at, settings.format);
      } catch {
        // A missing daily template makes an empty note, as in Obsidian.
      }
    }
    const filePath = this.filePathFor(id);
    await mkdir(dirname(filePath), { recursive: true });
    try {
      await writeFile(filePath, text, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      // Made outside Gumply a moment ago: index it and open it.
      if ((error as { code?: string }).code !== "EEXIST") throw error;
    }
    const record = await this.readRecord(filePath, id);
    this.pages.set(id, record);
    this.redirects.delete(id);
    await this.syncFolders();
    this.refreshTags(record);
    this.reindexAll();
    return { page: this.pageMetas().find((meta) => meta.id === id)!, created: true };
  }

  // --- plain folders (D33) ------------------------------------------------

  private folderPage(id: PageId): Page {
    const meta = this.list().find((item) => item.id === id && item.kind === "folder");
    if (!meta) throw notFound(`Folder not found: ${id}`);
    return { ...meta, content: "" };
  }

  /** First of `base`, `base 2`, … free as a folder, page and board (`self` may keep its own). */
  private async freeFolderTarget(base: PageId, self: PageId): Promise<PageId> {
    const taken = new Set(
      [...this.pages.keys(), ...this.folders.keys()].filter((key) => key !== self).map(collisionKey),
    );
    for (let suffix = 1; ; suffix += 1) {
      const candidate = suffix === 1 ? base : `${base} ${suffix}`;
      if (candidate.toLowerCase() === self.toLowerCase()) return candidate;
      if (taken.has(collisionKey(candidate))) continue;
      if (await pathExists(this.folderPathFor(candidate))) continue;
      if (await this.itemFileExists(candidate)) continue;
      return candidate;
    }
  }

  private folderPathFor(id: PageId): string {
    if (!isValidPageId(id) || keepsExtension(id)) throw badRequest("Invalid folder id");
    const absolute = resolve(this.root, id);
    if (!absolute.startsWith(`${this.root}${sep}`)) throw badRequest("Folder id escapes the vault");
    return absolute;
  }

  /** Rename a plain folder: the directory moves, everything inside follows. */
  private async renameFolderNow(id: PageId, patch: UpdatePageInput): Promise<Page & { rewrittenPages: PageId[] }> {
    if (patch.content !== undefined || patch.icon !== undefined || patch.tags !== undefined) {
      throw badRequest("A folder only has a name");
    }
    const title = typeof patch.title === "string" ? patch.title.trim() : "";
    if (title.length === 0) throw badRequest("title must not be empty");
    if (title.length > MAX_TITLE_LENGTH) throw badRequest(`title is too long (max ${MAX_TITLE_LENGTH} characters)`);
    const parent = parentOf(id);
    const base = parent ? `${parent}/${pageSegment(title)}` : pageSegment(title);
    if (base === id) return { ...this.folderPage(id), rewrittenPages: [] };
    const newId = await this.freeFolderTarget(base, id);
    const rewrittenPages = await this.relocateFolderNow(id, newId);
    return { ...this.folderPage(newId), rewrittenPages };
  }

  private async moveFolderNow(id: PageId, parentId: PageId | null): Promise<Page> {
    if (parentId !== null) {
      if (typeof parentId !== "string" || !isValidPageId(parentId)) {
        throw badRequest("parentId must be a valid page id or null");
      }
      if (parentId === id || parentId.startsWith(`${id}/`)) {
        throw badRequest("cannot move a folder into itself or one of its children");
      }
      this.requireParent(parentId);
    }
    const segment = id.split("/").pop() ?? id;
    const newId = parentId ? `${parentId}/${segment}` : segment;
    if (newId === id) return this.folderPage(id);
    const clash = [...this.pages.keys(), ...this.folders.keys()].some(
      (key) => key !== id && collisionKey(key) === collisionKey(newId),
    );
    if (
      clash ||
      (await pathExists(this.folderPathFor(newId))) ||
      (await this.itemFileExists(newId))
    ) {
      throw conflict(`A page or folder already exists at ${newId}`);
    }
    await this.relocateFolderNow(id, newId);
    return this.folderPage(newId);
  }

  /**
   * Move a plain folder's directory to `newId` and remap what's inside, like
   * `relocateNow` does for a page's sub-page folder. Path-qualified links into
   * it (`[[Work/Ideas]]`) follow; title links still resolve unchanged.
   */
  private async relocateFolderNow(id: PageId, newId: PageId): Promise<PageId[]> {
    const oldDir = this.folderPathFor(id);
    const newDir = this.folderPathFor(newId);
    await mkdir(dirname(newDir), { recursive: true });
    await rename(oldDir, newDir);

    const moved: Array<{ oldId: PageId; record: PageRecord }> = [];
    for (const [key, value] of [...this.pages]) {
      if (!key.startsWith(`${id}/`)) continue;
      this.pages.delete(key);
      const movedId = `${newId}${key.slice(id.length)}`;
      moved.push({ oldId: key, record: { ...value, id: movedId, filePath: this.movedFilePath(value, movedId) } });
    }
    for (const { oldId, record: value } of moved) {
      this.pages.set(value.id, value);
      this.redirects.delete(value.id);
      this.addRedirect(oldId, value.id);
    }
    // D20: each page's history follows it.
    for (const { oldId, record: value } of moved) {
      if (value.kind === "page" || value.kind === "whiteboard") await this.followHistory(oldId, value.id);
    }
    await this.syncFolders();

    const moves = moved.map(({ oldId, record: value }) => ({ from: oldId, to: value.id }));
    const relinked = await this.relinkMoved(moves);
    const boards = await this.rewriteBoardCards(moves);
    const linked = await this.rewriteFolderLinks(id, newId);
    this.reindexAll();
    return [...new Set([...relinked, ...boards, ...linked])].sort((a, b) => a.localeCompare(b));
  }

  /** Rewrite `[[from/…]]` links to `[[to/…]]` in every page and board (D33), frontmatter values included (#3c86ify2). */
  private async rewriteFolderLinks(from: PageId, to: PageId): Promise<PageId[]> {
    return this.rewriteEverywhere(new Set(), (markdown) => rewriteWikilinkFolder(markdown, from, to), {}, { frontmatter: true });
  }

  private async renameTagNow(fromInput: string, toInput: string, skip: readonly PageId[]): Promise<TagRenameResult> {
    const from = fromInput.trim().replace(/^#/, "");
    const to = toInput.trim().replace(/^#/, "");
    if (!isValidTagName(from)) throw badRequest("Unknown tag");
    if (!isValidTagName(to)) throw badRequest("A tag is letters, digits, _, - and /, with at least one that isn't a digit");
    if (from === to) return { renamed: 0, rewrittenPages: [], skippedPages: [] };
    // What other apps wrote since the last scan is read first.
    await this.refreshFromDisk();

    const rewrittenPages: PageId[] = [];
    const skippedPages: PageId[] = [];
    const copies = this.copyIds();
    for (const record of [...this.pages.values()]) {
      // D37/D43: a conflict copy keeps its tags as written until the user resolves it.
      if (copies.has(record.id)) continue;
      const changed = record.board ? this.boardWithTagRenamed(record.board, from, to) : null;
      const fmTags = record.board ? null : renameTagList(record.fmTags, from, to);
      const body = record.board ? null : renameInlineTag(record.content, from, to);
      if (!changed && !fmTags && !(body && body.count > 0)) continue;

      // An open editor with unsaved edits: its file is left alone, never overwritten.
      if (skip.includes(record.id)) {
        skippedPages.push(record.id);
        continue;
      }
      // D22: never write over a change this store hasn't seen.
      const mtime = await stat(record.filePath).then((stats) => stats.mtimeMs, () => null);
      if (mtime !== record.fileMtimeMs) {
        skippedPages.push(record.id);
        continue;
      }

      if (changed) {
        await this.saveBoardRecord(record, changed);
      } else {
        const at = new Date().toISOString();
        const content = body?.content ?? record.content;
        const tags = fmTags ?? record.fmTags;
        // Only what the rename changes: the `tags` line when the list
        // changed, and `updated:` only in a file that already has it. An
        // Obsidian note never gains Gumply's keys; a plain note changes only
        // its body bytes (#9bx3aznb, @opus-hunter's P2).
        const raw = await readFile(record.filePath, "utf8").catch(() => null);
        const hasUpdated = raw !== null && frontmatterKeys(parseNoteTemplate(raw).yaml).includes("updated");
        const written = await this.writePage(
          record.filePath,
          { title: record.title, ...(record.icon ? { icon: record.icon } : {}), tags, created: record.created, updated: at },
          content,
          [...(fmTags ? ["tags"] : []), ...(hasUpdated ? ["updated"] : [])],
          titleFromId(record.id),
        );
        record.content = content;
        record.fmTags = tags;
        record.updated = hasUpdated && written.frontmatter ? at : mtimeVersion(written.mtimeMs);
        record.fileMtimeMs = written.mtimeMs;
        this.refreshTags(record);
      }
      rewrittenPages.push(record.id);
    }
    return { renamed: rewrittenPages.length, rewrittenPages, skippedPages };
  }

  /** The board with the tag renamed in its tags, cards, frame labels and connector labels; null if none. */
  private boardWithTagRenamed(board: CanvasBoard, from: string, to: string): CanvasBoard | null {
    let changed = false;
    const text = (value: string): string => {
      const result = renameInlineTag(value, from, to);
      if (result.count > 0) changed = true;
      return result.content;
    };
    let next = rewriteCanvas(board, { text }).board;
    const nodes = next.nodes.map((node) =>
      node.type === "group" && typeof node.label === "string" && text(node.label) !== node.label
        ? { ...node, label: text(node.label) }
        : node,
    );
    const edges = next.edges.map((edge) =>
      typeof edge.label === "string" && text(edge.label) !== edge.label ? { ...edge, label: text(edge.label) } : edge,
    );
    if (changed) next = { ...next, nodes, edges };
    const tags = renameTagList(canvasMeta(next).tags, from, to);
    if (tags) {
      next = withCanvasMeta(next, { tags });
      changed = true;
    }
    return changed ? next : null;
  }

  /** D11/D33: a plain folder goes to the trash as a whole directory. */
  private async removeFolderNow(id: PageId): Promise<DeletePageResult> {
    const dir = this.folderPathFor(id);
    // Trash view (v1.9): the folder, then the pages and boards inside.
    const deleted = [
      id,
      ...[...this.pages.keys()].filter((key) => key.startsWith(`${id}/`)).sort((a, b) => a.localeCompare(b)),
    ];
    const trashId = await this.freeTrashId();
    const trashDir = join(this.root, ".trash", trashId);
    const inTrash = join(trashDir, id);
    // §3: the last state of each page and board goes into history before the Trash.
    for (const deletedId of deleted) {
      const doomed = this.pages.get(deletedId);
      if (doomed) await this.snapshotRecord(doomed, this.historySource, "trash");
      this.forgetSessionBytes(deletedId);
    }

    const manifest: TrashManifest = {
      id,
      trashId,
      deleted,
      deletedAt: new Date().toISOString(),
      file: id,
      kind: "folder",
    };
    try {
      await mkdir(dirname(inTrash), { recursive: true });
      await writeFile(join(trashDir, "meta.json"), JSON.stringify(manifest, null, 2), "utf8");
      await rename(dir, inTrash);
    } catch (error) {
      await rename(inTrash, dir).catch(() => undefined);
      await rm(trashDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    for (const key of deleted) this.pages.delete(key);
    await this.syncFolders();
    this.reindexAll();
    return { trashId, deleted };
  }

  /** A page, or a board's meta with empty content (shared endpoints: move). */
  private getAny(id: PageId): Page {
    const record = this.require(id);
    if (record.kind === "whiteboard" || record.kind === "base") return { ...metaOf(record, 0), content: "" };
    return this.get(id);
  }

  // --- index -------------------------------------------------------------

  private async rebuild(): Promise<void> {
    await this.readAll();
    this.reindexAll();
  }

  /** Read every file into the index's records (no links yet). */
  private async readAll(): Promise<void> {
    const { pages: next, folders } = await this.scanRecords();
    this.folders = folders;
    this.pages.clear();
    this.edgesBySource.clear();
    for (const [id, record] of next) this.pages.set(id, record);
  }

  /** True while the links of a vault just opened are being indexed (#g95wkd9y). */
  get indexing(): boolean {
    return this.indexingNow;
  }

  /** Resolves once the link index is complete (at once unless the vault is still being indexed). */
  whenIndexed(): Promise<void> {
    return this.indexDone;
  }

  /**
   * #g95wkd9y: fill the mention and search caches in small batches between
   * other work (never in the queue, so a save never waits for it). Both are
   * caches keyed on a page's content: a page that changes meanwhile is simply
   * refreshed when it's next used.
   */
  private warmCaches(): Promise<void> {
    const ids = [...this.pages.keys()];
    let at = 0;
    return new Promise((resolve) => {
      const batch = () => {
        if (this.stopped) return resolve();
        const copies = this.copyIds();
        const end = Math.min(ids.length, at + WARM_BATCH);
        for (; at < end; at += 1) {
          const record = this.pages.get(ids[at]!);
          if (!record) continue;
          this.searchText(record);
          if (record.kind === "page" && !copies.has(record.id)) this.mentionWordsOf(record);
        }
        if (at < ids.length) setImmediate(batch);
        else resolve();
      };
      setImmediate(batch);
    });
  }

  private reindexAll(): void {
    const metas = this.pageMetas();
    this.edgesBySource.clear();
    for (const meta of metas) {
      const record = this.pages.get(meta.id);
      if (!record) continue;
      this.edgesBySource.set(meta.id, this.edgesFor(record, metas));
    }
  }

  /** Recompute the link edges of these sources only (one page list for all of them). */
  private recomputeSources(ids: readonly PageId[]): void {
    if (ids.length === 0) return;
    const metas = this.pageMetas();
    // D43: a conflict copy beside its original holds no links (as recomputeSource).
    const copies = this.copyIds();
    for (const id of ids) {
      const record = this.pages.get(id);
      if (record && !copies.has(id)) this.edgesBySource.set(id, this.edgesFor(record, metas));
      else this.edgesBySource.delete(id);
    }
  }

  private recomputeSource(id: PageId): void {
    const record = this.pages.get(id);
    if (!record || this.copyIds().has(id)) {
      this.edgesBySource.delete(id);
      return;
    }
    this.edgesBySource.set(id, this.edgesFor(record, this.pageMetas()));
  }

  /**
   * Link edges from a page (`[[links]]`) or a board (D25: `[[links]]` in its
   * text plus page/board cards, i.e. file nodes).
   */
  private edgesFor(record: PageRecord, metas: readonly PageMeta[]): LinkEdge[] {
    const fromProperties = record.propertyLinks?.pages.map((entry) => entry.link) ?? [];
    const edges = collectLinkEdges(record.id, record.content, metas, fromProperties);
    if (!record.board) return edges;
    const seen = new Set(edges.map((edge) => edge.target ?? `?${edge.targetTitle.toLowerCase()}`));
    for (const link of canvasLinks(record.board)) {
      if (link.kind !== "file") continue;
      const id = this.idForFile(link.path);
      if (id === record.id) continue;
      const target = id === null ? null : (this.pages.get(id) ?? null);
      const name = link.path.split("/").pop() ?? link.path;
      const targetTitle = target?.title ?? name.replace(ITEM_FILE, "");
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
    const candidates = keepsExtension(clean) ? [clean] : [clean.replace(/\.md$/i, ""), clean];
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
    const copies = this.copyIds();
    for (const board of [...this.pages.values()]) {
      if (!board.board || copies.has(board.id)) continue;
      const result = rewriteCanvas(board.board, {
        file: (path) => byOldFile.get(path.replace(/^\/+/, "").toLowerCase()) ?? null,
      });
      if (result.count === 0) continue;
      await this.saveBoardRecord(board, result.board, { minimal: true });
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

  /**
   * #rpugpydh: the frontmatter's links, re-read after a write or a read of the
   * file (`raw`: the whole note). Only a note with `[[` in it is parsed.
   */
  private setPropertyLinks(record: PageRecord, raw: string): void {
    const links = raw.includes("[[") ? propertyLinks(parseNoteTemplate(raw).yaml) : null;
    if (links) record.propertyLinks = links;
    else delete record.propertyLinks;
  }

  private linkSnippet(record: PageRecord, edge: LinkEdge): string {
    const { targetTitle } = edge;
    if (edge.via === "property") {
      // A link only in the frontmatter: its key and the link (`related: [[Alpha]]`; the panel shows `related: Alpha`, the link highlighted).
      const entry = record.propertyLinks?.pages.find((candidate) => candidate.link.targetTitle === targetTitle);
      if (entry) return `${entry.key}: ${entry.link.raw}`;
    }
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
    if (isBaseId(absolute)) return this.readBaseRecord(absolute, id);
    const { raw, stats } = await readConsistent(absolute);
    const { frontmatter, content } = parseFrontmatter(raw);

    const created = toIso(frontmatter.created) ?? stats.birthtime.toISOString();
    const mtime = mtimeVersion(stats.mtimeMs);
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
      fmTags: normalizeTags(frontmatterValue(frontmatter, "tags")),
      explicitTitle,
      kind: "page",
    };
    if (icon) record.icon = icon;
    this.setPropertyLinks(record, raw);
    return record;
  }

  /**
   * A `.canvas` file (D25). Title = file name; icon/tags from the top-level
   * `gumply` object; dates from the file. A file that isn't valid JSON Canvas
   * still shows in the tree (as an empty board) and is never overwritten
   * without a backup: saving it backs up the original first.
   */
  private async readBoardRecord(absolute: string, id: PageId): Promise<PageRecord> {
    const { raw, stats } = await readConsistent(absolute);
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
      updated: mtimeVersion(stats.mtimeMs),
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

  // --- version history (spec/version-history, D41) -----------------------

  /** A page's or board's versions, newest first (§7). `:id` is the current id. */
  listHistory(id: PageId, options: { limit?: number; cursor?: string } = {}): Promise<HistoryList> {
    return this.enqueue(async () => {
      const record = this.historyRecord(id);
      const { entries, moves } = await readHistory(historyDir(this.root, record.id));
      const current = await readFile(record.filePath).catch(() => null);
      const newestFirst = [...entries].reverse();
      const start = options.cursor ? newestFirst.findIndex((entry) => entry.file === options.cursor) + 1 : 0;
      const limit = Math.min(Math.max(Math.floor(options.limit ?? 200), 1), 1000);
      const page = newestFirst.slice(Math.max(start, 0), Math.max(start, 0) + limit);
      const last = page[page.length - 1];
      const more = last !== undefined && newestFirst.indexOf(last) < newestFirst.length - 1;
      return {
        items: page.map((entry) => this.historyItem(entry, record)),
        ...(more && last ? { nextCursor: last.file } : {}),
        current: { version: record.updated, sha256: current ? sha256(current) : null },
        moves,
      };
    });
  }

  /** A version's exact bytes. */
  readVersion(id: PageId, file: string): Promise<{ bytes: Buffer; kind: "page" | "whiteboard" }> {
    return this.enqueue(async () => {
      const record = this.historyRecord(id);
      const entry = await this.historyEntry(record, file);
      return { bytes: await this.versionBytes(record, entry), kind: record.kind as "page" | "whiteboard" };
    });
  }

  /** A version against the current file (or another version): lines for pages, cards for boards. */
  diffVersion(id: PageId, file: string, against = "current"): Promise<HistoryDiff> {
    return this.enqueue(async () => {
      const record = this.historyRecord(id);
      const before = (await this.versionBytes(record, await this.historyEntry(record, file))).toString("utf8");
      const after =
        against === "current"
          ? await readFile(record.filePath, "utf8").catch(() => "")
          : (await this.versionBytes(record, await this.historyEntry(record, against))).toString("utf8");
      if (record.kind === "whiteboard") return { kind: "whiteboard", ...boardDiff(before, after) };
      return { kind: "page", lines: lineDiff(before, after) };
    });
  }

  /**
   * Restore a version (§4): the current bytes are saved first
   * (`before-restore`, so it's undoable), then the version's bytes are
   * written exactly into the current file. Never renames. 409 when the file
   * changed since `expectedUpdated`.
   */
  restoreVersion(id: PageId, file: string, input: { expectedUpdated?: string; writer?: string } = {}): Promise<Page | BoardDocument> {
    return this.enqueue(async () => {
      const record = this.historyRecord(id);
      const entry = await this.historyEntry(record, file);
      const bytes = await this.versionBytes(record, entry);
      const info = await stat(record.filePath).catch(() => null);
      if (info === null || Math.abs(info.mtimeMs - record.fileMtimeMs) > 1 || !versionMatches(record, input.expectedUpdated, input.writer)) {
        throw conflict("This page changed on disk.");
      }
      const ext = record.kind === "whiteboard" ? "canvas" : "md";
      const current = await readFile(record.filePath);
      if (!current.equals(bytes)) {
        await saveVersion(this.root, { id: record.id, ext, bytes: current, version: record.updated, source: "restore", reason: "before-restore" });
        const temporary = tempPathBeside(record.filePath);
        try {
          await writeFile(temporary, bytes);
          await rename(temporary, record.filePath);
        } catch (error) {
          await rm(temporary, { force: true }).catch(() => undefined);
          throw error;
        }
        const fresh = await this.readRecord(record.filePath, record.id);
        this.pages.set(record.id, fresh);
        // The bytes Gumply wrote before are the `before-restore` version now.
        this.forgetSessionBytes(record.id);
        this.reindexAll();
        await saveVersion(this.root, { id: record.id, ext, bytes, version: fresh.updated, source: "app", restoredFrom: entry.file });
      }
      return record.kind === "whiteboard" ? this.getBoard(record.id) : this.get(record.id);
    });
  }

  /** Keep (pin) a version, or let it go again. */
  pinVersion(id: PageId, file: string, pinned: boolean): Promise<HistoryItem> {
    return this.enqueue(async () => {
      const record = this.historyRecord(id);
      const entry = await this.historyEntry(record, file);
      await setPinned(this.root, record.id, entry.file, pinned);
      return this.historyItem({ ...entry, pinned }, record);
    });
  }

  /** Histories of pages that no longer exist (§2.3), newest first. Pages in Gumply's Trash aren't listed (D41). */
  historyOrphans(): Promise<HistoryOrphan[]> {
    return this.enqueue(() => this.historyOrphansNow());
  }

  /** Bring an orphan's version back as a new page at its old path (or `<name> 2`), never over another page. */
  restoreOrphan(key: string, file?: string): Promise<Page | BoardDocument> {
    return this.enqueue(async () => {
      const orphan = (await this.historyOrphansNow()).find((item) => item.key === key);
      if (!orphan) throw notFound("No such history");
      const dir = join(this.root, HISTORY_DIR, key);
      const { entries } = await readHistory(dir);
      const entry = entries.find((item) => item.file === (file ?? orphan.newest));
      if (!entry) throw notFound("No such version");
      const bytes = await readFile(join(dir, entry.file));
      const kind: PageKind = entry.file.endsWith(".canvas") ? "whiteboard" : "page";
      const parent = parentOf(orphan.lastId);
      const folder = parent !== null && (await this.folderExists(parent)) ? parent : null;
      const name = orphan.lastId.split("/").pop() ?? orphan.lastId;
      const stem = kind === "whiteboard" ? name.replace(/\.canvas$/i, "") : name;
      const taken = new Set([...this.pages.keys()].map(collisionKey));
      const newId = await this.restoreTarget(folder, stem, false, taken, kind);
      const target = this.filePathFor(newId);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes, { flag: "wx" });
      await moveHistoryDir(this.root, dir, orphan.lastId, newId, parentOf(newId) === parent ? "rename" : "move");
      await this.rebuild();
      const record = this.require(newId);
      await saveVersion(this.root, { id: newId, ext: kind === "whiteboard" ? "canvas" : "md", bytes, version: record.updated, source: "app", restoredFrom: entry.file });
      return kind === "whiteboard" ? this.getBoard(newId) : this.get(newId);
    });
  }

  /** How much space history takes. */
  historyUsage(): Promise<HistoryUsage> {
    return this.enqueue(() => usage(this.root));
  }

  /** "Clear history older than…": every unpinned version older than that, except each page's newest. */
  clearHistory(olderThanMs: number): Promise<HistoryUsage> {
    return this.enqueue(async () => pruneVault(this.root, { budget: budgetFor(await this.vaultBytes()), olderThanMs }));
  }

  // --- sync conflict copies (spec/sync-conflicts, D43; spec/api v1.29) -------

  /** Every conflict copy, attachment copy and possible copy in the vault. Reads only (D37). */
  conflicts(): Promise<ConflictsList> {
    return this.enqueue(async () => {
      const copies: ConflictCopy[] = [];
      for (const [copyId, { of, name }] of this.conflictNames()) {
        const copy = this.pages.get(copyId)!;
        const original = of === null ? undefined : this.pages.get(of);
        const same = original ? await sameBytes(copy.filePath, original.filePath) : false;
        copies.push({
          copyId,
          originalId: of,
          tool: name.tool,
          ...(name.device ? { device: name.device } : {}),
          ...(name.at ? { at: name.at } : {}),
          kind: copy.kind,
          same,
          copyUpdated: copy.updated,
          ...(original ? { originalUpdated: original.updated } : {}),
        });
      }
      const files = new Set([...this.linkIndex.files(), ...(await this.attachmentFiles())]);
      const attachments: ConflictAttachment[] = [];
      for (const path of [...files].sort()) {
        const slash = path.lastIndexOf("/");
        const name = conflictCopyOf(path.slice(slash + 1));
        if (!name) continue;
        const originalPath = `${path.slice(0, slash + 1)}${name.originalName}`;
        attachments.push({
          path,
          originalPath: files.has(originalPath) ? originalPath : null,
          tool: name.tool,
          ...(name.device ? { device: name.device } : {}),
          ...(name.at ? { at: name.at } : {}),
        });
      }
      return { copies: copies.sort((a, b) => a.copyId.localeCompare(b.copyId)), attachments, possible: await this.possibleCopiesNow() };
    });
  }

  /** The copy against its original: a line diff (pages, bases) or cards added/removed/changed (boards). */
  conflictDiff(copyId: PageId): Promise<ConflictDiff> {
    return this.enqueue(async () => {
      const { copy, original } = this.conflictPair(copyId, { possible: true });
      if (!original) throw badRequest("This copy's original is gone; there is nothing to compare with");
      const [before, after] = await Promise.all([readFile(original.filePath, "utf8"), readFile(copy.filePath, "utf8")]);
      if (copy.kind === "whiteboard") return { kind: "board", ...boardDiff(before, after) };
      return { kind: "text", lines: lineDiff(before, after) };
    });
  }

  /**
   * Resolve a conflict copy (§4.4). Conditional on both files: a file that
   * changed since Compare (the sync tool may still be at work) is a 409.
   * Nothing is deleted: the losing side goes to the Trash, and its bytes into
   * the original's history.
   */
  resolveConflict(copyId: PageId, input: ConflictResolveInput): Promise<ConflictResolveResult> {
    return this.enqueue(async () => {
      if (!input || typeof input !== "object" || typeof input.expected !== "object" || input.expected === null) throw badRequest("expected is required");
      const keep = input.keep;
      if (!["page", "copy", "both", "delete", "as-original"].includes(keep)) throw badRequest("keep must be page, copy, both, delete or as-original");
      await this.refreshFromDisk();
      const { copy, original, name } = this.conflictPair(copyId);
      if (!["page", "whiteboard", "base"].includes(copy.kind)) throw badRequest("Only pages, boards and bases are resolved here");
      await this.assertUnchanged(copy, input.expected.copy);
      if (original) await this.assertUnchanged(original, input.expected.page);
      const client = `${name.tool}${name.device ? ` ${name.device}` : ""}`;
      const versioned = (record: PageRecord) => record.kind === "page" || record.kind === "whiteboard";
      const extOf = (record: PageRecord): "md" | "canvas" => (record.kind === "whiteboard" ? "canvas" : "md");

      if (keep === "page" || keep === "delete") {
        if (keep === "page" && !original) throw badRequest("This copy's original is gone");
        if (keep === "delete" && original && !(await sameBytes(copy.filePath, original.filePath))) {
          throw badRequest("Delete copy is for an orphan copy or one that's the same as its page");
        }
        if (original && versioned(original)) {
          await saveVersion(this.root, { id: original.id, ext: extOf(original), bytes: await readFile(copy.filePath), version: copy.updated, source: "external", reason: "conflict", client });
        }
        const removed = await this.removeNow(copy.id);
        return { keep, ...(original ? { page: this.metaFor(original.id) } : {}), trashId: removed.trashId };
      }

      if (keep === "copy") {
        if (!original) throw badRequest("This copy's original is gone; use as-original");
        const bytes = await readFile(copy.filePath);
        const current = await readFile(original.filePath);
        let beforeVersion: string | undefined;
        if (versioned(original) && !current.equals(bytes)) {
          beforeVersion = (await saveVersion(this.root, { id: original.id, ext: extOf(original), bytes: current, version: original.updated, source: "restore", reason: "before-restore" })).file;
        }
        if (!current.equals(bytes)) {
          await writeAtomic(original.filePath, bytes);
          const fresh = original.kind === "base" ? await this.readBaseRecord(original.filePath, original.id) : await this.readRecord(original.filePath, original.id);
          this.pages.set(original.id, fresh);
          if (versioned(fresh)) {
            await saveVersion(this.root, { id: fresh.id, ext: extOf(fresh), bytes, version: fresh.updated, source: "external", reason: "conflict", client });
          }
        }
        const removed = await this.removeNow(copy.id);
        this.reindexAll();
        return { keep, page: this.metaFor(original.id), trashId: removed.trashId, ...(beforeVersion ? { beforeVersion } : {}) };
      }

      // both / as-original: the copy becomes an ordinary page under a new name; its bytes are untouched.
      let title: string;
      if (keep === "as-original") {
        if (original) throw badRequest("The original is still there; use both");
        title = name.originalName.replace(/\.(md|canvas|base)$/i, "");
      } else {
        if (!original) throw badRequest("This copy's original is gone; use as-original");
        const date = (name.at ?? new Date().toISOString()).slice(0, 10);
        title = `${original.title} (copy ${date})`;
      }
      const folder = copy.id.includes("/") ? copy.id.slice(0, copy.id.lastIndexOf("/") + 1) : "";
      const extension = copy.kind === "whiteboard" ? ".canvas" : copy.kind === "base" ? ".base" : "";
      const targetId = await this.freeId(`${folder}${pageSegment(title)}${extension}`, copy.kind);
      await this.relocateNow(copy.id, targetId);
      this.reindexAll();
      return { keep, renamedTo: targetId, ...(original ? { page: this.metaFor(original.id) } : {}) };
    });
  }

  /**
   * Undo of Keep both / as-original: rename the page back to the conflict-copy
   * name it had. `previousId` must be a conflict-copy name in the same folder.
   */
  undoConflictRename(currentId: PageId, previousId: PageId): Promise<PageMeta> {
    return this.enqueue(async () => {
      const record = this.require(this.resolveId(currentId));
      const folderOf = (id: string) => (id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : "");
      const previousName = previousId.slice(previousId.lastIndexOf("/") + 1);
      const fileName = record.kind === "page" ? `${previousName}.md` : previousName;
      if (folderOf(previousId) !== folderOf(record.id) || !conflictCopyOf(fileName)) throw badRequest("Not the conflict copy this page was");
      if (this.pages.has(previousId)) throw badRequest("That name is taken again");
      await this.relocateNow(record.id, previousId);
      this.reindexAll();
      return this.metaFor(previousId, { withCopies: true });
    });
  }

  /** "Not a copy": a possible copy (§3) is left alone from now on, in `.gumply/sync-dismissed.json`. */
  dismissPossibleCopy(copyId: PageId, dismissed: boolean): Promise<void> {
    return this.enqueue(async () => {
      const list = await this.readDismissed();
      const key = this.resolveId(copyId);
      const next = dismissed ? [...new Set([...list, key])] : list.filter((id) => id !== key);
      await mkdir(join(this.root, ".gumply"), { recursive: true });
      const file = join(this.root, ".gumply", "sync-dismissed.json");
      await writeAtomic(file, `${JSON.stringify({ notACopy: next.sort() }, null, 2)}\n`);
    });
  }

  private async readDismissed(): Promise<string[]> {
    try {
      const data = JSON.parse(await readFile(join(this.root, ".gumply", "sync-dismissed.json"), "utf8")) as { notACopy?: unknown };
      return Array.isArray(data.notACopy) ? data.notACopy.filter((id): id is string => typeof id === "string") : [];
    } catch {
      return [];
    }
  }

  /** §3's possible copies: the name pattern, the original beside it, ≥60% shared, not dismissed. */
  private async possibleCopiesNow(): Promise<PossibleCopy[]> {
    const dismissed = new Set(await this.readDismissed());
    const byPath = new Map<string, PageRecord>();
    for (const record of this.pages.values()) byPath.set(record.filePath, record);
    const out: PossibleCopy[] = [];
    for (const record of this.pages.values()) {
      if (dismissed.has(record.id) || !["page", "whiteboard", "base"].includes(record.kind)) continue;
      const name = possibleCopyOf(basename(record.filePath));
      if (!name) continue;
      const original = byPath.get(join(dirname(record.filePath), name.originalName));
      if (!original || original.id === record.id) continue;
      const similarity = await this.sharedContent(record, original);
      if (similarity >= POSSIBLE_COPY_MIN_SHARED) out.push({ copyId: record.id, originalId: original.id, similarity: Math.round(similarity * 100) / 100 });
    }
    return out.sort((a, b) => a.copyId.localeCompare(b.copyId));
  }

  private async sharedContent(a: PageRecord, b: PageRecord): Promise<number> {
    if (a.board && b.board) return sharedRatio(a.board.nodes.map((node) => node.id), b.board.nodes.map((node) => node.id));
    const [left, right] = await Promise.all([readFile(a.filePath, "utf8").catch(() => ""), readFile(b.filePath, "utf8").catch(() => "")]);
    return sharedRatio(left.split(/\r?\n/), right.split(/\r?\n/));
  }

  /** A conflict copy (or, for Compare, a possible copy) and its original. */
  private conflictPair(copyId: PageId, options: { possible?: boolean } = {}): { copy: PageRecord; original: PageRecord | undefined; name: ConflictCopyName } {
    const id = this.resolveId(copyId);
    const copy = this.pages.get(id);
    if (!copy) throw notFound("Page not found");
    const entry = this.conflictNames().get(id);
    if (entry) return { copy, original: entry.of === null ? undefined : this.pages.get(entry.of), name: entry.name };
    if (options.possible) {
      const possible = possibleCopyOf(basename(copy.filePath));
      const original = possible ? [...this.pages.values()].find((record) => record.filePath === join(dirname(copy.filePath), possible.originalName)) : undefined;
      if (possible && original) return { copy, original, name: { tool: "syncthing", originalName: possible.originalName } };
    }
    throw badRequest("Not a conflict copy");
  }

  /** D22 for a resolve: the file must be as Compare saw it. */
  private async assertUnchanged(record: PageRecord, expected: string | undefined): Promise<void> {
    if (typeof expected !== "string") throw badRequest("expected versions are required");
    const info = await stat(record.filePath).catch(() => null);
    if (info === null || Math.abs(info.mtimeMs - record.fileMtimeMs) > 1 || expected !== record.updated) {
      throw conflict("This changed while you were comparing. Check again.");
    }
  }

  private metaFor(id: PageId, options: { withCopies?: boolean } = { withCopies: true }): PageMeta {
    const meta = this.pageMetas(options).find((item) => item.id === id);
    if (!meta) throw notFound("Page not found");
    return meta;
  }

  private async historyOrphansNow(): Promise<HistoryOrphan[]> {
    const live = new Set([...this.pages.keys()].map(pageKey));
    const trashed = new Set<string>();
    for (const entry of await this.trashEntries().catch(() => [] as TrashEntry[])) {
      for (const id of entry.deleted) trashed.add(pageKey(id));
    }
    const out: HistoryOrphan[] = [];
    for (const key of await historyKeys(this.root)) {
      if (live.has(key) || trashed.has(key)) continue;
      const { entries } = await readHistory(join(this.root, HISTORY_DIR, key));
      const newest = entries[entries.length - 1];
      if (!newest) continue;
      // The directory's name is the page's last id (renames move it), even when no version was saved since.
      const lastId = keyToId(key);
      out.push({ key, lastId, title: titleFromId(lastId).replace(/\.canvas$/i, ""), lastAt: newest.at, versions: entries.length, newest: newest.file });
    }
    return out.sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
  }

  /** The page or board whose history is asked for (no `.base`, no folder, D41). */
  private historyRecord(id: PageId): PageRecord {
    const resolved = this.resolveId(id);
    const record = this.require(resolved);
    if (record.kind !== "page" && record.kind !== "whiteboard") throw notFound("Only pages and boards have history");
    return record;
  }

  /** `file` must be an index entry's exact file name: never a path. */
  private async historyEntry(record: PageRecord, file: string): Promise<HistoryEntry> {
    const { entries } = await readHistory(historyDir(this.root, record.id));
    const entry = typeof file === "string" ? entries.find((item) => item.file === file) : undefined;
    if (!entry) throw notFound("No such version");
    return entry;
  }

  private async versionBytes(record: PageRecord, entry: HistoryEntry): Promise<Buffer> {
    try {
      return await readFile(join(historyDir(this.root, record.id), entry.file));
    } catch {
      throw notFound("No such version");
    }
  }

  private historyItem(entry: HistoryEntry, record: PageRecord): HistoryItem {
    const strip = (id: string) => titleFromId(id).replace(/\.canvas$/i, "");
    const title = entry.id && strip(entry.id) !== strip(record.id) ? strip(entry.id) : undefined;
    const then = entry.id ? (parentOf(entry.id) ?? "") : undefined;
    const folder = then !== undefined && then !== (parentOf(record.id) ?? "") ? then : undefined;
    return {
      file: entry.file,
      at: entry.at,
      source: entry.source,
      ...(entry.reason ? { reason: entry.reason } : {}),
      ...(entry.client ? { client: entry.client } : {}),
      ...(entry.tool ? { tool: entry.tool } : {}),
      bytes: entry.bytes,
      sha256: entry.sha256,
      version: entry.version,
      pinned: entry.pinned === true,
      ...(entry.restoredFrom ? { restoredFrom: entry.restoredFrom } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(folder !== undefined ? { folder } : {}),
    };
  }

  /** The page or board a file belongs to (pages and `.canvas` only: no `.base`, D41). */
  private historyRecordFor(filePath: string): PageRecord | undefined {
    for (const record of this.pages.values()) {
      if (record.filePath === filePath) return record.kind === "page" || record.kind === "whiteboard" ? record : undefined;
    }
    return undefined;
  }

  /**
   * The pre-write rule (§3): the bytes on disk go into history before a write
   * replaces them, unless they're the newest entry already, or an app edit
   * less than 5 min after the previous app version (coalescing). History
   * never blocks a save: a failure is logged and the save goes on.
   */
  private async versionBeforeWrite(filePath: string, raw: string | Buffer | null): Promise<void> {
    if (raw === null) return;
    const record = this.historyRecordFor(filePath);
    if (!record) return;
    const bytes = typeof raw === "string" ? Buffer.from(raw, "utf8") : raw;
    const reason = this.historyReason ?? "edit";
    try {
      if (this.historySource === "app" && reason === "edit") {
        const newest = await newestVersion(this.root, record.id);
        if (newest && newest.source === "app" && Date.now() - Date.parse(newest.at) < HISTORY_COALESCE_MS && newest.sha256 !== sha256(bytes)) {
          this.armSession(record.id);
          return;
        }
      }
      await saveVersion(this.root, {
        id: record.id,
        ext: record.kind === "whiteboard" ? "canvas" : "md",
        bytes,
        version: record.updated,
        source: this.historySource,
        reason,
      });
    } catch (error) {
      console.warn(`[gumply] history for ${record.id} not saved:`, error);
    }
    if (this.historySource === "app") this.armSession(record.id);
  }

  /** The editing session ends 10 min after the last app save: its result becomes a version. */
  private armSession(id: PageId): void {
    const previous = this.sessionTimers.get(id);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.sessionTimers.delete(id);
      void this.checkpoint(id).catch(() => undefined);
    }, HISTORY_SESSION_MS);
    timer.unref?.();
    this.sessionTimers.set(id, timer);
  }

  /**
   * End a page's editing session now (the page was closed, the app quits):
   * its current bytes become a version unless they're the newest already.
   */
  checkpoint(id: PageId): Promise<boolean> {
    return this.enqueue(async () => {
      let resolved: PageId;
      try {
        resolved = this.resolveId(id);
      } catch {
        return false;
      }
      // Only a page edited in this session: merely viewing a page never starts its history.
      const timer = this.sessionTimers.get(resolved);
      if (!timer) return false;
      clearTimeout(timer);
      this.sessionTimers.delete(resolved);
      let record: PageRecord | undefined;
      record = this.pages.get(resolved);
      if (!record || (record.kind !== "page" && record.kind !== "whiteboard")) return false;
      // What Gumply wrote (the file may already hold an outside change the watcher hasn't seen yet).
      if (this.sessionBytes.has(resolved)) return this.saveSessionBytes(resolved);
      return this.snapshotRecord(record, "app", "session");
    });
  }

  /** End every open editing session (shutdown). */
  async flushHistory(): Promise<void> {
    for (const id of [...this.sessionTimers.keys()]) await this.checkpoint(id).catch(() => undefined);
    if (this.pruneTimer) clearTimeout(this.pruneTimer);
    this.pruneTimer = null;
  }

  /** The record's file as it is now, as a version (deduplicated). True when one was written. */
  private async snapshotRecord(record: PageRecord, source: HistorySource, reason?: HistoryReason): Promise<boolean> {
    if (record.kind !== "page" && record.kind !== "whiteboard") return false;
    const bytes = await readFile(record.filePath).catch(() => null);
    if (!bytes) return false;
    try {
      const before = await newestVersion(this.root, record.id);
      const entry = await saveVersion(this.root, {
        id: record.id,
        ext: record.kind === "whiteboard" ? "canvas" : "md",
        bytes,
        version: record.updated,
        source,
        ...(reason ? { reason } : {}),
      });
      return entry.file !== before?.file;
    } catch (error) {
      console.warn(`[gumply] history for ${record.id} not saved:`, error);
      return false;
    }
  }

  /**
   * A file changed outside Gumply: its new bytes become an `external`
   * version, at most one per 5 min. When an AI app (MCP, its own process)
   * saved a version of this page in the last 30 s, the change is its.
   */
  private async versionFromOutside(record: PageRecord): Promise<void> {
    if (record.kind !== "page" && record.kind !== "whiteboard") return;
    if (this.historySource !== "app") return;
    // #yikrbg7h: the user's last save first, then what the other program wrote.
    await this.saveSessionBytes(record.id);
    try {
      const newest = await newestVersion(this.root, record.id);
      const age = newest ? Date.now() - Date.parse(newest.at) : Infinity;
      if (newest?.source === "mcp" && age < 30_000) {
        await this.snapshotRecord(record, "mcp", "edit");
        return;
      }
      if (newest?.source === "external" && age < HISTORY_COALESCE_MS) return;
      await this.snapshotRecord(record, "external");
    } catch (error) {
      console.warn(`[gumply] history for ${record.id} not saved:`, error);
    }
  }

  /**
   * Keep the bytes a Gumply write just put in a page or board file (#yikrbg7h).
   * Past the cap, the pages written longest ago are saved as `session`
   * versions early and dropped from memory.
   */
  private async rememberWrite(filePath: string, text: string): Promise<void> {
    if (this.historySource !== "app") return;
    const path = relative(this.root, filePath).split(sep).join("/");
    if (!/\.(md|canvas)$/i.test(path)) return;
    const id = this.historyRecordFor(filePath)?.id ?? path.replace(/\.md$/i, "");
    this.forgetSessionBytes(id);
    const bytes = Buffer.from(text, "utf8");
    // Re-inserted, so the Map's order is "written longest ago" first.
    this.sessionBytes.set(id, bytes);
    this.sessionBytesTotal += bytes.length;
    for (const oldest of [...this.sessionBytes.keys()]) {
      if (this.sessionBytesTotal <= this.sessionBytesCap || oldest === id) break;
      await this.saveSessionBytes(oldest);
    }
  }

  private forgetSessionBytes(id: PageId): Buffer | undefined {
    const bytes = this.sessionBytes.get(id);
    if (bytes) {
      this.sessionBytes.delete(id);
      this.sessionBytesTotal -= bytes.length;
    }
    return bytes;
  }

  /**
   * The last bytes Gumply wrote to `id`, as an `app` / `session` version
   * (deduplicated), ending its editing session. True when a version was written.
   */
  private async saveSessionBytes(id: PageId): Promise<boolean> {
    const bytes = this.forgetSessionBytes(id);
    if (!bytes) return false;
    const timer = this.sessionTimers.get(id);
    if (timer) clearTimeout(timer);
    this.sessionTimers.delete(id);
    try {
      const before = await newestVersion(this.root, id);
      const entry = await saveVersion(this.root, {
        id,
        ext: /\.canvas$/i.test(id) ? "canvas" : "md",
        bytes,
        version: this.pages.get(id)?.updated ?? new Date().toISOString(),
        source: "app",
        reason: "session",
      });
      return entry.file !== before?.file;
    } catch (error) {
      console.warn(`[gumply] history for ${id} not saved:`, error);
      return false;
    }
  }

  /** A new page or board file: an older history under its id (a deleted page's) is set aside. */
  private async freshHistory(filePath: string): Promise<void> {
    const path = relative(this.root, filePath).split(sep).join("/");
    if (!/\.(md|canvas)$/i.test(path)) return;
    try {
      await setAsideHistory(this.root, path.replace(/\.md$/i, ""));
    } catch (error) {
      console.warn(`[gumply] history at ${path} not set aside:`, error);
    }
  }

  /** A page moved (D20): its history directory follows it. */
  private async followHistory(from: PageId, to: PageId): Promise<void> {
    // An open editing session follows the page too.
    const timer = this.sessionTimers.get(from);
    if (timer) {
      this.sessionTimers.delete(from);
      this.sessionTimers.set(to, timer);
    }
    const written = this.forgetSessionBytes(from);
    if (written) {
      this.sessionBytes.set(to, written);
      this.sessionBytesTotal += written.length;
    }
    try {
      await moveHistory(this.root, from, to, parentOf(from) === parentOf(to) ? "rename" : "move");
    } catch (error) {
      console.warn(`[gumply] history of ${from} didn't follow it to ${to}:`, error);
    }
  }

  /** The daily vault-wide prune (§2.4–2.5), a minute after start and then every day. */
  private schedulePrune(delay = 60_000): void {
    if (this.historySource !== "app" || this.pruneTimer) return;
    this.pruneTimer = setTimeout(() => {
      this.pruneTimer = null;
      void this.enqueue(async () => {
        await pruneVault(this.root, { budget: budgetFor(await this.vaultBytes()) });
      }).catch(() => undefined);
      this.schedulePrune(86_400_000);
    }, delay);
    this.pruneTimer.unref?.();
  }

  /** The vault's own size: every page and board file (for the history budget). */
  private async vaultBytes(): Promise<number> {
    let total = 0;
    for (const record of this.pages.values()) total += (await stat(record.filePath).catch(() => null))?.size ?? 0;
    return total;
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
    const extension = record.kind === "page" ? ".md" : idExtension(record.kind);
    const file = join(dir, `${safeId}-${Date.now()}${extension}`);
    await writeFile(file, raw, "utf8");
    // §3: the other side of a conflict is a version too (pages and boards).
    await this.snapshotRecord(record, "external", "conflict");
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
    /** v0.7 C: a new file's byte template (a rendered page template). */
    seed?: string,
    /** v1.12: a properties patch (values, changed keys, renames). */
    properties?: { values: Record<string, unknown>; changed: string[]; renames: Array<{ from: string; to: string }> },
    /** #3c86ify2: the existing frontmatter YAML with rewritten link values (used as the template's YAML). */
    frontmatterYaml?: string,
  ): Promise<{ mtimeMs: number; frontmatter: boolean; titleKey: boolean; text: string }> {
    await mkdir(dirname(filePath), { recursive: true });
    // Use the current file as the byte template so unknown frontmatter keys,
    // comments, key order, flow style, CRLF and the trailing newline survive
    // (#tterskg4). Only the keys in `changes` are touched.
    let template = null;
    // The file is already on disk (not a new page, not a template's seed).
    let existing = false;
    // The bytes this write replaces: they go into history first (§3).
    let previous: Buffer | null = null;
    try {
      previous = await readFile(filePath);
      template = parseNoteTemplate(previous.toString("utf8"));
      existing = true;
    } catch {
      // New file: write canonical frontmatter, or keep a template's layout.
      if (seed !== undefined) template = parseNoteTemplate(seed);
    }
    if (frontmatterYaml !== undefined && template !== null && template.yaml !== null) template = { ...template, yaml: frontmatterYaml };
    // A note without frontmatter (the Obsidian default) stays without it
    // unless it now needs a key: an icon, tags, or a title the file name
    // can't express.
    let plain = false;
    if (template !== null && template.yaml === null && implicitTitle !== undefined) {
      const tags = Array.isArray(frontmatter.tags) ? frontmatter.tags : [];
      plain = !frontmatter.icon && tags.length === 0 && frontmatter.title === implicitTitle;
    }
    // v1.12: a property edit on a note whose frontmatter has none of Gumply's
    // header keys (an Obsidian note, or a plain one getting its first
    // property) writes only the property lines: no title/created/updated are
    // added, and removing the last property removes the block again.
    const headerKeys = new Set(["title", "icon", "created", "updated"]);
    const bare =
      properties !== undefined &&
      template !== null &&
      implicitTitle !== undefined &&
      !frontmatterKeys(template.yaml).some((key) => headerKeys.has(key)) &&
      !frontmatter.icon &&
      frontmatter.title === implicitTitle;
    let text: string;
    // Whether the file now carries Gumply's version in `updated:` (else the
    // version is the file time, D22/v1.8).
    let versionKey = false;
    let titleWritten = false;
    if (bare) {
      const keys = new Set(properties.changed);
      if ((changes ?? []).includes("tags")) keys.add("tags");
      // Only the keys this edit touches (a new block holds just them).
      const values: Frontmatter = {};
      for (const key of keys) if (frontmatter[key] !== undefined && frontmatter[key] !== null) values[key] = frontmatter[key];
      text = serializeNoteLike(template, values, content, [...keys], properties.renames);
      plain = true; // no `updated:` key: the version is the file time
    } else if (plain) {
      text = serializeNoteLike(template, {}, content, []);
    } else {
      // Only the header keys a caller manages are filtered; property writes
      // (a user's or a template's `created:`) are written as asked.
      let managed = [...(changes ?? [])];
      const asked = properties?.changed ?? [];
      if (existing && template !== null && template.yaml !== null) {
        // #vi74zw3s: Gumply's header keys are never added to an existing note
        // that lacks them (an Obsidian note with `status:`/`tags:`): a body
        // save, a link rewrite or a tag rename changes only what it changes.
        // `title:` is written when the file has it, or when the title is
        // something the file name can't hold.
        const present = new Set(frontmatterKeys(template.yaml));
        managed = managed.filter((key) => {
          if (key === "updated" || key === "created") return present.has(key);
          if (key === "title") {
            return present.has("title") || implicitTitle === undefined || frontmatter.title !== implicitTitle;
          }
          return true;
        });
        versionKey = managed.includes("updated") || asked.includes("updated");
        titleWritten = managed.includes("title") || asked.includes("title");
      } else if (template !== null && template.yaml !== null) {
        // A new page from a template: its keys plus Gumply's, as asked.
        versionKey = managed.includes("updated") || asked.includes("updated");
        titleWritten = managed.includes("title") || asked.includes("title");
      } else {
        // A new file or a new block: canonical frontmatter with every key given.
        versionKey = frontmatter.updated !== undefined && frontmatter.updated !== null;
        titleWritten = true;
      }
      text = serializeNoteLike(template, frontmatter, content, [...managed, ...asked], properties?.renames ?? []);
    }
    const temporary = tempPathBeside(filePath);
    try {
      await writeFile(temporary, text, "utf8");
      // Stat the temp before the rename: the path's stat after it could be
      // another program's file (see statAfterRename, #a76d3php).
      const written = await stat(temporary);
      if (previous !== null && !previous.equals(Buffer.from(text, "utf8"))) await this.versionBeforeWrite(filePath, previous);
      if (previous === null) await this.freshHistory(filePath);
      await rename(temporary, filePath);
      await this.rememberWrite(filePath, text);
      return {
        mtimeMs: (await statAfterRename(filePath, written)).mtimeMs,
        // True when the version is the `updated:` just written; otherwise the
        // caller uses the file time (`mtimeVersion`), as for plain notes.
        frontmatter: !plain && versionKey,
        // A new block always has `title:`; an edited one only if it was written.
        titleKey: !plain && titleWritten,
        text,
      };
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Every page and board file under `dir`. With `directories`, also records
   * each directory walked (vault path → non-page files directly in it), so
   * D33 folders come from the same single walk.
   */
  private async scan(dir: string, directories?: DirectoryScan, others?: string[], unreadable?: string[]): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
      this.unreadableLogged.delete(dir);
    } catch (error) {
      // #g95wkd9y: a folder removed or renamed while the walk was under way (a
      // git checkout, a sync tool) holds nothing now; the next rescan sees where
      // it went. The vault itself missing is a real error.
      if (dir !== this.root && isGoneError(error)) return [];
      // #35q6kt6e: a folder that can't be listed now (permissions, a lock) is
      // out of reach, not empty: the caller keeps what it had, and so do the
      // plain folders under it; the rest of the walk goes on. Logged once.
      if (dir !== this.root && isPerFileError(error)) {
        if (!this.unreadableLogged.has(dir)) {
          this.unreadableLogged.add(dir);
          console.warn(`[gumply] can't list ${relative(this.root, dir)}/ (${(error as NodeJS.ErrnoException).code}); keeping what was there and reading the rest`);
        }
        unreadable?.push(dir);
        if (directories) {
          const key = relative(this.root, dir).split(sep).join("/");
          for (const folder of this.folders.values()) {
            if (folder.id === key || folder.id.startsWith(`${key}/`)) directories.set(folder.id, 0);
          }
        }
        return [];
      }
      throw error;
    }
    const files: string[] = [];
    let otherFiles = 0;

    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      // Attachments are files, never pages (D18). Skip the root attachments dir.
      if (dir === this.root && entry.name === "attachments") continue;
      if (entry.isSymbolicLink()) continue;

      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) files.push(...(await this.scan(absolute, directories, others, unreadable)));
      else if (entry.isFile() && ITEM_FILE.test(entry.name)) files.push(absolute);
      else if (entry.isFile()) {
        otherFiles += 1;
        // The name from the dirent only: no stat (a scan runs after every save).
        others?.push(relative(this.root, absolute).split(sep).join("/"));
      }
    }

    if (directories && dir !== this.root) {
      directories.set(relative(this.root, dir).split(sep).join("/"), otherFiles);
    }
    return files;
  }

  private async freeId(baseId: string, kind: PageKind = "page"): Promise<PageId> {
    // D33: a new page never takes a plain folder's name (that would turn the
    // folder into the page's sub-page folder).
    const taken = new Set([...this.pages.keys(), ...this.folders.keys()].map(collisionKey));
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

  /**
   * Direct children (pages, boards, folders) of every parent, in one pass.
   * #g95wkd9y: anything that builds many metas uses this, not
   * `directChildCount` per item (which walks the vault each time).
   */
  private childCounts(): Map<PageId, number> {
    const counts = new Map<PageId, number>();
    const count = (parentId: PageId | null) => {
      if (parentId) counts.set(parentId, (counts.get(parentId) ?? 0) + 1);
    };
    for (const record of this.pages.values()) count(record.parentId);
    for (const folder of this.folders.values()) count(folder.parentId);
    return counts;
  }

  /** One item's direct children; for many items use `childCounts`. */
  private directChildCount(id: PageId): number {
    let count = 0;
    for (const record of this.pages.values()) {
      if (record.parentId === id) count += 1;
    }
    for (const folder of this.folders.values()) {
      if (folder.parentId === id) count += 1;
    }
    return count;
  }

  /** A parent for a new or moved item: a page (its sub-page folder) or a plain folder (D33). */
  private requireParent(id: PageId): void {
    if (this.folders.has(id)) return;
    const kind = this.require(id).kind;
    if (kind === "base") throw badRequest("Database views can't have sub-pages");
    if (kind !== "page") throw badRequest("Whiteboards can't have sub-pages");
  }

  private filePathFor(id: PageId): string {
    if (!isValidPageId(id)) throw badRequest("Invalid page id");
    // Boards keep their extension in the id (v1.7); pages add `.md`.
    const absolute = resolve(this.root, keepsExtension(id) ? id : `${id}.md`);
    if (!absolute.startsWith(`${this.root}${sep}`)) {
      throw badRequest("Page id escapes the vault");
    }
    return absolute;
  }

  /** A page, board or base file already at `stem` (any of the three extensions). */
  private async itemFileExists(stem: PageId): Promise<boolean> {
    for (const extension of ["", BOARD_EXTENSION, BASE_EXTENSION]) {
      if (await pathExists(this.filePathFor(`${stem}${extension}`))) return true;
    }
    return false;
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

  private enqueue<T>(task: () => Promise<T>, options: { rescan?: boolean } = {}): Promise<T> {
    if (!options.rescan) this.pendingWrites += 1;
    const done = () => {
      if (!options.rescan) this.pendingWrites -= 1;
    };
    const result = this.writeQueue.then(task, task);
    this.writeQueue = result.then(done, done);
    return result;
  }
}
