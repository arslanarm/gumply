/**
 * Shared data model for Gumply. This file mirrors the contract in the team
 * wiki page `spec/api` and is imported by both the server and the web app.
 */

/**
 * Vault-relative path without `.md`, e.g. `"projects/gumply"`. Whiteboards
 * (D25) keep their extension: `"projects/Map.canvas"` (spec/api v1.7).
 */
export type PageId = string;

/**
 * D25: a tree item is a Markdown page or a JSON Canvas whiteboard; D33: or a
 * plain folder; D34 (spec/api-bases): or an Obsidian Bases database view.
 */
export type PageKind = "page" | "whiteboard" | "folder" | "base";

/** Metadata stored in a note's YAML frontmatter (plus derived fields). */
export interface PageMeta {
  id: PageId;
  /** v1.7: always sent by the server; absent means "page" (older fixtures). */
  kind?: PageKind;
  /** Frontmatter `title`, else a readable form of the file name. */
  title: string;
  /** Single emoji, if set. */
  icon?: string;
  tags: string[];
  /** Folder page that contains this page, if any. */
  parentId: PageId | null;
  /** Direct sub-pages (used for delete confirm and tree chevrons). */
  childCount: number;
  /** ISO 8601 timestamps (D33 folders: the Unix epoch; they have no file). */
  created: string;
  updated: string;
  /**
   * D33 folders only: files inside (any depth) that aren't pages or boards,
   * such as PDFs and images. They go to the trash with the folder.
   */
  otherFiles?: number;
  /**
   * v1.29 (spec/sync-conflicts, D43): this file is a sync tool's conflict copy
   * of the page with this id, or `null` when that original is gone (an orphan
   * copy). Absent on everything else. Copies with an original are left out of
   * the tree, graph, backlinks, tags, mentions and bases.
   */
  conflictOf?: PageId | null;
  /** v1.29: on an original, how many conflict copies sit beside it. */
  conflicts?: number;
}

/** Full page: metadata plus the Markdown body (without frontmatter). */
export interface Page extends PageMeta {
  /**
   * #8k4ssrkb (spec/api-attachments-resolve): each Obsidian-style file link
   * in the body, as written before `|` (`photo.png`, `att/pic.png`), mapped to
   * the vault file it resolves to from this page, or null. Absent when the
   * page has none.
   */
  fileLinks?: Record<string, string | null>;
  content: string;
  /** v1.12 (D34): the frontmatter's properties (without title, icon, created, updated). */
  properties?: import("./properties.js").Property[];
}

/** Response of `PUT /api/pages/:id`; `rewrittenPages` is set on a rename. */
export type PageUpdateResult = Page & {
  rewrittenPages?: PageId[];
  /** v1.35 (#xgnvipyd): a rename's link rewrite failed to write these pages (logged); they still link the old name. */
  linksNotRewritten?: PageId[];
  /** Vault-relative backup path when "Keep mine" replaced an external edit. */
  conflictBackup?: string;
};

/** `GET /api/boards/:id` (v1.7, D25): the tree item plus its JSON Canvas. */
export interface BoardDocument {
  meta: PageMeta;
  board: import("./canvas.js").CanvasBoard;
  /** #8k4ssrkb: Obsidian-style file links in the board's text, resolved from the board. */
  fileLinks?: Record<string, string | null>;
}

/** `PUT /api/boards/:id` response. */
export type BoardUpdateResult = BoardDocument & {
  /** Pages/boards whose links were rewritten by a rename (D12). */
  rewrittenPages?: PageId[];
  /** v1.35 (#xgnvipyd): pages a rename couldn't rewrite (a write error, logged); they still link the old name. */
  linksNotRewritten?: PageId[];
  /** Backup of the version "Keep mine" replaced (D22). */
  conflictBackup?: string;
  /**
   * The file had entries the editor can't keep (duplicate node ids, edges to
   * missing nodes); the original was copied here before this first save.
   */
  repairBackup?: string;
};

/** A page or board inside a trash entry (spec/api v1.9, #ppag3ugh). */
export interface TrashedPage {
  /** Where it was in the vault (its id before the delete). */
  id: PageId;
  /** v1.10 (D33): a deleted plain folder is a trash entry of kind "folder". */
  kind: PageKind | "folder";
  title: string;
  icon?: string;
  /** Its parent inside the same entry, or null for the entry's top page. */
  parentId: PageId | null;
}

