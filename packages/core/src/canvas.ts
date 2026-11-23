/**
 * Whiteboards as JSON Canvas 1.0 files (`.canvas`, D25, spec/whiteboard §1).
 *
 * The model stays a plain JSON object so nothing is lost on a round trip:
 * unknown keys (top level, nodes, edges), node order and colour notation are
 * kept exactly as read. Gumply-only data lives in extra `gumply` keys on the
 * standard node types, so Obsidian opens every board.
 *
 * `serializeCanvas` reproduces Obsidian's own writer byte for byte: an object
 * or array whose values are all primitives is written on one line, anything
 * else is broken into tab-indented lines, and there is no trailing newline.
 * A board saved by Obsidian therefore re-serialises unchanged, and diffs stay
 * small whichever app saved last.
 */
import { extractWikilinks, hasAttachmentExtension, type WikiLink } from "./links.js";

/** `"1"`–`"6"` (Obsidian's preset palette) or a hex colour like `"#ff8800"`. */
export type CanvasColor = string;
export type CanvasSide = "top" | "right" | "bottom" | "left";
export type CanvasEnd = "none" | "arrow";

/** The six JSON Canvas preset colours: red, orange, yellow, green, cyan, purple. */
export const CANVAS_PRESET_COLORS = ["1", "2", "3", "4", "5", "6"] as const;
export type CanvasPresetColor = (typeof CANVAS_PRESET_COLORS)[number];

export type GumplyShape = "rect" | "rounded" | "ellipse" | "diamond";
export const GUMPLY_SHAPES: readonly GumplyShape[] = ["rect", "rounded", "ellipse", "diamond"];

/** One ink sample: `[x, y, pressure]`, relative to the node's x/y. */
export type InkPoint = [number, number, number];

/** Gumply extras on a text node. Unknown keys are kept as they are. */
export type GumplyNodeData =
  /** Gumply's Text tool (#jchhjepb): plain, boxless text; an unmarked text node is an Obsidian card. */
  | { kind: "text"; [key: string]: unknown }
  | { kind: "sticky"; [key: string]: unknown }
  | { kind: "shape"; shape: GumplyShape; [key: string]: unknown }
  | { kind: "ink"; points: InkPoint[]; width: number; [key: string]: unknown };

interface CanvasNodeBase {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: CanvasColor;
  /** Unknown keys (from Obsidian plugins, newer spec versions…) are kept. */
  [key: string]: unknown;
}

export interface CanvasTextNode extends CanvasNodeBase {
  type: "text";
  text: string;
  gumply?: GumplyNodeData;
}

export interface CanvasFileNode extends CanvasNodeBase {
  type: "file";
  /** Vault-root path, e.g. `Projects/Q1 plan.md` or `attachments/pic.png`. */
  file: string;
  subpath?: string;
}

export interface CanvasLinkNode extends CanvasNodeBase {
  type: "link";
  url: string;
}

export interface CanvasGroupNode extends CanvasNodeBase {
  type: "group";
  label?: string;
  background?: string;
  backgroundStyle?: "cover" | "ratio" | "repeat";
}

/**
 * A board node. Nodes of a type this version doesn't know are kept on a
 * round trip too; at runtime their `type` is some other string, so switch on
 * {@link canvasNodeKind} (which returns `"unknown"` for them) rather than
 * assuming the four standard types are exhaustive.
 */
export type CanvasNode = CanvasTextNode | CanvasFileNode | CanvasLinkNode | CanvasGroupNode;

export interface CanvasEdge {
  id: string;
  fromNode: string;
  fromSide?: CanvasSide;
  fromEnd?: CanvasEnd;
  toNode: string;
  toSide?: CanvasSide;
  toEnd?: CanvasEnd;
  color?: CanvasColor;
  label?: string;
  [key: string]: unknown;
}

/** Board-level Gumply data: the title is the file name, so only icon and tags. */
export interface GumplyBoardData {
  icon?: string;
  tags?: string[];
  [key: string]: unknown;
}

export interface CanvasBoard {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  gumply?: GumplyBoardData;
  [key: string]: unknown;
}

export class CanvasParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanvasParseError";
  }
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A fresh, empty board (optionally with an icon/tags). */
export function emptyCanvas(meta?: GumplyBoardData): CanvasBoard {
  return meta ? { nodes: [], edges: [], gumply: { ...meta } } : { nodes: [], edges: [] };
}

