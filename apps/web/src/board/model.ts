/**
 * Pure board operations (spec/whiteboard §3). Every function returns a new
 * board and never mutates its input, so undo/redo can keep plain snapshots.
 *
 * Key order matters for small diffs with Obsidian (wiki
 * `whiteboard/canvas-format-notes`): Obsidian writes every non-geometry key
 * first (id, type, text…, gumply), then x, y, width, height, then color, and
 * a group's label last. New nodes are created in that order and updates keep
 * existing keys in place.
 * Geometry is always whole numbers, as Obsidian rounds it on load.
 */
import {
  canvasId,
  type CanvasBoard,
  type CanvasEdge,
  type CanvasNode,
  type CanvasSide,
  type GumplyShape,
  type InkPoint,
} from "@gumply/core";

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const round = (value: number): number => Math.round(value);

/* ------------------------------------------------------------------------ */
/* Factories                                                                 */
/* ------------------------------------------------------------------------ */

export const STICKY_SIZE = 200;
export const DEFAULT_STICKY_COLOR = "3";

/**
 * Order a new node's keys the way Obsidian writes them (checked against real
 * Obsidian): id, type, content keys and `gumply`, then geometry, then color,
 * then `tail` (a group's label comes last).
 */
function orderedNode(head: Record<string, unknown>, rect: Rect, color?: string, tail: Record<string, unknown> = {}): CanvasNode {
  const node: Record<string, unknown> = { ...head };
  node.x = round(rect.x);
  node.y = round(rect.y);
  node.width = Math.max(1, round(rect.width));
  node.height = Math.max(1, round(rect.height));
  if (color) node.color = color;
  Object.assign(node, tail);
  return node as CanvasNode;
}

export function createSticky(rect: Rect, color: string = DEFAULT_STICKY_COLOR, text = ""): CanvasNode {
  return orderedNode({ id: canvasId(), type: "text", text, gumply: { kind: "sticky" } }, rect, color);
}

export function createText(rect: Rect, text = ""): CanvasNode {
  return orderedNode({ id: canvasId(), type: "text", text }, rect);
}

export function createShape(rect: Rect, shape: GumplyShape, color?: string, text = ""): CanvasNode {
  return orderedNode({ id: canvasId(), type: "text", text, gumply: { kind: "shape", shape } }, rect, color);
}

export function createFrame(rect: Rect, label = "Frame", color?: string): CanvasNode {
  return orderedNode({ id: canvasId(), type: "group" }, rect, color, { label });
}

export function createFileNode(rect: Rect, file: string): CanvasNode {
  return orderedNode({ id: canvasId(), type: "file", file }, rect);
}

export function createLinkNode(rect: Rect, url: string): CanvasNode {
  return orderedNode({ id: canvasId(), type: "link", url }, rect);
}

/** Padding around an ink stroke so its round caps aren't clipped. */
export function inkPadding(width: number): number {
  return Math.ceil(width / 2) + 2;
}

/**
 * An ink node from absolute flow-space samples. The node's box is the stroke's
 * bounds (plus padding); points are stored relative to the node's x/y.
 */
export function createInk(samples: readonly InkPoint[], width: number, color?: string): CanvasNode | null {
  if (samples.length === 0) return null;
  const pad = inkPadding(width);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of samples) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const x = Math.floor(minX - pad);
  const y = Math.floor(minY - pad);
  const points: InkPoint[] = samples.map(([px, py, pressure]) => [
    roundTo(px - x, 1),
    roundTo(py - y, 1),
    roundTo(pressure, 2),
  ]);
  const rect = { x, y, width: Math.ceil(maxX + pad) - x, height: Math.ceil(maxY + pad) - y };
  return orderedNode({ id: canvasId(), type: "text", text: "", gumply: { kind: "ink", points, width } }, rect, color);
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function createEdge(
  fromNode: string,
  fromSide: CanvasSide | undefined,
  toNode: string,
  toSide: CanvasSide | undefined,
): CanvasEdge {
  // Obsidian's order: id, fromNode, fromSide, toNode, toSide. The default
  // ends (no arrow at the start, an arrow at the end) are left implicit.
  const ordered: Record<string, unknown> = { id: canvasId(), fromNode };
  if (fromSide) ordered.fromSide = fromSide;
  ordered.toNode = toNode;
  if (toSide) ordered.toSide = toSide;
  return ordered as CanvasEdge;
}

