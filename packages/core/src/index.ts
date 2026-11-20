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
  formatWikilink,
  linkTargetFor,
  pageBasename,
  rewriteLinksToPage,
  type LinkTarget,
} from "./link-target.js";
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
  type RelinkOptions,
} from "./attachment-paths.js";
export {
  CANVAS_PRESET_COLORS,
  CanvasParseError,
  GUMPLY_SHAPES,
  canvasAttachments,
  canvasBounds,
  canvasId,
  canvasLinks,
  canvasMeta,
  canvasNodeKind,
  canvasText,
  emptyCanvas,
  gumplyNodeData,
  isPresetColor,
  parseCanvas,
  rewriteCanvas,
  serializeCanvas,
  withCanvasMeta,
  type CanvasBoard,
  type CanvasColor,
  type CanvasEdge,
  type CanvasEnd,
  type CanvasFileNode,
  type CanvasGroupNode,
  type CanvasLink,
  type CanvasLinkNode,
  type CanvasNode,
  type CanvasNodeKind,
  type CanvasPresetColor,
  type CanvasRewrite,
  type CanvasSide,
  type CanvasTextNode,
  type GumplyBoardData,
  type GumplyNodeData,
  type GumplyShape,
  type InkPoint,
} from "./canvas.js";
