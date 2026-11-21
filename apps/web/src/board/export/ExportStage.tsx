/**
 * Export (spec/v0-6 §D): renders the board (or the selection) once more,
 * off screen, at zoom 1, with every object mounted (no culling, no level of
 * detail, nothing selected) and text set in the export font. Once it has
 * settled, `elementToSvg` turns it into an SVG, and PNGs are rasterised from
 * that SVG, so both formats match.
 *
 * Mounted by the board editor inside its context providers, so the real node
 * components (live page cards, rich text) render exactly as on screen.
 */
import { canvasBounds, type CanvasBoard } from "@gumply/core";
import { ConnectionMode, ReactFlow, ReactFlowProvider } from "@xyflow/react";
import { useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { EDGE_TYPES } from "../BoardEdge.js";
import { syncEdges, syncNodes } from "../flow.js";
import { FitBatch } from "../fit-batch.js";
import { FitBatchContext, NODE_TYPES } from "../nodes.js";
import { EXPORT_FONT_STACK, embeddedFontCss, loadExportFonts } from "./fonts.js";
import { elementToSvg } from "./svg.js";

/** Room around the content (frame names sit above their frame). */
export const EXPORT_PADDING = 32;
/** Give up waiting for slow content (page previews, images) after this long. */
const SETTLE_LIMIT_MS = 5000;
/** The stage counts as settled after this long without DOM changes. */
const QUIET_MS = 120;

export interface ExportStageProps {
  board: CanvasBoard;
  /** A CSS colour (resolved theme background) or null for transparent. */
  background: string | null;
  onDone: (result: { svg: string; width: number; height: number }) => void;
  onError: (error: unknown) => void;
}

const STAGE_CSS = `
.board-export-stage { position: fixed; left: -200000px; top: 0; pointer-events: none; contain: layout style; }
.board-export-stage .react-flow__node { contain: layout style; }
.board-export-stage :where(*:not(code, pre, kbd, samp, .board-card-emoji)) { font-family: ${EXPORT_FONT_STACK}; }
`;

const dataUris = new Map<string, Promise<string | null>>();

/** Same-origin images (vault files) as data URIs; others are left out. */
export function inlineImage(url: string): Promise<string | null> {
  let pending = dataUris.get(url);
  if (!pending) {
    pending = (async () => {
      if (url.startsWith("data:")) return url;
      try {
        if (new URL(url, window.location.href).origin !== window.location.origin) return null;
        const response = await fetch(url);
        if (!response.ok) return null;
        const blob = await response.blob();
        return await new Promise<string | null>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(blob);
        });
      } catch {
        return null;
      }
    })();
    dataUris.set(url, pending);
    // Vault files change: don't keep them past this export.
    void pending.finally(() => window.setTimeout(() => dataUris.delete(url), 10_000));
  }
  return pending;
}

function frame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** Wait until the stage shows every object and stops changing (page previews, images). */
async function settle(root: HTMLElement, nodes: number, edges: number, fitBatch: FitBatch): Promise<void> {
  const started = performance.now();
  let lastChange = performance.now();
  const observer = new MutationObserver(() => {
    lastChange = performance.now();
  });
  observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
  try {
    for (;;) {
      await frame();
      const now = performance.now();
      if (now - started > SETTLE_LIMIT_MS) return;
      const shownNodes = root.querySelectorAll(".react-flow__node").length;
      const shownEdges = root.querySelectorAll(".react-flow__edge").length;
      const images = Array.from(root.querySelectorAll("img"));
      const loading = images.some((image) => !image.complete);
      if (shownNodes < nodes || shownEdges < edges || loading || fitBatch.busy) continue;
      if (now - lastChange >= QUIET_MS) return;
    }
  } finally {
    observer.disconnect();
  }
}

export default function ExportStage({ board, background, onDone, onError }: ExportStageProps) {
  const ref = useRef<HTMLDivElement>(null);
  const bounds = useMemo(() => canvasBounds(board.nodes) ?? { x: 0, y: 0, width: 0, height: 0 }, [board]);
  const width = Math.ceil(bounds.width + EXPORT_PADDING * 2);
  const height = Math.ceil(bounds.height + EXPORT_PADDING * 2);
  const nodes = useMemo(() => syncNodes([], board, null, new Set()), [board]);
  const edges = useMemo(() => syncEdges([], board, null, new Set()), [board]);
  const fitBatch = useMemo(() => new FitBatch(), []);
  const latest = useRef({ onDone, onError });
  latest.current = { onDone, onError };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const root = ref.current;
        if (!root) throw new Error("The export stage isn't mounted");
        await settle(root, nodes.length, edges.length, fitBatch);
        await document.fonts.ready;
        if (cancelled) return;
        const viewport = root.querySelector(".react-flow__viewport") ?? root;
        const origin = root.getBoundingClientRect();
        const result = await elementToSvg(viewport, {
          origin: { x: origin.left, y: origin.top },
          width,
          height,
          background,
          fontCss: embeddedFontCss,
          inlineImage,
        });
        if (!cancelled) latest.current.onDone({ svg: result.svg, width, height });
      } catch (error) {
        if (!cancelled) latest.current.onError(error);
      }
    })();
    return () => {
      cancelled = true;
    };
    // One export per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return createPortal(
    <div
      ref={ref}
      className="board-root board-export-stage"
      style={{ width, height }}
      aria-hidden="true"
      data-testid="board-export-stage"
    >
      <style>{STAGE_CSS}</style>
      <FitBatchContext.Provider value={fitBatch}>
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          defaultViewport={{ x: EXPORT_PADDING - bounds.x, y: EXPORT_PADDING - bounds.y, zoom: 1 }}
          minZoom={1}
          maxZoom={1}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          panOnDrag={false}
          panOnScroll={false}
          zoomOnScroll={false}
          zoomOnPinch={false}
          zoomOnDoubleClick={false}
          preventScrolling={false}
          disableKeyboardA11y
          proOptions={{ hideAttribution: true }}
          // Every dot is a "source" (as in the editor): edges need loose mode to find their target side.
          connectionMode={ConnectionMode.Loose}
        />
      </ReactFlowProvider>
      </FitBatchContext.Provider>
    </div>,
    document.body,
  );
}

/** Load what the stage needs before mounting it (the font). */
export function prepareExport(): Promise<void> {
  return loadExportFonts();
}

