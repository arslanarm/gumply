import type { CanvasBoard, CanvasNode } from "@gumply/core";

/**
 * The History panel's board Changes (#fr5baurg): one board to draw, the
 * current cards plus the ones this version had and now lacks (ghosted), with
 * each changed card marked. The diff's ids come from the server
 * (`GET /history/:id/:file/diff`: from the version to now).
 */
export type BoardDiffMark = "added" | "removed" | "changed";

export interface BoardDiffIds {
  added: readonly string[];
  removed: readonly string[];
  changed: readonly string[];
}

export interface BoardDiffView {
  board: CanvasBoard;
  marks: Map<string, BoardDiffMark>;
}

export function boardDiffView(version: CanvasBoard, current: CanvasBoard, diff: BoardDiffIds): BoardDiffView {
  const marks = new Map<string, BoardDiffMark>();
  for (const id of diff.added) marks.set(id, "added");
  for (const id of diff.changed) marks.set(id, "changed");
  const removedIds = new Set(diff.removed);
  const ids = new Set(current.nodes.map((node) => node.id));
  const removed = version.nodes.filter((node) => removedIds.has(node.id) && !ids.has(node.id));
  for (const node of removed) marks.set(node.id, "removed");
  // Removed cards go underneath, so a card added on top of one stays readable.
  const nodes = [...removed, ...current.nodes];
  const all = new Set(nodes.map((node) => node.id));
  const edges = current.edges.filter((edge) => all.has(edge.fromNode) && all.has(edge.toNode));
  return { board: { ...current, nodes, edges }, marks };
}

/** A short, readable name for a card: its text's first line, the file or link, a group's label. */
export function boardCardLabel(node: CanvasNode | undefined): string | null {
  if (!node) return null;
  const value = node as CanvasNode & { text?: unknown; file?: unknown; url?: unknown; label?: unknown };
  const raw =
    typeof value.text === "string"
      ? value.text
      : typeof value.file === "string"
        ? (value.file.split("/").pop() ?? value.file)
        : typeof value.url === "string"
          ? value.url
          : typeof value.label === "string"
            ? value.label
            : "";
  const line = raw
    .split("\n")
    .map((part) => part.replace(/^[#>*\-\s]+/, "").trim())
    .find((part) => part.length > 0);
  if (!line) return null;
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}
