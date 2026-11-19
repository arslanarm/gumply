/** Public API of `@gumply/core`. */

export const APP_NAME = "Gumply";
export const CORE_VERSION = "0.1.0";

export type {
  ApiError,
  Backlink,
  DeletePageResult,
  GraphData,
  GraphNode,
  HealthResponse,
  LinkEdge,
  Page,
  PageId,
  PageMeta,
  PageUpdateResult,
  SearchResult,
} from "./types.js";

export {
  childPageId,
  isValidPageId,
  pageFilePath,
  parentOf,
  pathToPageId,
  slugify,
  titleFromId,
  uniqueId,
} from "./ids.js";

export {
  normalizeTags,
  parseFrontmatter,
  serializeFrontmatter,
  serializeNote,
  type Frontmatter,
  type ParsedNote,
} from "./frontmatter.js";

export {
  collectLinkEdges,
  extractPageLinks,
  extractTags,
  extractWikilinks,
  makeSnippet,
  maskCode,
  resolveWikilink,
  rewriteWikilinkTargets,
  type RewriteResult,
  type WikiLink,
} from "./links.js";
