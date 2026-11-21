/**
 * Shared data model for Gumply. This file mirrors the contract in the team
 * wiki page `spec/api` and is imported by both the server and the web app.
 */

/**
 * Vault-relative path without `.md`, e.g. `"projects/gumply"`. Whiteboards
 * (D25) keep their extension: `"projects/Map.canvas"` (spec/api v1.7).
 */
export type PageId = string;

/** D25: a tree item is a Markdown page or a JSON Canvas whiteboard; D33: or a plain folder. */
export type PageKind = "page" | "whiteboard" | "folder";

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
}

/** Full page: metadata plus the Markdown body (without frontmatter). */
export interface Page extends PageMeta {
  content: string;
}

/** Response of `PUT /api/pages/:id`; `rewrittenPages` is set on a rename. */
export type PageUpdateResult = Page & {
  rewrittenPages?: PageId[];
  /** Vault-relative backup path when "Keep mine" replaced an external edit. */
  conflictBackup?: string;
};

/** `GET /api/boards/:id` (v1.7, D25): the tree item plus its JSON Canvas. */
export interface BoardDocument {
  meta: PageMeta;
  board: import("./canvas.js").CanvasBoard;
}

/** `PUT /api/boards/:id` response. */
export type BoardUpdateResult = BoardDocument & {
  /** Pages/boards whose links were rewritten by a rename (D12). */
  rewrittenPages?: PageId[];
  /** Backup of the version "Keep mine" replaced (D22). */
  conflictBackup?: string;
  /**
   * The file had entries the editor can't keep (duplicate node ids, edges to
   * missing nodes); the original was copied here before this first save.
   */
  repairBackup?: string;
};

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
}

/** One node of the graph view. */
export interface GraphNode extends PageMeta {
  /** Number of links pointing at or from this page. */
  linkCount: number;
}

/** Payload of `GET /api/graph`. */
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
