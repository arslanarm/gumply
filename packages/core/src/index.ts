/** Public API of `@gumply/core`. */

export const APP_NAME = "Gumply";
export const CORE_VERSION = "0.1.0";

export type {
  ApiError,
  Attachment,
  Backlink,
  DeletePageResult,
  Embed,
  EmbedKind,
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
  pageSegment,
  parentOf,
  pathToPageId,
  slugify,
  titleFromId,
  uniqueId,
} from "./ids.js";

export {
  canonicalYaml,
  editFrontmatterYaml,
  parseNoteTemplate,
  serializeNoteLike,
  type NoteTemplate,
} from "./note-template.js";

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
  hasAttachmentExtension,
  makeSnippet,
  maskCode,
  resolveWikilink,
  rewriteWikilinkTargets,
  type RewriteResult,
  type WikiLink,
} from "./links.js";

export { parseEmbeds } from "./embeds.js";
export {
  ATTACHMENTS_DIR,
  attachmentHref,
  encodeHref,
  isAttachmentPath,
  looksLikeAttachmentHref,
  normaliseVaultPath,
  noteFolder,
  relinkAttachments,
  resolveAttachmentHref,
} from "./attachment-paths.js";
