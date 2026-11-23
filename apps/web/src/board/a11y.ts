/**
 * Boards from the keyboard (#pujmbsyz, a11y audit P2 4): the order Tab walks
 * the objects in, and how one is named when the live region announces it.
 */
import { canvasNodeKind, type CanvasNode, type CanvasNodeKind } from "@gumply/core";
import { boardCardLabel } from "../lib/board-diff.js";
import type { MessageKey } from "../i18n/index.js";

/** Objects whose tops are this close count as one row (a line of stickies). */
const ROW = 24;

/**
 * Reading order: rows top to bottom, each row left to right. An object joins
 * the row whose first (topmost) object is at most {@link ROW} above it.
 */
export function readingOrder(nodes: readonly CanvasNode[]): string[] {
  const byTop = nodes.map((node, index) => ({ node, index })).sort((a, b) => a.node.y - b.node.y || a.index - b.index);
  const rows: Array<{ top: number; items: typeof byTop }> = [];
  for (const item of byTop) {
    const row = rows.at(-1);
    if (row && item.node.y - row.top <= ROW) row.items.push(item);
    else rows.push({ top: item.node.y, items: [item] });
  }
  return rows.flatMap((row) => row.items.sort((a, b) => a.node.x - b.node.x || a.index - b.index).map(({ node }) => node.id));
}

/** The next (or previous) object after `current` in reading order; null past either end. */
export function nextInOrder(order: readonly string[], current: string | null, backwards: boolean): string | null {
  if (order.length === 0) return null;
  if (current === null || !order.includes(current)) return backwards ? (order.at(-1) ?? null) : (order[0] ?? null);
  const index = order.indexOf(current) + (backwards ? -1 : 1);
  return order[index] ?? null;
}

const KIND_KEY: Partial<Record<CanvasNodeKind, MessageKey>> = {
  sticky: "board.tools.sticky",
  text: "board.tools.text",
  shape: "board.tools.shape",
  group: "board.tools.frame",
  ink: "board.a11y.kinds.drawing",
  page: "board.a11y.kinds.page",
  board: "board.a11y.kinds.board",
  image: "board.a11y.kinds.image",
  file: "board.a11y.kinds.file",
  link: "board.a11y.kinds.link",
};

/** "Sticky note: Goal: ship 0.9" — the kind, then its text when it has any. */
export function describeNode(node: CanvasNode, t: (key: MessageKey) => string): string {
  const kind = t(KIND_KEY[canvasNodeKind(node)] ?? "board.a11y.kinds.object");
  const label = boardCardLabel(node);
  return label ? `${kind}: ${label}` : kind;
}
