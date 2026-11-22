/**
 * A live, read-only view of a board, fitted to its frame (spec/v0-6 B, D30):
 * what a page shows for `![[Board.canvas]]`. Same nodes and connectors as the
 * editor (so it looks exactly like the board), but nothing is selectable,
 * draggable or editable, and the wheel scrolls the page instead of the board.
 *
 * Lazy-loaded through `./index.ts` (it pulls in React Flow).
 */
import { canvasBounds, type CanvasBoard } from "@gumply/core";
import { ConnectionMode, ReactFlow, ReactFlowProvider, useReactFlow, type Viewport } from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./board.css";
import type { BoardPageOption } from "./BoardEditor.js";
import { EDGE_TYPES } from "./BoardEdge.js";
import { BoardActionsContext, BoardRenderersContext, type BoardActions } from "./context.js";
import { BoardContentContext, type BoardContent } from "./content/context.js";
import { boardContentRenderers } from "./content/renderers.js";
import { syncEdges, syncNodes, type BoardFlowEdge, type BoardFlowNode } from "./flow.js";
import { lodLevel, type LodLevel } from "./lod.js";
import { NODE_TYPES } from "./nodes.js";

/** How a card changed between a version and now (the History panel's Changes, #fr5baurg). */
export type BoardDiffMark = "added" | "removed" | "changed";

export interface BoardPreviewProps {
  board: CanvasBoard;
  pages?: readonly BoardPageOption[];
  loadPage?: (path: string) => Promise<string | null>;
  /** Pan and zoom (the History panel); an embed in a page stays still so the page scrolls (D30). */
  interactive?: boolean;
  /** Cards to mark, by node id: `board-diff-added` / `-removed` / `-changed` classes. */
  highlight?: ReadonlyMap<string, BoardDiffMark>;
}

const NONE = new Set<string>();
const noop = () => {};
const READ_ONLY: BoardActions = {
  startEditing: noop,
  commitText: noop,
  cancelEditing: noop,
  draftText: noop,
  draftEdgeLabel: noop,
  startEditingEdge: noop,
  commitEdgeLabel: noop,
  updateEdge: noop,
  deleteEdge: noop,
  commitResize: noop,
  // A click anywhere opens the whole board (the embed handles it).
  openNode: noop,
};

/** Space around the fitted content, in px; the top clears the hover bar (title, Open). */
const FIT_PADDING = { top: "48px", right: "24px", bottom: "24px", left: "24px" } as const;
const MIN_ZOOM = 0.02;
/**
 * Objects mounted per frame. A 1000-object board mounted at once blocks the
 * page for ~400 ms, a visible hitch while scrolling onto it; in chunks (back
 * to front, so z-order holds) every frame stays short.
 */
const CHUNK = 40;

