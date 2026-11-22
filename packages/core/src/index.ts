/** Public API of `@gumply/core`. */

export const APP_NAME = "Gumply";
export const CORE_VERSION = "0.7.1";

export type {
  ApiError,
  Attachment,
  VaultImage,
  LinkableFile,
  Backlink,
  BoardDocument,
  BoardUpdateResult,
  DeletePageResult,
  Embed,
  EmbedKind,
  GraphData,
  TagCount,
  GraphNode,
  HealthResponse,
  LinkEdge,
  Page,
  PageId,
  PageKind,
  PageMeta,
  PageUpdateResult,
  RestoreResult,
  SearchResult,
  TrashedDocument,
  TrashedPage,
  TrashItem,
  LinkMentionsInput,
  LinkMentionsResult,
  PageMentions,
} from "./types.js";

export {
  childPageId,
  isValidPageId,
  pageFilePath,
  pageSegment,
  parentOf,
  pathToPageId,
  slugify,
  legacySlugTitle,
  titleFromId,
  uniqueId,
} from "./ids.js";

export {
  canonicalYaml,
  editFrontmatterYaml,
  frontmatterKeys,
  parseNoteTemplate,
  YAML_EMPTY,
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
  formatBoardEmbed,
  formatPageEmbed,
  isBaseTarget,
  isBoardTarget,
  hasAttachmentExtension,
  makeSnippet,
  maskCode,
  resolveWikilink,
  rewriteWikilinkFolder,
  rewriteWikilinkTargets,
  type RewriteResult,
  type WikiLink,
} from "./links.js";

export { parseEmbeds } from "./embeds.js";
export { linkSnippet, markdownLinks, plainText, type MarkdownLink } from "./plain-text.js";
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
export {
  embeddedMarkdown,
  headingKey,
  newBlockId,
  pageBlock,
  pageBlockIds,
  pageHeadings,
  pageSection,
  parseEmbedPart,
  type EmbedPart,
  type OutlineBlock,
  type OutlineHeading,
} from "./page-embeds.js";
export * from "./bases/index.js";

export {
  findInlineTags,
  isTagLike,
  isValidTagName,
  renamedTag,
  renameInlineTag,
  renameTagList,
  tagMatches,
  type InlineTag,
  type TagRewrite,
} from "./tags.js";

export {
  coercePropertyValue,
  convertPropertyValue,
  HEADER_KEYS,
  inferPropertyType,
  isPropertyType,
  isValidPropertyKey,
  PROPERTY_TYPES,
  propertyValueMatches,
  type PropertiesPatch,
  type Property,
  type PropertyInfo,
  type PropertyType,
  type PropertyValue,
} from "./properties.js";

export {
  DEFAULT_DAILY_SETTINGS,
  DEFAULT_TEMPLATE_SETTINGS,
  dailyNoteDay,
  dailyNoteId,
  dateFromDay,
  formatMomentDate,
  parseMomentDate,
  renderTemplate,
  type DailyNoteSettings,
  type TemplateContext,
  type TemplateSettings,
} from "./templates.js";
export { LinkFileIndex, isLinkableFile, obsidianFileLinks, resolveLinkedFile, shortestLinkText } from "./link-files.js";
export { linkSourceFolder, pickLinkTarget, preferredLinkPath } from "./link-order.js";
export { isWikilinkInner, WIKILINK_INNER, WIKILINK_PART, WIKILINK_TARGET, WIKILINK_UNESCAPED } from "./wikilink-syntax.js";
export { graphItemPath, matchesGraphQuery, parseGraphQuery, type GraphQuery, type GraphQueryItem, type GraphQueryOp, type GraphQueryTerm } from "./graph-query.js";
export {
  DEFAULT_GRAPH_FILTERS,
  DEFAULT_GRAPH_SETTINGS,
  fromObsidianGraph,
  MAX_GRAPH_GROUPS,
  MAX_GRAPH_QUERY,
  normalizeGraphSettings,
  obsidianColor,
  type GraphFilters,
  type GraphGroup,
  type GraphSettings,
  type GraphSettingsResponse,
  type GraphSettingsSource,
} from "./graph-settings.js";
export {
  DEFAULT_MCP_SETTINGS,
  isMcpAccess,
  MCP_ACCESS_LEVELS,
  MCP_AUDIT_PATH,
  MCP_SETTINGS_PATH,
  parseMcpAuditLog,
  parseMcpSettings,
  serializeMcpSettings,
  type McpAccess,
  type McpAuditEntry,
  type McpLaunchCommand,
  type McpSettings,
  type McpSettingsPatch,
  type McpSettingsResponse,
} from "./mcp-settings.js";

export {
  NOTION_IMPORT_LIMITS,
  formatImportLimit,
  notionReportMarkdown,
  notionUrlId,
  planNotionImport,
  stripNotionId,
  type NotionEntry,
  type NotionImportOptions,
  type NotionImportPlan,
  type NotionImportReport,
  type NotionPlannedDatabase,
  type NotionPlannedFile,
} from "./notion-import.js";
export { headingRenames, rewriteHeadingLinks, rewriteHeadingSubpath, type HeadingRename } from "./heading-rename.js";
export { findMentions, linkMentions, mentionableText, mentionLink, mentionSnippet, mentionTerms, mentionWords, type MentionMatch } from "./mentions.js";

export {
  coverValue,
  PAGE_COLORS,
  PAGE_GRADIENTS,
  PAGE_LOOK_KEYS,
  pageLook,
  parseCover,
  type PageColor,
  type PageCover,
  type PageGradient,
  type PageLook,
} from "./page-look.js";
