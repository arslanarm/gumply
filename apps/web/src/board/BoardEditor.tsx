/**
 * The whiteboard editor (spec/whiteboard §3): a Miro-like infinite canvas on
 * React Flow. The JSON Canvas board is the document; every finished gesture
 * becomes one undo step and one `onChange` (the host autosaves it).
 *
 * Lazy-loaded through `./index.ts` so page startup doesn't pay for it.
 */
import { gumplyNodeData, type CanvasBoard, type CanvasNode, type GumplyShape, type InkPoint } from "@gumply/core";
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  NodeToolbar,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  useReactFlow,
  useViewport,
  type Connection,
  type EdgeChangeset,
  type FinalConnectionState,
  type NodeChangeset,
  type OnConnectEnd,
  type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import "./board.css";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { currentModifierLabel, isTypingTarget } from "../lib/shortcuts.js";
import { EDGE_TYPES } from "./BoardEdge.js";
import { ConnectorToolbar } from "./ConnectorToolbar.js";
import { BOARD_DRAG_MIME } from "./constants.js";
import { BoardActionsContext, BoardRenderersContext, type BoardActions, type BoardRenderers } from "./context.js";
import { BoardContentContext, type BoardContent } from "./content/context.js";
import { boardContentRenderers } from "./content/renderers.js";
import { resolveBoardLink } from "./content/links.js";
import { syncEdges, syncNodes, type BoardFlowEdge, type BoardFlowNode } from "./flow.js";
import {
  amend,
  canRedo,
  canUndo,
  commit as commitHistory,
  createHistory,
  dropLast,
  redo,
  reset,
  undo,
  type BoardHistory,
} from "./history.js";
import { BoardIcon, type BoardIconName } from "./icons.js";
import { DEFAULT_INK_WIDTH, inkPath } from "./ink.js";
import {
  addEdges,
  addFrame,
  addNodes,
  clipboardFromText,
  clipboardToText,
  closestSides,
  copySelection,
  createEdge,
  createFileNode,
  createFrame,
  createInk,
  createLinkNode,
  createShape,
  createSticky,
  createText,
  deleteElements,
  duplicateNodes,
  frameFollowers,
  moveNodes,
  nudgeNodes,
  pasteClipboard,
  rectFromPoints,
  reorderNodes,
  safeExternalUrl,
  STICKY_SIZE,
  updateEdge,
  updateNode,
  updateNodes,
  type Point,
  type Rect,
} from "./model.js";
import { NODE_TYPES } from "./nodes.js";
import { Palette } from "./Swatch.js";

export type BoardTool = "select" | "hand" | "sticky" | "text" | "shape" | "connector" | "frame" | "pen";

/** A page or board offered by "Add page…" (the host maps its tree to paths). */
export interface BoardPageOption {
  /** Vault path of the file, e.g. `Projects/Q1 plan.md`. */
  path: string;
  title: string;
  icon?: string;
  /** Last change (PageMeta.updated): live page cards refresh when it moves (W2b). */
  updated?: string;
}

export interface BoardEditorControls {
  /** The current document. */
  getBoard: () => CanvasBoard;
  /** Replace the document (reload from disk); clears undo history. */
  replaceBoard: (board: CanvasBoard) => void;
  /** Add a page/board/file card centred on a screen point (or the view centre). */
  addFileCard: (path: string, clientPoint?: Point) => void;
}

export interface BoardEditorProps {
  /** Used to remember the view (pan/zoom) per board. */
  boardId: string;
  /** The document as loaded. Later changes to this prop are ignored; use `replaceBoard`. */
  board: CanvasBoard;
  /** Called after every change with the new document. */
  onChange: (board: CanvasBoard) => void;
  pages?: readonly BoardPageOption[];
  /** Open a page/board/file card's target (vault path). */
  onOpenFile?: (path: string) => void;
  /** Open a web link card. Defaults to a new browser tab. */
  onOpenUrl?: (url: string) => void;
  /** Upload a dropped/pasted/picked file into the vault; resolves to its vault path. */
  uploadFile?: (file: File) => Promise<string>;
  /** Card/text renderers; defaults to W2b's rich content (Markdown, live page cards). */
  renderers?: BoardRenderers;
  /** Markdown body of a page, for live page cards (W2b). */
  loadPage?: (path: string) => Promise<string | null>;
  onReady?: (controls: BoardEditorControls) => void;
}

const NO_OPEN = () => {};
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
const CLICK_SLOP = 5;
const VIEW_KEY = (id: string): string => `gumply:board-view:${id}`;
const EDITABLE_KINDS = new Set(["sticky", "text", "shape", "group"]);
export const PAGE_CARD_SIZE = { width: 360, height: 220 };

function loadViewport(boardId: string): Viewport | null {
  try {
    const raw = window.localStorage.getItem(VIEW_KEY(boardId));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<Viewport>;
    if (typeof value.x === "number" && typeof value.y === "number" && typeof value.zoom === "number") {
      return { x: value.x, y: value.y, zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value.zoom)) };
    }
  } catch {
    // Unreadable view state: fall back to fitting the board.
  }
  return null;
}

function saveViewport(boardId: string, viewport: Viewport): void {
  try {
    window.localStorage.setItem(VIEW_KEY(boardId), JSON.stringify(viewport));
  } catch {
    // Storage full or disabled: the view just isn't remembered.
  }
}

function isMod(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey;
}

const URL_PATTERN = /^https?:\/\/\S+$/i;

/* ------------------------------------------------------------------------ */
/* Toolbar                                                                   */
/* ------------------------------------------------------------------------ */

interface ToolSpec {
  tool: BoardTool;
  icon: BoardIconName;
  label: string;
  keys: string;
}

const TOOLS: readonly ToolSpec[] = [
  { tool: "select", icon: "select", label: "Select", keys: "V" },
  { tool: "hand", icon: "hand", label: "Hand", keys: "H" },
  { tool: "sticky", icon: "sticky", label: "Sticky note", keys: "N" },
  { tool: "text", icon: "text", label: "Text", keys: "T" },
  { tool: "shape", icon: "shape", label: "Shape", keys: "S" },
  { tool: "connector", icon: "connector", label: "Connector", keys: "C" },
  { tool: "frame", icon: "frame", label: "Frame", keys: "F" },
  { tool: "pen", icon: "pen", label: "Pen", keys: "P" },
];