/** `GET /api/trash`: one delete (a page or board plus its sub-pages). */
export interface TrashItem extends TrashedPage {
  trashId: string;
  /** ISO time of the delete. */
  deletedAt: string;
  /** The folder page it was in (its id when deleted), or null at the top level. */
  originalParentId: PageId | null;
  /** That folder page's current title, or null when it no longer exists. */
  originalParentTitle: string | null;
  /** Sub-pages deleted with it, parents before children. */
  children: TrashedPage[];
  /** Folders only: files in it that aren't pages or boards (PDFs, images…). */
  otherFiles?: number;
}

/** `GET /api/trash/:trashId[?id=]`: a trashed page or board, read-only. */
export interface TrashedDocument {
  item: TrashItem;
  /** The page shown (the entry's top page, or one of its sub-pages); null for a folder. */
  page: Page | null;
  /** Boards only: the board's JSON Canvas. */
  board?: import("./canvas.js").CanvasBoard;
}

/** `POST /api/trash/:trashId/restore` (v1.9). */
export interface RestoreResult {
  /** Every restored page and board, with their ids now. */
  restored: PageMeta[];
  /** The entry's top page, where it is now. */
  id: PageId;
  /** Its folder page was gone, so it went to the top level. */
  movedToTopLevel: boolean;
  /** Its name was taken, so it got a ` 2` suffix (D20). */
  renamed: boolean;
}

/** Response of `DELETE /api/pages/:id` (D11: files move to `.trash/`). */
export interface DeletePageResult {
  trashId: string;
  /** The deleted page and all of its sub-pages. */
  deleted: PageId[];
}

/**
 * A parsed `[[wikilink]]`.
 * `target` is `null` when no page matches `targetTitle` (an unresolved link).
 */
export interface LinkEdge {
  source: PageId;
  target: PageId | null;
  targetTitle: string;
  /**
   * #rpugpydh: the link is only in the page's frontmatter (`related: "[[X]]"`),
   * not its body. Additive; only snippets read it (never the graph payload).
   */
  via?: "property";
}

/** One node of the graph view. */
export interface GraphNode extends PageMeta {
  /** Number of links pointing at or from this page. */
  linkCount: number;
}

/** Payload of `GET /api/graph`. */
/**
 * `GET /api/tags` (#9bx3aznb): one entry per tag as written (nested tags are
 * their own entries), counted like Obsidian's tags pane.
 */
export interface TagCount {
  /** Without `#`, in the first spelling met (pages in id order). */
  tag: string;
  /** Occurrences: every inline `#tag` (repeats too) plus each frontmatter entry. */
  count: number;
  /** Pages and boards that have it. */
  pages: PageId[];
}

export interface GraphData {
  nodes: GraphNode[];
  links: Array<{ source: PageId; target: PageId }>;
  tags: string[];
  /**
   * Links pointing at pages that do not exist (v1.2, ghost nodes). One pair
   * per source page and missing title (case-insensitive); the UI groups them
   * into one ghost node per title.
   */
  unresolved: Array<{ source: PageId; targetTitle: string }>;
  /**
   * v1.19 (`?include=attachments`, spec/api-graph-groups): each page's link to
   * an attachment file it embeds or links (`![[pic.png]]`), resolved like
   * Obsidian. Absent unless asked for.
   */
  attachments?: Array<{ source: PageId; path: string }>;
}

/** Payload item of `GET /api/pages/:id/backlinks`. */
export interface Backlink {
  page: PageMeta;
  snippet: string;
}

/** Payload item of `GET /api/search`. */
export interface SearchResult {
  page: PageMeta;
  snippet: string;
  score: number;
}

/** Payload of `GET /api/health`. */
export interface HealthResponse {
  ok: boolean;
  name: string;
  version: string;
  vaultPath: string;
  /** Running inside the desktop app (v1.9): native-only actions are offered. */
  desktop?: boolean;
  /**
   * Desktop only (G2): a random per-launch token. A page handed to main for
   * printing is downloaded as `<Title>.<token>.gumply-print.html`; main takes
   * no other name for its print path.
   */
  printToken?: string;
}

/** #3ht5gh6q: `GET /api/files/images`, an image anywhere in the vault. */
export interface VaultImage {
  /** Vault path, e.g. `att/photo.png`. */
  path: string;
  /** File name, e.g. `photo.png`. */
  name: string;
  /** Last modified, ISO. */
  modified: string;
}