/* ------------------------------------------------------------------------ */
/* Updates                                                                   */
/* ------------------------------------------------------------------------ */

/** Merge `patch` into a node, keeping key order; `undefined` removes a key. */
export function patchObject<T extends Record<string, unknown>>(target: T, patch: Record<string, unknown>): T {
  let changed = false;
  const next: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      if (key in next) {
        delete next[key];
        changed = true;
      }
    } else if (next[key] !== value) {
      next[key] = value;
      changed = true;
    }
  }
  return changed ? (next as T) : target;
}

/** Apply per-node patches. Returns the same board when nothing changed. */
export function updateNodes(board: CanvasBoard, patches: ReadonlyMap<string, Record<string, unknown>>): CanvasBoard {
  if (patches.size === 0) return board;
  let changed = false;
  const nodes = board.nodes.map((node) => {
    const patch = patches.get(node.id);
    if (!patch) return node;
    const next = patchObject(node, roundGeometry(patch));
    if (next !== node) changed = true;
    return next;
  });
  return changed ? { ...board, nodes } : board;
}

export function updateNode(board: CanvasBoard, id: string, patch: Record<string, unknown>): CanvasBoard {
  return updateNodes(board, new Map([[id, patch]]));
}

function roundGeometry(patch: Record<string, unknown>): Record<string, unknown> {
  const result = { ...patch };
  for (const key of ["x", "y", "width", "height"]) {
    const value = result[key];
    if (typeof value === "number") result[key] = key === "width" || key === "height" ? Math.max(1, round(value)) : round(value);
  }
  return result;
}

export function updateEdge(board: CanvasBoard, id: string, patch: Record<string, unknown>): CanvasBoard {
  let changed = false;
  const edges = board.edges.map((edge) => {
    if (edge.id !== id) return edge;
    const next = patchObject(edge, patch);
    if (next !== edge) changed = true;
    return next;
  });
  return changed ? { ...board, edges } : board;
}

/** Move nodes to absolute positions (after a drag). */
export function moveNodes(board: CanvasBoard, positions: ReadonlyMap<string, Point>): CanvasBoard {
  const patches = new Map<string, Record<string, unknown>>();
  for (const [id, point] of positions) patches.set(id, { x: point.x, y: point.y });
  return updateNodes(board, patches);
}

/** Nudge nodes by a delta (arrow keys). */
export function nudgeNodes(board: CanvasBoard, ids: ReadonlySet<string>, dx: number, dy: number): CanvasBoard {
  const patches = new Map<string, Record<string, unknown>>();
  for (const node of board.nodes) {
    if (ids.has(node.id)) patches.set(node.id, { x: node.x + dx, y: node.y + dy });
  }
  return updateNodes(board, patches);
}

/* ------------------------------------------------------------------------ */
/* Add / delete / order                                                      */
/* ------------------------------------------------------------------------ */

/** Add nodes on top (or behind everything, used for frames). */
export function addNodes(board: CanvasBoard, nodes: readonly CanvasNode[], where: "front" | "back" = "front"): CanvasBoard {
  if (nodes.length === 0) return board;
  return { ...board, nodes: where === "front" ? [...board.nodes, ...nodes] : [...nodes, ...board.nodes] };
}

/**
 * Add a frame just below the lowest node it contains, so it never covers
 * its own contents yet stays above unrelated nodes behind it.
 */