/**
 * Parse a `.canvas` file. An empty file is an empty board (Obsidian creates
 * them that way). Invalid JSON, or JSON that isn't an object, throws a
 * {@link CanvasParseError}.
 *
 * Entries that can't be drawn are dropped: nodes without a string `id`/`type`,
 * duplicate node ids (the first wins), and edges whose ends don't exist.
 * Non-numeric positions/sizes fall back to Obsidian's defaults (0, 0, 100×100),
 * keeping the key in place. Everything else is kept as read.
 */
export function parseCanvas(source: string): CanvasBoard {
  if (source.trim().length === 0) return emptyCanvas();

  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch (error) {
    throw new CanvasParseError(`Not a valid canvas file: ${(error as Error).message}`);
  }
  if (!isObject(data)) throw new CanvasParseError("Not a valid canvas file: the top level must be an object");

  const rawNodes = data.nodes === undefined ? [] : data.nodes;
  const rawEdges = data.edges === undefined ? [] : data.edges;
  if (!Array.isArray(rawNodes)) throw new CanvasParseError("Not a valid canvas file: `nodes` must be an array");
  if (!Array.isArray(rawEdges)) throw new CanvasParseError("Not a valid canvas file: `edges` must be an array");

  const ids = new Set<string>();
  const nodes: CanvasNode[] = [];
  for (const raw of rawNodes) {
    if (!isObject(raw) || typeof raw.id !== "string" || typeof raw.type !== "string") continue;
    if (ids.has(raw.id)) continue;
    ids.add(raw.id);
    nodes.push(normaliseGeometry(raw) as CanvasNode);
  }

  const edges: CanvasEdge[] = [];
  const edgeIds = new Set<string>();
  for (const raw of rawEdges) {
    if (!isObject(raw) || typeof raw.id !== "string") continue;
    if (typeof raw.fromNode !== "string" || typeof raw.toNode !== "string") continue;
    if (!ids.has(raw.fromNode) || !ids.has(raw.toNode) || edgeIds.has(raw.id)) continue;
    edgeIds.add(raw.id);
    edges.push(raw as CanvasEdge);
  }

  // Rebuild in the file's key order; `nodes`/`edges` are added when missing.
  const board: JsonObject = {};
  for (const key of Object.keys(data)) {
    board[key] = key === "nodes" ? nodes : key === "edges" ? edges : data[key];
  }
  if (!("nodes" in board)) board.nodes = nodes;
  if (!("edges" in board)) board.edges = edges;
  return board as CanvasBoard;
}

const GEOMETRY_DEFAULTS: Record<string, number> = { x: 0, y: 0, width: 100, height: 100 };

function normaliseGeometry(node: JsonObject): JsonObject {
  let result = node;
  for (const [key, fallback] of Object.entries(GEOMETRY_DEFAULTS)) {
    const value = result[key];
    if (typeof value === "number" && Number.isFinite(value)) continue;
    if (result === node) result = { ...node };
    result[key] = fallback;
  }
  return result;
}

/**
 * Write a board in Obsidian's exact `.canvas` format (see the module comment).
 * `undefined` values are skipped, like `JSON.stringify` does.
 */
export function serializeCanvas(board: CanvasBoard): string {
  return writeJson(board).join("\n");
}

function isPrimitive(value: unknown): boolean {
  return typeof value !== "object";
}

/** A port of Obsidian's canvas writer. Returns the value's lines. */
function writeJson(value: unknown): string[] {
  if (value === undefined) return ["null"];
  if (isPrimitive(value) || !value) return [JSON.stringify(value) ?? "null"];

  if (Array.isArray(value)) {
    if (value.every(isPrimitive)) return [JSON.stringify(value)];
    const lines = ["["];
    value.forEach((item, index) => {
      const inner = writeJson(item);
      inner.forEach((line, at) => {
        const comma = at === inner.length - 1 && index !== value.length - 1 ? "," : "";
        lines.push(`\t${line}${comma}`);
      });
    });
    lines.push("]");
    return lines;
  }

  const object = value as JsonObject;
  if (Object.values(object).every(isPrimitive)) return [JSON.stringify(object)];
  const keys = Object.keys(object).filter((key) => object[key] !== undefined);
  const lines = ["{"];
  keys.forEach((key, index) => {
    const inner = writeJson(object[key]);
    inner[0] = `${JSON.stringify(key)}:${inner[0]}`;
    inner.forEach((line, at) => {
      const comma = at === inner.length - 1 && index !== keys.length - 1 ? "," : "";
      lines.push(`\t${line}${comma}`);
    });
  });
  lines.push("}");
  return lines;
}

