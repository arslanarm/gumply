import type { GraphNode } from "@gumply/core";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import ForceGraph2D, {
  type ForceGraphMethods,
  type LinkObject,
  type NodeObject,
} from "react-force-graph-2d";
import {
  FALLBACK_GRAPH_PALETTE,
  ghostTooltip,
  graphPaletteFromStyles,
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
  palette: readonly string[];
}

type ThemeColorToken = Exclude<keyof ThemeColors, "palette">;

const FALLBACK_COLORS: ThemeColors = {
  text: "#26251f",
  muted: "#6f6d65",
  panel: "#ffffff",
  accent: "#4f46e5",
  border: "#e6e4dd",
  palette: FALLBACK_GRAPH_PALETTE,
};

/** Empty space kept around the graph when auto-fitting, in CSS px. */
const FIT_PADDING = 40;
/** Room under the lowest node for its label. */
const LABEL_ALLOWANCE = 16;
/** Auto-fit never zooms in further than this (matches the user max zoom). */
const MAX_FIT_ZOOM = 8;
/** ... nor further out (very large vaults still show every node). */
const MIN_FIT_ZOOM = 0.06;
/** Labels fade in between these zoom levels (Q1b: labels scale with zoom). */
const LABEL_FADE_START = 0.8;
const LABEL_FADE_END = 1.1;
const LABEL_FONT_PX = 11;
const MAX_LABEL_CHARS = 22;

function readThemeColors(): ThemeColors {
  if (typeof window === "undefined") return FALLBACK_COLORS;
  const styles = getComputedStyle(document.documentElement);
  const read = (name: ThemeColorToken): string =>
    styles.getPropertyValue(`--${name}`).trim() || FALLBACK_COLORS[name];
  return {
    text: read("text"),
    muted: read("muted"),
    panel: read("panel"),
    accent: read("accent"),
    border: read("border"),
    palette: graphPaletteFromStyles(styles),
  };
}

