import type { GraphNode } from "@gumply/core";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import ForceGraph2D, {
  type ForceGraphMethods,
  type LinkObject,
  type NodeObject,
} from "react-force-graph-2d";
import {
  ghostTooltip,
  isGhostId,
  labelledIds,
  neighbourIds,
  nodeColor,
  nodeRadius,
  nodeTooltip,
  type GhostNode,
  type GraphLink,
} from "./graph-model.js";

export type CanvasNode = GraphNode | GhostNode;

export interface GraphCanvasProps {
  nodes: readonly CanvasNode[];
  links: readonly GraphLink[];
  /** Page to ring when arriving from a page. */
  highlightId?: string | null;
  testId: string;
  ariaLabel: string;
  showControls?: boolean;
  reducedMotion?: boolean;
  onOpenPage: (id: string) => void;
  onCreatePage?: (title: string) => void;
}

interface ThemeColors {
  text: string;
  muted: string;
  panel: string;
  accent: string;
  border: string;
}

const FALLBACK_COLORS: ThemeColors = {
  text: "#26251f",
  muted: "#7c7a72",
  panel: "#ffffff",
  accent: "#4f46e5",
  border: "#e6e4dd",
};

function readThemeColors(): ThemeColors {
  if (typeof window === "undefined") return FALLBACK_COLORS;
  const styles = getComputedStyle(document.documentElement);
  const read = (name: keyof ThemeColors): string =>
    styles.getPropertyValue(`--${name}`).trim() || FALLBACK_COLORS[name];
  return {
    text: read("text"),
    muted: read("muted"),
    panel: read("panel"),
    accent: read("accent"),
    border: read("border"),
  };
}

function useThemeColors(): ThemeColors {
  const [colors, setColors] = useState<ThemeColors>(readThemeColors);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setColors(readThemeColors());
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);

  return colors;
}

function useElementSize(ref: RefObject<HTMLDivElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const update = (): void => {
      setSize({ width: element.clientWidth, height: element.clientHeight });
    };
    update();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return size;
}

function countOf(node: CanvasNode): number {
  return isGhostId(node.id) ? (node as GhostNode).refCount : (node as GraphNode).linkCount;
}

function titleOf(node: CanvasNode): string {
  return isGhostId(node.id) ? (node as GhostNode).title : (node as GraphNode).title;
}

function endpointId(value: string | number | NodeObject<CanvasNode> | undefined): string {
  if (value !== undefined && value !== null && typeof value === "object") return String(value.id);
  return value === undefined || value === null ? "" : String(value);
}

