/**
 * Board model → React Flow elements.
 *
 * The board (`CanvasBoard`) is the document; React Flow nodes are a view of
 * it that also carries view state (selection, measured size, a node being
 * dragged). `syncNodes` rebuilds the view after every document change and
 * reuses the previous element object whenever its canvas node is unchanged,
 * so React Flow only re-renders what actually changed (500+ nodes stay fast).
 */
import { canvasNodeKind, type CanvasBoard, type CanvasEdge, type CanvasNode, type CanvasNodeKind } from "@gumply/core";
import type { Edge, Node } from "@xyflow/react";
import { closestSides } from "./model.js";

export interface BoardNodeData extends Record<string, unknown> {
  node: CanvasNode;
  kind: CanvasNodeKind;
  editing: boolean;
  /** The only selected node: shows resize handles (a group selection doesn't). */
  resizable: boolean;
}

export interface BoardEdgeData extends Record<string, unknown> {
  edge: CanvasEdge;
  editing: boolean;
  /** The edges' z-index (see {@link boardLayers}); their labels use it too. */
  layer: number;
}

export type BoardFlowNode = Node<BoardNodeData>;
export type BoardFlowEdge = Edge<BoardEdgeData>;

/** React Flow node type per kind (several kinds share a component). */
export function flowNodeType(kind: CanvasNodeKind): string {
  switch (kind) {
    case "sticky":
    case "text":
    case "shape":
    case "ink":
      return kind;
    case "group":
      return "frame";
    default:
      return "card";
  }
}

function buildNode(node: CanvasNode, z: number, editing: boolean, selected: boolean, resizable: boolean): BoardFlowNode {
  const kind = canvasNodeKind(node);
  const flowNode: BoardFlowNode = {
    id: node.id,
    type: flowNodeType(kind),
    position: { x: node.x, y: node.y },
    width: node.width,
    height: node.height,
    // Frames at the back, then edges, then the other nodes in array order (as Obsidian draws them); see boardLayers.
    zIndex: z,
    data: { node, kind, editing, resizable },
    draggable: !editing,
    className: `board-node board-node-${kind}`,
  };
  if (selected) flowNode.selected = true;
  return flowNode;
}

/**
 * The React Flow nodes for `board`, reusing `previous` elements whose canvas
 * node, z-index and editing flag are unchanged.
 */
export function syncNodes(
  previous: readonly BoardFlowNode[],
  board: CanvasBoard,
  editingId: string | null,
  selected: ReadonlySet<string>,
): BoardFlowNode[] {
  const byId = new Map(previous.map((node) => [node.id, node]));
  const layers = boardLayers(board).nodes;
  return board.nodes.map((node) => {
    const old = byId.get(node.id);
    const z = layers.get(node.id) ?? 0;
    const editing = node.id === editingId;
    const isSelected = selected.has(node.id);
    const resizable = isSelected && selected.size === 1 && !editing;
    // Mid-gesture, React Flow owns the live position/size: keep it.
    if (old && (old.dragging || old.resizing)) {
      return Boolean(old.selected) === isSelected ? old : { ...old, selected: isSelected };
    }
    if (
      old &&
      old.data.node === node &&
      old.zIndex === z &&
      old.data.editing === editing &&
      old.data.resizable === resizable &&
      Boolean(old.selected) === isSelected &&
      !old.dragging &&
      !old.resizing &&
      old.position.x === node.x &&
      old.position.y === node.y &&
      old.width === node.width &&
      old.height === node.height
    ) {
      return old;
    }
    const next = buildNode(node, z, editing, isSelected, resizable);
    if (old?.measured) next.measured = old.measured;
    return next;
  });
}

/**
 * Layers (#sdwrzdgx), as Obsidian 1.14 draws a canvas (measured in a sealed Obsidian): frames (groups) always at
 * the back, a larger one behind a smaller one; then every edge and edge label; then the other nodes in array order.
 * So arrows show over a frame's fill and pass under every card, and a card listed before its frame still shows.
 */
export interface BoardLayers {
  /** Each node's z-index. */
  nodes: Map<string, number>;
  /** The z-index every edge (and its label) is drawn on. */
  edges: number;
}

export function boardLayers(board: CanvasBoard): BoardLayers {
  const frames = board.nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => node.type === "group")
    .sort((a, b) => b.node.width * b.node.height - a.node.width * a.node.height || a.index - b.index);
  const nodes = new Map<string, number>();
  frames.forEach(({ node }, rank) => nodes.set(node.id, rank));
  const edges = frames.length;
  board.nodes.forEach((node, index) => {
    if (node.type !== "group") nodes.set(node.id, edges + 1 + index);
  });
  return { nodes, edges };
}

function edgeSides(edge: CanvasEdge, nodes: ReadonlyMap<string, CanvasNode>): [string, string] {
  if (edge.fromSide && edge.toSide) return [edge.fromSide, edge.toSide];
  const from = nodes.get(edge.fromNode);
  const to = nodes.get(edge.toNode);
  const [fromAuto, toAuto] = from && to ? closestSides(from, to) : (["right", "left"] as const);
  return [edge.fromSide ?? fromAuto, edge.toSide ?? toAuto];
}

export function syncEdges(
  previous: readonly BoardFlowEdge[],
  board: CanvasBoard,
  editingId: string | null,
  selected: ReadonlySet<string>,
): BoardFlowEdge[] {
  const byId = new Map(previous.map((edge) => [edge.id, edge]));
  const nodes = new Map(board.nodes.map((node) => [node.id, node]));
  const layer = boardLayers(board).edges;
  return board.edges.map((edge) => {
    const old = byId.get(edge.id);
    const editing = edge.id === editingId;
    const [sourceHandle, targetHandle] = edgeSides(edge, nodes);
    // Auto-sided edges depend on their nodes' positions, so they're rebuilt.
    const autoSided = !edge.fromSide || !edge.toSide;
    const isSelected = selected.has(edge.id);
    if (
      old &&
      old.data?.edge === edge &&
      old.data.editing === editing &&
      old.data.layer === layer &&
      Boolean(old.selected) === isSelected &&
      !autoSided
    ) {
      return old;
    }
    const flowEdge: BoardFlowEdge = {
      id: edge.id,
      type: "board",
      source: edge.fromNode,
      target: edge.toNode,
      sourceHandle,
      targetHandle,
      zIndex: layer,
      data: { edge, editing, layer },
    };
    if (isSelected) flowEdge.selected = true;
    return flowEdge;
  });
}