function useThemeColors(): ThemeColors {
  const [colors, setColors] = useState<ThemeColors>(readThemeColors);

  useEffect(() => {
    const update = () => setColors(readThemeColors());
    const query =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-color-scheme: dark)")
        : null;
    query?.addEventListener?.("change", update);

    const observer =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(update);
    observer?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    return () => {
      query?.removeEventListener?.("change", update);
      observer?.disconnect();
    };
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** `#rrggbb` + alpha → `rgba(...)`, so canvas colours match the CSS theme. */
function withAlpha(color: string, alpha: number): string {
  const value = color.trim();
  if (/^#[0-9a-f]{6}$/i.test(value)) {
    const r = Number.parseInt(value.slice(1, 3), 16);
    const g = Number.parseInt(value.slice(3, 5), 16);
    const b = Number.parseInt(value.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  if (/^#[0-9a-f]{3}$/i.test(value)) {
    const r = Number.parseInt(value[1]! + value[1]!, 16);
    const g = Number.parseInt(value[2]! + value[2]!, 16);
    const b = Number.parseInt(value[3]! + value[3]!, 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return value;
}

/**
 * Weak spring towards the centre of the canvas. The stock d3 charge force
 * pushes unlinked pages away with nothing pulling them back, which is how an
 * isolated page ended up in a far corner (owner feedback, Q1b). Applied on both
 * axes so every component — linked or not — stays near the fitted view.
 */
interface ForceNode {
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
}

interface AxisForce {
  (alpha: number): void;
  initialize: (nodes: ForceNode[]) => void;
}

function axisForce(axis: "x" | "y", strength: number): AxisForce {
  let forceNodes: ForceNode[] = [];

  const force: AxisForce = (alpha) => {
    for (const node of forceNodes) {
      if (axis === "x") {
        node.vx = (node.vx ?? 0) + (0 - (node.x ?? 0)) * strength * alpha;
      } else {
        node.vy = (node.vy ?? 0) + (0 - (node.y ?? 0)) * strength * alpha;
      }
    }
  };
  force.initialize = (next: ForceNode[]): void => {
    forceNodes = next;
  };
  return force;
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

interface FitTarget {
  centerX: number;
  centerY: number;
  zoom: number;
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
  const fitTimer = useRef<number | null>(null);
  const size = useElementSize(containerRef);
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const colors = useThemeColors();
  const [ready, setReady] = useState(false);
  /** Bumped on every applied fit; lets tests (and debugging) observe refits. */
  const [fitGeneration, setFitGeneration] = useState(0);

  const [hoveredId, setHoveredId] = useState<string | null>(null);

  /** Identity of the drawn data set; fit again when it (not just render) changes. */
  const dataKey = useMemo(
    () => `${nodes.map((node) => node.id).join("\u0000")}|${links.length}`,
    [nodes, links],
  );

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

  const isDimmed = useCallback(
    (id: string): boolean =>
      hoveredId !== null && id !== hoveredId && !neighbours.has(id),
    [hoveredId, neighbours],
  );

  /**
   * Fit every node into view (Q1b #1), in screen space: node circles and labels
   * are drawn at a constant CSS size, so their radius — not just the centre —
   * has to be kept inside the canvas. Computed here instead of `zoomToFit` so
   * the zoom is capped: a 1–2 node vault doesn't get blown up 20×.
   */
  const fitTarget = useCallback((): FitTarget | null => {
    const { width, height } = sizeRef.current;
    if (width < 40 || height < 40 || nodes.length === 0) return null;

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let maxRadius = 0;
    let positioned = 0;

    for (const node of nodes) {
      const x = (node as CanvasNode & { x?: number }).x;
      const y = (node as CanvasNode & { y?: number }).y;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      positioned += 1;
      minX = Math.min(minX, x as number);
      maxX = Math.max(maxX, x as number);
      minY = Math.min(minY, y as number);
      maxY = Math.max(maxY, y as number);
      maxRadius = Math.max(maxRadius, nodeRadius(countOf(node), maxCount));
    }
    if (positioned === 0) return null;

    const spanX = maxX - minX;
    const spanY = maxY - minY;
    const availableWidth = Math.max(20, width - FIT_PADDING * 2 - maxRadius * 2);
    const availableHeight = Math.max(
      20,
      height - FIT_PADDING * 2 - maxRadius * 2 - LABEL_ALLOWANCE,
    );
    const zoomX = spanX > 1 ? availableWidth / spanX : MAX_FIT_ZOOM;
    const zoomY = spanY > 1 ? availableHeight / spanY : MAX_FIT_ZOOM;

    return {
      centerX: (minX + maxX) / 2,
      centerY: (minY + maxY) / 2,
      zoom: clamp(Math.min(zoomX, zoomY), MIN_FIT_ZOOM, MAX_FIT_ZOOM),
    };
  }, [nodes, maxCount]);

  const fitView = useCallback(
    (duration: number): void => {
      const graph = graphRef.current;
      const target = fitTarget();
      if (!graph || !target) return;
      graph.centerAt(target.centerX, target.centerY, duration);
      graph.zoom(target.zoom, duration);
      setFitGeneration((generation) => generation + 1);
    },
    [fitTarget],
  );

  const settleTimer = useRef<number | null>(null);

  const clearSettleTimer = useCallback((): void => {
    if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    settleTimer.current = null;
  }, []);

  /**
   * Auto-fit is requested on data change and on resize (Q1b #1). The short
   * delay lets react-force-graph apply the new graph data and gives freshly
   * added nodes their first coordinates.
   */
  const scheduleFit = useCallback(
    (duration: number, markReady: boolean): void => {
      if (typeof window === "undefined") return;
      if (fitTimer.current !== null) window.clearTimeout(fitTimer.current);
      fitTimer.current = window.setTimeout(() => {
        fitTimer.current = null;
        fitView(duration);
        if (markReady) setReady(true);
      }, 80);
    },
    [fitView],
  );

  const lastDataKey = useRef<string | null>(null);
  useEffect(() => {
    if (size.width <= 0 || size.height <= 0) return;
    const newData = lastDataKey.current !== dataKey;
    lastDataKey.current = dataKey;
    if (newData) setReady(false);

    // Draw the whole graph immediately (even while physics is still moving)…
    scheduleFit(0, false);
    // …and mark the view ready once the layout has settled. Resize has no
    // engine stop, so it settles after the tween; new data normally settles on
    // `onEngineStop`, with a fallback if the engine reports nothing.
    clearSettleTimer();
    settleTimer.current = window.setTimeout(() => {
      settleTimer.current = null;
      fitView(0);
      setReady(true);
    }, newData ? 4000 : 600);

    return () => {
      if (fitTimer.current !== null) window.clearTimeout(fitTimer.current);
      fitTimer.current = null;
      clearSettleTimer();
    };
  }, [dataKey, size.width, size.height, scheduleFit, fitView, clearSettleTimer]);

  // Physics: springy but calm, and every component (even a page with no links)
  // is pulled towards the middle so auto-fit never has to chase a far corner.
  // Deliberately *not* re-run on resize: reheating would move a settled graph
  // right after the resize fit and leave nodes outside the new viewport.
  const hasSize = size.width > 0;
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || !hasSize) return;

    const link = graph.d3Force("link") as
      | { distance: (value: number) => unknown; strength: (value: number) => unknown }
      | undefined;
    link?.distance(52);
    link?.strength(0.45);

    const charge = graph.d3Force("charge") as
      | { strength: (value: number) => unknown; distanceMax: (value: number) => unknown }
      | undefined;
    charge?.strength(-60 - Math.min(180, nodes.length * 0.6));
    charge?.distanceMax(1400);

    // Small vaults need a firmer centring pull so an isolated page doesn't
    // drift away from a 3-node cluster; big vaults stay airy.
    const centerStrength = nodes.length <= 12 ? 0.22 : nodes.length <= 60 ? 0.16 : 0.12;
    graph.d3Force("x", axisForce("x", centerStrength) as never);
    graph.d3Force("y", axisForce("y", centerStrength) as never);
    graph.d3ReheatSimulation();
  }, [dataKey, hasSize, nodes.length]);

  const isDimmedRef = useRef(isDimmed);
  isDimmedRef.current = isDimmed;
  const labelIdsRef = useRef(labelIds);
  labelIdsRef.current = labelIds;
  const ghostByIdRef = useRef(ghostById);
  ghostByIdRef.current = ghostById;
  const hoveredRef = useRef(hoveredId);
  hoveredRef.current = hoveredId;

  const drawNode = useCallback(
    (rawNode: NodeObject<CanvasNode>, ctx: CanvasRenderingContext2D, scale: number) => {
      const node = rawNode as CanvasNode & { x?: number; y?: number };
      const id = node.id;
      const ghost = isGhostId(id);
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const safeScale = Math.max(scale, 0.05);
      const radiusPx = nodeRadius(countOf(node), maxCount);
      const radius = radiusPx / safeScale;
      const dimmed = isDimmedRef.current(id);
      const hovered = hoveredRef.current === id;

      ctx.save();
      ctx.globalAlpha = dimmed ? 0.18 : 1;

      // Soft halo for the page the user came from, like Obsidian's active note.
      if (highlightId === id) {
        ctx.beginPath();
        ctx.arc(x, y, radius + 6 / safeScale, 0, Math.PI * 2);
        ctx.fillStyle = withAlpha(colors.accent, 0.14);
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);

      if (ghost) {
        ctx.setLineDash([4 / safeScale, 3 / safeScale]);
        ctx.lineWidth = 1.4 / safeScale;
        ctx.strokeStyle = colors.muted;
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.fillStyle = nodeColor(node as GraphNode, colors.palette);
        ctx.fill();
        ctx.lineWidth = 1.2 / safeScale;
        ctx.strokeStyle = colors.panel;
        ctx.stroke();
      }

      if (highlightId === id || hovered) {
        ctx.beginPath();
        ctx.arc(x, y, radius + 3 / safeScale, 0, Math.PI * 2);
        ctx.lineWidth = 1.6 / safeScale;
        ctx.strokeStyle = colors.accent;
        ctx.stroke();
      }

      const hoveredLabel = hovered || highlightId === id;
      const fade = clamp(
        (scale - LABEL_FADE_START) / (LABEL_FADE_END - LABEL_FADE_START),
        0,
        1,
      );
      const labelAlpha = dimmed ? 0.18 : hoveredLabel ? 1 : fade;

      if ((labelIdsRef.current.has(id) || highlightId === id) && labelAlpha > 0.02) {
        const title = titleOf(node);
        const label =
          title.length > MAX_LABEL_CHARS ? `${title.slice(0, MAX_LABEL_CHARS - 1)}…` : title;
        const fontSize = LABEL_FONT_PX / safeScale;
        ctx.globalAlpha = labelAlpha;
        ctx.font = `${fontSize}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        // Halo in the canvas background colour keeps labels legible over links
        // and neighbouring nodes (Obsidian does the same).
        ctx.lineWidth = 3 / safeScale;
        ctx.strokeStyle = withAlpha(colors.panel, 0.82);
        ctx.lineJoin = "round";
        ctx.strokeText(label, x, y + radius + 4 / safeScale);
        ctx.fillStyle = ghost ? colors.muted : colors.text;
        ctx.fillText(label, x, y + radius + 4 / safeScale);
      }

      ctx.restore();
    },
    [colors, highlightId, hoveredId, maxCount],
  );

  const drawPointerArea = useCallback(
    (
      rawNode: NodeObject<CanvasNode>,
      paintColor: string,
      ctx: CanvasRenderingContext2D,
      scale: number,
    ) => {
      const node = rawNode as CanvasNode & { x?: number; y?: number };
      const safeScale = Math.max(scale, 0.05);
      const radius = (nodeRadius(countOf(node), maxCount) + 5) / safeScale;
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
      const ghost = ghostByIdRef.current.get(node.id);
      if (ghost) {
        if (onCreatePage) onCreatePage(ghost.title);
        return;
      }
      onOpenPage(node.id);
    },
    [onCreatePage, onOpenPage],
  );

  const handleEngineStop = useCallback(() => {
    clearSettleTimer();
    fitView(reducedMotion ? 0 : 300);
    setReady(true);
  }, [clearSettleTimer, fitView, reducedMotion]);

  const graphData = useMemo(
    () => ({ nodes: [...nodes], links: [...links] }),
    [nodes, links],
  );

  const linkColor = useCallback(
    (link: LinkObject<CanvasNode, GraphLink>) => {
      const source = endpointId(link.source);
      const target = endpointId(link.target);
      const connected =
        hoveredId !== null && (source === hoveredId || target === hoveredId);
      if (connected) return withAlpha(colors.accent, 0.85);
      if (hoveredId !== null) return withAlpha(colors.muted, 0.08);
      return withAlpha(colors.muted, 0.32);
    },
    [colors, hoveredId],
  );

  const linkWidth = useCallback(
    (link: LinkObject<CanvasNode, GraphLink>) => {
      const source = endpointId(link.source);
      const target = endpointId(link.target);
      return hoveredId !== null && (source === hoveredId || target === hoveredId) ? 1.7 : 1;
    },
    [hoveredId],
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
              if (graph) graph.zoom(Math.max(0.06, graph.zoom() / 1.5), 200);
            }}
          >
            −
          </button>
          <button
            type="button"
            className="graph-control"
            data-testid="graph-fit"
            aria-label="Fit graph to view"
            onClick={() => fitView(300)}
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
        data-graph-ready={ready ? "true" : "false"}
        data-graph-fit={String(fitGeneration)}
        role="img"
        aria-label={ariaLabel}
      >
        {size.width > 0 && size.height > 0 ? (
          <ForceGraph2D<CanvasNode, GraphLink>
            ref={graphRef}
            width={size.width}
            height={size.height}
            graphData={graphData}
            nodeId="id"
            backgroundColor="transparent"
            nodeCanvasObjectMode={() => "replace"}
            nodeCanvasObject={drawNode}
            nodePointerAreaPaint={drawPointerArea}
            nodeLabel={(node) => {
              const value = node as CanvasNode;
              const ghost = ghostByIdRef.current.get(value.id);
              return ghost ? ghostTooltip(ghost) : nodeTooltip(value as GraphNode);
            }}
            linkColor={linkColor}
            linkWidth={linkWidth}
            linkLineDash={(link) => {
              const target = endpointId((link as LinkObject<CanvasNode, GraphLink>).target);
              return isGhostId(target) ? [4, 3] : null;
            }}
            onNodeClick={handleNodeClick}
            onNodeHover={(node) => setHoveredId(node ? String(node.id) : null)}
            onEngineStop={handleEngineStop}
            cooldownTicks={reducedMotion ? 2 : 140}
            warmupTicks={reducedMotion ? 90 : 40}
            d3AlphaDecay={reducedMotion ? 0.1 : 0.03}
            d3VelocityDecay={0.38}
            minZoom={0.06}
            maxZoom={8}
            enableNodeDrag
          />
        ) : null}
      </div>
    </div>
  );
}