const SHAPES: readonly { shape: GumplyShape; label: string }[] = [
  { shape: "rect", label: "Rectangle" },
  { shape: "rounded", label: "Rounded rectangle" },
  { shape: "ellipse", label: "Ellipse" },
  { shape: "diamond", label: "Diamond" },
];

function ToolButton({ active, icon, label, keys, onClick, disabled, testId, children }: {
  active?: boolean;
  icon: BoardIconName;
  label: string;
  keys?: string;
  onClick: () => void;
  disabled?: boolean;
  testId: string;
  children?: ReactNode;
}) {
  const tooltip = keys ? `${label} · ${keys}` : label;
  return (
    <button
      type="button"
      className={`board-tool${active ? " is-active" : ""}`}
      aria-label={label}
      aria-pressed={active}
      data-tooltip={tooltip}
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
    >
      <BoardIcon name={icon} />
      {children}
    </button>
  );
}

function PagePicker({ pages, onPick, onClose }: {
  pages: readonly BoardPageOption[];
  onPick: (page: BoardPageOption) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => inputRef.current?.focus(), []);
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = needle ? pages.filter((page) => page.title.toLowerCase().includes(needle)) : pages;
    return list.slice(0, 50);
  }, [pages, query]);
  return (
    <div className="board-popover board-page-picker" data-testid="board-page-picker" role="dialog" aria-label="Add page">
      <input
        ref={inputRef}
        className="board-picker-input"
        placeholder="Find a page…"
        value={query}
        data-testid="board-page-picker-input"
        onChange={(event) => {
          setQuery(event.target.value);
          setIndex(0);
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") onClose();
          else if (event.key === "ArrowDown") {
            event.preventDefault();
            setIndex((value) => Math.min(matches.length - 1, value + 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setIndex((value) => Math.max(0, value - 1));
          } else if (event.key === "Enter") {
            const page = matches[index];
            if (page) onPick(page);
          }
        }}
      />
      <div className="board-picker-list" role="listbox">
        {matches.length === 0 ? <div className="board-picker-empty">No pages found</div> : null}
        {matches.map((page, at) => (
          <button
            type="button"
            key={page.path}
            role="option"
            aria-selected={at === index}
            className={`board-picker-item${at === index ? " is-active" : ""}`}
            data-testid="board-page-option"
            onMouseEnter={() => setIndex(at)}
            onClick={() => onPick(page)}
          >
            <span className="board-picker-icon" aria-hidden="true">
              {page.icon ?? (page.path.endsWith(".canvas") ? <BoardIcon name="board" size={15} /> : <BoardIcon name="page" size={15} />)}
            </span>
            <span className="board-picker-title">{page.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** The zoom readout re-renders on every pan/zoom frame, so it's isolated. */
function ZoomPercent() {
  const { zoom } = useViewport();
  return <>{Math.round(zoom * 100)}%</>;
}

/* ------------------------------------------------------------------------ */
/* Selection toolbar                                                         */
/* ------------------------------------------------------------------------ */

/* ------------------------------------------------------------------------ */
/* The canvas                                                                */
/* ------------------------------------------------------------------------ */

interface Selection {
  nodes: ReadonlySet<string>;
  edges: ReadonlySet<string>;
}

const EMPTY_SET: ReadonlySet<string> = new Set();
const EMPTY_SELECTION: Selection = { nodes: EMPTY_SET, edges: EMPTY_SET };

interface DragState {
  start: Map<string, Point>;
  anchorId: string;
  followers: Map<string, Point>;
}

interface CreateDraft {
  tool: BoardTool;
  start: Point;
  startClient: Point;
  current: Point;
  currentClient: Point;
}

function BoardCanvas(props: BoardEditorProps) {
  const { boardId, onChange, pages = [], onOpenFile, onOpenUrl, uploadFile, renderers, loadPage, onReady } = props;
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const content = useMemo<BoardContent>(
    () => ({ pages, openFile: onOpenFile ?? NO_OPEN, loadPage }),
    [pages, onOpenFile, loadPage],
  );
  const flow = useReactFlow<BoardFlowNode, BoardFlowEdge>();
  const rootRef = useRef<HTMLDivElement>(null);

  const [history, setHistory] = useState<BoardHistory>(() => createHistory(props.board));
  const board = history.present;
  const boardRef = useRef(board);
  boardRef.current = board;

  const [editing, setEditing] = useState<{ type: "node" | "edge"; id: string } | null>(null);
  const editingNodeId = editing?.type === "node" ? editing.id : null;
  const editingEdgeId = editing?.type === "edge" ? editing.id : null;

  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [nodes, setNodes] = useState<BoardFlowNode[]>(() => syncNodes([], props.board, null, EMPTY_SET));
  const [edges, setEdges] = useState<BoardFlowEdge[]>(() => syncEdges([], props.board, null, EMPTY_SET));
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  const [tool, setTool] = useState<BoardTool>("select");
  const [shape, setShape] = useState<GumplyShape>("rect");
  const [shapeMenu, setShapeMenu] = useState(false);
  const [pagePicker, setPagePicker] = useState(false);
  const [dragging, setDragging] = useState(false);
  const pointerRef = useRef<Point | null>(null);
  const pasteCount = useRef(0);
  /** A node created for typing: its first text joins the creation's undo step. */
  const freshNodeRef = useRef<string | null>(null);
  const viewSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /* ---------------- document changes ---------------- */

  const apply = useCallback((change: (board: CanvasBoard) => CanvasBoard) => {
    setHistory((current) => commitHistory(current, change(current.present)));
  }, []);

  const select = useCallback((nodeIds: Iterable<string>, edgeIds: Iterable<string> = []) => {
    setSelection({ nodes: new Set(nodeIds), edges: new Set(edgeIds) });
  }, []);

  // Rebuild the React Flow view after every document, selection or
  // edit-state change. Ids of nodes that no longer exist are harmless.
  // A lone selected connector gets its own toolbar, next to it.
  const toolbarEdgeId =
    selection.nodes.size === 0 && selection.edges.size === 1 && !editing && tool === "select"
      ? ([...selection.edges][0] ?? null)
      : null;
  useLayoutEffect(() => {
    setNodes((previous) => syncNodes(previous, board, editingNodeId, selection.nodes));
    setEdges((previous) => syncEdges(previous, board, editingEdgeId, selection.edges));
  }, [board, editingNodeId, editingEdgeId, selection]);

  // Report every document change after the first render, including undoing
  // all the way back to the loaded board (it must be saved too).
  const reportedBoard = useRef(board);
  useEffect(() => {
    if (board === reportedBoard.current) return;
    reportedBoard.current = board;
    onChange(board);
  }, [board, onChange]);

  const selectedNodeIds = useMemo(
    () => board.nodes.filter((node) => selection.nodes.has(node.id)).map((node) => node.id),
    [board, selection],
  );
  const selectedEdgeIds = useMemo(
    () => board.edges.filter((edge) => selection.edges.has(edge.id)).map((edge) => edge.id),
    [board, selection],
  );
  const selectedRef = useRef({ nodes: selectedNodeIds, edges: selectedEdgeIds });
  selectedRef.current = { nodes: selectedNodeIds, edges: selectedEdgeIds };

  /* ---------------- geometry helpers ---------------- */

  const toFlow = useCallback((client: Point): Point => flow.screenToFlowPosition(client), [flow]);

  const viewCentre = useCallback((): Point => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return toFlow({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  }, [toFlow]);

  /* ---------------- actions for nodes and edges ---------------- */

  const actions = useMemo<BoardActions>(
    () => ({
      startEditing: (id) => {
        const node = boardRef.current.nodes.find((candidate) => candidate.id === id);
        if (!node) return;
        const kind = node.type === "group" ? "group" : gumplyNodeData(node)?.kind ?? node.type;
        if (!EDITABLE_KINDS.has(kind)) return;
        select([id]);
        setEditing({ type: "node", id });
      },
      commitText: (id, text, size) => {
        setEditing((current) => (current?.type === "node" && current.id === id ? null : current));
        const fresh = freshNodeRef.current === id;
        freshNodeRef.current = null;
        setHistory((history) => {
          const current = history.present;
          const node = current.nodes.find((candidate) => candidate.id === id);
          if (!node) return history;
          // Only fold into the creation step if that really was the last step.
          const created = fresh && !history.past.at(-1)?.nodes.some((candidate) => candidate.id === id);
          if (node.type === "group") {
            const next = updateNode(current, id, { label: text.trim() || "Frame" });
            return created ? amend(history, next) : commitHistory(history, next);
          }
          // A plain text box left empty disappears, like in Miro.
          if (text.trim().length === 0 && node.type === "text" && !gumplyNodeData(node)) {
            return created ? dropLast(history) : commitHistory(history, deleteElements(current, new Set([id])));
          }
          const patch: Record<string, unknown> = { text };
          if (size?.height && size.height > node.height) patch.height = size.height;
          const next = updateNode(current, id, patch);
          return created ? amend(history, next) : commitHistory(history, next);
        });
        rootRef.current?.focus({ preventScroll: true });
      },
      cancelEditing: () => {
        setEditing(null);
        rootRef.current?.focus({ preventScroll: true });
      },
      startEditingEdge: (id) => {
        select([], [id]);
        setEditing({ type: "edge", id });
      },
      commitEdgeLabel: (id, label) => {
        setEditing((current) => (current?.type === "edge" && current.id === id ? null : current));
        apply((current) => updateEdge(current, id, { label: label.trim() ? label.trim() : undefined }));
        rootRef.current?.focus({ preventScroll: true });
      },
      updateEdge: (id, patch) => apply((current) => updateEdge(current, id, patch)),
      deleteEdge: (id) => apply((current) => deleteElements(current, new Set(), new Set([id]))),
      commitResize: (id, rect) => {
        apply((current) => updateNode(current, id, { x: rect.x, y: rect.y, width: rect.width, height: rect.height }));
      },
      openNode: (node) => {
        if (node.type === "file" && typeof node.file === "string") onOpenFile?.(node.file);
        else if (node.type === "link") {
          // Only http(s)/mailto ever open: a board from elsewhere may hold javascript: or data: URLs.
          const url = safeExternalUrl(node.url);
          if (!url) return;
          if (onOpenUrl) onOpenUrl(url);
          else window.open(url, "_blank", "noopener,noreferrer");
        }
      },
    }),
    [apply, onOpenFile, onOpenUrl, select],
  );

  /* ---------------- creating things ---------------- */

  const addAndSelect = useCallback(
    (node: CanvasNode, options: { edit?: boolean; frame?: boolean } = {}) => {
      apply((current) => (options.frame ? addFrame(current, node) : addNodes(current, [node])));
      select([node.id]);
      if (options.edit) {
        freshNodeRef.current = node.id;
        setEditing({ type: "node", id: node.id });
      }
    },
    [apply, select],
  );

  const createFromDraft = useCallback(
    (draft: CreateDraft) => {
      const moved =
        Math.abs(draft.currentClient.x - draft.startClient.x) > CLICK_SLOP ||
        Math.abs(draft.currentClient.y - draft.startClient.y) > CLICK_SLOP;
      const dragged = rectFromPoints(draft.start, draft.current);
      const centred = (width: number, height: number): Rect => ({
        x: draft.start.x - width / 2,
        y: draft.start.y - height / 2,
        width,
        height,
      });
      const atLeast = (rect: Rect, width: number, height: number): Rect => ({
        ...rect,
        width: Math.max(width, rect.width),
        height: Math.max(height, rect.height),
      });
      switch (draft.tool) {
        case "sticky":
          addAndSelect(createSticky(moved ? atLeast(dragged, 60, 60) : centred(STICKY_SIZE, STICKY_SIZE)), { edit: true });
          break;
        case "text":
          addAndSelect(
            createText(moved ? atLeast(dragged, 60, 40) : { x: draft.start.x, y: draft.start.y - 20, width: 240, height: 40 }),
            { edit: true },
          );
          break;
        case "shape":
          addAndSelect(createShape(moved ? atLeast(dragged, 24, 24) : centred(160, 110), shape), { edit: true });
          break;
        case "frame":
          // Name it right away (typing must not hit the tool shortcuts).
          addAndSelect(createFrame(moved ? atLeast(dragged, 80, 60) : centred(640, 400)), { frame: true, edit: true });
          break;
        default:
          return;
      }
      setTool("select");
    },
    [addAndSelect, shape],
  );

  const addFileCard = useCallback(
    (path: string, client?: Point) => {
      const at = client ? toFlow(client) : viewCentre();
      const size = PAGE_CARD_SIZE;
      addAndSelect(createFileNode({ x: at.x - size.width / 2, y: at.y - size.height / 2, ...size }, path));
    },
    [addAndSelect, toFlow, viewCentre],
  );

  const addUploadedFile = useCallback(
    async (file: File, client?: Point) => {
      if (!uploadFile) return;
      const at = client ? toFlow(client) : viewCentre();
      let size = { width: 320, height: 200 };
      if (file.type.startsWith("image/")) {
        size = await imageSize(file).catch(() => size);
      } else {
        size = { width: 320, height: 96 };
      }
      const path = await uploadFile(file);
      addAndSelect(createFileNode({ x: at.x - size.width / 2, y: at.y - size.height / 2, ...size }, path));
    },
    [addAndSelect, toFlow, uploadFile, viewCentre],
  );

  useEffect(() => {
    onReady?.({
      getBoard: () => boardRef.current,
      replaceBoard: (next) => {
        setEditing(null);
        setHistory(reset(next));
      },
      addFileCard,
    });
  }, [addFileCard, onReady]);

  /* ---------------- React Flow events ---------------- */

  const dragState = useRef<DragState | null>(null);

  const onNodesChange = useCallback((changes: NodeChangeset<BoardFlowNode>) => {
    const drag = dragState.current;
    if (drag) {
      // Frames carry what lies inside them.
      const anchorChange = changes.getForNode(drag.anchorId).find((change) => change.type === "position");
      const start = drag.start.get(drag.anchorId);
      if (anchorChange?.type === "position" && anchorChange.position && start && drag.followers.size > 0) {
        const dx = anchorChange.position.x - start.x;
        const dy = anchorChange.position.y - start.y;
        for (const [id, origin] of drag.followers) {
          changes.add({ id, type: "position", position: { x: origin.x + dx, y: origin.y + dy }, dragging: true });
        }
      }
    }
    // Deletion goes through the board (one undo step), never React Flow.
    for (const change of changes.getByType("remove")) changes.remove(change);
    const selects = changes.getByType("select");
    if (selects.length > 0) {
      setSelection((current) => {
        const nodes = new Set(current.nodes);
        for (const change of selects) {
          if (change.selected) nodes.add(change.id);
          else nodes.delete(change.id);
        }
        return { nodes, edges: current.edges };
      });
    }
    setNodes((current) => changes.applyTo(current));
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChangeset<BoardFlowEdge>) => {
    for (const change of changes.getByType("remove")) changes.remove(change);
    const selects = changes.getByType("select");
    if (selects.length > 0) {
      setSelection((current) => {
        const edges = new Set(current.edges);
        for (const change of selects) {
          if (change.selected) edges.add(change.id);
          else edges.delete(change.id);
        }
        return { nodes: current.nodes, edges };
      });
    }
    setEdges((current) => changes.applyTo(current));
  }, []);

  const onNodeDragStart = useCallback((_event: unknown, node: BoardFlowNode, dragged: BoardFlowNode[]) => {
    const ids = new Set(dragged.map((item) => item.id));
    const followerIds = frameFollowers(boardRef.current, ids);
    const followers = new Map<string, Point>();
    for (const item of boardRef.current.nodes) if (followerIds.has(item.id)) followers.set(item.id, { x: item.x, y: item.y });
    dragState.current = {
      anchorId: node.id,
      start: new Map(dragged.map((item) => [item.id, { ...item.position }])),
      followers,
    };
    setDragging(true);
  }, []);

  const onNodeDragStop = useCallback(
    (_event: unknown, node: BoardFlowNode, dragged: BoardFlowNode[]) => {
      const drag = dragState.current;
      dragState.current = null;
      setDragging(false);
      const positions = new Map<string, Point>(dragged.map((item) => [item.id, item.position]));
      const start = drag?.start.get(node.id);
      if (drag && start) {
        const dx = node.position.x - start.x;
        const dy = node.position.y - start.y;
        for (const [id, origin] of drag.followers) positions.set(id, { x: origin.x + dx, y: origin.y + dy });
      }
      apply((current) => moveNodes(current, positions));
    },
    [apply],
  );

  const isValidConnection = useCallback(
    (connection: BoardFlowEdge | Connection) => connection.source !== connection.target,
    [],
  );

  const connect = useCallback(
    (source: string, sourceSide: string | null | undefined, target: string, targetSide: string | null | undefined) => {
      if (source === target) return;
      const sides = ["top", "right", "bottom", "left"];
      const from = boardRef.current.nodes.find((node) => node.id === source);
      const to = boardRef.current.nodes.find((node) => node.id === target);
      if (!from || !to) return;
      const [autoFrom, autoTo] = closestSides(from, to);
      const fromSide = sourceSide && sides.includes(sourceSide) ? sourceSide : autoFrom;
      const toSide = targetSide && sides.includes(targetSide) ? targetSide : autoTo;
      const edge = createEdge(source, fromSide as never, target, toSide as never);
      apply((current) => addEdges(current, [edge]));
      select([], [edge.id]);
    },
    [apply, select],
  );

  const onConnect = useCallback(
    (connection: Connection) => connect(connection.source, connection.sourceHandle, connection.target, connection.targetHandle),
    [connect],
  );

  /** Dropping on a node's body (not exactly on a dot) still connects, to the nearest side. */
  const onConnectEnd: OnConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      if (state.isValid || !state.fromNode) return;
      const point = "changedTouches" in event ? event.changedTouches[0] : event;
      if (!point) return;
      const element = document.elementFromPoint(point.clientX, point.clientY);
      const target = element?.closest<HTMLElement>(".react-flow__node")?.dataset.id;
      if (!target || target === state.fromNode.id) return;
      const to = boardRef.current.nodes.find((node) => node.id === target);
      const from = boardRef.current.nodes.find((node) => node.id === state.fromNode?.id);
      if (!to || !from) return;
      connect(from.id, state.fromHandle?.id ?? null, to.id, closestSides(from, to)[1]);
    },
    [connect],
  );

  const addStickyAt = useCallback(
    (client: Point) => {
      const at = toFlow(client);
      const rect = { x: at.x - STICKY_SIZE / 2, y: at.y - STICKY_SIZE / 2, width: STICKY_SIZE, height: STICKY_SIZE };
      addAndSelect(createSticky(rect), { edit: true });
    },
    [addAndSelect, toFlow],
  );

  const onNodeDoubleClick = useCallback(
    (event: ReactMouseEvent, node: BoardFlowNode) => {
      const kind = node.data.kind;
      if (kind === "page" || kind === "board" || kind === "file" || kind === "link") actions.openNode(node.data.node);
      // Inside a frame, double-click works like on the canvas (the label renames).
      else if (kind === "group") addStickyAt({ x: event.clientX, y: event.clientY });
      else actions.startEditing(node.id);
    },
    [actions, addStickyAt],
  );

  const onEdgeDoubleClick = useCallback((_event: unknown, edge: BoardFlowEdge) => actions.startEditingEdge(edge.id), [actions]);

  /* ---------------- viewport ---------------- */

  const initialViewport = useMemo(() => loadViewport(boardId), [boardId]);

  const onInit = useCallback(() => {
    if (initialViewport) return;
    if (boardRef.current.nodes.length > 0) {
      void flow.fitView({ padding: 0.15, maxZoom: 1 });
    } else {
      const rect = rootRef.current?.getBoundingClientRect();
      void flow.setViewport({ x: (rect?.width ?? 0) / 2, y: (rect?.height ?? 0) / 2, zoom: 1 });
    }
  }, [flow, initialViewport]);

  const fit = useCallback(() => {
    if (boardRef.current.nodes.length === 0) {
      const rect = rootRef.current?.getBoundingClientRect();
      void flow.setViewport({ x: (rect?.width ?? 0) / 2, y: (rect?.height ?? 0) / 2, zoom: 1 }, { duration: 200 });
    } else {
      void flow.fitView({ padding: 0.15, maxZoom: 1, duration: 200 });
    }
  }, [flow]);

  /*
   * React Flow marks nodes `nopan`, which also blocks trackpad scrolling and
   * pinch-zoom while the pointer is over an object. On a busy board that's
   * most of the screen, so wheel events over objects are handled here, with
   * React Flow's own deltas (spec: scroll pans, Ctrl/Cmd+wheel or pinch zooms).
   */
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onWheel = (event: WheelEvent): void => {
      const target = event.target as Element | null;
      if (!target?.closest(".react-flow__node, .react-flow__edgelabel-renderer")) return;
      if (target.closest(".nowheel")) return;
      event.preventDefault();
      event.stopPropagation();
      const { x, y, zoom } = flow.getViewport();
      if (event.ctrlKey || event.metaKey) {
        const factor = event.deltaMode === 1 ? 0.05 : event.deltaMode ? 1 : 0.002;
        const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * 2 ** (-event.deltaY * factor * (event.ctrlKey ? 10 : 1))));
        const rect = root.getBoundingClientRect();
        const px = event.clientX - rect.left;
        const py = event.clientY - rect.top;
        void flow.setViewport({ x: px - ((px - x) * next) / zoom, y: py - ((py - y) * next) / zoom, zoom: next });
        rememberView();
        return;
      }
      const scale = event.deltaMode === 1 ? 20 : 1;
      let dx = event.deltaX * scale;
      let dy = event.deltaY * scale;
      if (event.shiftKey && !/mac/i.test(navigator.platform)) {
        dx = dy;
        dy = 0;
      }
      void flow.setViewport({ x: x - dx, y: y - dy, zoom });
      rememberView();
    };
    const rememberView = (): void => {
      if (viewSaveTimer.current) clearTimeout(viewSaveTimer.current);
      viewSaveTimer.current = setTimeout(() => saveViewport(boardId, flow.getViewport()), 250);
    };
    root.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => root.removeEventListener("wheel", onWheel, { capture: true });
  }, [boardId, flow]);

  /* ---------------- commands ---------------- */

  const deleteSelection = useCallback(() => {
    const { nodes: nodeIds, edges: edgeIds } = selectedRef.current;
    if (nodeIds.length === 0 && edgeIds.length === 0) return;
    apply((current) => deleteElements(current, new Set(nodeIds), new Set(edgeIds)));
  }, [apply]);

  const duplicateSelection = useCallback(() => {
    const ids = new Set(selectedRef.current.nodes);
    if (ids.size === 0) return;
    let created: string[] = [];
    apply((current) => {
      const result = duplicateNodes(current, ids);
      created = result.nodeIds;
      return result.board;
    });
    select(created);
  }, [apply, select]);

  const recolour = useCallback(
    (color: string | undefined) => {
      const patches = new Map(selectedRef.current.nodes.map((id) => [id, { color }]));
      apply((current) => {
        let next = updateNodes(current, patches);
        for (const id of selectedRef.current.edges) next = updateEdge(next, id, { color });
        return next;
      });
    },
    [apply],
  );

  const reshape = useCallback(
    (next: GumplyShape) => {
      setShape(next);
      apply((current) => {
        const patches = new Map<string, Record<string, unknown>>();
        for (const node of current.nodes) {
          const extras = gumplyNodeData(node);
          if (selectedRef.current.nodes.includes(node.id) && extras?.kind === "shape") {
            patches.set(node.id, { gumply: { ...extras, shape: next } });
          }
        }
        return updateNodes(current, patches);
      });
    },
    [apply],
  );

  const reorder = useCallback(
    (where: "front" | "back") => apply((current) => reorderNodes(current, new Set(selectedRef.current.nodes), where)),
    [apply],
  );

  const doUndo = useCallback(() => {
    setEditing(null);
    setHistory((current) => undo(current));
  }, []);
  const doRedo = useCallback(() => {
    setEditing(null);
    setHistory((current) => redo(current));
  }, []);

  const chooseTool = useCallback((next: BoardTool) => {
    setTool(next);
    setShapeMenu(false);
    setPagePicker(false);
  }, []);

  /* ---------------- keyboard ---------------- */

  const ownsEvent = useCallback((target: EventTarget | null): boolean => {
    const root = rootRef.current;
    if (!root) return false;
    if (target === document.body || target === document.documentElement || target === null) return true;
    return target instanceof Node && root.contains(target);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || !ownsEvent(event.target) || isTypingTarget(event.target)) return;
      const key = event.key;
      const mod = isMod(event);
      const lower = key.toLowerCase();

      if (mod && lower === "z") {
        event.preventDefault();
        if (event.shiftKey) doRedo();
        else doUndo();
        return;
      }
      if (mod && lower === "y") {
        event.preventDefault();
        doRedo();
        return;
      }
      if (mod && lower === "d") {
        event.preventDefault();
        duplicateSelection();
        return;
      }
      if (mod && lower === "a") {
        event.preventDefault();
        select(boardRef.current.nodes.map((node) => node.id));
        return;
      }
      if (mod || event.altKey) return;

      if (key === "Escape") {
        if (tool !== "select") chooseTool("select");
        else select([]);
        return;
      }
      if (key === "Delete" || key === "Backspace") {
        event.preventDefault();
        deleteSelection();
        return;
      }
      if (key === "Enter") {
        const [only] = selectedRef.current.nodes;
        if (selectedRef.current.nodes.length === 1 && only) {
          event.preventDefault();
          actions.startEditing(only);
        } else if (selectedRef.current.edges.length === 1 && selectedRef.current.edges[0]) {
          event.preventDefault();
          actions.startEditingEdge(selectedRef.current.edges[0]);
        }
        return;
      }
      if (key.startsWith("Arrow")) {
        const ids = new Set(selectedRef.current.nodes);
        if (ids.size === 0) return;
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        const dx = key === "ArrowLeft" ? -step : key === "ArrowRight" ? step : 0;
        const dy = key === "ArrowUp" ? -step : key === "ArrowDown" ? step : 0;
        const followers = frameFollowers(boardRef.current, ids);
        apply((current) => nudgeNodes(current, new Set([...ids, ...followers]), dx, dy));
        return;
      }
      if (key === "!" || (event.shiftKey && event.code === "Digit1")) {
        event.preventDefault();
        fit();
        return;
      }
      if (key === "]") {
        reorder("front");
        return;
      }
      if (key === "[") {
        reorder("back");
        return;
      }
      if (event.shiftKey) return;
      const byKey: Record<string, BoardTool> = {
        v: "select",
        h: "hand",
        n: "sticky",
        t: "text",
        s: "shape",
        c: "connector",
        l: "connector",
        f: "frame",
        p: "pen",
      };
      const next = byKey[lower];
      if (next) {
        event.preventDefault();
        chooseTool(next);
        // S shows the shape choices too, so they're discoverable from the keyboard.
        if (next === "shape") setShapeMenu(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [actions, apply, chooseTool, deleteSelection, doRedo, doUndo, duplicateSelection, fit, ownsEvent, reorder, select, tool]);

  /* ---------------- clipboard ---------------- */

  useEffect(() => {
    const onCopy = (event: ClipboardEvent, cut: boolean): void => {
      if (!ownsEvent(document.activeElement) || isTypingTarget(document.activeElement)) return;
      const ids = new Set(selectedRef.current.nodes);
      if (ids.size === 0) return;
      event.preventDefault();
      event.clipboardData?.setData("text/plain", clipboardToText(copySelection(boardRef.current, ids)));
      pasteCount.current = 0;
      if (cut) apply((current) => deleteElements(current, ids));
    };
    const copy = (event: ClipboardEvent): void => onCopy(event, false);
    const cut = (event: ClipboardEvent): void => onCopy(event, true);
    const paste = (event: ClipboardEvent): void => {
      if (!ownsEvent(document.activeElement) || isTypingTarget(document.activeElement)) return;
      const data = event.clipboardData;
      if (!data) return;
      const files = Array.from(data.files ?? []);
      if (files.length > 0 && uploadFile) {
        event.preventDefault();
        for (const file of files) void addUploadedFile(file);
        return;
      }
      const text = data.getData("text/plain");
      if (!text) return;
      event.preventDefault();
      const clip = clipboardFromText(text);
      const at = pointerRef.current ?? viewCentre();
      if (clip) {
        pasteCount.current += 1;
        let created: string[] = [];
        apply((current) => {
          const result = pasteClipboard(current, clip, { at });
          created = result.nodeIds;
          return result.board;
        });
        select(created);
        return;
      }
      const trimmed = text.trim();
      // W2b: a pasted `[[Page]]` (or `[[Map.canvas|Map]]`) becomes a page/board card.
      const wiki = /^\[\[([^[\]|#]+)(?:#[^[\]|]*)?(?:\|[^[\]]*)?\]\]$/.exec(trimmed);
      const linked = wiki ? resolveBoardLink(wiki[1] ?? "", pagesRef.current) : null;
      if (linked) {
        addAndSelect(
          createFileNode(
            { x: at.x - PAGE_CARD_SIZE.width / 2, y: at.y - PAGE_CARD_SIZE.height / 2, ...PAGE_CARD_SIZE },
            linked.path,
          ),
        );
        return;
      }
      if (URL_PATTERN.test(trimmed)) {
        addAndSelect(createLinkNode({ x: at.x - 200, y: at.y - 150, width: 400, height: 300 }, trimmed));
      } else {
        addAndSelect(createText({ x: at.x - 160, y: at.y - 20, width: 320, height: Math.max(40, 24 * trimmed.split("\n").length + 16) }, trimmed));
      }
    };
    document.addEventListener("copy", copy);
    document.addEventListener("cut", cut);
    document.addEventListener("paste", paste);
    return () => {
      document.removeEventListener("copy", copy);
      document.removeEventListener("cut", cut);
      document.removeEventListener("paste", paste);
    };
  }, [addAndSelect, addUploadedFile, apply, ownsEvent, select, uploadFile, viewCentre]);

  /* ---------------- create / pen overlays ---------------- */

  const [draft, setDraft] = useState<CreateDraft | null>(null);
  const [stroke, setStroke] = useState<{ client: number[][]; flow: InkPoint[] } | null>(null);
  const creating = tool === "sticky" || tool === "text" || tool === "shape" || tool === "frame";

  const onOverlayDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    rootRef.current?.focus({ preventScroll: true });
    const client = { x: event.clientX, y: event.clientY };
    const point = toFlow(client);
    if (tool === "pen") {
      const rect = rootRef.current?.getBoundingClientRect();
      const local = [client.x - (rect?.left ?? 0), client.y - (rect?.top ?? 0), event.pressure || 0.5];
      setStroke({ client: [local], flow: [[point.x, point.y, event.pressure || 0.5]] });
      return;
    }
    setDraft({ tool, start: point, startClient: client, current: point, currentClient: client });
  };

  const onOverlayMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const client = { x: event.clientX, y: event.clientY };
    if (stroke) {
      const rect = rootRef.current?.getBoundingClientRect();
      const point = toFlow(client);
      const pressure = event.pressure || 0.5;
      setStroke({
        client: [...stroke.client, [client.x - (rect?.left ?? 0), client.y - (rect?.top ?? 0), pressure]],
        flow: [...stroke.flow, [point.x, point.y, pressure]],
      });
      return;
    }
    if (draft) setDraft({ ...draft, current: toFlow(client), currentClient: client });
  };

  const onOverlayUp = (): void => {
    if (stroke) {
      const node = createInk(stroke.flow, DEFAULT_INK_WIDTH);
      setStroke(null);
      if (node) apply((current) => addNodes(current, [node]));
      return;
    }
    if (draft) {
      setDraft(null);
      createFromDraft(draft);
    }
  };

  const draftRect = useMemo(() => {
    if (!draft || draft.tool === "pen") return null;
    const rect = rootRef.current?.getBoundingClientRect();
    const box = rectFromPoints(draft.startClient, draft.currentClient);
    if (box.width <= CLICK_SLOP && box.height <= CLICK_SLOP) return null;
    return { left: box.x - (rect?.left ?? 0), top: box.y - (rect?.top ?? 0), width: box.width, height: box.height };
  }, [draft]);

  /* ---------------- pane events ---------------- */

  const onDoubleClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (tool !== "select") return;
    const target = event.target as Element;
    if (!target.classList.contains("react-flow__pane")) return;
    addStickyAt({ x: event.clientX, y: event.clientY });
  };

  const onDragOver = (event: ReactDragEvent<HTMLDivElement>): void => {
    const types = Array.from(event.dataTransfer.types);
    if (types.includes(BOARD_DRAG_MIME) || (types.includes("Files") && uploadFile)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  };

  const onDrop = (event: ReactDragEvent<HTMLDivElement>): void => {
    const client = { x: event.clientX, y: event.clientY };
    const path = event.dataTransfer.getData(BOARD_DRAG_MIME);
    if (path) {
      event.preventDefault();
      addFileCard(path, client);
      return;
    }
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0 && uploadFile) {
      event.preventDefault();
      files.forEach((file, index) => void addUploadedFile(file, { x: client.x + index * 24, y: client.y + index * 24 }));
    }
  };

  /* ---------------- render ---------------- */

  const selectedNodes = useMemo(
    () => board.nodes.filter((node) => selectedNodeIds.includes(node.id)),
    [board, selectedNodeIds],
  );
  const commonColor =
    selectedNodes.length > 0 && selectedNodes.every((node) => node.color === selectedNodes[0]?.color) ? selectedNodes[0]?.color : null;
  const shapesSelected = selectedNodes.length > 0 && selectedNodes.every((node) => gumplyNodeData(node)?.kind === "shape");
  const selectedShape = shapesSelected ? (gumplyNodeData(selectedNodes[0] as CanvasNode) as { shape: GumplyShape }).shape : null;
  const showNodeToolbar = selectedNodeIds.length > 0 && !editing && !dragging && tool === "select";

  const hand = tool === "hand";
  const toolbarEdge = toolbarEdgeId && !dragging ? board.edges.find((edge) => edge.id === toolbarEdgeId) : undefined;
  const modifier = currentModifierLabel();

  return (
    <BoardActionsContext.Provider value={actions}>
      <BoardContentContext.Provider value={content}>
      <BoardRenderersContext.Provider value={renderers ?? boardContentRenderers}>
        <div
          ref={rootRef}
          className={`board-root board-tool-${tool}${dragging ? " is-dragging" : ""}`}
          tabIndex={-1}
          data-testid="board"
          data-tool={tool}
          onPointerDown={() => {
            if (!editing && document.activeElement !== rootRef.current && !isTypingTarget(document.activeElement)) {
              rootRef.current?.focus({ preventScroll: true });
            }
          }}
          onPointerMove={(event) => {
            pointerRef.current = toFlow({ x: event.clientX, y: event.clientY });
          }}
          onPointerLeave={() => {
            pointerRef.current = null;
          }}
          onDoubleClick={onDoubleClick}
          onDragOver={onDragOver}
          onDrop={onDrop}
        >
          <ReactFlow<BoardFlowNode, BoardFlowEdge>
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeDragStart={onNodeDragStart}
            onNodeDragStop={onNodeDragStop}
            onConnect={onConnect}
            onConnectEnd={onConnectEnd}
            isValidConnection={isValidConnection}
            onNodeDoubleClick={onNodeDoubleClick}
            onEdgeDoubleClick={onEdgeDoubleClick}
            onInit={onInit}
            onMoveEnd={(_event, next) => saveViewport(boardId, next)}
            {...(initialViewport ? { defaultViewport: initialViewport } : {})}
            minZoom={MIN_ZOOM}
            maxZoom={MAX_ZOOM}
            connectionMode={ConnectionMode.Loose}
            connectionRadius={28}
            selectionMode={SelectionMode.Partial}
            selectionOnDrag={tool === "select"}
            panOnDrag={hand ? [0, 1] : [1]}
            panOnScroll
            zoomOnScroll={false}
            zoomOnPinch
            zoomOnDoubleClick={false}
            nodesDraggable={tool === "select"}
            nodesConnectable={tool === "select" || tool === "connector"}
            elementsSelectable={tool === "select" || tool === "connector"}
            elevateNodesOnSelect={false}
            elevateEdgesOnSelect={false}
            deleteKeyCode={null}
            selectionKeyCode={null}
            multiSelectionKeyCode="Shift"
            disableKeyboardA11y
            onlyRenderVisibleElements={nodes.length > 200}
            nodeDragThreshold={2}
            proOptions={{ hideAttribution: false }}
            attributionPosition="bottom-left"
          >
            <Background variant={BackgroundVariant.Dots} gap={24} size={1.6} className="board-grid" />

            <NodeToolbar nodeId={selectedNodeIds} isVisible={showNodeToolbar} position={Position.Top} offset={14}>
              <div className="board-context" data-testid="board-context-toolbar" onPointerDown={(event) => event.stopPropagation()}>
                <Palette current={commonColor} onPick={recolour} />
                {shapesSelected ? (
                  <div className="board-context-group">
                    {SHAPES.map((item) => (
                      <button
                        type="button"
                        key={item.shape}
                        className={`board-context-button${selectedShape === item.shape ? " is-active" : ""}`}
                        aria-label={item.label}
                        data-tooltip={item.label}
                        data-testid={`board-context-shape-${item.shape}`}
                        onClick={() => reshape(item.shape)}
                      >
                        <BoardIcon name={item.shape} size={16} />
                      </button>
                    ))}
                  </div>
                ) : null}
                <div className="board-context-group">
                  <button type="button" className="board-context-button" aria-label="Bring to front" data-tooltip="Bring to front · ]" data-testid="board-front" onClick={() => reorder("front")}>
                    <BoardIcon name="front" size={16} />
                  </button>
                  <button type="button" className="board-context-button" aria-label="Send to back" data-tooltip="Send to back · [" data-testid="board-back" onClick={() => reorder("back")}>
                    <BoardIcon name="back" size={16} />
                  </button>
                  <button type="button" className="board-context-button is-danger" aria-label="Delete" data-tooltip="Delete · Del" data-testid="board-delete" onClick={deleteSelection}>
                    <BoardIcon name="trash" size={16} />
                  </button>
                </div>
              </div>
            </NodeToolbar>

            <Panel position="bottom-right" className="board-zoom">
              <button type="button" className="board-zoom-button" aria-label="Zoom out" data-tooltip="Zoom out" data-testid="board-zoom-out" onClick={() => void flow.zoomOut({ duration: 150 })}>
                <BoardIcon name="minus" size={16} />
              </button>
              <button type="button" className="board-zoom-value" aria-label="Reset zoom to 100%" data-tooltip="Zoom to 100%" data-testid="board-zoom-value" onClick={() => void flow.zoomTo(1, { duration: 150 })}>
                <ZoomPercent />
              </button>
              <button type="button" className="board-zoom-button" aria-label="Zoom in" data-tooltip="Zoom in" data-testid="board-zoom-in" onClick={() => void flow.zoomIn({ duration: 150 })}>
                <BoardIcon name="plus" size={16} />
              </button>
              <span className="board-zoom-divider" />
              <button type="button" className="board-zoom-button" aria-label="Fit to screen" data-tooltip="Fit · Shift+1" data-testid="board-fit" onClick={fit}>
                <BoardIcon name="fit" size={16} />
              </button>
            </Panel>
          </ReactFlow>

          <div className="board-toolbar" role="toolbar" aria-label="Board tools" aria-orientation="vertical" data-testid="board-toolbar">
            <div className="board-toolbar-group">
              {TOOLS.map((spec) => (
                <ToolButton
                  key={spec.tool}
                  active={tool === spec.tool}
                  icon={spec.tool === "shape" ? shape : spec.icon}
                  label={spec.label}
                  keys={spec.tool === "connector" ? "C" : spec.keys}
                  testId={`board-tool-${spec.tool}`}
                  onClick={() => {
                    chooseTool(spec.tool);
                    if (spec.tool === "shape") setShapeMenu((open) => (tool === "shape" ? !open : true));
                  }}
                />
              ))}
              <ToolButton
                icon="image"
                label={uploadFile ? "Image or file" : "Image or file (unavailable)"}
                testId="board-tool-image"
                disabled={!uploadFile}
                onClick={() => fileInputRef.current?.click()}
              />
              <ToolButton
                icon="page"
                label="Add page…"
                testId="board-tool-page"
                active={pagePicker}
                onClick={() => {
                  setShapeMenu(false);
                  setPagePicker((open) => !open);
                }}
              />
            </div>
            <div className="board-toolbar-group">
              <ToolButton icon="undo" label="Undo" keys={`${modifier}Z`} testId="board-undo" disabled={!canUndo(history)} onClick={doUndo} />
              <ToolButton icon="redo" label="Redo" keys={`${modifier}+Shift+Z`} testId="board-redo" disabled={!canRedo(history)} onClick={doRedo} />
            </div>
            {shapeMenu && tool === "shape" ? (
              <div className="board-popover board-shape-menu" data-testid="board-shape-menu" role="menu">
                {SHAPES.map((item) => (
                  <button
                    type="button"
                    key={item.shape}
                    role="menuitemradio"
                    aria-checked={shape === item.shape}
                    className={`board-tool${shape === item.shape ? " is-active" : ""}`}
                    aria-label={item.label}
                    data-tooltip={item.label}
                    data-testid={`board-shape-${item.shape}`}
                    onClick={() => {
                      setShape(item.shape);
                      setShapeMenu(false);
                    }}
                  >
                    <BoardIcon name={item.shape} />
                  </button>
                ))}
              </div>
            ) : null}
            {pagePicker ? (
              <PagePicker
                pages={pages}
                onClose={() => setPagePicker(false)}
                onPick={(page) => {
                  setPagePicker(false);
                  addFileCard(page.path);
                }}
              />
            ) : null}
            <input
              ref={fileInputRef}
              type="file"
              hidden
              data-testid="board-file-input"
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                event.target.value = "";
                files.forEach((file) => void addUploadedFile(file));
              }}
            />
          </div>

          {creating || tool === "pen" ? (
            <div
              className="board-overlay"
              data-testid="board-overlay"
              onPointerDown={onOverlayDown}
              onPointerMove={onOverlayMove}
              onPointerUp={onOverlayUp}
              onPointerCancel={onOverlayUp}
            >
              {draftRect ? (
                <div
                  className={`board-draft board-draft-${draft?.tool ?? ""}${draft?.tool === "shape" ? ` board-draft-${shape}` : ""}`}
                  style={draftRect}
                />
              ) : null}
              {stroke ? (
                <svg className="board-live-ink" width="100%" height="100%">
                  <path d={inkPath(stroke.client, DEFAULT_INK_WIDTH * flow.getZoom(), false)} />
                </svg>
              ) : null}
            </div>
          ) : null}

          {toolbarEdge ? <ConnectorToolbar edge={toolbarEdge} rootRef={rootRef} layoutKey={board} /> : null}

          {board.nodes.length === 0 ? (
            <div className="board-empty" data-testid="board-empty">
              <strong>This board is empty</strong>
              <span>Double-click to add a sticky note · drag pages from the sidebar</span>
            </div>
          ) : null}
        </div>
      </BoardRenderersContext.Provider>
      </BoardContentContext.Provider>
    </BoardActionsContext.Provider>
  );
}

function imageSize(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, 480 / Math.max(image.naturalWidth, image.naturalHeight, 1));
      resolve({ width: Math.max(40, image.naturalWidth * scale), height: Math.max(40, image.naturalHeight * scale) });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Not an image"));
    };
    image.src = url;
  });
}

export function BoardEditor(props: BoardEditorProps) {
  return (
    <ReactFlowProvider>
      <BoardCanvas {...props} />
    </ReactFlowProvider>
  );
}

export default BoardEditor;