export function addFrame(board: CanvasBoard, frame: CanvasNode): CanvasBoard {
  const inside = new Set(nodesInside(board, frame).map((node) => node.id));
  const index = board.nodes.findIndex((node) => inside.has(node.id));
  if (index === -1) return addNodes(board, [frame], "front");
  const nodes = [...board.nodes];
  nodes.splice(index, 0, frame);
  return { ...board, nodes };
}

export function addEdges(board: CanvasBoard, edges: readonly CanvasEdge[]): CanvasBoard {
  if (edges.length === 0) return board;
  const ids = new Set(board.nodes.map((node) => node.id));
  const valid = edges.filter((edge) => ids.has(edge.fromNode) && ids.has(edge.toNode));
  return valid.length === 0 ? board : { ...board, edges: [...board.edges, ...valid] };
}

/** Delete nodes and edges; edges attached to deleted nodes go too. */
export function deleteElements(
  board: CanvasBoard,
  nodeIds: ReadonlySet<string>,
  edgeIds: ReadonlySet<string> = new Set(),
): CanvasBoard {
  if (nodeIds.size === 0 && edgeIds.size === 0) return board;
  const nodes = board.nodes.filter((node) => !nodeIds.has(node.id));
  const edges = board.edges.filter(
    (edge) => !edgeIds.has(edge.id) && !nodeIds.has(edge.fromNode) && !nodeIds.has(edge.toNode),
  );
  if (nodes.length === board.nodes.length && edges.length === board.edges.length) return board;
  return { ...board, nodes, edges };
}

/** Bring to front / send to back, keeping the moved nodes' relative order. */
export function reorderNodes(board: CanvasBoard, ids: ReadonlySet<string>, where: "front" | "back"): CanvasBoard {
  const moved = board.nodes.filter((node) => ids.has(node.id));
  if (moved.length === 0) return board;
  const rest = board.nodes.filter((node) => !ids.has(node.id));
  const nodes = where === "front" ? [...rest, ...moved] : [...moved, ...rest];
  if (nodes.every((node, index) => node === board.nodes[index])) return board;
  return { ...board, nodes };
}

/* ------------------------------------------------------------------------ */
/* Frames                                                                    */
/* ------------------------------------------------------------------------ */

function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/** Nodes lying fully inside a frame's box (nested frames and their contents included). */
export function nodesInside(board: CanvasBoard, frame: Rect & { id?: string }): CanvasNode[] {
  return board.nodes.filter((node) => node.id !== frame.id && contains(frame, node));
}

/**
 * The ids that move along when `ids` are dragged: every selected frame drags
 * the nodes inside it. The dragged ids themselves are not included.
 */
export function frameFollowers(board: CanvasBoard, ids: ReadonlySet<string>): Set<string> {
  const followers = new Set<string>();
  for (const node of board.nodes) {
    if (!ids.has(node.id) || node.type !== "group") continue;
    for (const inner of nodesInside(board, node)) if (!ids.has(inner.id)) followers.add(inner.id);
  }
  return followers;
}

/* ------------------------------------------------------------------------ */
/* Duplicate, copy and paste                                                 */
/* ------------------------------------------------------------------------ */

export const CLIPBOARD_MIME = "application/x-gumply-board";
const CLIPBOARD_MARKER = "gumply-board-clipboard";