/** #4usgpjh8: `GET /api/files/linkable?from=`, any linkable file in the vault. */
export interface LinkableFile extends VaultImage {
  /** The link text Obsidian writes for it from the note (`pic.png`, or the full path). */
  link: string;
}

/** A file stored under `vault/attachments/` (D18). */
export interface Attachment {
  /** Vault-relative path, e.g. `attachments/photo.png`. */
  path: string;
  /** File name inside `attachments/`, e.g. `photo.png`. */
  name: string;
  /** Size in bytes. */
  size: number;
  /** MIME type, e.g. `image/png`. */
  mime: string;
}

export type EmbedKind = "image" | "file";

/** One image/file reference found in Markdown (D19). */
export interface Embed {
  kind: EmbedKind;
  /** Vault-relative path; Obsidian names get `attachments/` prefixed. */
  path: string;
  /** File name (last path segment). */
  name: string;
  /** Alt text / link text as written (empty when absent). */
  alt: string;
  /** Original matched Markdown. */
  raw: string;
  /** Index of `raw` in the source Markdown. */
  index: number;
  /** How the reference was written. */
  syntax: "markdown" | "obsidian";
}

/** Error body used for 400/404/409 responses. */
export interface ApiError {
  error: string;
}

/** v1.21 (C1, spec/api-mentions): `GET /pages/:id/mentions`, one entry per mentioning page. */
export interface PageMentions {
  page: PageMeta;
  /** The source's version: pass it back as `expectedUpdated` to link. */
  updated: string;
  mentions: Array<{
    /** Offset into the source's body (frontmatter excluded): the `positions` to link. */
    index: number;
    length: number;
    /** As written. */
    text: string;
    /** The title or alias matched. */
    term: string;
    /** Plain text around it; `start`/`end` mark the mention in `text`. */
    snippet: { text: string; start: number; end: number };
  }>;
}

/** `POST /pages/:id/mentions/link` body. */
export interface LinkMentionsInput {
  source: PageId;
  expectedUpdated?: string;
  positions?: number[];
  all?: boolean;
}

export interface LinkMentionsResult {
  linked: number;
  rewrittenPages: PageId[];
}

// --- v1.29: sync conflict copies (spec/sync-conflicts, D43) -----------------

/** A sync tool's conflict copy of a page, board or base. */
export interface ConflictCopy {
  copyId: PageId;
  /** The original's id, or null when it's gone (an orphan copy). */
  originalId: PageId | null;
  tool: "syncthing" | "nextcloud" | "obsidian" | "dropbox";
  /** Device or user as the tool wrote it. */
  device?: string;
  /** The tool's own local time as written in the name (`YYYY-MM-DD[THH:MM[:SS]]`, no zone). */
  at?: string;
  kind: PageKind;
  /** The copy's bytes equal the original's. */
  same: boolean;
  /** Versions for a conditional resolve. */
  copyUpdated: string;
  originalUpdated?: string;
}

/** An attachment's conflict copy: listed only, resolved by hand (D43). */
export interface ConflictAttachment {
  path: string;
  originalPath: string | null;
  tool: ConflictCopy["tool"];
  device?: string;
  at?: string;
}

/** A name that might be an iCloud / Google Drive / OneDrive copy, with mostly the same content. */
export interface PossibleCopy {
  copyId: PageId;
  originalId: PageId;
  /** Shared lines (or board card ids), 0–1. */
  similarity: number;
}

export interface ConflictsList {
  copies: ConflictCopy[];
  attachments: ConflictAttachment[];
  possible: PossibleCopy[];
}

export type ConflictKeep = "page" | "copy" | "both" | "delete" | "as-original";

export interface ConflictResolveInput {
  keep: ConflictKeep;
  /** The versions Compare showed; a changed file is a 409. */
  expected: { page?: string; copy: string };
}

export interface ConflictResolveResult {
  keep: ConflictKeep;
  /** The page or board kept, as it is now. */
  page?: PageMeta;
  /** The Trash entry the losing side went to (Undo: restore it). */
  trashId?: string;
  /** Keep copy: the history file holding the page's bytes before (Undo: restore it). */
  beforeVersion?: string;
  /** Keep both / as-original: the copy's new id. */
  renamedTo?: PageId;
}

export type ConflictDiff =
  | { kind: "text"; lines: Array<{ op: "same" | "add" | "remove"; text: string }> }
  | { kind: "board"; added: string[]; removed: string[]; changed: string[] };
