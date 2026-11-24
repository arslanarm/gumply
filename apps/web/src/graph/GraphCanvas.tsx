import type { GraphNode } from "@gumply/core";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import ForceGraph2D, {
  type ForceGraphMethods,
  type LinkObject,
  type NodeObject,
} from "react-force-graph-2d";
import {
  FALLBACK_GRAPH_PALETTE,
  ghostDetail,
  graphPaletteFromStyles,
  isAttachmentNodeId,
  isGhostId,
  isTagNodeId,
  labelledIds,
  neighbourIds,
  nodeColor,
  nodeRadius,
  nodeDetail,
  PAGE_NODE_COLOR,
  type GhostNode,
  type GraphLink,
} from "./graph-model.js";
import {
  DRAG_ALPHA,
  DRAG_THRESHOLD_PX,
  capAlpha,
  fitZoom,
  pickNode,
  visibleBounds,
  type AlphaForce,
  type FitItem,
} from "./graph-interaction.js";
import { emojiNodeSize, emojiSprite, normaliseIcon } from "./emoji-sprites.js";
import { clusterLinkFactor, engineTicks, forceCluster, layoutInputFor } from "./layout-forces.js";
import {
  clusterKeyFor,
  colorSlots,
  computeClusters,
  convexHull,
  corePoints,
  mixColors,
  NO_CLUSTERS,
  rgbOf,
  separateHulls,
  traceRoundedHull,
  type ClusterMode,
  type ClusterNode,
  type Clusters,
} from "./clusters.js";
import { startLayout } from "./layout-client.js";
import { browserLayoutStore, cachedLayout, cachesLayout, keepLayout, layoutCacheKey, type CachedClusters, type LayoutStore } from "./layout-cache.js";

let layoutStore: LayoutStore | null | undefined;
/** The browser's graph layout cache, opened on first use (N6). */
function graphLayoutStore(): LayoutStore | null {
  if (layoutStore === undefined) layoutStore = browserLayoutStore();
  return layoutStore;
}
import { t, useT } from "../i18n/index.js";

export type CanvasNode = GraphNode | GhostNode;

export interface GraphCanvasProps {
  nodes: readonly CanvasNode[];
  links: readonly GraphLink[];
  /** Page to ring when arriving from a page. */
  highlightId?: string | null;
  /**
   * Local graph: keep this page pinned in the middle and fit the view around
   * it, so its neighbours spread around the centre (#z5abndiz).
   */
  centerId?: string | null;
  testId: string;
  ariaLabel: string;
  showControls?: boolean;
  reducedMotion?: boolean;
  onOpenPage: (id: string) => void;
  onCreatePage?: (title: string) => void;
  /**
   * E1: a node's fill instead of the default (first tag, else the page
   * colour), given the theme's palette; null keeps the default. Keep it
   * stable (memoised): a new function re-styles every node.
   */
  colorOf?: (node: GraphNode, palette: readonly string[]) => string | null;
  /**
   * #xb4b54gr: group pages into clusters (links, folder, first tag): a soft
   * area behind each, and a gentle force keeping each together and the
   * groups apart. "off" (the default) draws and moves nothing extra.
   */
  clusterMode?: ClusterMode;
  /**
   * #xb4b54gr: told whether the mode found any groups, so the graph panel can
   * say "No clear groups found" instead of leaving a mode that draws nothing.
   */
  onClustersFound?: (found: { mode: ClusterMode; groups: number }) => void;
}

interface ThemeColors {
  text: string;
  muted: string;
  panel: string;
  /** Canvas background (`--bg`). */
  bg: string;
  accent: string;
  border: string;
  /** Untagged pages (`--graph-page`). */
  page: string;
  palette: readonly string[];
}

type ThemeColorToken = Exclude<keyof ThemeColors, "palette" | "page">;