export interface BoardClipboard {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

/** The selected nodes plus the edges between them. */
export function copySelection(board: CanvasBoard, ids: ReadonlySet<string>): BoardClipboard {
  const nodes = board.nodes.filter((node) => ids.has(node.id));
  const edges = board.edges.filter((edge) => ids.has(edge.fromNode) && ids.has(edge.toNode));
  return { nodes, edges };
}

export function clipboardToText(clip: BoardClipboard): string {
  return JSON.stringify({ [CLIPBOARD_MARKER]: 1, nodes: clip.nodes, edges: clip.edges });
}

/** Parse clipboard text written by {@link clipboardToText}; null for anything else. */
export function clipboardFromText(text: string): BoardClipboard | null {
  if (!text.includes(CLIPBOARD_MARKER)) return null;
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    if (data[CLIPBOARD_MARKER] !== 1 || !Array.isArray(data.nodes) || !Array.isArray(data.edges)) return null;
    const nodes = data.nodes.filter(
      (node): node is CanvasNode =>
        typeof node === "object" &&
        node !== null &&
        typeof (node as CanvasNode).id === "string" &&
        typeof (node as CanvasNode).type === "string" &&
        typeof (node as CanvasNode).x === "number" &&
        typeof (node as CanvasNode).y === "number",
    );
    const edges = data.edges.filter(
      (edge): edge is CanvasEdge =>
        typeof edge === "object" &&
        edge !== null &&
        typeof (edge as CanvasEdge).id === "string" &&
        typeof (edge as CanvasEdge).fromNode === "string" &&
        typeof (edge as CanvasEdge).toNode === "string",
    );
    return nodes.length > 0 ? { nodes, edges } : null;
  } catch {
    return null;
  }
}

/**
 * Insert a copy of `clip` with fresh ids, shifted by `offset` (or centred on
 * `at`). Returns the new board and the ids of the inserted nodes.
 */
export function pasteClipboard(
  board: CanvasBoard,
  clip: BoardClipboard,
  placement: { offset: Point } | { at: Point },
): { board: CanvasBoard; nodeIds: string[] } {
  if (clip.nodes.length === 0) return { board, nodeIds: [] };
  let dx: number;
  let dy: number;
  if ("offset" in placement) {
    dx = placement.offset.x;
    dy = placement.offset.y;
  } else {
    const bounds = boundsOf(clip.nodes);
    dx = placement.at.x - (bounds.x + bounds.width / 2);
    dy = placement.at.y - (bounds.y + bounds.height / 2);
  }
  const idMap = new Map<string, string>();
  const nodes = clip.nodes.map((node) => {
    const id = canvasId();
    idMap.set(node.id, id);
    return { ...node, id, x: round(node.x + dx), y: round(node.y + dy) } as CanvasNode;
  });
  const edges: CanvasEdge[] = [];
  for (const edge of clip.edges) {
    const fromNode = idMap.get(edge.fromNode);
    const toNode = idMap.get(edge.toNode);
    if (fromNode && toNode) edges.push({ ...edge, id: canvasId(), fromNode, toNode });
  }
  return { board: addEdges(addNodes(board, nodes), edges), nodeIds: nodes.map((node) => node.id) };
}

export const DUPLICATE_OFFSET = 24;

export function duplicateNodes(board: CanvasBoard, ids: ReadonlySet<string>): { board: CanvasBoard; nodeIds: string[] } {
  return pasteClipboard(board, copySelection(board, ids), { offset: { x: DUPLICATE_OFFSET, y: DUPLICATE_OFFSET } });
}

/* ------------------------------------------------------------------------ */
/* Geometry helpers                                                          */
/* ------------------------------------------------------------------------ */

export function boundsOf(rects: readonly Rect[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const rect of rects) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Normalise a drag rectangle (any direction) to a positive one. */
export function rectFromPoints(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

/** The pair of sides an edge should use when the file doesn't say. */
export function closestSides(from: Rect, to: Rect): [CanvasSide, CanvasSide] {
  const fx = from.x + from.width / 2;
  const fy = from.y + from.height / 2;
  const tx = to.x + to.width / 2;
  const ty = to.y + to.height / 2;
  const dx = tx - fx;
  const dy = ty - fy;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? ["right", "left"] : ["left", "right"];
  return dy >= 0 ? ["bottom", "top"] : ["top", "bottom"];
}

/* ------------------------------------------------------------------------ */
/* Link safety                                                               */
/* ------------------------------------------------------------------------ */

const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/**
 * The URL a link card may open, or null. Boards can come from anywhere (a
 * shared vault, Obsidian), so only web and mail links open; `javascript:`,
 * `data:`, `file:` and anything unparsable never do.
 */
export function safeExternalUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = new URL(trimmed);
    return SAFE_PROTOCOLS.has(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}
