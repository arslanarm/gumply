/**
 * Typed client for the local API (wiki `spec/api`). Vite proxies `/api` to the
 * server, so paths are relative and work in dev and in e2e.
 */
import type {
  HealthResponse,
  ApiError,
  BoardDocument,
  BoardUpdateResult,
  CanvasBoard,
  DailyNoteSettings,
  Attachment,
  McpSettingsPatch,
  McpSettingsResponse,
  DesktopUpdatesState,
  UpdateMode,
  VaultImage,
  LinkableFile,
  NotionImportReport,
  Backlink,
  GraphData,
  GraphSettings,
  GraphSettingsResponse,
  LinkMentionsInput,
  LinkMentionsResult,
  PageMentions,
  Page,
  PageId,
  PageMeta,
  PropertiesPatch,
  PropertyInfo,
  PropertyType,
  RestoreResult,
  SearchResult,
  TrashedDocument,
  TagCount,
  TrashItem,
  BaseConfig,
  BaseViewResult,
  ConflictDiff,
  ConflictResolveInput,
  ConflictResolveResult,
  ConflictsList,
} from "@gumply/core";
import { expandGraphLinks, type IndexedGraphData } from "@gumply/core";
import { currentLanguage } from "../i18n/index.js";

export class ApiRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
  }
}

let newVaultPage: PageId | null = null;

/** The `X-Gumply-Renaming` header (v1.35): a percent-encoded JSON list; anything malformed is no renames. */
export function parseRenames(header: string | null): Array<{ fromTitle: string; fromId: PageId; to: PageId }> {
  if (!header) return [];
  try {
    const value = JSON.parse(decodeURIComponent(header)) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter(
      (item): item is { fromTitle: string; fromId: PageId; to: PageId } =>
        typeof item === "object" && item !== null && typeof item.fromTitle === "string" && typeof item.fromId === "string" && typeof item.to === "string",
    );
  } catch {
    return [];
  }
}

/** One-shot: the server just seeded the demo vault and suggests this page. */
export function consumeNewVaultPage(): PageId | null {
  const page = newVaultPage;
  newVaultPage = null;
  return page;
}

let vaultSyncing = false;
let vaultIndexing = false;
/** v1.35 (#xgnvipyd): renames still rewriting their links, from the last page list. */
let renamesInProgress: Array<{ fromTitle: string; fromId: PageId; to: PageId }> = [];

/**
 * The page a not-yet-rewritten `[[Old]]` link means while a rename of `Old`
 * is still rewriting the links to it (spec/api v1.35), or null.
 */
export function renamedTargetFor(targetTitle: string): PageId | null {
  const wanted = targetTitle.trim().toLowerCase();
  const found = renamesInProgress.find((rename) => rename.fromTitle.toLowerCase() === wanted || rename.fromId.toLowerCase() === wanted);
  return found ? found.to : null;
}

/** Whether the last page list said the vault's links are still being indexed (#g95wkd9y, spec/api v1.33). */
export function isVaultIndexing(): boolean {
  return vaultIndexing;
}

/** Whether the last page list said a sync tool is changing many files (spec/sync-conflicts §8). */
export function isVaultSyncing(): boolean {
  return vaultSyncing;
}

let unreachableSeen = false;

/**
 * #2xx3uae4: one-shot. Whether any request since the last call couldn't reach
 * the local server (a failed fetch, or a 5xx, which the dev server's proxy
 * answers while it's down). The poll asks after it succeeds: what failed in
 * between (a dialog's load, even in an outage shorter than a poll) loads again.
 */
export function takeUnreachableSeen(): boolean {
  const seen = unreachableSeen;
  unreachableSeen = false;
  return seen;
}