/* ------------------------------------------------------------------------ */
/* Node kinds and Gumply extras                                              */
/* ------------------------------------------------------------------------ */

export type CanvasNodeKind =
  | "text"
  | "sticky"
  | "shape"
  | "ink"
  | "page"
  | "board"
  | "image"
  | "file"
  | "link"
  | "group"
  | "unknown";

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico|heic)$/i;

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

/**
 * The node's validated Gumply extras, or null when it has none or they are
 * malformed (the node is then shown as what its JSON Canvas type says).
 */
export function gumplyNodeData(node: CanvasNode): GumplyNodeData | null {
  if (node.type !== "text" || !isObject(node.gumply)) return null;
  const data = node.gumply;
  switch (data.kind) {
    case "text":
    case "sticky":
      return data as GumplyNodeData;
    case "shape":
      return GUMPLY_SHAPES.includes(data.shape as GumplyShape) ? (data as GumplyNodeData) : null;
    case "ink": {
      if (typeof data.width !== "number" || !Number.isFinite(data.width) || !Array.isArray(data.points)) return null;
      const ok = data.points.every((point) => isNumberArray(point) && point.length >= 2 && point.length <= 3);
      return ok ? (data as GumplyNodeData) : null;
    }
    default:
      return null;
  }
}

/**
 * A board Gumply has written to: its own metadata, or Gumply data on any
 * node (#jchhjepb, D39). On a board that isn't, an unmarked `text` node is
 * drawn as Obsidian draws it (a card); on one that is, it stays the boxless
 * text Gumply's Text tool made before nodes were marked.
 */
export function isGumplyBoard(board: CanvasBoard): boolean {
  if (board.gumply !== undefined) return true;
  return board.nodes.some((node) => node.gumply !== undefined);
}

/** What a node is, from a user's point of view. */
export function canvasNodeKind(node: CanvasNode): CanvasNodeKind {
  switch (node.type) {
    case "text":
      return gumplyNodeData(node)?.kind ?? "text";
    case "file": {
      const file = typeof node.file === "string" ? node.file : "";
      if (/\.md$/i.test(file)) return "page";
      if (/\.canvas$/i.test(file)) return "board";
      return IMAGE_EXTENSION.test(file) ? "image" : "file";
    }
    case "link":
      return "link";
    case "group":
      return "group";
    default:
      return "unknown";
  }
}

/** True for `"1"`–`"6"`. */
export function isPresetColor(color: unknown): color is CanvasPresetColor {
  return typeof color === "string" && (CANVAS_PRESET_COLORS as readonly string[]).includes(color);
}

/** The board's icon and tags, normalised (`icon` null when unset). */
export function canvasMeta(board: CanvasBoard): { icon: string | null; tags: string[] } {
  const data = isObject(board.gumply) ? board.gumply : {};
  const icon = typeof data.icon === "string" && data.icon.trim().length > 0 ? data.icon : null;
  const tags = Array.isArray(data.tags) ? data.tags.filter((tag): tag is string => typeof tag === "string") : [];
  return { icon, tags };
}

/**
 * A copy of the board with icon and/or tags changed (`icon: null` removes it).
 * Other `gumply` keys and the board's key order are kept.
 */
export function withCanvasMeta(
  board: CanvasBoard,
  patch: { icon?: string | null; tags?: string[] },
): CanvasBoard {
  const data: GumplyBoardData = isObject(board.gumply) ? { ...board.gumply } : {};
  if (patch.icon !== undefined) {
    if (patch.icon === null || patch.icon.trim().length === 0) delete data.icon;
    else data.icon = patch.icon;
  }
  if (patch.tags !== undefined) data.tags = [...patch.tags];
  const next: CanvasBoard = { ...board };
  if (Object.keys(data).length === 0) delete next.gumply;
  else next.gumply = data;
  return next;
}

