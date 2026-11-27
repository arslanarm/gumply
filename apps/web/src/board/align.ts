import type { CanvasBoard, CanvasNode } from "@gumply/core";

/**
 * #b9425ktw D (#fzrwse3y's P3 6): align and distribute a multi-selection, as in Miro and FigJam. Only the selected
 * items move, each only on the one axis; edges follow by themselves (they name node ids). An unchanged result is the
 * same board, so it makes no undo step.
 */

export type Alignment = "left" | "center" | "right" | "top" | "middle" | "bottom";
export type Distribution = "horizontal" | "vertical";

const round = (value: number): number => Math.round(value);

function withMoves(board: CanvasBoard, moves: ReadonlyMap<string, { x: number; y: number }>): CanvasBoard {
  let changed = false;
  const nodes = board.nodes.map((node) => {
    const to = moves.get(node.id);
    if (!to || (to.x === node.x && to.y === node.y)) return node;
    changed = true;
    return { ...node, x: to.x, y: to.y } as CanvasNode;
  });
  return changed ? { ...board, nodes } : board;
}

export function alignNodes(board: CanvasBoard, ids: ReadonlySet<string>, how: Alignment): CanvasBoard {
  const chosen = board.nodes.filter((node) => ids.has(node.id));
  if (chosen.length < 2) return board;
  const left = Math.min(...chosen.map((node) => node.x));
  const right = Math.max(...chosen.map((node) => node.x + node.width));
  const top = Math.min(...chosen.map((node) => node.y));
  const bottom = Math.max(...chosen.map((node) => node.y + node.height));
  const moves = new Map<string, { x: number; y: number }>();
  for (const node of chosen) {
    let { x, y } = node;
    if (how === "left") x = left;
    else if (how === "center") x = round((left + right) / 2 - node.width / 2);
    else if (how === "right") x = right - node.width;
    else if (how === "top") y = top;
    else if (how === "middle") y = round((top + bottom) / 2 - node.height / 2);
    else y = bottom - node.height;
    moves.set(node.id, { x, y });
  }
  return withMoves(board, moves);
}

/** Equal gaps between the items along `axis`; the first and the last stay where they are. */
export function distributeNodes(board: CanvasBoard, ids: ReadonlySet<string>, axis: Distribution): CanvasBoard {
  const chosen = board.nodes.filter((node) => ids.has(node.id));
  if (chosen.length < 3) return board;
  const horizontal = axis === "horizontal";
  const start = (node: CanvasNode) => (horizontal ? node.x : node.y);
  const size = (node: CanvasNode) => (horizontal ? node.width : node.height);
  const sorted = [...chosen].sort((a, b) => start(a) - start(b) || start(a) + size(a) - (start(b) + size(b)));
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const span = start(last) + size(last) - start(first);
  const sizes = sorted.reduce((sum, node) => sum + size(node), 0);
  const gap = (span - sizes) / (sorted.length - 1);
  const moves = new Map<string, { x: number; y: number }>();
  let cursor = start(first);
  sorted.forEach((node, index) => {
    const position = index === 0 ? start(first) : index === sorted.length - 1 ? start(last) : round(cursor);
    moves.set(node.id, horizontal ? { x: position, y: node.y } : { x: node.x, y: position });
    cursor += size(node) + gap;
  });
  return withMoves(board, moves);
}
