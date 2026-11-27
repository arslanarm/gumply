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
  /** The edges' z-index (see {@link edgeLayer}); their labels use it too. */
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

function buildNode(node: CanvasNode, index: number, editing: boolean, selected: boolean, resizable: boolean): BoardFlowNode {
  const kind = canvasNodeKind(node);
  const flowNode: BoardFlowNode = {
    id: node.id,
    type: flowNodeType(kind),
    position: { x: node.x, y: node.y },
    width: node.width,
    height: node.height,
    // Array order is the z-order (JSON Canvas / Obsidian); see nodeLayer.
    zIndex: nodeLayer(index),
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
  return board.nodes.map((node, index) => {
    const old = byId.get(node.id);
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
      old.zIndex === nodeLayer(index) &&
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
    const next = buildNode(node, index, editing, isSelected, resizable);
    if (old?.measured) next.measured = old.measured;
    return next;
  });
}

/**
 * Layers (#sdwrzdgx): nodes sit on even z-indexes in array order, and every
 * edge one above the last frame (group), so arrows between objects inside a
 * frame are drawn over its fill, as Obsidian does, and still under the cards.
 * Without frames, edges stay under every node.
 */
export function nodeLayer(index: number): number {
  return index * 2;
}

export function edgeLayer(board: CanvasBoard): number {
  let last = -1;
  board.nodes.forEach((node, index) => {
    if (node.type === "group") last = index;
  });
  return last < 0 ? 0 : nodeLayer(last) + 1;
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
  const layer = edgeLayer(board);
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
