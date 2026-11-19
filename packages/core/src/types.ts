/**
 * Shared data model for Gumply. This file mirrors the contract in the team
 * wiki page `spec/api` and is imported by both the server and the web app.
 */

/** Vault-relative path without `.md`, e.g. `"projects/gumply"`. */
export type PageId = string;

/** Metadata stored in a note's YAML frontmatter (plus derived fields). */
export interface PageMeta {
  id: PageId;
  /** Frontmatter `title`, else a readable form of the file name. */
  title: string;
  /** Single emoji, if set. */
  icon?: string;
  tags: string[];
  /** Folder page that contains this page, if any. */
  parentId: PageId | null;
  /** Direct sub-pages (used for delete confirm and tree chevrons). */
  childCount: number;
  /** ISO 8601 timestamps. */
  created: string;
  updated: string;
}

/** Full page: metadata plus the Markdown body (without frontmatter). */
export interface Page extends PageMeta {
  content: string;
}

/** Response of `PUT /api/pages/:id`; `rewrittenPages` is set on a rename. */
export type PageUpdateResult = Page & { rewrittenPages?: PageId[] };

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

/** Error body used for 400/404/409 responses. */
export interface ApiError {
  error: string;
}