function Preview({ board, pages = [], loadPage, interactive = false, highlight }: BoardPreviewProps) {
  const flow = useReactFlow<BoardFlowNode, BoardFlowEdge>();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const lod = useRef<LodLevel>(0);
  const [nodes, setNodes] = useState<BoardFlowNode[]>(() => readOnlyNodes(syncNodes([], board, null, NONE)));
  const [edges, setEdges] = useState<BoardFlowEdge[]>(() => syncEdges([], board, null, NONE));
  const [revealed, setRevealed] = useState(() => Math.min(board.nodes.length, CHUNK));
  const complete = revealed >= board.nodes.length;

  useEffect(() => {
    if (complete) return;
    const frame = requestAnimationFrame(() => startTransition(() => setRevealed((count) => count + CHUNK)));
    return () => cancelAnimationFrame(frame);
  }, [complete, revealed]);

  const shownNodes = useMemo(() => {
    const shown = complete ? nodes : nodes.slice(0, revealed);
    return highlight ? marked(shown, highlight) : shown;
  }, [complete, nodes, revealed, highlight]);
  const shownEdges = useMemo(() => {
    if (complete) return edges;
    const ids = new Set(shownNodes.map((node) => node.id));
    return edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
  }, [complete, edges, shownNodes]);

  // Live: a new board (saved in Gumply or changed on disk) reuses unchanged
  // elements, so only what changed re-renders.
  useEffect(() => {
    setNodes((previous) => readOnlyNodes(syncNodes(previous, board, null, NONE)));
    setEdges((previous) => syncEdges(previous, board, null, NONE));
  }, [board]);

  const syncZoom = useCallback((zoom: number) => {
    const root = rootRef.current;
    if (!root) return;
    root.style.setProperty("--board-zoom", String(zoom));
    const level = lodLevel(zoom, lod.current);
    if (level !== lod.current || !root.dataset.lod) {
      lod.current = level;
      root.dataset.lod = String(level);
    }
  }, []);

  // Fit the board's own bounds (not the measured nodes): right from the first
  // chunk, and without waiting for React Flow to measure anything.
  const fit = useCallback(() => {
    const bounds = canvasBounds(board.nodes);
    if (!bounds) {
      const rect = rootRef.current?.getBoundingClientRect();
      const viewport: Viewport = { x: (rect?.width ?? 0) / 2, y: (rect?.height ?? 0) / 2, zoom: 1 };
      void flow.setViewport(viewport);
      syncZoom(1);
      return;
    }
    void flow.fitBounds(bounds, { padding: FIT_PADDING }).then(() => syncZoom(flow.getZoom()));
  }, [board, flow, syncZoom]);

  // Refit when the board changes or the frame is resized (bottom-edge drag,
  // window width).
  useEffect(() => {
    fit();
  }, [fit]);
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => fit());
    observer.observe(root);
    return () => observer.disconnect();
  }, [fit]);

  const content = useMemo<BoardContent>(() => ({ pages, openFile: noop, loadPage }), [pages, loadPage]);

  return (
    <BoardActionsContext.Provider value={READ_ONLY}>
      <BoardContentContext.Provider value={content}>
        <BoardRenderersContext.Provider value={boardContentRenderers}>
          <div
            ref={rootRef}
            className="board-root board-preview"
            data-testid="board-preview"
            data-nodes={board.nodes.length}
            data-ready={complete ? "true" : "false"}
          >
            <ReactFlow<BoardFlowNode, BoardFlowEdge>
              nodes={shownNodes}
              edges={shownEdges}
              nodeTypes={NODE_TYPES}
              edgeTypes={EDGE_TYPES}
              onInit={fit}
              minZoom={MIN_ZOOM}
              maxZoom={interactive ? 2 : 1}
              // Every side handle is a "source" (like the editor): an edge may end on one.
              connectionMode={ConnectionMode.Loose}
              nodesDraggable={false}
              nodesConnectable={false}
              nodesFocusable={false}
              edgesFocusable={false}
              elementsSelectable={false}
              panOnDrag={interactive}
              panOnScroll={false}
              zoomOnScroll={interactive}
              zoomOnPinch={interactive}
              zoomOnDoubleClick={false}
              // An embed: the page scrolls over it. The History panel: the wheel zooms the board.
              preventScrolling={interactive}
              deleteKeyCode={null}
              selectionKeyCode={null}
              multiSelectionKeyCode={null}
              disableKeyboardA11y
              proOptions={{ hideAttribution: false }}
              attributionPosition="bottom-right"
            />
          </div>
        </BoardRenderersContext.Provider>
      </BoardContentContext.Provider>
    </BoardActionsContext.Provider>
  );
}

/** The diff marks as classes on the flow nodes (new objects only where the class changes). */
function marked(nodes: BoardFlowNode[], highlight: ReadonlyMap<string, BoardDiffMark>): BoardFlowNode[] {
  return nodes.map((node) => {
    const mark = highlight.get(node.id);
    const className = mark ? `board-diff-${mark}` : undefined;
    return node.className === className ? node : { ...node, className };
  });
}

/** Nodes the preview can't move: no `nopan`/drag handling, no resize handles. */
function readOnlyNodes(nodes: BoardFlowNode[]): BoardFlowNode[] {
  for (const node of nodes) {
    if (node.draggable !== false) node.draggable = false;
  }
  return nodes;
}

export function BoardPreview(props: BoardPreviewProps) {
  return (
    <ReactFlowProvider>
      <Preview {...props} />
    </ReactFlowProvider>
  );
}

export default BoardPreview;
