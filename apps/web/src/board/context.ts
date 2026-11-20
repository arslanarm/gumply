/**
 * What board nodes and edges can ask the editor to do, and the slots other
 * features plug their renderers into (W2b: rich text with [[links]], live
 * page cards, image/link cards).
 */
import type { CanvasFileNode, CanvasLinkNode, CanvasNode, CanvasNodeKind } from "@gumply/core";
import { createContext, useContext, type ReactNode } from "react";

export interface BoardActions {
  /** Start editing a node's text (or a frame's label). */
  startEditing: (id: string) => void;
  /** Save edited text and leave edit mode. `height` grows the node to fit. */
  commitText: (id: string, text: string, size?: { height?: number }) => void;
  /** Leave edit mode without saving. */
  cancelEditing: () => void;
  startEditingEdge: (id: string) => void;
  commitEdgeLabel: (id: string, label: string) => void;
  /** Persist a finished resize. */
  commitResize: (id: string, rect: { x: number; y: number; width: number; height: number }) => void;
  /** Open what a card points at (a page, a board, a file or a URL). */
  openNode: (node: CanvasNode) => void;
}

export const BoardActionsContext = createContext<BoardActions | null>(null);

export function useBoardActions(): BoardActions {
  const actions = useContext(BoardActionsContext);
  if (!actions) throw new Error("useBoardActions outside a board");
  return actions;
}

/** Props for a text renderer: what a sticky/shape/text node shows when not editing. */
export interface BoardTextRenderProps {
  text: string;
  kind: CanvasNodeKind;
}

export interface BoardCardRenderProps {
  node: CanvasFileNode | CanvasLinkNode | CanvasNode;
  kind: CanvasNodeKind;
  selected: boolean;
}

/**
 * Optional renderers. Anything left out falls back to the built-in plain
 * renderers, so the engine works on its own.
 */
export interface BoardRenderers {
  text?: (props: BoardTextRenderProps) => ReactNode;
  card?: (props: BoardCardRenderProps) => ReactNode;
}

export const BoardRenderersContext = createContext<BoardRenderers>({});

export function useBoardRenderers(): BoardRenderers {
  return useContext(BoardRenderersContext);
}