/** `fetch` for the API that notes when the server couldn't be reached (see `takeUnreachableSeen`). */
async function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    unreachableSeen = true;
    throw error;
  }
  if (response.status >= 500) unreachableSeen = true;
  return response;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  // The interface language: a first run seeds the demo in it (#93yv3ban).
  headers.set("Accept-Language", currentLanguage());
  if (init.body !== undefined && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  const response = await apiFetch(`/api${path}`, { ...init, headers });

  // First-run signal from the server: open this page once, then forget it.
  const firstPage = response.headers.get("x-gumply-new-vault");
  if (firstPage) {
    try {
      newVaultPage = decodeURIComponent(firstPage);
    } catch {
      newVaultPage = firstPage;
    }
  }

  const files = response.headers.get("x-gumply-files");
  if (files !== null) noteFileIndexVersion(files);
  // v1.29 (D43): the page list says whether a sync tool is changing many files.
  if (path === "/pages" || path.startsWith("/pages?")) {
    vaultSyncing = response.headers.get("x-gumply-syncing") === "1";
    vaultIndexing = response.headers.get("x-gumply-indexing") === "1";
    renamesInProgress = parseRenames(response.headers.get("x-gumply-renaming"));
  }

  if (!response.ok) {
    let message = response.statusText || `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as Partial<ApiError>;
      if (typeof body.error === "string" && body.error.length > 0) message = body.error;
    } catch {
      // Non-JSON error body: keep the status text.
    }
    throw new ApiRequestError(response.status, message);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export interface CreatePageInput {
  title: string;
  parentId?: PageId | null;
  content?: string;
  icon?: string;
  /** v0.7 C: start from this template page. */
  template?: PageId;
}

export interface UpdatePageInput {
  title?: string;
  content?: string;
  icon?: string | null;
  tags?: string[];
  /** Version the client loaded; server returns 409 if the file changed. */
  expectedUpdated?: string;
  /** Force-save after a conflict ("Keep mine"). */
  force?: boolean;
  /** This editor's id (#d5e4mawv): see `newWriterId`. */
  writer?: string;
  /** v1.12 (D34): change frontmatter properties. */
  properties?: PropertiesPatch;
}

/** v1.1: a rename reports which other pages had their links rewritten (D12). */
export type UpdatePageResult = Page & {
  rewrittenPages?: PageId[];
  conflictBackup?: string;
  /** v1.35 (N10): a rename's link changes kept on `links` lines the editor didn't touch; the renames' new titles. */
  renameLinksMerged?: { links: number; titles: string[] };
  /** #z9hufufn: a rename rewrote this page's own body, starting from this version. */
  ownRewriteFrom?: string;
  /** v1.35, #bbh3n5p7: pages whose links a rename, heading rename or move left as they were (read-only, a write error). */
  linksNotRewritten?: PageId[];
};

/** DELETE result: v1.1 returns a trash id; v1.0 returns 204 (no trash). */
export interface DeletePageResult {
  trashId: string | null;
  deleted: PageId[];
}

const pagePath = (id: PageId): string => `/pages/${encodeURIComponent(id)}`;

/** Browsers cap all keepalive request bodies in flight at 64 KB. */
export const KEEPALIVE_LIMIT = 60_000;

/**
 * A PUT that outlives the page (#3t6v62cb): sent synchronously with
 * `keepalive`, outside the mutation chain (the page may be gone before the
 * chain gets to it). Null when the body is too big for keepalive.
 */
function exitPut<T>(path: string, body: unknown): Promise<T> | null {
  const json = JSON.stringify(body);
  if (new Blob([json]).size > KEEPALIVE_LIMIT) return null;
  return request<T>(path, { method: "PUT", body: json, keepalive: true });
}
const boardPath = (id: PageId): string => `/boards/${encodeURIComponent(id)}`;
const basePath = (id: PageId): string => `/bases/${encodeURIComponent(id)}`;

/** spec/api-bases: a database view file (`meta.kind === "base"`). `error`: its YAML can't be read. */
export interface BaseDocument {
  meta: PageMeta;
  config: BaseConfig;
  error?: string;
}

export interface SaveBaseInput {
  config?: BaseConfig;
  title?: string;
  expectedUpdated?: string;
  force?: boolean;
  writer?: string;
}

export type SaveBaseResult = BaseDocument & { rewrittenPages?: PageId[]; conflictBackup?: string; linksNotRewritten?: PageId[] };

/** spec/api v1.7: a board and its tree metadata (`meta.kind === "whiteboard"`). */
export type BoardResponse = BoardDocument;

export interface SaveBoardInput {
  board?: CanvasBoard;
  /** Renames the file; the response can carry a new `meta.id` (D20). */
  title?: string;
  icon?: string | null;
  tags?: string[];
  /** The `meta.updated` the client last saw; the server answers 409 if the file changed (D22). */
  expectedUpdated?: string;
  /** Force-save after a conflict ("Keep mine"); the disk version is backed up. */
  force?: boolean;
  /** This view's id (#d5e4mawv): see `newWriterId`. */
  writer?: string;
}

/** `POST /api/tags/rename` (#9bx3aznb). */
export interface TagRenameResult {
  renamed: number;
  rewrittenPages: PageId[];
  /** Left alone: changed on disk meanwhile, or the open page with unsaved edits. */
  skippedPages: PageId[];
}

/** `PUT /api/boards/:id`: `rewrittenPages`, `conflictBackup`, `repairBackup` (once). */
export type SaveBoardResult = BoardUpdateResult;

/** v0.8 B2 (spec/api-import): `GET /api/import/:job`. */
export interface NotionImportJob {
  id: string;
  state: "reading" | "planning" | "writing" | "done" | "failed";
  done: number;
  total: number;
  folder?: string;
  report?: NotionImportReport;
  /** Why it failed, in English. */
  error?: string;
  /** `damaged`: a corrupt or cut-short export (#4zzay6mn); `errorFile` names the entry when one can be named. */
  errorCode?: "damaged";
  errorFile?: string;
}

/** Vault-relative path → the API URL that serves it (`/api/files/...`). */
export function fileUrl(path: string): string {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(path)) return path;
  return `/api/files/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * All writes go through one queue. This guarantees ordering between a pending
 * autosave and a rename: the server's link rewrite (D12) must happen *after*
 * any in-flight stale content write, never before it.
 */
let mutationChain: Promise<void> = Promise.resolve();

/**
 * #bbh3n5p7: told when any write's answer names pages whose links were left as they were
 * (`linksNotRewritten`: a rename, a heading rename or a move met a read-only page), so the
 * app says so once, whichever view sent it.
 */
const notRewrittenListeners = new Set<(ids: PageId[]) => void>();
export function onLinksNotRewritten(listener: (ids: PageId[]) => void): () => void {
  notRewrittenListeners.add(listener);
  return () => notRewrittenListeners.delete(listener);
}
function noteNotRewritten(value: unknown): void {
  const ids = typeof value === "object" && value !== null ? (value as { linksNotRewritten?: unknown }).linksNotRewritten : undefined;
  if (!Array.isArray(ids) || ids.length === 0) return;
  for (const listener of notRewrittenListeners) listener(ids.filter((id): id is PageId => typeof id === "string"));
}

function mutate<T>(task: () => Promise<T>): Promise<T> {
  const result = mutationChain.then(task, task).then((value) => {
    noteNotRewritten(value);
    return value;
  });
  mutationChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** The server's linkable-files version last seen on `GET /pages` (#jxww67d9). */
let fileIndexVersion: string | null = null;
const fileIndexListeners = new Set<() => void>();

/**
 * Call `listener` when the vault's linkable files changed outside this tab
 * (another app, a sync tool, a second tab), seen on the page-list poll.
 */
export function onFileIndexChanged(listener: () => void): () => void {
  fileIndexListeners.add(listener);
  return () => fileIndexListeners.delete(listener);
}

function noteFileIndexVersion(version: string): void {
  const before = fileIndexVersion;
  fileIndexVersion = version;
  if (before !== null && before !== version) for (const listener of fileIndexListeners) listener();
}

const attachmentListeners = new Set<(attachment: Attachment) => void>();

/** Call `listener` after each upload or image import (#zawz963a: links that missed may resolve now). */
export function onAttachmentSaved(listener: (attachment: Attachment) => void): () => void {
  attachmentListeners.add(listener);
  return () => attachmentListeners.delete(listener);
}

function attachmentSaved(attachment: Attachment): Attachment {
  for (const listener of attachmentListeners) listener(attachment);
  return attachment;
}

export const api = {
  /** App name, version, vault folder and (v1.9) whether it is the desktop app. */
  health: (): Promise<HealthResponse> => request("/health"),

  listPages: (): Promise<PageMeta[]> => request("/pages"),

  getPage: (id: PageId): Promise<Page> => request(pagePath(id)),

  backlinks: (id: PageId): Promise<Backlink[]> => request(`${pagePath(id)}/backlinks`),

  /** v1.21 (C1, spec/api-mentions): pages mentioning this one as plain text. */
  mentions: (id: PageId): Promise<PageMentions[]> => request(`${pagePath(id)}/mentions`),

  /** Turn mentions of page `id` in `input.source` into links (conditional, D22). */
  linkMentions: (id: PageId, input: LinkMentionsInput): Promise<LinkMentionsResult> =>
    mutate(() => request(`${pagePath(id)}/mentions/link`, { method: "POST", body: JSON.stringify(input) })),

  /**
   * Full-text search (D13): title and body matches, ranked by the server, one
   * page of `limit` (v1.31: the server's default is 50, at most 200).
   */
  search: (query: string, limit?: number): Promise<SearchResult[]> =>
    request(`/search?q=${encodeURIComponent(query)}${limit ? `&limit=${limit}` : ""}`),

  /** D18: files in `vault/attachments/`, sorted by name. */
  listAttachments: (): Promise<Attachment[]> => request("/attachments"),

  /** #3ht5gh6q: every image in the vault, newest first. */
  listImages: (): Promise<VaultImage[]> => request("/files/images"),

  /** v0.8 B2 (spec/api-import): start importing a Notion export zip into `parentId` (null = the vault root). */
  startNotionImport: (file: File, parentId: string | null): Promise<NotionImportJob> => {
    const body = new FormData();
    body.set("file", file);
    if (parentId) body.set("parentId", parentId);
    // #n86gnptg: `Import report.md` is written in the app's language.
    body.set("language", currentLanguage());
    return request("/import/notion", { method: "POST", body });
  },

  /** v0.8 B2: an import's progress and, when done, its report. */
  notionImport: (job: string): Promise<NotionImportJob> => request(`/import/${encodeURIComponent(job)}`),

  /** #4usgpjh8: every linkable file, with the link Obsidian writes for it from note `from`. */
  listLinkableFiles: (from: string): Promise<LinkableFile[]> => request(`/files/linkable?from=${encodeURIComponent(from)}`),

  /** D18: multipart upload; the server dedupes the name and writes the file. */
  uploadAttachment: (file: File): Promise<Attachment> => {
    const body = new FormData();
    body.set("file", file);
    return request<Attachment>("/attachments", { method: "POST", body }).then(attachmentSaved);
  },

  /** #w6i6e6u7: the server downloads a remote image into attachments/. */
  importAttachment: (url: string): Promise<Attachment> =>
    request<Attachment>("/attachments/import", { method: "POST", body: JSON.stringify({ url }) }).then(attachmentSaved),

  /** spec/auto-update: the desktop app's updates (404 in the browser and in development). */
  desktopUpdates: (): Promise<DesktopUpdatesState> => request("/desktop/updates"),
  checkDesktopUpdates: (): Promise<DesktopUpdatesState> => request("/desktop/updates/check", { method: "POST", body: "{}" }),
  setDesktopUpdatesMode: (mode: UpdateMode): Promise<DesktopUpdatesState> =>
    request("/desktop/updates/settings", { method: "PUT", body: JSON.stringify({ mode }) }),
  /** "Restart now": the app quits through its normal path (save flush), installs, starts again. */
  restartForUpdate: (): Promise<{ ok: true }> => request("/desktop/updates/restart", { method: "POST", body: "{}" }),

  /** A3 (spec/api-mcp-settings): Settings → MCP. */
  mcpSettings: (): Promise<McpSettingsResponse> => request("/mcp/settings"),
  setMcpSettings: (patch: McpSettingsPatch): Promise<McpSettingsResponse> =>
    request("/mcp/settings", { method: "PUT", body: JSON.stringify(patch) }),

  /** v0.7 C: the templates folder and its pages. */
  listTemplates: (): Promise<{ folder: string; templates: PageMeta[] }> => request("/templates"),

  /** v0.7 C: a template's body with its variables filled (inserted at the caret). */
  renderTemplate: (template: PageId, title: string): Promise<{ content: string }> =>
    request(`/templates/render?template=${encodeURIComponent(template)}&title=${encodeURIComponent(title)}`),

  /** v0.7 C: fill an empty page from a template (body + missing properties). */
  applyTemplate: (id: PageId, template: PageId): Promise<Page> =>
    mutate(() => request(`${pagePath(id)}/template`, { method: "POST", body: JSON.stringify({ template }) })),

  /** v0.7 C: Obsidian's daily-note settings (or Gumply's). */
  dailySettings: (): Promise<DailyNoteSettings> => request("/daily/settings"),

  /** v0.7 C: open or make the note for `date` (YYYY-MM-DD, local). */
  dailyNote: (date: string): Promise<{ page: PageMeta; created: boolean }> =>
    mutate(() => request("/daily", { method: "POST", body: JSON.stringify({ date }) })),

  createPage: (input: CreatePageInput): Promise<Page> =>
    mutate(() => request("/pages", { method: "POST", body: JSON.stringify(input) })),

  updatePage: (id: PageId, patch: UpdatePageInput): Promise<UpdatePageResult> =>
    mutate(() =>
      request(pagePath(id), { method: "PUT", body: JSON.stringify(patch) }),
    ),

  /** Save on the way out (reload, close): keepalive; null when too big. */
  updatePageOnExit: (id: PageId, patch: UpdatePageInput): Promise<UpdatePageResult> | null =>
    exitPut(pagePath(id), patch),

  /** v1.12 (D34): every property key in the vault, with its type and use count. */
  listProperties: (): Promise<PropertyInfo[]> => request("/properties"),

  /** v1.12: change a key's type vault-wide (types.json; files keep their values). */
  /** `ifAbsent` (#7prbquxu): only when the types file has no entry for the key yet (a database column's type). */
  setPropertyType: (key: string, type: PropertyType, options: { ifAbsent?: boolean } = {}): Promise<PropertyInfo[]> =>
    mutate(() =>
      request(`/properties/${encodeURIComponent(key)}`, { method: "PUT", body: JSON.stringify({ type, ...(options.ifAbsent ? { ifAbsent: true } : {}) }) }),
    ),

  deletePage: (id: PageId): Promise<DeletePageResult> =>
    mutate(async () => {
      const result = await request<{ trashId?: string; deleted?: PageId[] } | undefined>(
        pagePath(id),
        { method: "DELETE" },
      );
      if (!result) return { trashId: null, deleted: [id] };
      return { trashId: result.trashId ?? null, deleted: result.deleted ?? [id] };
    }),

  /**
   * Restore a page (and its sub-pages) from the trash. v1.9: where it was, or
   * at the top level when its folder page is gone; a taken name gets ` 2`.
   */
  restoreTrash: (trashId: string): Promise<RestoreResult> =>
    mutate(() => request(`/trash/${encodeURIComponent(trashId)}/restore`, { method: "POST" })),

  /** v1.9 (#ppag3ugh): everything in the trash, newest first. */
  listTrash: (): Promise<TrashItem[]> => request("/trash"),

  /** v1.9: a trashed page or board (or one of its sub-pages), read-only. */
  getTrashed: (trashId: string, id?: PageId): Promise<TrashedDocument> =>
    request(`/trash/${encodeURIComponent(trashId)}${id ? `?id=${encodeURIComponent(id)}` : ""}`),

  /** v1.9: delete one trash entry for good. */
  deleteTrashed: (trashId: string): Promise<unknown> =>
    mutate(() => request(`/trash/${encodeURIComponent(trashId)}`, { method: "DELETE" })),

  /** v1.9: empty the trash; resolves to how many entries were deleted. */
  emptyTrash: (): Promise<{ deleted: number }> => mutate(() => request("/trash", { method: "DELETE" })),


  /** #9bx3aznb: every tag with its occurrences and pages (the tags pane). */
  listTags: (): Promise<TagCount[]> => request("/tags"),

  /** #9bx3aznb: rename a tag in every page and board (`from`/`to` without `#`). */
  renameTag: (from: string, to: string, skip: PageId[] = []): Promise<TagRenameResult> =>
    mutate(() => request("/tags/rename", { method: "POST", body: JSON.stringify({ from, to, skip }) })),

  movePage: (id: PageId, parentId: PageId | null): Promise<Page> =>
    mutate(() =>
      request(`${pagePath(id)}/move`, {
        method: "POST",
        body: JSON.stringify({ parentId }),
      }),
    ),

  /** spec/whiteboard §2: load a board. */
  getBoard: (id: PageId): Promise<BoardResponse> => request(boardPath(id)),

  /** spec/whiteboard §2: save a board (409 on conflict, like pages). */
  saveBoard: (id: PageId, input: SaveBoardInput): Promise<SaveBoardResult> =>
    mutate(() => request(boardPath(id), { method: "PUT", body: JSON.stringify(input) })),

  /** Save a board on the way out: keepalive; null when too big. */
  saveBoardOnExit: (id: PageId, input: SaveBoardInput): Promise<SaveBoardResult> | null =>
    exitPut(boardPath(id), input),

  createBoard: (input: { title: string; parentId?: PageId | null; icon?: string }): Promise<BoardResponse> =>
    mutate(() => request("/boards", { method: "POST", body: JSON.stringify(input) })),

  /**
   * spec/api v1.12 (#qw4pcm2h): set frontmatter properties of one page,
   * conditionally. Used by database views (cells, kanban, calendar). A null
   * value is written as a bare `key:`, as Obsidian does; the key stays.
   */
  /** #7prbquxu phase 2: a block pasted into an owned database: existing rows set, new rows made, all or nothing. */
  pasteRows: (
    baseId: PageId,
    rows: Array<{ id?: PageId; title?: string; set: Record<string, string | number | boolean | string[] | null> }>,
    options: { expectedUpdated: string; writer: string },
  ): Promise<{ changed: PageId[]; created: PageId[]; refused: Array<{ id: PageId; title: string }>; stuck: Array<{ id: PageId; title: string }> }> =>
    mutate(() => request(`${basePath(baseId)}/rows-paste`, { method: "POST", body: JSON.stringify({ rows, ...options }) })),

  /**
   * #7prbquxu: rename or delete a property in every row of an owned database, on the server in one
   * job (a rename is all or nothing). `clash` / `skipped` name the rows that stopped it.
   */
  changeOwnedRowsProperty: (
    baseId: PageId,
    change: { rename: { from: string; to: string } } | { remove: string },
    options: { expectedUpdated: string; writer: string },
  ): Promise<{
    changed: PageId[];
    skipped: Array<{ id: PageId; title: string }>;
    clash: Array<{ id: PageId; title: string }>;
    stuck: Array<{ id: PageId; title: string }>;
    /** The base changed on disk after the rows: a rename was put back, a delete kept the column. */
    baseRefused?: boolean;
    /** The base as it is now: the view takes its config and version. */
    base: BaseDocument;
  }> =>
    mutate(() => request(`${basePath(baseId)}/rows-property`, { method: "POST", body: JSON.stringify({ ...change, ...options }) })),

  setPageProperties: (
    id: PageId,
    values: Record<string, string | number | boolean | string[] | null>,
    expectedUpdated: string,
  ): Promise<UpdatePageResult> =>
    mutate(() =>
      request(pagePath(id), {
        method: "PUT",
        body: JSON.stringify({ properties: { set: values }, expectedUpdated }),
      }),
    ),

  /**
   * #8k4ssrkb: what an Obsidian-style file link typed after load resolves to,
   * from the note holding it (null: no such file).
   */
  resolveFileLink: async (link: string, from: PageId): Promise<string | null> => {
    const params = new URLSearchParams({ link, from });
    return (await request<{ path: string | null }>(`/files/resolve?${params.toString()}`)).path;
  },

  /** spec/api-bases: a database view's config. */
  getBase: (id: PageId): Promise<BaseDocument> => request(basePath(id)),

  /** spec/api-bases: run one view (`name`; default the first) on the server, `this` = the embedding page. */
  runBaseView: (id: PageId, options: { name?: string; thisId?: PageId | null } = {}): Promise<BaseViewResult> => {
    const params = new URLSearchParams();
    if (options.name) params.set("name", options.name);
    if (options.thisId) params.set("this", options.thisId);
    const query = params.toString();
    return request(`${basePath(id)}/view${query ? `?${query}` : ""}`);
  },

  /** spec/api-bases: save a config (only what changed is written) and/or rename. 409 like pages. */
  saveBase: (id: PageId, input: SaveBaseInput): Promise<SaveBaseResult> =>
    mutate(() => request(basePath(id), { method: "PUT", body: JSON.stringify(input) })),

  /** #wrr9fjn9: save a view change on the way out (reload, close): keepalive; null when too big. */
  saveBaseOnExit: (id: PageId, input: SaveBaseInput): Promise<SaveBaseResult> | null => exitPut(basePath(id), input),

  createBase: (input: {
    title: string;
    parentId?: PageId | null;
    source?: { folder?: PageId | null; tag?: string };
    /** #7prbquxu: a database with its own rows folder (spec/database-tables §1). */
    rows?: boolean;
  }): Promise<BaseDocument> => mutate(() => request("/bases", { method: "POST", body: JSON.stringify(input) })),

  /** Graph payload (spec/api v1.2); `center`/`depth` produce a local graph. */
  getGraph: (options: { center?: PageId; depth?: number; attachments?: boolean } = {}): Promise<GraphData> => {
    const params = new URLSearchParams();
    if (options.center !== undefined) params.set("center", options.center);
    if (options.depth !== undefined) params.set("depth", String(options.depth));
    if (options.attachments) params.set("include", "attachments");
    // v1.32 (#g95wkd9y): links as index pairs (a tenth of the bytes on a big vault).
    params.set("links", "index");
    return request<IndexedGraphData>(`/graph?${params.toString()}`).then(expandGraphLinks);
  },

  /** E1 (spec/api-graph-groups, v1.19): the graph's colour groups and filters. */
  getGraphSettings: (): Promise<GraphSettingsResponse> => request("/graph/settings"),

  putGraphSettings: (settings: GraphSettings): Promise<GraphSettingsResponse> =>
    mutate(() => request("/graph/settings", { method: "PUT", body: JSON.stringify(settings) })),

  // --- sync conflict copies (spec/api v1.29, spec/sync-conflicts, D43) ---

  conflicts: (): Promise<ConflictsList> => request("/conflicts"),

  conflictDiff: (copyId: PageId): Promise<ConflictDiff> => request(`/conflicts/${encodeURIComponent(copyId)}/diff`),

  /** Keep page / copy / both, Delete copy, Keep as original; 409 when either file changed since Compare. */
  resolveConflict: (copyId: PageId, input: ConflictResolveInput): Promise<ConflictResolveResult> =>
    mutate(() => request(`/conflicts/${encodeURIComponent(copyId)}/resolve`, { method: "POST", body: JSON.stringify(input) })),

  /** Undo of Keep both / Keep as original: back to the conflict-copy name. */
  conflictRenameBack: (currentId: PageId, to: PageId): Promise<PageMeta> =>
    mutate(() => request(`/conflicts/${encodeURIComponent(currentId)}/rename-back`, { method: "POST", body: JSON.stringify({ to }) })),

  /** "Not a copy" for a possible copy, or undo it. */
  dismissPossibleCopy: (copyId: PageId, dismissed: boolean): Promise<{ dismissed: boolean }> =>
    mutate(() => request(`/conflicts/${encodeURIComponent(copyId)}/dismiss`, { method: dismissed ? "POST" : "DELETE" })),

  // --- version history (spec/api v1.28, spec/api-version-history) ---

  /** A page's or board's versions, newest first. */
  history: (id: PageId): Promise<HistoryList> => request(historyPath(id)),

  /** A version's exact text. */
  historyText: async (id: PageId, file: string): Promise<string> => {
    const response = await apiFetch(`/api${historyPath(id)}/${encodeURIComponent(file)}`);
    if (!response.ok) throw new ApiRequestError(response.status, response.statusText || `HTTP ${response.status}`);
    return response.text();
  },

  historyDiff: (id: PageId, file: string): Promise<HistoryDiff> =>
    request(`${historyPath(id)}/${encodeURIComponent(file)}/diff`),

  /** Restore a version into the current file (byte-exact, never renames); 409 when the page changed. */
  /** `why` (spec/api v1.34): "undo-keep-copy" when this restore undoes a conflict's Keep copy. */
  restoreVersion: (id: PageId, file: string, expectedUpdated: string, why?: "undo-keep-copy"): Promise<Page | BoardDocument | BaseDocument> =>
    mutate(() =>
      request(`${historyPath(id)}/${encodeURIComponent(file)}/restore`, { method: "POST", body: JSON.stringify({ expectedUpdated, ...(why ? { why } : {}) }) }),
    ),

  /**
   * spec/api v1.34 (#chbpc9yb): keep text about to be dropped (a save conflict's
   * Reload) as a "Before reload" version. Never writes the page file.
   */
  keepUnsaved: (id: PageId, input: { content: string } | { board: unknown }): Promise<{ file: string; at: string } | { saved: false }> =>
    mutate(() => request(`${historyPath(id)}/unsaved`, { method: "POST", body: JSON.stringify(input) })),

  pinVersion: (id: PageId, file: string, pinned: boolean): Promise<HistoryItem> =>
    mutate(() => request(`${historyPath(id)}/${encodeURIComponent(file)}/pin`, { method: "PUT", body: JSON.stringify({ pinned }) })),

  /** The page was closed: its editing session ends now (D41). Fire and forget. */
  historyCheckpoint: (id: PageId): Promise<{ saved: boolean }> =>
    mutate(() => request(`${historyPath(id)}/checkpoint`, { method: "POST" })),

  historyOrphans: (): Promise<HistoryOrphan[]> => request("/history-orphans"),

  restoreOrphan: (key: string): Promise<Page | BoardDocument> =>
    mutate(() => request(`/history-orphans/${encodeURIComponent(key)}/restore`, { method: "POST", body: JSON.stringify({}) })),

  historyUsage: (): Promise<HistoryUsage> => request("/history-usage"),

  /** "Clear history older than…": every unpinned version older than `days` (never a page's newest). */
  clearHistory: (days: number): Promise<HistoryUsage> =>
    mutate(() => request(`/history-usage?olderThan=${encodeURIComponent(String(days))}`, { method: "DELETE" })),
};

const historyPath = (id: PageId): string => `/history/${encodeURIComponent(id)}`;

export type HistorySource = "app" | "external" | "mcp" | "import" | "restore";
export type HistoryReason = "edit" | "session" | "rename" | "move" | "trash" | "before-restore" | "conflict" | "before-reload";

/** One version in `GET /history/:id` (spec/api-version-history). */
export interface HistoryItem {
  file: string;
  at: string;
  source: HistorySource;
  reason?: HistoryReason;
  client?: string;
  tool?: string;
  bytes: number;
  sha256: string;
  /** The page's version these bytes had (an MCP audit row's `before`). */
  version: string;
  pinned: boolean;
  restoredFrom?: string;
  /** spec/api v1.34: this restore was an Undo of "Keep copy". */
  undid?: "keep-copy";
  /** The title then, when it differs from now. */
  title?: string;
  /** The folder then ("" = top level), when it differs. */
  folder?: string;
}

export interface HistoryList {
  items: HistoryItem[];
  nextCursor?: string;
  current: { version: string; sha256: string | null };
  moves: Array<{ event: "rename" | "move" | "recreated"; from: string; id: string; at: string }>;
}

export type HistoryDiff =
  | { kind: "page"; lines: Array<{ op: "same" | "add" | "remove"; text: string }> }
  | { kind: "whiteboard"; added: string[]; removed: string[]; changed: string[] };

export interface HistoryOrphan {
  key: string;
  lastId: PageId;
  title: string;
  lastAt: string;
  versions: number;
  newest: string;
}

export interface HistoryUsage {
  bytes: number;
  pages: number;
  versions: number;
}