const FALLBACK_COLORS: ThemeColors = {
  text: "#26251f",
  muted: "#65635c",
  panel: "#ffffff",
  bg: "#f7f6f3",
  accent: "#4f46e5",
  border: "#e6e4dd",
  page: PAGE_NODE_COLOR,
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
const LABEL_FONT_FAMILY = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
/** Gap between a node and its label, and the label line height (CSS px). */
const LABEL_GAP_PX = 4;
const LABEL_LINE_PX = 14;
const MAX_LABEL_CHARS = 22;
/** #xb4b54gr: how much of its area's colour a page dot in a shaded cluster takes (the rest is the page grey). */
const CLUSTER_DOT_SHARE = 0.6;
/** Dash for links into a "not created yet" page (graph units, as before). */
const GHOST_LINK_DASH = [4, 3];

function readThemeColors(): ThemeColors {
  if (typeof window === "undefined") return FALLBACK_COLORS;
  const styles = getComputedStyle(document.documentElement);
  const read = (name: ThemeColorToken): string =>
    styles.getPropertyValue(`--${name}`).trim() || FALLBACK_COLORS[name];
  return {
    text: read("text"),
    muted: read("muted"),
    panel: read("panel"),
    bg: read("bg"),
    accent: read("accent"),
    border: read("border"),
    page: styles.getPropertyValue("--graph-page").trim() || PAGE_NODE_COLOR,
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

/** #xb4b54gr: relative luminance (0 black – 1 white) of a `#rgb`, `#rrggbb` or `rgb()` colour; 1 if unreadable. */
function luminance(color: string): number {
  const rgb = rgbOf(color);
  if (!rgb) return 1;
  const [r, g, b] = rgb.map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
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

/** Per-node drawing data, computed once per data/theme change, not per frame. */
interface NodeStyle {
  /** Drawn radius in CSS px (half the emoji size for icon nodes). */
  radius: number;
  ghost: boolean;
  /** A whiteboard (spec/whiteboard §2): drawn as a rounded square. */
  board: boolean;
  /** Pre-rendered page icon (#emmyabbj); drawn instead of the dot. */
  emoji: HTMLCanvasElement | null;
  /** Fill colour (pages only). */
  fill: string;
  /** Truncated label text. */
  label: string;
  /** Label width at LABEL_FONT_PX, in CSS px (for label-aware fitting). */
  labelWidth: number;
  tooltip: string;
}

let measureContext: CanvasRenderingContext2D | null | undefined;

/** Width of a label in CSS px; a rough estimate where canvas text isn't available. */
function measureLabel(text: string): number {
  if (measureContext === undefined) {
    measureContext =
      typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
    if (measureContext) measureContext.font = `${LABEL_FONT_PX}px ${LABEL_FONT_FAMILY}`;
  }
  return measureContext ? measureContext.measureText(text).width : text.length * LABEL_FONT_PX * 0.56;
}

type PositionedNode = CanvasNode & { x?: number; y?: number; vx?: number; vy?: number; fx?: number; fy?: number };

interface DragState {
  node: PositionedNode;
  pointerId: number;
  startX: number;
  startY: number;
  /** Graph-space offset from the pointer to the node centre, kept while dragging. */
  offsetX: number;
  offsetY: number;
  moved: boolean;
}

const TOOLTIP_OFFSET_X = 14;
const TOOLTIP_OFFSET_Y = 16;

/** Shared canvas for the global graph and the local panel. */
export function GraphCanvas({
  nodes,
  links,
  highlightId = null,
  centerId = null,
  testId,
  ariaLabel,
  showControls = false,
  reducedMotion = false,
  onOpenPage,
  onCreatePage,
  colorOf,
  clusterMode = "off",
  onClustersFound,
}: GraphCanvasProps) {
  useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraphMethods<CanvasNode, GraphLink> | undefined>(undefined);
  const fitTimer = useRef<number | null>(null);
  const size = useElementSize(containerRef);
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const colors = useThemeColors();
  const [ready, setReady] = useState(false);
  /** A worker layout is running (its end, not the settle timer, makes the view ready). */
  const workerRunning = useRef(false);
  /** Bumped on every applied fit; lets tests (and debugging) observe refits. */
  const [fitGeneration, setFitGeneration] = useState(0);
  /** Why the last fit happened (data, resize, settle, engine, button); for tests and debugging. */
  const [fitReason, setFitReason] = useState("");
  /** The physics engine has stopped since the data last changed (tests wait for it). */
  const [engineStopped, setEngineStopped] = useState(false);
  /**
   * #g95wkd9y: big graphs are laid out in a worker (force-graph's own engine is
   * off); small ones keep force-graph's engine, unchanged.
   */
  const engine = engineTicks(nodes.length, reducedMotion);
  /** Bumped when the worker sends positions: requests a redraw. */
  const [layoutFrame, setLayoutFrame] = useState(0);
  /** A big graph being laid out without streaming: its progress (0–1), else null. */
  const [arranging, setArranging] = useState<number | null>(null);

  const [hoveredId, setHoveredId] = useState<string | null>(null);
  /** Set once the user zooms, pans or drags: auto-fit then stops moving the camera. */
  const userViewRef = useRef(false);
  /** Highest alpha the forces see (see `capAlpha`); lowered while dragging. */
  const alphaCapRef = useRef(Number.POSITIVE_INFINITY);

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
    () => nodes.reduce((max, node) => Math.max(max, countOf(node)), 0),
    [nodes],
  );

  const ghostById = useMemo(
    () => new Map(nodes.filter((node) => isGhostId(node.id)).map((node) => [node.id, node as GhostNode])),
    [nodes],
  );

  /**
   * #xb4b54gr: the drawn nodes' clusters. Recomputed only when what they're
   * computed from changes (node ids, links, and the folder or tag in those
   * modes), not on every page-list poll; colours keep their slot across runs.
   */
  const clusterNodes = useMemo<ClusterNode[]>(
    () =>
      nodes.map((node) => {
        const page = !isGhostId(node.id) && !isTagNodeId(node.id) && !isAttachmentNodeId(node.id);
        const meta = node as GraphNode;
        return { id: node.id, clusterable: page, parentId: page ? (meta.parentId ?? null) : null, tags: page ? (meta.tags ?? []) : [] };
      }),
    [nodes],
  );
  /** Re-cluster (and re-lay out) only when the mode or the drawn content changes (see clusterKeyFor). */
  const clusterKey = useMemo(() => clusterKeyFor(clusterMode, dataKey, clusterNodes), [clusterMode, dataKey, clusterNodes]);
  const previousSlots = useRef<Map<string, number>>(new Map());
  /** Big graphs in links mode: Louvain runs in the layout worker, which posts the clusters back. */
  const clustersInWorker = engine.worker && clusterMode === "links";
  const [workerClusters, setWorkerClusters] = useState<{ key: string; clusters: Clusters } | null>(null);
  const clusterKeyRef = useRef(clusterKey);
  clusterKeyRef.current = clusterKey;
  const { clusters, clusterSlots } = useMemo(() => {
    if (clusterMode === "off") {
      previousSlots.current = new Map();
      return { clusters: NO_CLUSTERS, clusterSlots: [] as number[] };
    }
    const next = clustersInWorker
      ? workerClusters !== null && workerClusters.key === clusterKey
        ? workerClusters.clusters
        : NO_CLUSTERS
      : computeClusters(clusterMode, clusterNodes, links);
    const { slots, byId } = colorSlots(next, clusterNodes.map((node) => node.id), previousSlots.current);
    previousSlots.current = byId;
    return { clusters: next, clusterSlots: slots };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterKey, clustersInWorker, workerClusters]);
  const clustersRef = useRef(clusters);
  clustersRef.current = clusters;
  // Report what was found once the mode's answer is in (in the worker's case, when it arrives).
  const clustersAnswered = !clustersInWorker || (workerClusters !== null && workerClusters.key === clusterKey);
  useEffect(() => {
    if (clusterMode === "off" || !clustersAnswered || nodes.length === 0) return;
    onClustersFound?.({ mode: clusterMode, groups: clusters.list.length });
  }, [clusters, clusterMode, clustersAnswered, nodes.length, onClustersFound]);
  const clusterSlotsRef = useRef(clusterSlots);
  clusterSlotsRef.current = clusterSlots;
  /** Cluster by node id (force-graph's engine hands the force node objects). */
  const clusterById = useMemo(() => {
    const byId = new Map<string, number>();
    nodes.forEach((node, i) => {
      const c = clusters.of[i] ?? -1;
      if (c >= 0) byId.set(node.id, c);
    });
    return byId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusters]);

  const nodeStyles = useMemo(() => {
    const styles = new Map<string, NodeStyle>();
    // A user group's or the first tag's colour wins; else a page in a shaded cluster takes a tint of its
    // area's colour (#xb4b54gr, @lead), so the dots say which group they're in, not only the area.
    const fillOf = (node: GraphNode): string => {
      const own = colorOf?.(node, colors.palette) ?? nodeColor(node, colors.palette, colors.page);
      const c = clusterById.get(node.id);
      if (own !== colors.page || c === undefined) return own;
      const area = colors.palette[(clusterSlots[c] ?? c) % colors.palette.length];
      return area ? mixColors(area, colors.page, CLUSTER_DOT_SHARE) : own;
    };
    for (const node of nodes) {
      const ghost = isGhostId(node.id);
      const title = titleOf(node);
      const truncated = title.length > MAX_LABEL_CHARS;
      const label = truncated ? `${title.slice(0, MAX_LABEL_CHARS - 1)}…` : title;
      const detail = ghost ? ghostDetail(node as GhostNode) : nodeDetail(node as GraphNode);
      const dotRadius = nodeRadius(countOf(node), maxCount);
      const icon = ghost ? null : normaliseIcon((node as GraphNode).icon);
      const emoji = icon ? emojiSprite(icon) : null;
      styles.set(node.id, {
        // An emoji node is a bit bigger than its dot so the icon reads, and
        // still grows with links; picking, rings, labels and fit use it.
        radius: emoji ? emojiNodeSize(dotRadius) / 2 : dotRadius,
        ghost,
        board: !ghost && (node as GraphNode).kind === "whiteboard",
        emoji,
        fill: ghost ? "" : fillOf(node as GraphNode),
        label,
        labelWidth: measureLabel(label),
        // The hovered node's label already shows the title; only repeat it
        // when the label had to be truncated.
        tooltip: truncated ? `${title} · ${detail}` : detail,
      });
    }
    return styles;
  }, [nodes, maxCount, colors.palette, colors.page, colorOf, clusterById, clusterSlots]);

  /** Labels drawn when nothing is hovered: what the fit has to keep in view. */
  const restingLabelIds = useMemo(
    () =>
      labelledIds(
        nodes.map((node) => ({ id: node.id, count: countOf(node) })),
        null,
        new Set<string>(),
      ),
    [nodes],
  );

  /** Link colours parsed once per theme, not once per link per frame. */
  const linkPaint = useMemo(
    () => ({
      idle: withAlpha(colors.muted, 0.32),
      faded: withAlpha(colors.muted, 0.08),
      active: withAlpha(colors.accent, 0.85),
      halo: withAlpha(colors.accent, 0.14),
      labelHalo: withAlpha(colors.panel, 0.82),
    }),
    [colors],
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
    const bare: FitItem[] = [];
    const withLabels: FitItem[] = [];
    let focus: PositionedNode | null = null;

    for (const node of nodes as PositionedNode[]) {
      const { x, y } = node;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const px = x as number;
      const py = y as number;
      minX = Math.min(minX, px);
      maxX = Math.max(maxX, px);
      minY = Math.min(minY, py);
      maxY = Math.max(maxY, py);
      if (centerId !== null && node.id === centerId) focus = node;

      const style = nodeStyles.get(node.id);
      const r = style?.radius ?? 4;
      // Without labels: the node plus the old fixed label allowance below it.
      bare.push({ x: px, y: py, left: r, right: r, top: r, bottom: r + LABEL_ALLOWANCE });
      // With labels: the full label width and height (labels can be wide).
      const pinned = node.id === highlightId || node.id === centerId;
      const labelled = style && (restingLabelIds.has(node.id) || pinned);
      const half = labelled ? Math.max(r, style.labelWidth / 2 + 2) : r;
      withLabels.push({
        x: px,
        y: py,
        left: half,
        right: half,
        top: r,
        bottom: labelled ? r + LABEL_GAP_PX + LABEL_LINE_PX : r,
      });
    }
    if (minX > maxX) return null;

    // Local graph: the current page is the centre of the view; otherwise the
    // middle of the drawing.
    const centerX = focus ? (focus.x as number) : (minX + maxX) / 2;
    const centerY = focus ? (focus.y as number) : (minY + maxY) / 2;
    const halfWidth = width / 2 - FIT_PADDING;
    const halfHeight = height / 2 - FIT_PADDING;

    // Labels only show from LABEL_FADE_START on. If the graph only fits below
    // that zoom, they are hidden anyway and only the nodes have to fit.
    const labelZoom = fitZoom(withLabels, centerX, centerY, halfWidth, halfHeight);
    const zoom =
      labelZoom >= LABEL_FADE_START
        ? labelZoom
        : Math.min(fitZoom(bare, centerX, centerY, halfWidth, halfHeight), LABEL_FADE_START);

    return {
      centerX,
      centerY,
      zoom: clamp(Number.isFinite(zoom) ? zoom : MAX_FIT_ZOOM, MIN_FIT_ZOOM, MAX_FIT_ZOOM),
    };
  }, [nodes, nodeStyles, restingLabelIds, centerId, highlightId]);

  // The running camera animation (fit), if any. force-graph's own animated
  // `centerAt`/`zoom` can't be cancelled and keep writing the camera every
  // frame, so a pan started while a fit was running snapped back when the
  // layout settled. Ours stops as soon as the user takes the camera.
  const cameraFrame = useRef<number | null>(null);

  const stopCameraAnimation = useCallback((): void => {
    if (cameraFrame.current !== null) window.cancelAnimationFrame(cameraFrame.current);
    cameraFrame.current = null;
  }, []);

  const moveCamera = useCallback(
    (target: { centerX: number; centerY: number; zoom: number }, duration: number): void => {
      const graph = graphRef.current;
      if (!graph) return;
      stopCameraAnimation();
      const apply = (x: number, y: number, k: number) => {
        graph.zoom(k);
        graph.centerAt(x, y);
      };
      if (duration <= 0) {
        apply(target.centerX, target.centerY, target.zoom);
        return;
      }
      const from = { ...graph.centerAt(), k: graph.zoom() };
      const start = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / duration);
        const eased = t * (2 - t); // quadratic ease-out, like force-graph's
        apply(
          from.x + (target.centerX - from.x) * eased,
          from.y + (target.centerY - from.y) * eased,
          from.k + (target.zoom - from.k) * eased,
        );
        cameraFrame.current = t < 1 ? window.requestAnimationFrame(step) : null;
      };
      cameraFrame.current = window.requestAnimationFrame(step);
    },
    [stopCameraAnimation],
  );

  useEffect(() => stopCameraAnimation, [stopCameraAnimation]);

  const fitView = useCallback(
    (duration: number, reason: string): void => {
      const graph = graphRef.current;
      const target = fitTarget();
      if (!graph || !target) return;
      moveCamera(target, duration);
      // The camera is "auto" again until the user moves it.
      userViewRef.current = false;
      setFitGeneration((generation) => generation + 1);
      setFitReason(reason);
    },
    [fitTarget, moveCamera],
  );

  /** Fit only if the user hasn't zoomed, panned or dragged since the last fit. */
  const autoFit = useCallback(
    (duration: number, reason: string): void => {
      if (!userViewRef.current) fitView(duration, reason);
    },
    [fitView],
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
    (duration: number, markReady: boolean, reason: string): void => {
      if (typeof window === "undefined") return;
      if (fitTimer.current !== null) window.clearTimeout(fitTimer.current);
      fitTimer.current = window.setTimeout(() => {
        fitTimer.current = null;
        fitView(duration, reason);
        if (markReady) setReady(true);
      }, 80);
    },
    [fitView],
  );

  const lastDataKey = useRef<string | null>(null);
  const lastSizeKey = useRef("");
  useEffect(() => {
    if (size.width <= 0 || size.height <= 0) return;
    const newData = lastDataKey.current !== dataKey;
    lastDataKey.current = dataKey;
    const sizeKey = `${size.width}x${size.height}`;
    const resized = lastSizeKey.current !== sizeKey;
    lastSizeKey.current = sizeKey;
    if (newData) {
      setReady(false);
      setEngineStopped(false);
      alphaCapRef.current = Number.POSITIVE_INFINITY;
    }

    // Draw the whole graph immediately (even while physics is still moving)…
    scheduleFit(0, false, newData ? "data" : resized ? "resize" : "inputs");
    // …and mark the view ready once the layout has settled. Resize has no
    // engine stop, so it settles after the tween; new data normally settles on
    // `onEngineStop`, with a fallback if the engine reports nothing.
    clearSettleTimer();
    settleTimer.current = window.setTimeout(() => {
      settleTimer.current = null;
      autoFit(0, "settle");
      // A worker layout still running hasn't settled: it marks ready itself when done
      // (else `data-graph-ready` said true ~8 s into a 30 s layout on the 10k vault).
      if (!workerRunning.current) setReady(true);
    }, newData ? 4000 : 600);

    return () => {
      if (fitTimer.current !== null) window.clearTimeout(fitTimer.current);
      fitTimer.current = null;
      clearSettleTimer();
    };
  }, [dataKey, size.width, size.height, scheduleFit, autoFit, clearSettleTimer]);

  // Physics: springy but calm, and every component (even a page with no links)
  // is pulled towards the middle so auto-fit never has to chase a far corner.
  // Deliberately *not* re-run on resize: reheating would move a settled graph
  // right after the resize fit and leave nodes outside the new viewport.
  const hasSize = size.width > 0;
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || !hasSize) return;

    const link = graph.d3Force("link") as AlphaForce | undefined;
    (link?.distance as ((value: number) => unknown) | undefined)?.(52);
    // #xb4b54gr: links between clusters are relaxed, so groups sit apart (big graphs: in the worker).
    const clustered = clusterById.size > 0 && !engine.worker;
    const endId = (end: unknown) => (typeof end === "object" && end !== null ? (end as { id: string }).id : String(end));
    (link?.strength as ((value: number | ((link: { source: unknown; target: unknown }) => number)) => unknown) | undefined)?.(
      clustered
        ? (edge) => 0.45 * clusterLinkFactor(clusterById.get(endId(edge.source)) ?? -1, clusterById.get(endId(edge.target)) ?? -1)
        : 0.45,
    );
    if (link) graph.d3Force("link", capAlpha(link, alphaCapRef) as never);

    const charge = graph.d3Force("charge") as AlphaForce | undefined;
    (charge?.strength as ((value: number) => unknown) | undefined)?.(
      -60 - Math.min(180, nodes.length * 0.6),
    );
    (charge?.distanceMax as ((value: number) => unknown) | undefined)?.(1400);
    if (charge) graph.d3Force("charge", capAlpha(charge, alphaCapRef) as never);

    // Small vaults need a firmer centring pull so an isolated page doesn't
    // drift away from a 3-node cluster; big vaults stay airy.
    const centerStrength = nodes.length <= 12 ? 0.22 : nodes.length <= 60 ? 0.16 : 0.12;
    // Local graph: pin the current page in the middle, and shape the layout
    // like the (tall, narrow) panel instead of a circle that leaves half of it
    // empty (#z5abndiz).
    let stretchX = 1;
    let stretchY = 1;
    if (centerId !== null) {
      const focus = nodes.find((node) => node.id === centerId) as PositionedNode | undefined;
      if (focus) {
        focus.fx = 0;
        focus.fy = 0;
      }
      // Only with enough nodes to fill an area: a 2–3 node star would just
      // collapse into a line along the panel's long side.
      if (nodes.length >= 5) {
        const { width, height } = sizeRef.current;
        const aspect = clamp(height / Math.max(1, width), 0.5, 2.5);
        stretchX = aspect ** 0.35;
        stretchY = 1 / stretchX;
      }
    }
    graph.d3Force(
      "x",
      capAlpha(axisForce("x", centerStrength * stretchX) as never, alphaCapRef) as never,
    );
    graph.d3Force(
      "y",
      capAlpha(axisForce("y", centerStrength * stretchY) as never, alphaCapRef) as never,
    );
    // #xb4b54gr: clusters held together and apart (big graphs: in the worker).
    graph.d3Force(
      "cluster",
      clusterById.size > 0 && !engine.worker
        ? (capAlpha(
            forceCluster<PositionedNode>((node) => clusterById.get(node.id) ?? -1) as never,
            alphaCapRef,
          ) as never)
        : null,
    );
    // The worker lays out big graphs: reheating force-graph's engine would run
    // its ticks on the main thread (#g95wkd9y).
    if (!engine.worker) graph.d3ReheatSimulation();
  }, [dataKey, hasSize, nodes, centerId, engine.worker, clusterById]);

  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const nodeStylesRef = useRef(nodeStyles);
  nodeStylesRef.current = nodeStyles;
  const ghostByIdRef = useRef(ghostById);
  ghostByIdRef.current = ghostById;
  const hoveredRef = useRef(hoveredId);
  hoveredRef.current = hoveredId;
  const centerIdRef = useRef(centerId);
  centerIdRef.current = centerId;

  // Dev/e2e-only probe: node positions in container CSS px.
  useEffect(() => {
    if (!import.meta.env.DEV || typeof window === "undefined") return;
    const registry = ((window as unknown as { __gumplyGraphs?: Record<string, unknown> })
      .__gumplyGraphs ??= {});
    registry[testId] = {
      nodes: () => {
        const graph = graphRef.current;
        if (!graph) return [];
        return nodesRef.current.map((node) => {
          const positioned = node as PositionedNode;
          const point = graph.graph2ScreenCoords(positioned.x ?? 0, positioned.y ?? 0);
          return {
            id: node.id,
            x: point.x,
            y: point.y,
            r: nodeStylesRef.current.get(node.id)?.radius ?? 0,
            board: nodeStylesRef.current.get(node.id)?.board ?? false,
          };
        });
      },
      zoom: () => graphRef.current?.zoom() ?? 1,
      hovered: () => hoveredRef.current,
      // #xb4b54gr: the groups drawn (sizes, biggest first) and the clusters key.
      clusters: () => ({ sizes: clustersRef.current.list.map((info) => info.size), modularity: clustersRef.current.modularity ?? null }),
    };
    return () => {
      delete registry[testId];
    };
  }, [testId]);

  /**
   * Draws every node and label in one pass after the links, batched by colour
   * (one fill per tag colour instead of one per node) and skipping nodes outside
   * the viewport. Replaces force-graph's per-node `nodeCanvasObject` calls.
   */
  const drawNodes = useCallback(
    (ctx: CanvasRenderingContext2D, scale: number): void => {
      const k = Math.max(scale, 0.05);
      const styles = nodeStylesRef.current;
      const transform = ctx.getTransform();
      const dpr = transform.a / k || 1;
      const bounds = visibleBounds(transform, ctx.canvas.width, ctx.canvas.height, 80 * dpr);

      const fade = clamp((scale - LABEL_FADE_START) / (LABEL_FADE_END - LABEL_FADE_START), 0, 1);
      const dimmedPass: Array<[PositionedNode, NodeStyle]> = [];
      const brightPass: Array<[PositionedNode, NodeStyle]> = [];
      for (const node of nodesRef.current as PositionedNode[]) {
        const x = node.x;
        const y = node.y;
        if (x === undefined || y === undefined) continue;
        if (x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY) continue;
        const style = styles.get(node.id);
        if (!style) continue;
        (hoveredId !== null && node.id !== hoveredId && !neighbours.has(node.id)
          ? dimmedPass
          : brightPass
        ).push([node, style]);
      }

      ctx.save();

      // Soft halo for the page the user came from, like Obsidian's active note.
      const highlighted = highlightId
        ? (nodesRef.current.find((node) => node.id === highlightId) as PositionedNode | undefined)
        : undefined;
      const highlightStyle = highlightId ? styles.get(highlightId) : undefined;
      if (highlighted?.x !== undefined && highlighted.y !== undefined && highlightStyle) {
        const dimmed =
          hoveredId !== null && highlightId !== hoveredId && !neighbours.has(highlightId as string);
        ctx.globalAlpha = dimmed ? 0.18 : 1;
        ctx.beginPath();
        ctx.arc(highlighted.x, highlighted.y, (highlightStyle.radius + 6) / k, 0, Math.PI * 2);
        ctx.fillStyle = linkPaint.halo;
        ctx.fill();
      }

      const paintCircles = (items: Array<[PositionedNode, NodeStyle]>, alpha: number): void => {
        if (items.length === 0) return;
        ctx.globalAlpha = alpha;
        const fills = new Map<string, Path2D>();
        const outlines = new Path2D();
        const ghosts = new Path2D();
        let ghostCount = 0;
        const emojis: Array<[number, number, number, HTMLCanvasElement, boolean]> = [];
        for (const [node, style] of items) {
          const x = node.x as number;
          const y = node.y as number;
          const r = style.radius / k;
          if (style.emoji) {
            emojis.push([x, y, r, style.emoji, style.board]);
            continue;
          }
          if (style.ghost) {
            ghosts.moveTo(x + r, y);
            ghosts.arc(x, y, r, 0, Math.PI * 2);
            ghostCount += 1;
            continue;
          }
          let path = fills.get(style.fill);
          if (!path) {
            path = new Path2D();
            fills.set(style.fill, path);
          }
          if (style.board) {
            // A rounded square around the dot's circle: boards read apart at a glance.
            path.roundRect(x - r, y - r, r * 2, r * 2, r * 0.3);
            outlines.roundRect(x - r, y - r, r * 2, r * 2, r * 0.3);
            continue;
          }
          path.moveTo(x + r, y);
          path.arc(x, y, r, 0, Math.PI * 2);
          outlines.moveTo(x + r, y);
          outlines.arc(x, y, r, 0, Math.PI * 2);
        }
        for (const [fill, path] of fills) {
          ctx.fillStyle = fill;
          ctx.fill(path);
        }
        if (fills.size > 0) {
          ctx.lineWidth = 1.2 / k;
          ctx.strokeStyle = colors.panel;
          ctx.stroke(outlines);
        }
        if (ghostCount > 0) {
          ctx.setLineDash([4 / k, 3 / k]);
          ctx.lineWidth = 1.4 / k;
          ctx.strokeStyle = colors.muted;
          ctx.stroke(ghosts);
          ctx.setLineDash([]);
        }
        // Page icons: one drawImage of a cached sprite each, no text shaping.
        if (emojis.length > 0) {
          // A disc in the canvas colour first, so link ends don't show
          // through thin or transparent glyphs (🕸, ✈️ …).
          const backs = new Path2D();
          const boardFrames = new Path2D();
          let boardIcons = 0;
          for (const [x, y, r, , board] of emojis) {
            if (board) {
              // An icon board keeps its square shape: a framed tile behind it.
              backs.roundRect(x - r, y - r, r * 2, r * 2, r * 0.4);
              boardFrames.roundRect(x - r, y - r, r * 2, r * 2, r * 0.4);
              boardIcons += 1;
              continue;
            }
            backs.moveTo(x + r * 0.85, y);
            backs.arc(x, y, r * 0.85, 0, Math.PI * 2);
          }
          ctx.fillStyle = colors.bg;
          ctx.fill(backs);
          if (boardIcons > 0) {
            ctx.lineWidth = 1.2 / k;
            ctx.strokeStyle = colors.muted;
            ctx.stroke(boardFrames);
          }
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = "high";
          for (const [x, y, r, sprite, board] of emojis) {
            // Inset a little inside a board's tile so the frame shows.
            const size = board ? r * 1.6 : r * 2;
            ctx.drawImage(sprite, x - size / 2, y - size / 2, size, size);
          }
        }
      };
      paintCircles(dimmedPass, 0.18);
      paintCircles(brightPass, 1);

      // Accent ring: current page and hovered node.
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1.6 / k;
      ctx.strokeStyle = colors.accent;
      for (const [node, style] of brightPass) {
        if (node.id !== highlightId && node.id !== hoveredId) continue;
        ctx.beginPath();
        ctx.arc(node.x as number, node.y as number, (style.radius + 3) / k, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Labels last, so they sit above every node (Obsidian does the same).
      const labelled = labelIds;
      ctx.font = `${LABEL_FONT_PX / k}px ${LABEL_FONT_FAMILY}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.lineJoin = "round";
      ctx.lineWidth = 3 / k;
      ctx.strokeStyle = linkPaint.labelHalo;
      const paintLabels = (items: Array<[PositionedNode, NodeStyle]>, dimmed: boolean): void => {
        for (const [node, style] of items) {
          const id = node.id;
          if (!labelled.has(id) && highlightId !== id) continue;
          const pinned = id === hoveredId || id === highlightId;
          const alpha = dimmed ? 0.18 : pinned ? 1 : fade;
          if (alpha <= 0.02) continue;
          ctx.globalAlpha = alpha;
          const x = node.x as number;
          const y = (node.y as number) + (style.radius + LABEL_GAP_PX) / k;
          ctx.strokeText(style.label, x, y);
          ctx.fillStyle = style.ghost ? colors.muted : colors.text;
          ctx.fillText(style.label, x, y);
        }
      };
      paintLabels(dimmedPass, true);
      paintLabels(brightPass, false);

      ctx.restore();
    },
    [colors, highlightId, hoveredId, neighbours, labelIds, linkPaint],
  );

  /**
   * #xb4b54gr: a soft rounded area behind each cluster, before the links: a
   * palette colour at low opacity with a faint edge, no name (@plony). Hulls
   * are recomputed only when positions change (each engine tick, or each
   * worker update).
   */
  const hullCache = useRef<{ key: string; hulls: Array<Array<[number, number]>> } | null>(null);
  const dark = useMemo(() => luminance(colors.bg) < 0.4, [colors.bg]);
  const drawClusters = useCallback(
    (ctx: CanvasRenderingContext2D, scale: number): void => {
      const { of, list } = clustersRef.current;
      if (list.length === 0) return;
      const drawn = nodesRef.current as PositionedNode[];
      const k = Math.max(scale, 0.05);
      // A worker-laid graph only moves on its updates; the engine moves every tick.
      const key = engine.worker ? `${layoutFrame}|${drawn.length}|${clusterKey}` : "";
      let hulls = hullCache.current && key !== "" && hullCache.current.key === key ? hullCache.current.hulls : null;
      if (!hulls) {
        const points: Array<Array<[number, number]>> = list.map(() => []);
        drawn.forEach((node, i) => {
          const c = of[i] ?? -1;
          if (c < 0 || node.x === undefined || node.y === undefined) return;
          points[c]!.push([node.x, node.y]);
        });
        hulls = points.map((set) => convexHull(corePoints(set)));
        hullCache.current = { key, hulls };
      }
      // Room around the outermost pages: mostly constant on screen, so a zoomed-in area stays snug.
      const pad = 4 + 16 / k;
      const fill = dark ? 0.12 : 0.075;
      const edge = dark ? 0.28 : 0.2;
      const dimmed = hoveredId !== null;
      // Areas never overlap: hulls that would touch are cut apart (cheap: C ≤ 40).
      const shapes = separateHulls(hulls, pad);
      ctx.save();
      shapes.forEach((hull, c) => {
        if (hull.length === 0) return;
        const slot = clusterSlotsRef.current[c] ?? c;
        const color = colors.palette[slot % colors.palette.length] ?? colors.accent;
        ctx.beginPath();
        traceRoundedHull(ctx, hull, pad);
        // Opacity through globalAlpha: theme colours may be rgb() as well as hex.
        // Tighter groups read stronger: the per-cluster strength (0.2–1) maps to 0.52–1 of the tint, so a
        // loose group of a connected web stays visible (the force uses the raw strength). Half while a node is hovered.
        const strength = (dimmed ? 0.5 : 1) * (0.4 + 0.6 * (clustersRef.current.list[c]?.strength ?? 1));
        ctx.globalAlpha = fill * strength;
        ctx.fillStyle = color;
        ctx.fill();
        ctx.globalAlpha = edge * strength;
        ctx.lineWidth = 1 / k;
        ctx.strokeStyle = color;
        ctx.stroke();
      });
      ctx.restore();
    },
    [colors, dark, engine.worker, layoutFrame, hoveredId, clusterKey],
  );

  /**
   * force-graph only repaints when it thinks something changed. Our node layer
   * is drawn in `onRenderFramePost`, so hand it a new (no-op) node accessor
   * whenever that layer's inputs change: that prop change requests a redraw.
   */
  const hideBuiltInNodes = useMemo(() => {
    void drawNodes;
    void drawClusters;
    void nodeStyles;
    void layoutFrame;
    return () => false;
  }, [drawNodes, drawClusters, nodeStyles, layoutFrame]);

  const handleNodeClick = useCallback(
    (node: CanvasNode) => {
      const ghost = ghostByIdRef.current.get(node.id);
      if (ghost) {
        if (onCreatePage) onCreatePage(ghost.title);
        return;
      }
      onOpenPage(node.id);
    },
    [onCreatePage, onOpenPage],
  );
  const handleNodeClickRef = useRef(handleNodeClick);
  handleNodeClickRef.current = handleNodeClick;

  /**
   * Pointer handling (#74jpajdy): hover, click and drag pick nodes against
   * their live positions with a ≥28 px target (see graph-interaction.ts).
   * A press on a node is kept away from d3-zoom, so it drags the node instead
   * of panning; a press on empty canvas still pans.
   */
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let drag: DragState | null = null;
    let lastPointer: { x: number; y: number } | null = null;
    let hoverFrame = 0;

    const local = (event: PointerEvent | MouseEvent): { x: number; y: number } => {
      const rect = container.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    const pick = (point: { x: number; y: number }): PositionedNode | null => {
      const graph = graphRef.current;
      if (!graph) return null;
      const g = graph.screen2GraphCoords(point.x, point.y);
      const styles = nodeStylesRef.current;
      return pickNode(nodesRef.current as PositionedNode[], g.x, g.y, graph.zoom(), (node) =>
        styles.get(node.id)?.radius ?? 0,
      );
    };

    const showTooltip = (node: PositionedNode | null, point: { x: number; y: number } | null): void => {
      const tip = tooltipRef.current;
      if (!tip) return;
      const text = node ? nodeStylesRef.current.get(node.id)?.tooltip : undefined;
      if (!text || !point) {
        tip.hidden = true;
        return;
      }
      if (tip.textContent !== text) tip.textContent = text;
      tip.hidden = false;
      // Above the pointer: the node's label sits below the node, so a tooltip
      // underneath would cover it.
      const maxX = container.clientWidth - tip.offsetWidth - 8;
      const maxY = container.clientHeight - tip.offsetHeight - 8;
      const x = clamp(point.x + TOOLTIP_OFFSET_X, 8, Math.max(8, maxX));
      const above = point.y - tip.offsetHeight - TOOLTIP_OFFSET_Y;
      const y = above >= 8 ? above : Math.min(maxY, point.y + TOOLTIP_OFFSET_Y + LABEL_LINE_PX);
      tip.style.transform = `translate(${x}px, ${y}px)`;
    };

    const setHover = (node: PositionedNode | null): void => {
      const id = node ? node.id : null;
      if (hoveredRef.current !== id) {
        hoveredRef.current = id;
        setHoveredId(id);
      }
      container.style.cursor = drag?.moved ? "grabbing" : node ? "pointer" : "";
    };

    const updateHover = (): void => {
      hoverFrame = 0;
      if (drag || !lastPointer) return;
      const node = pick(lastPointer);
      setHover(node);
      showTooltip(node, lastPointer);
    };

    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0 || !event.isPrimary) return;
      // Pan or node drag: the user has the camera now; stop any running fit.
      stopCameraAnimation();
      const point = local(event);
      const node = pick(point);
      const graph = graphRef.current;
      if (!node || !graph) return;
      const g = graph.screen2GraphCoords(point.x, point.y);
      drag = {
        node,
        pointerId: event.pointerId,
        startX: point.x,
        startY: point.y,
        offsetX: (node.x ?? g.x) - g.x,
        offsetY: (node.y ?? g.y) - g.y,
        moved: false,
      };
      container.setPointerCapture?.(event.pointerId);
    };

    // d3-zoom (pan) and force-graph listen for mousedown on the canvas: a press
    // that starts on a node must not reach them.
    const onMouseDown = (event: MouseEvent): void => {
      if (!drag) return;
      event.stopPropagation();
      event.preventDefault();
    };

    const onPointerMove = (event: PointerEvent): void => {
      const point = local(event);
      lastPointer = point;
      if (drag && event.pointerId === drag.pointerId) {
        const graph = graphRef.current;
        if (!graph) return;
        if (!drag.moved) {
          if (Math.hypot(point.x - drag.startX, point.y - drag.startY) < DRAG_THRESHOLD_PX) return;
          drag.moved = true;
          userViewRef.current = true;
          alphaCapRef.current = DRAG_ALPHA;
          showTooltip(null, null);
          setHover(drag.node);
        }
        const g = graph.screen2GraphCoords(point.x, point.y);
        drag.node.fx = drag.node.x = g.x + drag.offsetX;
        drag.node.fy = drag.node.y = g.y + drag.offsetY;
        // Keep the simulation awake (alpha is capped, so this stays calm).
        graph.d3ReheatSimulation();
        return;
      }
      if (event.buttons !== 0) {
        // Panning the background: the user owns the camera now.
        userViewRef.current = true;
        showTooltip(null, null);
        return;
      }
      if (!hoverFrame) hoverFrame = window.requestAnimationFrame(updateHover);
    };

    const endDrag = (event: PointerEvent, cancelled: boolean): void => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const { node, moved } = drag;
      drag = null;
      if (container.hasPointerCapture?.(event.pointerId)) {
        container.releasePointerCapture(event.pointerId);
      }
      if (moved) {
        // Release the node (Obsidian-like); the local graph's centre page
        // stays pinned where it was dropped.
        if (node.id !== centerIdRef.current) {
          node.fx = undefined;
          node.fy = undefined;
        }
        // Let neighbours settle; alpha stays capped until the engine stops.
        graphRef.current?.d3ReheatSimulation();
      } else if (!cancelled) {
        handleNodeClickRef.current(node);
      }
      const point = local(event);
      lastPointer = point;
      const hovered = pick(point);
      setHover(hovered);
      showTooltip(hovered, point);
    };

    const onPointerUp = (event: PointerEvent): void => endDrag(event, false);
    const onPointerCancel = (event: PointerEvent): void => endDrag(event, true);

    const onPointerLeave = (): void => {
      if (drag) return;
      lastPointer = null;
      setHover(null);
      showTooltip(null, null);
    };

    const onWheel = (): void => {
      stopCameraAnimation();
      userViewRef.current = true;
    };

    container.addEventListener("pointerdown", onPointerDown, true);
    container.addEventListener("mousedown", onMouseDown, true);
    container.addEventListener("pointermove", onPointerMove);
    container.addEventListener("pointerup", onPointerUp);
    container.addEventListener("pointercancel", onPointerCancel);
    container.addEventListener("pointerleave", onPointerLeave);
    container.addEventListener("wheel", onWheel, { capture: true, passive: true });
    return () => {
      if (hoverFrame) window.cancelAnimationFrame(hoverFrame);
      container.removeEventListener("pointerdown", onPointerDown, true);
      container.removeEventListener("mousedown", onMouseDown, true);
      container.removeEventListener("pointermove", onPointerMove);
      container.removeEventListener("pointerup", onPointerUp);
      container.removeEventListener("pointercancel", onPointerCancel);
      container.removeEventListener("pointerleave", onPointerLeave);
      container.removeEventListener("wheel", onWheel, true);
    };
  }, []);

  const settleLayout = useCallback(() => {
    clearSettleTimer();
    alphaCapRef.current = Number.POSITIVE_INFINITY;
    // Never yank the camera after the user zoomed, panned or dragged a node.
    autoFit(reducedMotion ? 0 : 300, "engine");
    setReady(true);
    setEngineStopped(true);
  }, [clearSettleTimer, autoFit, reducedMotion]);

  // With the worker laying the graph out, force-graph's engine (0 ticks)
  // "stops" at once: that isn't the layout settling.
  const handleEngineStop = useCallback(() => {
    if (!engine.worker) settleLayout();
  }, [engine.worker, settleLayout]);

  // #g95wkd9y: big graphs: the worker lays them out from where the nodes are
  // now (force-graph's start positions, or the last layout before a filter
  // change, so nothing jumps) and streams positions into the shared nodes.
  // Reduced motion: one update, when it has settled.
  const settleLayoutRef = useRef(settleLayout);
  settleLayoutRef.current = settleLayout;
  useEffect(() => {
    if (!engine.worker || !hasSize) return;
    workerRunning.current = true;
    // Every run, not only new data: a re-arrange (the centre page or reduced motion
    // changed) hasn't settled either; the worker's `done` marks ready again.
    setReady(false);
    setEngineStopped(false);
    const drawn = nodes as PositionedNode[];
    const { width, height } = sizeRef.current;
    const cluster = !clustersInWorker && clustersRef.current.list.length > 0 ? clustersRef.current.of : undefined;
    const input = layoutInputFor(drawn, links, {
      centerId,
      width,
      height,
      reducedMotion,
      ...(cluster ? { cluster } : {}),
    });
    if (clustersInWorker) {
      input.clusterLinks = {
        ids: drawn.map((node) => node.id),
        clusterable: Uint8Array.from(drawn, (node) => (isGhostId(node.id) || isTagNodeId(node.id) || isAttachmentNodeId(node.id) ? 0 : 1)),
      };
    }
    const runKey = clusterKeyRef.current;
    // Above STREAM_MAX_NODES (or with reduced motion) the graph is drawn once,
    // settled; meanwhile its start layout shows dimmed with a status. With a
    // layout cache, only once the cache has no layout for it (no "Arranging"
    // flash before a kept layout).
    const arrange = () => setArranging(input.stream ? null : 0);
    const place = (x: Float32Array, y: Float32Array) => {
      for (let i = 0; i < drawn.length; i += 1) {
        const node = drawn[i]!;
        node.x = x[i];
        node.y = y[i];
        node.vx = 0;
        node.vy = 0;
      }
      setLayoutFrame((frame) => frame + 1);
    };
    const settled = () => {
      workerRunning.current = false;
      setArranging(null);
      settleLayoutRef.current();
    };
    // N6 (#9x4duwmg): a big graph laid out before, unchanged, shows its kept
    // positions at once. The key is taken before the worker gets (and
    // detaches) the input's arrays.
    const store = cachesLayout(drawn.length) ? graphLayoutStore() : null;
    const keyStart = performance.now();
    // #xb4b54gr: the grouping (mode, and the folders or tags it uses) is part of the layout: in the key.
    const key = store ? layoutCacheKey(drawn.map((node) => node.id), input.links, `${centerId ?? ""}|${reducedMotion ? 1 : 0}|${runKey}`) : "";
    // Its main-thread cost, readable by the perf probes (`graph-layout-key`).
    if (store) performance.measure?.("graph-layout-key", { start: keyStart });
    let cancelled = false;
    let cancel: () => void = () => {};
    if (!store) arrange();
    // #xb4b54gr: the worker's clusters for this run, kept with its positions.
    let found: CachedClusters | undefined;
    const deliverClusters = (clusters: CachedClusters) =>
      setWorkerClusters({ key: runKey, clusters: { of: clusters.of, list: clusters.list, ...(clusters.modularity === undefined ? {} : { modularity: clusters.modularity }) } });
    void cachedLayout(store, key, drawn.length).then((kept) => {
      if (cancelled) return;
      // A kept layout without the clusters this mode needs from the worker is a miss.
      if (kept && (!clustersInWorker || kept.clusters)) {
        // The clusters first, then the positions: the same order as the worker's.
        if (clustersInWorker && kept.clusters) deliverClusters(kept.clusters);
        place(kept.x, kept.y);
        settled();
        return;
      }
      if (store) arrange();
      cancel = startLayout(input, (update) => {
        if (update.type === "clusters") {
          found = { of: update.of, list: update.list, ...(update.modularity === undefined ? {} : { modularity: update.modularity }) };
          deliverClusters(found);
          return;
        }
        if (update.type === "progress") {
          setArranging(update.progress);
          return;
        }
        place(update.x, update.y);
        if (update.done) {
          void keepLayout(store, key, { x: update.x, y: update.y, ...(found ? { clusters: found } : {}) });
          settled();
        }
      });
    });
    return () => {
      cancelled = true;
      workerRunning.current = false;
      cancel();
      setArranging(null);
    };
  }, [dataKey, engine.worker, hasSize, centerId, reducedMotion, clusterKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // force-graph/d3 rewrite `link.source/target` from ids into node objects.
  // Hand it copies: the model's links must keep their string ids, or the next
  // filter pass (`visibleIds.has(link.source)`) drops every link (#pyx74enx).
  // Nodes are shared on purpose so positions survive filtering.
  const graphData = useMemo(
    () => ({
      nodes: [...nodes],
      links: links.map((link) => ({ source: link.source, target: link.target })),
    }),
    [nodes, links],
  );

  const linkColor = useCallback(
    (link: LinkObject<CanvasNode, GraphLink>) => {
      if (hoveredId === null) return linkPaint.idle;
      const source = endpointId(link.source);
      const target = endpointId(link.target);
      return source === hoveredId || target === hoveredId ? linkPaint.active : linkPaint.faded;
    },
    [linkPaint, hoveredId],
  );

  const linkWidth = useCallback(
    (link: LinkObject<CanvasNode, GraphLink>) => {
      if (hoveredId === null) return 1;
      const source = endpointId(link.source);
      const target = endpointId(link.target);
      return source === hoveredId || target === hoveredId ? 1.7 : 1;
    },
    [hoveredId],
  );

  const linkLineDash = useCallback(
    (link: LinkObject<CanvasNode, GraphLink>) =>
      isGhostId(endpointId(link.target)) ? GHOST_LINK_DASH : null,
    [],
  );

  return (
    <div className="graph-canvas-wrap">
      {showControls ? (
        <div className="graph-controls" role="group" aria-label={t("graph.controls")}>
          <button
            type="button"
            className="graph-control"
            data-testid="graph-zoom-out"
            aria-label={t("board.zoomOut")}
            onClick={() => {
              const graph = graphRef.current;
              userViewRef.current = true;
              stopCameraAnimation();
              if (graph) graph.zoom(Math.max(0.06, graph.zoom() / 1.5), 200);
            }}
          >
            −
          </button>
          <button
            type="button"
            className="graph-control"
            data-testid="graph-fit"
            aria-label={t("graph.fitLabel")}
            onClick={() => fitView(300, "button")}
          >
            {t("board.fit")}
          </button>
          <button
            type="button"
            className="graph-control"
            data-testid="graph-zoom-in"
            aria-label={t("board.zoomIn")}
            onClick={() => {
              const graph = graphRef.current;
              userViewRef.current = true;
              stopCameraAnimation();
              if (graph) graph.zoom(Math.min(8, graph.zoom() * 1.5), 200);
            }}
          >
            +
          </button>
        </div>
      ) : null}

      <div
        ref={containerRef}
        className={arranging === null ? "graph-canvas" : "graph-canvas graph-canvas--arranging"}
        data-testid={testId}
        data-graph-ready={ready ? "true" : "false"}
        data-graph-fit={String(fitGeneration)}
        data-graph-fit-reason={fitReason}
        data-graph-engine={engineStopped ? "stopped" : "running"}
        data-graph-layout={engine.worker ? "worker" : "engine"}
        data-graph-arranging={arranging === null ? undefined : "true"}
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
            nodeVisibility={hideBuiltInNodes}
            onRenderFramePre={drawClusters}
            onRenderFramePost={drawNodes}
            linkColor={linkColor}
            linkWidth={linkWidth}
            linkLineDash={linkLineDash}
            onEngineStop={handleEngineStop}
            cooldownTicks={engine.cooldownTicks}
            warmupTicks={engine.warmupTicks}
            d3AlphaDecay={reducedMotion ? 0.1 : 0.03}
            d3VelocityDecay={0.38}
            minZoom={0.06}
            maxZoom={8}
            enablePointerInteraction={false}
            enableNodeDrag={false}
          />
        ) : null}
        <div ref={tooltipRef} className="graph-tooltip" role="presentation" hidden />
        {arranging !== null ? <div className="graph-arranging-veil" aria-hidden="true" /> : null}
        {arranging !== null ? (
          <div className="graph-arranging" role="status" data-testid="graph-arranging">
            {arranging > 0 ? t("graph.arrangingProgress", { percent: Math.round(arranging * 100) }) : t("graph.arranging")}
          </div>
        ) : null}
      </div>
    </div>
  );
}