/** A new node/edge id in Obsidian's style: 16 lowercase hex characters. */
export function canvasId(): string {
  const bytes = new Uint8Array(8);
  const crypto = (globalThis as { crypto?: { getRandomValues(array: Uint8Array): Uint8Array } }).crypto;
  if (crypto) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Bounding box of the given nodes (all by default), or null when there are none. */
export function canvasBounds(
  nodes: readonly CanvasNode[],
): { x: number; y: number; width: number; height: number } | null {
  if (nodes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + node.width);
    maxY = Math.max(maxY, node.y + node.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/* ------------------------------------------------------------------------ */
/* Links, attachments, rename rewrite and search text                        */
/* ------------------------------------------------------------------------ */

export type CanvasLink =
  /** A page or board card: a file node pointing at a `.md` or `.canvas` file. */
  | { kind: "file"; nodeId: string; path: string; subpath?: string }
  /** A `[[link]]` inside a text node (sticky, shape or plain text). */
  | { kind: "wikilink"; nodeId: string; link: WikiLink };

function isNoteFile(path: string): boolean {
  return /\.(md|canvas)$/i.test(path);
}

/**
 * Everything on the board that links to a page or board, in node order:
 * page/board cards first-class (file nodes), then `[[links]]` in text nodes.
 * Code spans/blocks and `![[embeds]]` are ignored, as in pages.
 */
export function canvasLinks(board: CanvasBoard): CanvasLink[] {
  const links: CanvasLink[] = [];
  for (const node of board.nodes) {
    if (node.type === "file" && typeof node.file === "string" && isNoteFile(node.file)) {
      const link: CanvasLink = { kind: "file", nodeId: node.id, path: node.file };
      if (typeof node.subpath === "string" && node.subpath.length > 0) link.subpath = node.subpath;
      links.push(link);
    } else if (node.type === "text" && typeof node.text === "string") {
      for (const link of extractWikilinks(node.text)) links.push({ kind: "wikilink", nodeId: node.id, link });
    }
  }
  return links;
}

/** Vault paths of the attachment files on the board (images, PDFs…), deduplicated. */
export function canvasAttachments(board: CanvasBoard): string[] {
  const seen = new Set<string>();
  for (const node of board.nodes) {
    if (node.type !== "file" || typeof node.file !== "string") continue;
    if (isNoteFile(node.file) || !hasAttachmentExtension(node.file)) continue;
    seen.add(node.file);
  }
  return [...seen];
}

export interface CanvasRewrite {
  /** New path for a file node's `file`, or null/undefined to leave it. */
  file?: (path: string, node: CanvasFileNode) => string | null | undefined;
  /** New Markdown for a text node's `text` (e.g. `rewriteLinksToPage`). */
  text?: (markdown: string, node: CanvasTextNode) => string;
  /** New `subpath` (`#Heading`) for a file node that has one, or null/undefined to leave it (C2). */
  subpath?: (subpath: string, node: CanvasFileNode) => string | null | undefined;
}

/**
 * The D12/D20 rename writer for boards: rewrite file-node paths and text-node
 * Markdown. Returns the same board object when nothing changed; otherwise a
 * copy in which only the changed nodes are new (key order kept).
 */
export function rewriteCanvas(board: CanvasBoard, rewrite: CanvasRewrite): { board: CanvasBoard; count: number } {
  let count = 0;
  const nodes = board.nodes.map((node): CanvasNode => {
    if (node.type === "file" && typeof node.file === "string" && (rewrite.file || rewrite.subpath)) {
      const file = rewrite.file?.(node.file, node);
      const subpath =
        rewrite.subpath && typeof node.subpath === "string" && node.subpath.length > 0
          ? rewrite.subpath(node.subpath, node)
          : null;
      const fileChanged = Boolean(file) && file !== node.file;
      const subpathChanged = Boolean(subpath) && subpath !== node.subpath;
      if (fileChanged || subpathChanged) {
        count += 1;
        return { ...node, ...(fileChanged ? { file: file! } : {}), ...(subpathChanged ? { subpath: subpath! } : {}) };
      }
    } else if (node.type === "text" && rewrite.text && typeof node.text === "string") {
      const next = rewrite.text(node.text, node);
      if (next !== node.text) {
        count += 1;
        return { ...node, text: next };
      }
    }
    return node;
  });
  return count === 0 ? { board, count } : { board: { ...board, nodes }, count };
}

/**
 * Searchable plain text of a board: text-node Markdown, frame labels and web
 * link URLs in node order, then connector labels, separated by blank lines. Ink and file
 * paths are left out.
 */
export function canvasText(board: CanvasBoard): string {
  const parts: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value === "string" && value.trim().length > 0) parts.push(value.trim());
  };
  for (const node of board.nodes) {
    if (node.type === "text") add(node.text);
    else if (node.type === "group") add(node.label);
    else if (node.type === "link") add(node.url);
  }
  for (const edge of board.edges) add(edge.label);
  return parts.join("\n\n");
}