/** Shared canvas for the global graph and the local panel. */
export function GraphCanvas({
  nodes,
  links,
  highlightId = null,
  testId,
  ariaLabel,
  showControls = false,
  reducedMotion = false,
  onOpenPage,
  onCreatePage,
}: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraphMethods<CanvasNode, GraphLink> | undefined>(undefined);
  const fitted = useRef(false);
  const colors = useThemeColors();
  const size = useElementSize(containerRef);

  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const neighbours = useMemo(
    () => (hoveredId ? neighbourIds(links, hoveredId) : new Set<string>()),
    [hoveredId, links],
  );

  const labelIds = useMemo(
    () =>
      labelledIds(
        nodes.map((node) => ({ id: node.id, count: countOf(node) })),
        hoveredId,
        neighbours,
      ),
    [nodes, hoveredId, neighbours],
  );

  const maxCount = useMemo(
    () => Math.max(0, ...nodes.map((node) => countOf(node))),
    [nodes],
  );

  const ghostById = useMemo(
    () => new Map(nodes.filter((node) => isGhostId(node.id)).map((node) => [node.id, node as GhostNode])),
    [nodes],
  );

  useEffect(() => {
    fitted.current = false;
  }, [nodes, links]);

  const isDimmed = useCallback(
    (id: string): boolean =>
      hoveredId !== null && id !== hoveredId && !neighbours.has(id),
    [hoveredId, neighbours],
  );

  const drawNode = useCallback(
    (rawNode: NodeObject<CanvasNode>, ctx: CanvasRenderingContext2D, scale: number) => {
      const node = rawNode as CanvasNode & { x?: number; y?: number };
      const id = node.id;
      const ghost = isGhostId(id);
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const radiusPx = nodeRadius(countOf(node), maxCount);
      const radius = radiusPx / Math.max(scale, 0.2);
      const dimmed = isDimmed(id);

      ctx.save();
      ctx.globalAlpha = dimmed ? 0.22 : 1;

      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);

      if (ghost) {
        ctx.setLineDash([4 / Math.max(scale, 0.2), 3 / Math.max(scale, 0.2)]);
        ctx.lineWidth = 1 / Math.max(scale, 0.2);
        ctx.strokeStyle = colors.muted;
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.fillStyle = nodeColor(node as GraphNode);
        ctx.fill();
        ctx.lineWidth = 1 / Math.max(scale, 0.2);
        ctx.strokeStyle = colors.panel;
        ctx.stroke();
      }

      if (highlightId === id || hoveredId === id) {
        ctx.beginPath();
        ctx.arc(x, y, radius + 3 / Math.max(scale, 0.2), 0, Math.PI * 2);
        ctx.lineWidth = 2 / Math.max(scale, 0.2);
        ctx.strokeStyle = colors.accent;
        ctx.stroke();
      }

      if (labelIds.has(id)) {
        const title = titleOf(node);
        const label = title.length > 20 ? `${title.slice(0, 19)}…` : title;
        const fontSize = 10 / Math.max(scale, 0.2);
        ctx.font = `${fontSize}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillStyle = ghost ? colors.muted : colors.text;
        ctx.fillText(label, x, y + radius + 3 / Math.max(scale, 0.2));
      }

      ctx.restore();
    },
    [colors, highlightId, hoveredId, isDimmed, labelIds, maxCount],
  );

  const drawPointerArea = useCallback(
    (
      rawNode: NodeObject<CanvasNode>,
      paintColor: string,
      ctx: CanvasRenderingContext2D,
      scale: number,
    ) => {
      const node = rawNode as CanvasNode & { x?: number; y?: number };
      const radius = (nodeRadius(countOf(node), maxCount) + 4) / Math.max(scale, 0.2);
      ctx.beginPath();
      ctx.arc(node.x ?? 0, node.y ?? 0, radius, 0, Math.PI * 2);
      ctx.fillStyle = paintColor;
      ctx.fill();
    },
    [maxCount],
  );

  const handleNodeClick = useCallback(
    (rawNode: NodeObject<CanvasNode>) => {
      const node = rawNode as CanvasNode;
      const ghost = ghostById.get(node.id);
      if (ghost) {
        if (onCreatePage) onCreatePage(ghost.title);
        return;
      }
      onOpenPage(node.id);
    },
    [ghostById, onCreatePage, onOpenPage],
  );

  return (
    <div className="graph-canvas-wrap">
      {showControls ? (
        <div className="graph-controls" role="group" aria-label="Graph view controls">
          <button
            type="button"
            className="graph-control"
            data-testid="graph-zoom-out"
            aria-label="Zoom out"
            onClick={() => {
              const graph = graphRef.current;
              if (graph) graph.zoom(Math.max(0.2, graph.zoom() / 1.5), 200);
            }}
          >
            −
          </button>
          <button
            type="button"
            className="graph-control"
            data-testid="graph-fit"
            onClick={() => graphRef.current?.zoomToFit(400, 60)}
          >
            Fit
          </button>
          <button
            type="button"
            className="graph-control"
            data-testid="graph-zoom-in"
            aria-label="Zoom in"
            onClick={() => {
              const graph = graphRef.current;
              if (graph) graph.zoom(Math.min(8, graph.zoom() * 1.5), 200);
            }}
          >
            +
          </button>
        </div>
      ) : null}

      <div
        ref={containerRef}
        className="graph-canvas"
        data-testid={testId}
        role="img"
        aria-label={ariaLabel}
      >
        {size.width > 0 && size.height > 0 ? (
          <ForceGraph2D<CanvasNode, GraphLink>
            ref={graphRef}
            width={size.width}
            height={size.height}
            graphData={{ nodes: [...nodes], links: [...links] }}
            nodeId="id"
            backgroundColor="transparent"
            nodeCanvasObjectMode={() => "replace"}
            nodeCanvasObject={drawNode}
            nodePointerAreaPaint={drawPointerArea}
            nodeLabel={(node) => {
              const value = node as CanvasNode;
              const ghost = ghostById.get(value.id);
              return ghost ? ghostTooltip(ghost) : nodeTooltip(value as GraphNode);
            }}
            linkColor={(link) => {
              const source = endpointId((link as LinkObject<CanvasNode, GraphLink>).source);
              const target = endpointId((link as LinkObject<CanvasNode, GraphLink>).target);
              if (hoveredId !== null && (source === hoveredId || target === hoveredId)) {
                return colors.accent;
              }
              return hoveredId !== null ? `${colors.border}66` : `${colors.muted}88`;
            }}
            linkWidth={(link) => {
              const source = endpointId((link as LinkObject<CanvasNode, GraphLink>).source);
              const target = endpointId((link as LinkObject<CanvasNode, GraphLink>).target);
              return hoveredId !== null && (source === hoveredId || target === hoveredId) ? 2 : 1;
            }}
            linkLineDash={(link) => {
              const target = endpointId((link as LinkObject<CanvasNode, GraphLink>).target);
              return isGhostId(target) ? [4, 3] : null;
            }}
            onNodeClick={handleNodeClick}
            onNodeHover={(node) => setHoveredId(node ? String(node.id) : null)}
            onEngineStop={() => {
              if (fitted.current || nodes.length === 0) return;
              fitted.current = true;
              graphRef.current?.zoomToFit(400, 60);
            }}
            cooldownTicks={reducedMotion ? 2 : 120}
            warmupTicks={reducedMotion ? 80 : 0}
            d3AlphaDecay={0.03}
            minZoom={0.15}
            maxZoom={8}
            enableNodeDrag
          />
        ) : null}
      </div>
    </div>
  );
}
