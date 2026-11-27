/**
 * The whiteboard editor (spec/whiteboard §3): a Miro-like infinite canvas on
 * React Flow. The JSON Canvas board is the document; every finished gesture
 * becomes one undo step and one `onChange` (the host autosaves it).
 *
 * Lazy-loaded through `./index.ts` so page startup doesn't pay for it.
 */
import { ClampedToolbar } from "./toolbar-clamp.js";
import { gumplyNodeData, isGumplyBoard, WIKILINK_INNER, WIKILINK_PART, WIKILINK_TARGET, type CanvasBoard, type CanvasNode, type GumplyShape, type InkPoint } from "@gumply/core";
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
  useInternalNode,
  useOnViewportChange,
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
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { currentModifierLabel, isTypingTarget, layoutKey, withModifier } from "../lib/shortcuts.js";
import { EDGE_TYPES } from "./BoardEdge.js";
import { useBoardExport } from "./BoardExport.js";
import { BoardExportButton, BoardExportDialog, type ExportFormat } from "./BoardMenu.js";
import { ConnectorToolbar } from "./ConnectorToolbar.js";
import { BOARD_DRAG_MIME } from "./constants.js";
import { BoardActionsContext, BoardLookContext, BoardRenderersContext, type BoardActions, type BoardRenderers } from "./context.js";
import { BoardContentContext, type BoardContent } from "./content/context.js";
import { boardContentRenderers } from "./content/renderers.js";
import { resolveBoardLink } from "./content/links.js";
import { errorMessage } from "../lib/errors.js";
import { ApiRequestError } from "../api/client.js";
import { syncEdges, syncNodes, type BoardFlowEdge, type BoardFlowNode } from "./flow.js";
import { GROUP_DRAG_MIN, setGroupOffset } from "./group-drag.js";
import { lodLevel, type LodLevel } from "./lod.js";
import { createZoomVar, zoomVarTargets } from "./zoom-var.js";
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
  CLIPBOARD_MIME,
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
import { t, useT } from "../i18n/index.js";
import { describeNode, nextInOrder, readingOrder } from "./a11y.js";
import { clipboardPlainText } from "./clipboard-text.js";
import { motionMs } from "../lib/motion.js";
import { freeSpot, nearestFree } from "./placement.js";
import { useAttributionOutOfTabOrder } from "./attribution.js";
import { alignNodes, distributeNodes, type Alignment, type Distribution } from "./align.js";

/** #b9425ktw D: Alt+Shift+… for align and distribute, by key position (event.code). */
const ALIGN_KEYS: Record<string, Alignment | Distribution> = {
  KeyL: "left",
  KeyC: "center",
  KeyR: "right",
  KeyT: "top",
  KeyM: "middle",
  KeyB: "bottom",
  KeyH: "horizontal",
  KeyV: "vertical",
};
const ALIGN_LETTERS: Record<Alignment | Distribution, string> = {
  left: "L",
  center: "C",
  right: "R",
  top: "T",
  middle: "M",
  bottom: "B",
  horizontal: "H",
  vertical: "V",
};
/** The keys as written in tooltips: ⌥⇧L on a Mac (where the app writes ⌘), Alt+Shift+L elsewhere (@opus-editor). */
export function alignShortcut(how: Alignment | Distribution): string {
  return currentModifierLabel() === "⌘" ? `⌥⇧${ALIGN_LETTERS[how]}` : `Alt+Shift+${ALIGN_LETTERS[how]}`;
}

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
  /**
   * A gesture is in progress whose result isn't in the document yet (text
   * being typed, a drag, a resize, a stroke…). The host must treat the board
   * as dirty meanwhile: reloading it would silently drop that work (#x74uu7c3).
   */
  isBusy: () => boolean;
  /** The board's frames, for the Outline pane (v0.8 D1). */
  frames: () => BoardFrame[];
  /** Called after every change to the document; returns the unsubscribe. */
  subscribe: (listener: () => void) => () => void;
  /** Zoom so a frame fills the view. */
  zoomToFrame: (id: string) => void;
  /** #snuin2ja (Cmd+K): pick a tool, as its toolbar button does. */
  setTool: (tool: BoardTool) => void;
  /** #snuin2ja (Cmd+K): fit, zoom in or out, or 100%, as the zoom panel does. */
  view: (action: "fit" | "in" | "out" | "reset") => void;
  /** #pypzxe6i: open the export dialog (from the board's own ⋯ or Cmd+K), with a format chosen or not. */
  openExport: (format?: ExportFormat) => void;
}

export interface BoardFrame {
  id: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BoardEditorProps {
  /** Used to remember the view (pan/zoom) per board. */
  boardId: string;
  /** #8k4ssrkb: Obsidian file links in the board's text, resolved from the board. */
  fileLinks?: Readonly<Record<string, string | null>>;
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
  /**
   * A dropped/pasted/picked file couldn't be added (too large, offline, server
   * error). Without it the failure is only logged; it never throws.
   */
  onUploadError?: (message: string) => void;
  /** Card/text renderers; defaults to W2b's rich content (Markdown, live page cards). */
  renderers?: BoardRenderers;
  /** Markdown body of a page, for live page cards (W2b). */
  loadPage?: (path: string) => Promise<string | null>;
  onReady?: (controls: BoardEditorControls) => void;
}

const NO_OPEN = () => {};
/** Attachment size limit (D18), checked before uploading. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/** Focusable controls whose own Enter wins over the board's (#sdwrzdgx). */
const CONTROL_SELECTOR = "button, a[href], [role='button'], [role='menuitem'], [role='menuitemcheckbox'], [role='option'], [role='tab']";
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
  readonly label: string;
  keys: string;
}

const TOOLS: readonly ToolSpec[] = [
  { tool: "select", icon: "select", get label() { return t("board.tools.select"); }, keys: "V" },
  { tool: "hand", icon: "hand", get label() { return t("board.tools.hand"); }, keys: "H" },
  { tool: "sticky", icon: "sticky", get label() { return t("board.tools.sticky"); }, keys: "N" },
  { tool: "text", icon: "text", get label() { return t("board.tools.text"); }, keys: "T" },
  { tool: "shape", icon: "shape", get label() { return t("board.tools.shape"); }, keys: "S" },
  { tool: "connector", icon: "connector", get label() { return t("board.tools.connector"); }, keys: "C" },
  { tool: "frame", icon: "frame", get label() { return t("board.tools.frame"); }, keys: "F" },
  { tool: "pen", icon: "pen", get label() { return t("board.tools.pen"); }, keys: "P" },
];

// Labels are getters: read at render time, in the interface language.
const SHAPES: readonly { shape: GumplyShape; readonly label: string }[] = [
  { shape: "rect", get label() { return t("board.shapes.rect"); } },
  { shape: "rounded", get label() { return t("board.shapes.rounded"); } },
  { shape: "ellipse", get label() { return t("board.shapes.ellipse"); } },
  { shape: "diamond", get label() { return t("board.shapes.diamond"); } },
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
    <div className="board-popover board-page-picker" data-testid="board-page-picker" role="dialog" aria-label={t("board.addPage")}>
      <input
        ref={inputRef}
        className="board-picker-input"
        placeholder={t("board.findPage")}
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
        {matches.length === 0 ? <div className="board-picker-empty">{t("board.noPagesFound")}</div> : null}
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
  /** Big selection: moved with CSS translate, committed on drop (group-drag.ts). */
  group: GroupDrag | null;
}

/** Key of the selection rectangle among a group drag's moved elements. */
const SELECTION_KEY = "\u0000selection";
/** Key of the React Flow viewport when a whole-board drag moves it. */
const VIEWPORT_KEY = "\u0000viewport";

/** React Flow's viewport `transform: translate(xpx, ypx) scale(k)`. */
function parseViewport(transform: string): { x: number; y: number; zoom: number } | null {
  const match = /translate\(\s*(-?[\d.e+-]+)px\s*,\s*(-?[\d.e+-]+)px\s*\)\s*scale\(\s*([\d.e+-]+)\s*\)/.exec(transform);
  return match ? { x: Number(match[1]), y: Number(match[2]), zoom: Number(match[3]) } : null;
}

function viewportTransform(x: number, y: number, zoom: number): string {
  return `translate(${x}px, ${y}px) scale(${zoom})`;
}

interface GroupDrag {
  ids: Set<string>;
  /** Moved node elements (and the selection rectangle) by id. */
  elements: Map<string, HTMLElement>;
  /** `.react-flow__nodes` child count when `elements` was collected. */
  scannedChildren: number;
  /**
   * Everything moves (e.g. Ctrl+A): shift React Flow's viewport (it holds every
   * object, connector, label and the selection box) instead of each object.
   */
  whole: boolean;
  /** Whole-board drag: React Flow's viewport transform, and the one last written over it. */
  base?: { x: number; y: number; zoom: number };
  written?: string;
  /** Set once the temporary moves have been undone. */
  cleared?: boolean;
  dx: number;
  dy: number;
}

interface Settling {
  group: GroupDrag;
  anchorId: string;
  /** The anchor object's committed position. */
  x: number;
  y: number;
}

/**
 * Undo a group drag's temporary moves (translate, connector offsets, viewport
 * shift). Returns false when it was already cleared.
 */
function clearGroupDrag(group: GroupDrag): boolean {
  if (group.cleared) return false;
  group.cleared = true;
  for (const item of group.elements.values()) item.style.translate = "";
  // Hand the viewport back to React Flow, unless it has re-rendered it.
  const viewport = group.elements.get(VIEWPORT_KEY);
  if (viewport && group.base && viewport.style.transform === group.written) {
    viewport.style.transform = viewportTransform(group.base.x, group.base.y, group.base.zoom);
  }
  setGroupOffset(null);
  return true;
}

/**
 * Clears a finished group drag in the same commit in which React Flow renders
 * the committed positions, so the objects never show both the new position
 * and the temporary offset (a one-frame jump).
 */
function GroupDragSettler({ settling, onDone }: { settling: Settling; onDone: () => void }) {
  const anchor = useInternalNode(settling.anchorId);
  const x = anchor?.position.x;
  const y = anchor?.position.y;
  useLayoutEffect(() => {
    const arrived = x === undefined || y === undefined || (Math.abs(x - settling.x) < 0.5 && Math.abs(y - settling.y) < 0.5);
    if (!arrived) return;
    clearGroupDrag(settling.group);
    onDone();
  }, [x, y, settling, onDone]);
  return null;
}

interface CreateDraft {
  tool: BoardTool;
  start: Point;
  startClient: Point;
  current: Point;
  currentClient: Point;
}

function BoardCanvas(props: BoardEditorProps) {
  // Re-render on a language switch (#7h5utv23).
  useT();
  const { boardId, onChange, pages = [], onOpenFile, onOpenUrl, uploadFile, onUploadError, renderers, loadPage, onReady } = props;
  const onUploadErrorRef = useRef(onUploadError);
  onUploadErrorRef.current = onUploadError;
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const content = useMemo<BoardContent>(
    () => ({ pages, openFile: onOpenFile ?? NO_OPEN, loadPage, boardId: props.boardId, fileLinks: props.fileLinks }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pages, onOpenFile, loadPage, props.boardId, props.fileLinks],
  );
  const flow = useReactFlow<BoardFlowNode, BoardFlowEdge>();
  const rootRef = useRef<HTMLDivElement>(null);
  useAttributionOutOfTabOrder(rootRef);

  const [history, setHistory] = useState<BoardHistory>(() => createHistory(props.board));
  const board = history.present;
  // D39 (#jchhjepb): decided from the board as it opened, so adding a sticky
  // to an Obsidian board doesn't turn its cards into plain text mid-session.
  const [look] = useState(() => ({ textCards: !isGumplyBoard(props.board) }));
  const boardRef = useRef(board);
  boardRef.current = board;
  // The Outline pane listens for document changes (v0.8 D1).
  const listenersRef = useRef(new Set<() => void>());
  useEffect(() => {
    for (const listener of listenersRef.current) listener();
  }, [board]);
  // Drafts (text being typed) go straight to the host's autosave.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

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
  // #b9425ktw D: the context toolbar's Align panel (2+ objects selected).
  const [alignMenu, setAlignMenu] = useState(false);
  const alignButtonRef = useRef<HTMLButtonElement | null>(null);
  const alignMenuRef = useRef<HTMLDivElement | null>(null);
  /** Opened from the keyboard: its first button takes the focus once it's there. */
  const focusAlignMenu = useRef(false);
  useEffect(() => {
    if (!alignMenu || !focusAlignMenu.current) return;
    focusAlignMenu.current = false;
    alignMenuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [alignMenu]);
  const [pagePicker, setPagePicker] = useState(false);
  const [dragging, setDragging] = useState(false);
  /** Kept current every render; read by the host through `isBusy`. */
  const busyRef = useRef(false);
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
  // The Align panel closes with the multi-selection it was for.
  useEffect(() => {
    if (selectedNodeIds.length < 2) setAlignMenu(false);
  }, [selectedNodeIds.length]);
  const selectedEdgeIds = useMemo(
    () => board.edges.filter((edge) => selection.edges.has(edge.id)).map((edge) => edge.id),
    [board, selection],
  );
  // Export as PNG/SVG from the ⋯ menu (spec/v0-6 §D); errors use the board notice.
  const exporter = useBoardExport({
    boardId,
    board,
    selectedNodeIds,
    rootRef,
    onError: (message) => onUploadErrorRef.current?.(message),
  });
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
            const next = updateNode(current, id, { label: text.trim() || t("board.frame") });
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
      draftText: (id, text) => {
        const node = boardRef.current.nodes.find((candidate) => candidate.id === id);
        if (!node) return;
        const patch = node.type === "group" ? { label: text.trim() || t("board.frame") } : { text };
        onChangeRef.current(updateNode(boardRef.current, id, patch));
      },
      draftEdgeLabel: (id, label) => {
        onChangeRef.current(updateEdge(boardRef.current, id, { label: label.trim() ? label.trim() : undefined }));
      },
      cancelEditing: () => {
        setEditing(null);
        // A draft may already be queued: the board as it is wins again.
        onChangeRef.current(boardRef.current);
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
      const want = { x: at.x - size.width / 2, y: at.y - size.height / 2, ...size };
      // #b9425ktw (#fzrwse3y's P3 5): from the toolbar (no drop point), the nearest free spot to the view's centre,
      // so the card doesn't cover what's there; a card dropped at a point goes exactly there.
      // Only spots inside the visible part count (@opus-editor); if even the fallback lands outside it (a view
      // smaller than a card), the view moves to the card, so the new, selected card is never out of sight.
      const rect = rootRef.current?.getBoundingClientRect();
      const view = rect ? (() => {
        const from = toFlow({ x: rect.left, y: rect.top });
        const to = toFlow({ x: rect.right, y: rect.bottom });
        return { x: from.x, y: from.y, width: to.x - from.x, height: to.y - from.y };
      })() : undefined;
      // In view first; zoomed in, nothing may fit there: then the nearest free spot anywhere (the view follows it
      // below), and only then an offset, so the card never covers an item (the 200 % slot case).
      const nodes = boardRef.current.nodes;
      const corner = client ? want : nearestFree(want, nodes, view) ?? nearestFree(want, nodes) ?? freeSpot(want, nodes);
      addAndSelect(createFileNode({ ...corner, ...size }, path));
      if (!client && view) {
        const seen = corner.x < view.x + view.width && corner.x + size.width > view.x && corner.y < view.y + view.height && corner.y + size.height > view.y;
        if (!seen) void flow.setCenter(corner.x + size.width / 2, corner.y + size.height / 2, { zoom: flow.getZoom(), duration: 0 });
      }
    },
    [addAndSelect, flow, toFlow, viewCentre],
  );

  const addUploadedFile = useCallback(
    async (file: File, client?: Point) => {
      if (!uploadFile) return;
      const report = (message: string) => {
        if (onUploadErrorRef.current) onUploadErrorRef.current(message);
        else console.warn(message);
      };
      // Same limit as the server (D18): refuse before sending 25 MB for nothing.
      if (file.size > MAX_UPLOAD_BYTES) {
        report(t("board.upload.tooLarge", { name: file.name }));
        return;
      }
      const at = client ? toFlow(client) : viewCentre();
      let size = { width: 320, height: 200 };
      if (file.type.startsWith("image/")) {
        size = await imageSize(file).catch(() => size);
      } else {
        size = { width: 320, height: 96 };
      }
      let path: string;
      try {
        path = await uploadFile(file);
      } catch (error) {
        // #f6v8z4ti: a failed upload is a calm notice, never an uncaught error.
        const reason = errorMessage(error);
        if (/too large/i.test(reason)) report(t("board.upload.tooLarge", { name: file.name }));
        // Our server answered with an error: it is reachable, so don't say it isn't.
        else if (error instanceof ApiRequestError && error.status >= 500) report(t("board.upload.serverError", { name: file.name }));
        else report(t("board.upload.failed", { name: file.name, reason }));
        return;
      }
      addAndSelect(createFileNode({ x: at.x - size.width / 2, y: at.y - size.height / 2, ...size }, path));
    },
    [addAndSelect, toFlow, uploadFile, viewCentre],
  );

  // #snuin2ja: tool and view actions for Cmd+K, defined further down.
  const paletteRef = useRef<{ setTool: (tool: BoardTool) => void; view: (action: "fit" | "in" | "out" | "reset") => void } | null>(null);

  // #pypzxe6i: the export dialog (its format, if one was asked for): the canvas's export button, the row ⋯ and Cmd+K open it.
  const [exportDialog, setExportDialog] = useState<{ format?: ExportFormat } | null>(null);
  // Start loading the export code as the dialog opens, as the old menu did.
  const preloadExport = exporter.preload;
  useEffect(() => {
    if (exportDialog) preloadExport();
  }, [exportDialog, preloadExport]);

  useEffect(() => {
    onReady?.({
      setTool: (tool) => paletteRef.current?.setTool(tool),
      view: (action) => paletteRef.current?.view(action),
      openExport: (format) => setExportDialog(format ? { format } : {}),
      getBoard: () => boardRef.current,
      replaceBoard: (next) => {
        setEditing(null);
        setHistory(reset(next));
      },
      addFileCard,
      // A drag counts from its first move: `dragState` is set synchronously,
      // and a big-selection drag (group-drag.ts) never sets `node.dragging`.
      isBusy: () =>
        busyRef.current ||
        dragState.current !== null ||
        nodesRef.current.some((node) => node.dragging || node.resizing),
      frames: () =>
        boardRef.current.nodes
          .filter((node) => node.type === "group")
          .map((node) => ({
            id: node.id,
            title: (node.type === "group" ? node.label : undefined)?.trim() ?? "",
            x: node.x,
            y: node.y,
            width: node.width,
            height: node.height,
          })),
      subscribe: (listener) => {
        listenersRef.current.add(listener);
        return () => listenersRef.current.delete(listener);
      },
      zoomToFrame: (id) => {
        const node = boardRef.current.nodes.find((item) => item.id === id);
        if (!node) return;
        void flow.fitBounds({ x: node.x, y: node.y, width: node.width, height: node.height }, { padding: 0.08, duration: motionMs(250) });
      },
    });
  }, [addFileCard, onReady, flow]);

  /* ---------------- React Flow events ---------------- */

  const dragState = useRef<DragState | null>(null);

  /** Find the DOM elements of the objects a group drag moves (mounted ones only). */
  const collectGroupElements = useCallback((group: GroupDrag): void => {
    const container = rootRef.current?.querySelector<HTMLElement>(".react-flow__nodes");
    if (!container) return;
    if (group.whole) {
      // One layer holds every node, connector, label and the selection box.
      const viewport = rootRef.current?.querySelector<HTMLElement>(".react-flow__viewport");
      if (viewport) group.elements.set(VIEWPORT_KEY, viewport);
      group.scannedChildren = Number.POSITIVE_INFINITY;
      return;
    }
    group.scannedChildren = container.childElementCount;
    for (const element of container.querySelectorAll<HTMLElement>(".react-flow__node")) {
      const id = element.dataset.id;
      if (id && group.ids.has(id)) group.elements.set(id, element);
    }
    const rect = rootRef.current?.querySelector<HTMLElement>(".react-flow__nodesselection-rect");
    if (rect) group.elements.set(SELECTION_KEY, rect);
  }, []);

  const paintGroupDrag = useCallback(
    (group: GroupDrag): void => {
      // Objects scrolled into view mid-drag (auto-pan) mount late: pick them up.
      if (!group.whole) {
        const container = rootRef.current?.querySelector<HTMLElement>(".react-flow__nodes");
        if (container && container.childElementCount !== group.scannedChildren) collectGroupElements(group);
      }
      if (group.whole) {
        // Shift React Flow's own pan/zoom transform on the viewport (what a pan
        // does, and as cheap); a separate `translate` made Chrome re-layerize
        // the whole board every frame. If React Flow rewrote the transform in
        // between (auto-pan), that is the new base.
        const viewport = group.elements.get(VIEWPORT_KEY);
        const view = viewport ? parseViewport(viewport.style.transform) : null;
        if (viewport && view) {
          if (group.written === undefined || viewport.style.transform !== group.written) group.base = view;
          const base = group.base ?? view;
          viewport.style.transform = viewportTransform(base.x + group.dx * base.zoom, base.y + group.dy * base.zoom, base.zoom);
          // Read back: the browser re-serialises (rounds) the numbers.
          group.written = viewport.style.transform;
        }
      } else {
        const translate = `${group.dx}px ${group.dy}px`;
        for (const element of group.elements.values()) element.style.translate = translate;
        // Connectors add the offset to their moved ends (BoardEdge).
        setGroupOffset({ ids: group.ids, dx: group.dx, dy: group.dy });
      }
    },
    [collectGroupElements],
  );

  const onNodesChange = useCallback((changes: NodeChangeset<BoardFlowNode>) => {
    const drag = dragState.current;
    if (drag?.group) {
      // Big selection: move the elements, not the React state (see group-drag.ts).
      const group = drag.group;
      const anchor = changes.getForNode(drag.anchorId).find((change) => change.type === "position");
      const start = drag.start.get(drag.anchorId);
      if (anchor?.type === "position" && anchor.dragging && anchor.position && start) {
        group.dx = anchor.position.x - start.x;
        group.dy = anchor.position.y - start.y;
        paintGroupDrag(group);
      }
      for (const change of changes.getByType("position")) if (change.dragging) changes.remove(change);
    } else if (drag) {
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
    if (!changes.isEmpty()) setNodes((current) => changes.applyTo(current));
  }, [paintGroupDrag]);

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
    const moving = new Set([...ids, ...followers.keys()]);
    const group: GroupDrag | null =
      moving.size >= GROUP_DRAG_MIN
        ? {
            ids: moving,
            elements: new Map(),
            scannedChildren: -1,
            whole: moving.size >= boardRef.current.nodes.length,
            dx: 0,
            dy: 0,
          }
        : null;
    if (group) collectGroupElements(group);
    dragState.current = {
      anchorId: node.id,
      start: new Map(dragged.map((item) => [item.id, { ...item.position }])),
      followers,
      group,
    };
    setDragging(true);
  }, [collectGroupElements]);

  /** A finished group drag waiting for React Flow to show the committed positions. */
  const [settling, setSettling] = useState<Settling | null>(null);
  const settleDone = useCallback(() => setSettling(null), []);

  const onNodeDragStop = useCallback(
    (_event: unknown, node: BoardFlowNode, dragged: BoardFlowNode[]) => {
      const drag = dragState.current;
      dragState.current = null;
      setDragging(false);
      if (drag?.group) {
        const group = drag.group;
        setSettling({ group, anchorId: node.id, x: node.position.x, y: node.position.y });
        // Fallback: never leave the temporary offset behind.
        window.setTimeout(() => {
          if (clearGroupDrag(group)) setSettling((current) => (current?.group === group ? null : current));
        }, 600);
      }
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

  /**
   * Fit inside what's actually visible: clear of the floating toolbar (left)
   * and the zoom controls (bottom), with air at the top (#8ht6zhdv item 1).
   */
  const fitPadding = useCallback(() => {
    const root = rootRef.current?.getBoundingClientRect();
    const toolbar = rootRef.current?.querySelector(".board-toolbar")?.getBoundingClientRect();
    // #3nnx98m4: on a short board the toolbar is a row across the top (board.css): clear it there instead.
    if (root && toolbar && toolbar.width > toolbar.height) {
      const top = Math.max(40, Math.round(toolbar.bottom - root.top + 20));
      return { top: `${top}px`, right: "40px", bottom: "72px", left: "40px" } as const;
    }
    const left = root && toolbar ? Math.max(32, Math.round(toolbar.right - root.left + 28)) : 96;
    return { top: "40px", right: "40px", bottom: "72px", left: `${left}px` } as const;
  }, []);

  /** Keep handles a constant screen size at any zoom (#8ht6zhdv item 2). */
  const lod = useRef<LodLevel>(0);
  const zoomVar = useRef(createZoomVar()).current;
  const zoomNow = useRef(1);
  const viewRestFrame = useRef(0);
  const viewQuietFrames = useRef(0);
  const viewMoving = useRef(false);
  // Every dot can show with the connector tool, and while a connection is
  // dragged (the target's dots appear under the pointer): the whole board then.
  const connectorTool = useRef(false);
  connectorTool.current = tool === "connector";
  const connecting = useRef(false);
  /** The object under the pointer, and where the pointer last was (client px). */
  const hoveredNode = useRef<Element | null>(null);
  const lastPointer = useRef<{ x: number; y: number } | null>(null);
  /** #zkknytrs: `--board-zoom` on the elements whose dots can show (zoom-var.ts), not the whole board. */
  const selectedNodeElements = useRef<HTMLElement[]>([]);
  const selectedKey = useRef("");
  /**
   * `full` looks up the selected objects again (zoom, selection, tool, rest);
   * a hover change reuses them, so objects sliding under the pointer during a
   * pan cost two style writes, not a query over the whole board.
   */
  const placeZoomVar = useCallback(
    (full = true) => {
      const root = rootRef.current;
      if (!root) return;
      if (full) {
        // From our selection, not React Flow's `selected` class, which can land a
        // render later. Looked up again only when the selection changed or one of
        // its objects isn't in the page yet (or anymore): a drag re-renders often.
        const ids = selectedRef.current.nodes;
        const key = ids.join("\n");
        const cached = selectedNodeElements.current;
        const complete = cached.length === ids.length && cached.every((element) => element.isConnected);
        if (key !== selectedKey.current || !complete) {
          const wanted = new Set(ids);
          selectedNodeElements.current =
            wanted.size === 0 ? [] : [...root.querySelectorAll<HTMLElement>(".react-flow__node")].filter((element) => wanted.has(element.dataset.id ?? ""));
          selectedKey.current = key;
        }
      }
      // Compensate down to the minimum zoom, so dots keep a ~10 px screen
      // target however far out you are (#zk6etvae).
      const targets = zoomVarTargets(root, connectorTool.current || connecting.current, hoveredNode.current, selectedNodeElements.current);
      zoomVar.sync(targets, Math.max(MIN_ZOOM, zoomNow.current));
    },
    [zoomVar],
  );
  /** placeZoomVar in the next frame, at most once per frame. */
  const zoomVarFrame = useRef(0);
  const placeZoomVarSoon = useCallback(() => {
    if (zoomVarFrame.current) return;
    zoomVarFrame.current = requestAnimationFrame(() => {
      zoomVarFrame.current = 0;
      placeZoomVar();
    });
  }, [placeZoomVar]);
  const syncZoomVar = useCallback((zoom: number) => {
    const root = rootRef.current;
    if (!root) return;
    // A pan (same zoom) changes no dot size: only objects that come into view
    // need it, which the rest pass below covers.
    if (zoom !== zoomNow.current) {
      zoomNow.current = zoom;
      placeZoomVar();
      // Objects that come into view mount after this step: place it on them too.
      placeZoomVarSoon();
    }
    // Once the view rests (a few frames with no change, however slow the
    // frames are): newly mounted objects, and the object now under a pointer
    // that didn't move (no pointer event tells us). Once per gesture, never per step.
    viewQuietFrames.current = 0;
    viewMoving.current = true;
    if (!viewRestFrame.current) {
      const watch = (): void => {
        viewQuietFrames.current += 1;
        if (viewQuietFrames.current < 3) {
          viewRestFrame.current = requestAnimationFrame(watch);
          return;
        }
        viewRestFrame.current = 0;
        viewMoving.current = false;
        const board = rootRef.current;
        if (board && lastPointer.current) hoveredNode.current = board.querySelector(".react-flow__node:hover");
        placeZoomVar();
      };
      viewRestFrame.current = requestAnimationFrame(watch);
    }
    // Level of detail: unreadably small text is drawn as bars (lod.ts).
    const level = lodLevel(zoom, lod.current);
    if (level !== lod.current || !root.dataset.lod) {
      lod.current = level;
      root.dataset.lod = String(level);
    }
  }, [placeZoomVar, placeZoomVarSoon]);
  const onViewportChange = useCallback((viewport: Viewport) => syncZoomVar(viewport.zoom), [syncZoomVar]);
  const onConnectStartZoomVar = useCallback(() => {
    connecting.current = true;
    placeZoomVar();
  }, [placeZoomVar]);
  const onConnectEndZoomVar: OnConnectEnd = useCallback(
    (event, state) => {
      connecting.current = false;
      placeZoomVar();
      onConnectEnd(event, state);
    },
    [onConnectEnd, placeZoomVar],
  );
  useOnViewportChange({ onChange: onViewportChange });
  // Selection and tool decide where dots show (after React Flow has rendered the `selected` classes).
  useEffect(() => {
    placeZoomVar();
    placeZoomVarSoon();
  }, [selection, tool, placeZoomVar, placeZoomVarSoon]);
  useEffect(
    () => () => {
      cancelAnimationFrame(viewRestFrame.current);
      cancelAnimationFrame(zoomVarFrame.current);
    },
    [],
  );

  const onInit = useCallback(() => {
    syncZoomVar(flow.getZoom());
    if (initialViewport) return;
    if (boardRef.current.nodes.length > 0) {
      void flow.fitView({ padding: fitPadding(), maxZoom: 1 });
    } else {
      const rect = rootRef.current?.getBoundingClientRect();
      void flow.setViewport({ x: (rect?.width ?? 0) / 2, y: (rect?.height ?? 0) / 2, zoom: 1 });
    }
  }, [flow, initialViewport, fitPadding, syncZoomVar]);

  const fit = useCallback(() => {
    if (boardRef.current.nodes.length === 0) {
      const rect = rootRef.current?.getBoundingClientRect();
      void flow.setViewport({ x: (rect?.width ?? 0) / 2, y: (rect?.height ?? 0) / 2, zoom: 1 }, { duration: motionMs(200) });
    } else {
      void flow.fitView({ padding: fitPadding(), maxZoom: 1, duration: motionMs(200) });
    }
  }, [flow, fitPadding]);

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

  /* ---------------- the keyboard (#pujmbsyz, a11y audit P2 4) ---------------- */

  /** What the live region says (a repeat gets a no-break space so it's announced again). */
  const [announcement, setAnnouncement] = useState("");
  const announce = useCallback((message: string) => {
    setAnnouncement((current) => (current === message ? `${message}\u00a0` : message));
  }, []);
  const describe = useCallback((id: string): string => {
    const node = boardRef.current.nodes.find((candidate) => candidate.id === id);
    return node ? describeNode(node, t) : "";
  }, []);
  /** Set during a pointer press: focus that follows a click doesn't re-select (Shift+click keeps its set). */
  const pointerFocus = useRef(false);
  const nodeElement = useCallback(
    (id: string): HTMLElement | null => rootRef.current?.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(id)}"]`) ?? null,
    [],
  );
  /** Select an object and focus it, bringing it into view first when it's off screen. */
  const focusNode = useCallback(
    (id: string) => {
      const node = boardRef.current.nodes.find((candidate) => candidate.id === id);
      if (!node) return;
      select([id]);
      const element = nodeElement(id);
      const root = rootRef.current?.getBoundingClientRect();
      const box = element?.getBoundingClientRect();
      const visible = !!(element && root && box && box.right > root.left && box.left < root.right && box.bottom > root.top && box.top < root.bottom);
      if (!visible) void flow.setCenter(node.x + node.width / 2, node.y + node.height / 2, { zoom: flow.getZoom(), duration: 0 });
      requestAnimationFrame(() => nodeElement(id)?.focus({ preventScroll: true }));
    },
    [flow, nodeElement, select],
  );

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

  /**
   * #b9425ktw D (@lead): the Align button and its 3×3 panel by keyboard. Enter or Space on the button opens the
   * panel with the focus on its first button; arrows move in the grid (Home/End to the ends); Escape closes it and
   * gives the focus back to the button. These keys are taken here (preventDefault), so the board's own (arrows move
   * objects, Enter edits one, Escape clears the selection) don't also run.
   */
  const alignKeys = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const inMenu = alignMenuRef.current?.contains(target) ?? false;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (target === alignButtonRef.current) focusAlignMenu.current = !alignMenu;
      (target as HTMLButtonElement).click();
      return;
    }
    if (event.key === "Escape" && (inMenu || alignMenu)) {
      event.preventDefault();
      setAlignMenu(false);
      alignButtonRef.current?.focus();
      return;
    }
    if (!inMenu) return;
    const buttons = [...(alignMenuRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const at = buttons.indexOf(target as HTMLButtonElement);
    if (at === -1) return;
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 3, ArrowUp: -3 }[event.key as string];
    let next = at;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    else if (step !== undefined) next = at + step;
    else return;
    event.preventDefault();
    // Within the grid; a disabled button (distribute with two objects) is skipped in the direction of travel.
    const direction = step !== undefined ? Math.sign(step) : event.key === "Home" ? 1 : -1;
    while (next >= 0 && next < buttons.length && buttons[next]!.disabled) next += direction;
    if (next >= 0 && next < buttons.length) buttons[next]!.focus();
  }, [alignMenu]);

  /** #b9425ktw D (#fzrwse3y's P3 6): align or distribute the selected objects; one undo step, said aloud. */
  const arrange = useCallback(
    (how: Alignment | Distribution) => {
      const ids = new Set(selectedRef.current.nodes);
      const current = boardRef.current;
      const next = how === "horizontal" || how === "vertical" ? distributeNodes(current, ids, how) : alignNodes(current, ids, how);
      // Nothing to move (already lined up): no undo step, and nothing said (@opus-editor's nit).
      if (next === current) return;
      apply(() => next);
      announce(t("board.aligned", { count: ids.size }));
    },
    [announce, apply],
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

  // Cmd+K acts as the keys and zoom buttons do, then gives focus back to the
  // board, so the next key reaches it (`ownsEvent`).
  paletteRef.current = {
    setTool: (next) => {
      chooseTool(next);
      // As with S: the shape choices show too.
      if (next === "shape") setShapeMenu(true);
      rootRef.current?.focus({ preventScroll: true });
    },
    view: (action) => {
      if (action === "fit") fit();
      else if (action === "in") void flow.zoomIn({ duration: 150 });
      else if (action === "out") void flow.zoomOut({ duration: 150 });
      else void flow.zoomTo(1, { duration: 150 });
      rootRef.current?.focus({ preventScroll: true });
    },
  };

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
      // #9ajce8q3: letters and brackets by the layout's letter, or by position on a non-Latin layout (ЙЦУКЕН).
      const lower = layoutKey(event);

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
      // #b9425ktw D (@lead: not mouse-only): Alt+Shift+L/C/R/T/M/B align, Alt+Shift+H/V distribute a multi-selection.
      // By the key's position (event.code), so they work in any keyboard layout, and Alt's dead keys on macOS don't
      // matter. Tabbing to the Align button would select one object instead.
      if (event.altKey && event.shiftKey && !mod) {
        const how = ALIGN_KEYS[event.code];
        if (how && selectedRef.current.nodes.length >= 2) {
          event.preventDefault();
          arrange(how);
          return;
        }
      }
      if (mod || event.altKey) return;

      // Tab / Shift+Tab: the next object in reading order; past either end, out of the board.
      if (key === "Tab") {
        const root = rootRef.current;
        if (!root || tool !== "select" || !(event.target instanceof Element) || !root.contains(event.target)) return;
        const focused = event.target.closest<HTMLElement>(".react-flow__node");
        const current = focused?.dataset.id ?? (selectedRef.current.nodes.length === 1 ? (selectedRef.current.nodes[0] ?? null) : null);
        const next = nextInOrder(readingOrder(boardRef.current.nodes), current, event.shiftKey);
        if (!next) {
          // Past either end: out of the board. The browser's own Tab would walk
          // the other objects in creation order, so take them out of it for this key.
          const stops = [...root.querySelectorAll<HTMLElement>(".react-flow__node, .react-flow__edge")]
            .filter((el) => el.tabIndex >= 0)
            .map((el) => [el, el.tabIndex] as const);
          for (const [el] of stops) el.tabIndex = -1;
          window.setTimeout(() => {
            for (const [el, tabIndex] of stops) if (el.isConnected) el.tabIndex = tabIndex;
          }, 0);
          return;
        }
        event.preventDefault();
        focusNode(next);
        return;
      }

      if (key === "Escape") {
        if (tool !== "select") chooseTool("select");
        else select([]);
        return;
      }
      if (key === "Delete" || key === "Backspace") {
        event.preventDefault();
        const count = selectedRef.current.nodes.length + selectedRef.current.edges.length;
        deleteSelection();
        if (count > 0) {
          announce(t("board.a11y.deleted", { count }));
          // The focused object is gone: keep the keyboard on the board.
          rootRef.current?.focus({ preventScroll: true });
        }
        return;
      }
      if (key === "Enter") {
        // #sdwrzdgx: on a focused button (a tool, a colour, zoom, a card's Open) Enter presses
        // it; only on the board or an object does it place or edit.
        if (event.target instanceof Element && event.target.closest(CONTROL_SELECTOR)) return;
        // With a tool chosen: place the object in the middle of the view and start typing in it.
        if (tool === "sticky" || tool === "text" || tool === "shape" || tool === "frame") {
          event.preventDefault();
          const rect = rootRef.current?.getBoundingClientRect();
          const client = rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : { x: 0, y: 0 };
          const at = viewCentre();
          createFromDraft({ tool, start: at, startClient: client, current: at, currentClient: client });
          announce(t("board.a11y.placed", { label: t(`board.tools.${tool}` as const) }));
          return;
        }
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
        const step = event.shiftKey ? 40 : 8;
        const dx = key === "ArrowLeft" ? -step : key === "ArrowRight" ? step : 0;
        const dy = key === "ArrowUp" ? -step : key === "ArrowDown" ? step : 0;
        const followers = frameFollowers(boardRef.current, ids);
        apply((current) => nudgeNodes(current, new Set([...ids, ...followers]), dx, dy));
        const [first] = selectedRef.current.nodes;
        if (first) announce(t("board.a11y.moved", { label: ids.size === 1 ? describe(first) : String(ids.size) }));
        return;
      }
      if (key === "!" || (event.shiftKey && event.code === "Digit1")) {
        event.preventDefault();
        fit();
        return;
      }
      if (lower === "]" || lower === "[") {
        // #sdwrzdgx: frames always sit behind cards, so a frames-only selection doesn't reorder; say why.
        const chosen = boardRef.current.nodes.filter((node) => selectedRef.current.nodes.includes(node.id));
        if (chosen.length > 0 && chosen.every((node) => node.type === "group")) announce(t("board.framesBehind"));
        else reorder(lower === "]" ? "front" : "back");
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
  }, [actions, announce, apply, arrange, chooseTool, createFromDraft, deleteSelection, describe, doRedo, doUndo, duplicateSelection, fit, focusNode, ownsEvent, reorder, select, tool, viewCentre]);

  /* ---------------- clipboard ---------------- */

  useEffect(() => {
    const onCopy = (event: ClipboardEvent, cut: boolean): void => {
      if (!ownsEvent(document.activeElement) || isTypingTarget(document.activeElement)) return;
      const ids = new Set(selectedRef.current.nodes);
      if (ids.size === 0) return;
      event.preventDefault();
      const clip = copySelection(boardRef.current, ids);
      // #sdwrzdgx: the board format under its own type; readable text for pages and other apps.
      event.clipboardData?.setData(CLIPBOARD_MIME, clipboardToText(clip));
      event.clipboardData?.setData("text/plain", clipboardPlainText(clip, pagesRef.current));
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
      // The board format, or (copied before #sdwrzdgx) the same JSON as text.
      const clip = clipboardFromText(data.getData(CLIPBOARD_MIME)) ?? clipboardFromText(text);
      if (!text && !clip) return;
      event.preventDefault();
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
      const wiki = new RegExp(String.raw`^\[\[(${WIKILINK_TARGET}+)(?:#${WIKILINK_PART}*)?(?:\|${WIKILINK_INNER}*)?\]\]$`).exec(trimmed);
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

  /* ---------------- connector tool (#r3d9ft49) ---------------- */

  /**
   * With the Connector tool, the overlay owns the pointer (objects never move):
   * drag from anywhere on an object to another, or click one then the other.
   * Both ends snap to the nearest sides; a drop on empty canvas cancels.
   */
  const [link, setLink] = useState<{
    from: string;
    fromRect: DOMRect;
    current: Point;
    target: { id: string; rect: DOMRect } | null;
    startClient: Point;
  } | null>(null);
  const [linkFrom, setLinkFrom] = useState<{ id: string; rect: DOMRect } | null>(null);

  /** The object under a screen point (the overlay sits above them). */
  const objectAt = useCallback((client: Point): { id: string; rect: DOMRect } | null => {
    const stack = document.elementsFromPoint(client.x, client.y);
    let frame: { id: string; rect: DOMRect } | null = null;
    for (const element of stack) {
      const node = element.closest<HTMLElement>(".react-flow__node");
      if (!node?.dataset.id || !rootRef.current?.contains(node)) continue;
      const hit = { id: node.dataset.id, rect: node.getBoundingClientRect() };
      // Prefer what's on top of a frame; connect the frame itself only if nothing else is there.
      if (node.classList.contains("board-node-group")) {
        frame ??= hit;
        continue;
      }
      return hit;
    }
    return frame;
  }, []);

  useEffect(() => {
    if (tool !== "connector") {
      setLink(null);
      setLinkFrom(null);
      return;
    }
    // Like Miro: picking the tool clears the selection (no handles under the pick outline).
    select([]);
  }, [tool, select]);

  const onConnectorDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    rootRef.current?.focus({ preventScroll: true });
    const client = { x: event.clientX, y: event.clientY };
    const hit = objectAt(client);
    if (!hit) {
      setLinkFrom(null);
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    setLink({ from: hit.id, fromRect: hit.rect, current: client, target: null, startClient: client });
  };

  const onConnectorMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!link) return;
    const client = { x: event.clientX, y: event.clientY };
    const hit = objectAt(client);
    setLink({ ...link, current: client, target: hit && hit.id !== link.from ? hit : null });
  };

  const onConnectorUp = (): void => {
    if (!link) return;
    const current = link;
    setLink(null);
    const moved =
      Math.abs(current.current.x - current.startClient.x) > CLICK_SLOP ||
      Math.abs(current.current.y - current.startClient.y) > CLICK_SLOP;
    if (moved) {
      // Dropped on empty canvas: nothing is made (spec/whiteboard §3).
      if (current.target) connect(current.from, null, current.target.id, null);
      setLinkFrom(null);
      return;
    }
    // A click: the first picks the start, the second the end.
    if (linkFrom && linkFrom.id !== current.from) {
      connect(linkFrom.id, null, current.from, null);
      setLinkFrom(null);
    } else {
      setLinkFrom(linkFrom?.id === current.from ? null : { id: current.from, rect: current.fromRect });
    }
  };

  const connectorHintKey = "gumply:board-connector-hint";
  const [connectorHint, setConnectorHint] = useState(false);
  useEffect(() => {
    if (tool !== "connector") {
      setConnectorHint(false);
      return;
    }
    let seen = false;
    try {
      seen = window.localStorage.getItem(connectorHintKey) === "seen";
      window.localStorage.setItem(connectorHintKey, "seen");
    } catch {
      // Storage unavailable: show it every time, which is harmless.
    }
    if (seen) return;
    setConnectorHint(true);
    const timer = window.setTimeout(() => setConnectorHint(false), 6000);
    return () => window.clearTimeout(timer);
  }, [tool]);

  /** A screen rect relative to the board root, for overlay drawing. */
  const local = (rect: DOMRect): { left: number; top: number; width: number; height: number } => {
    const root = rootRef.current?.getBoundingClientRect();
    return { left: rect.left - (root?.left ?? 0), top: rect.top - (root?.top ?? 0), width: rect.width, height: rect.height };
  };

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
  // #sdwrzdgx: frames always sit behind cards (as in Obsidian), so front/back can't move frames-only selections.
  const framesOnly = selectedNodes.length > 0 && selectedNodes.every((node) => node.type === "group");
  const shapesSelected = selectedNodes.length > 0 && selectedNodes.every((node) => gumplyNodeData(node)?.kind === "shape");
  const selectedShape = shapesSelected ? (gumplyNodeData(selectedNodes[0] as CanvasNode) as { shape: GumplyShape }).shape : null;
  const showNodeToolbar = selectedNodeIds.length > 0 && !editing && !dragging && tool === "select";

  busyRef.current = editing !== null || dragging || draft !== null || stroke !== null || link !== null;
  const hand = tool === "hand";
  const toolbarEdge = toolbarEdgeId && !dragging ? board.edges.find((edge) => edge.id === toolbarEdgeId) : undefined;
  const modifier = currentModifierLabel();

  return (
    <BoardActionsContext.Provider value={actions}>
      <BoardLookContext.Provider value={look}>
      <BoardContentContext.Provider value={content}>
      <BoardRenderersContext.Provider value={renderers ?? boardContentRenderers}>
        <div
          ref={rootRef}
          className={`board-root board-tool-${tool}${dragging ? " is-dragging" : ""}`}
          tabIndex={-1}
          data-testid="board"
          data-tool={tool}
          role="region"
          aria-label={t("board.a11y.label")}
          onPointerDownCapture={() => {
            pointerFocus.current = true;
            window.setTimeout(() => {
              pointerFocus.current = false;
            }, 0);
          }}
          onFocus={(event) => {
            // #pujmbsyz: keyboard focus on an object selects it (React Flow's own keyboard mode stays off).
            if (pointerFocus.current || editing) return;
            const element = event.target instanceof Element ? event.target.closest<HTMLElement>(".react-flow__node") : null;
            const id = element?.dataset.id;
            if (!id) return;
            const { nodes: selected } = selectedRef.current;
            if (!(selected.length === 1 && selected[0] === id)) select([id]);
            announce(t("board.a11y.selected", { label: describe(id) }));
          }}
          onPointerDown={() => {
            if (!editing && document.activeElement !== rootRef.current && !isTypingTarget(document.activeElement)) {
              rootRef.current?.focus({ preventScroll: true });
            }
          }}
          onPointerMove={(event) => {
            pointerRef.current = toFlow({ x: event.clientX, y: event.clientY });
            lastPointer.current = { x: event.clientX, y: event.clientY };
          }}
          onPointerOver={(event) => {
            // Hover shows an object's dots: give it `--board-zoom` when the pointer moves onto another object.
            const node = event.target instanceof Element ? event.target.closest(".react-flow__node") : null;
            if (node === hoveredNode.current) return;
            hoveredNode.current = node;
            // While the view moves, objects slide under a still pointer: the rest pass places the last one.
            if (!viewMoving.current) placeZoomVar(false);
          }}
          onPointerLeave={() => {
            pointerRef.current = null;
            lastPointer.current = null;
            if (hoveredNode.current) {
              hoveredNode.current = null;
              placeZoomVar(false);
            }
          }}
          onDoubleClick={onDoubleClick}
          onDragOver={onDragOver}
          onDrop={onDrop}
        >
          <div className="visually-hidden" role="status" aria-live="polite" data-testid="board-announcer">
            {announcement}
          </div>
          {/* #b9425ktw (#fzrwse3y's P3 7): the tool toolbar comes first in the markup, so it's the first Tab stop
              on the board (it's first on screen); it's positioned absolutely, so where it sits on screen is unchanged. */}
          <div className="board-toolbar" role="toolbar" aria-label={t("board.toolsLabel")} aria-orientation="vertical" data-testid="board-toolbar">
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
                label={uploadFile ? t("board.imageOrFile") : t("board.imageOrFileUnavailable")}
                testId="board-tool-image"
                disabled={!uploadFile}
                onClick={() => fileInputRef.current?.click()}
              />
              <ToolButton
                icon="page"
                label={t("board.addPageEllipsis")}
                testId="board-tool-page"
                active={pagePicker}
                onClick={() => {
                  setShapeMenu(false);
                  setPagePicker((open) => !open);
                }}
              />
            </div>
            <div className="board-toolbar-group">
              <ToolButton icon="undo" label={t("common.undo")} keys={withModifier(modifier, "Z")} testId="board-undo" disabled={!canUndo(history)} onClick={doUndo} />
              <ToolButton icon="redo" label={t("board.redo")} keys={`${modifier}+Shift+Z`} testId="board-redo" disabled={!canRedo(history)} onClick={doRedo} />
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
            onConnectStart={onConnectStartZoomVar}
            onConnectEnd={onConnectEndZoomVar}
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
            nodesConnectable={tool === "select"}
            elementsSelectable={tool === "select"}
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
            {settling ? <GroupDragSettler settling={settling} onDone={settleDone} /> : null}

            {/* Mounted only while shown: NodeToolbar subscribes to every id it is
                given, and on each node update it rebuilds and compares the whole
                list, which is O(n²) per frame when dragging a big selection
                (#r6biyzx6). */}
            {showNodeToolbar ? (
            <NodeToolbar nodeId={selectedNodeIds} isVisible position={Position.Top} offset={14}>
              <ClampedToolbar>
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
                {selectedNodeIds.length >= 2 ? (
                  <div className="board-context-group board-align" onKeyDown={alignKeys}>
                    <button
                      type="button"
                      ref={alignButtonRef}
                      className={`board-context-button${alignMenu ? " is-active" : ""}`}
                      aria-label={t("board.align")}
                      aria-haspopup="true"
                      aria-expanded={alignMenu}
                      data-tooltip={t("board.align")}
                      data-testid="board-align"
                      onClick={() => setAlignMenu((open) => !open)}
                    >
                      <BoardIcon name="align-left" size={16} />
                    </button>
                    {alignMenu ? (
                      <div className="board-align-menu" ref={alignMenuRef} role="group" aria-label={t("board.align")} data-testid="board-align-menu">
                        {(
                          [
                            ["left", "align-left", "board.alignLeft"],
                            ["center", "align-center", "board.alignCenter"],
                            ["right", "align-right", "board.alignRight"],
                            ["top", "align-top", "board.alignTop"],
                            ["middle", "align-middle", "board.alignMiddle"],
                            ["bottom", "align-bottom", "board.alignBottom"],
                            ["horizontal", "distribute-horizontal", "board.distributeHorizontal"],
                            ["vertical", "distribute-vertical", "board.distributeVertical"],
                          ] as const
                        ).map(([how, icon, label]) => (
                          <button
                            type="button"
                            key={how}
                            className="board-context-button"
                            aria-label={t(label)}
                            data-tooltip={`${t(label)} · ${alignShortcut(how)}`}
                            aria-keyshortcuts={`Alt+Shift+${ALIGN_LETTERS[how]}`}
                            data-testid={`board-align-${how}`}
                            // Distributing needs three: the first and last stay, the ones between move.
                            disabled={(how === "horizontal" || how === "vertical") && selectedNodeIds.length < 3}
                            onClick={() => arrange(how)}
                          >
                            <BoardIcon name={icon} size={16} />
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <div className="board-context-group">
                  <button
                    type="button"
                    className="board-context-button"
                    aria-label={t("board.bringToFront")}
                    aria-disabled={framesOnly || undefined}
                    aria-description={framesOnly ? t("board.framesBehind") : undefined}
                    data-tooltip={framesOnly ? t("board.framesBehind") : `${t("board.bringToFront")} · ]`}
                    data-testid="board-front"
                    onClick={() => {
                      if (!framesOnly) reorder("front");
                    }}
                  >
                    <BoardIcon name="front" size={16} />
                  </button>
                  <button
                    type="button"
                    className="board-context-button"
                    aria-label={t("board.sendToBack")}
                    aria-disabled={framesOnly || undefined}
                    aria-description={framesOnly ? t("board.framesBehind") : undefined}
                    data-tooltip={framesOnly ? t("board.framesBehind") : `${t("board.sendToBack")} · [`}
                    data-testid="board-back"
                    onClick={() => {
                      if (!framesOnly) reorder("back");
                    }}
                  >
                    <BoardIcon name="back" size={16} />
                  </button>
                  <button type="button" className="board-context-button is-danger" aria-label={t("common.delete")} data-tooltip={`${t("common.delete")} · Del`} data-testid="board-delete" onClick={deleteSelection}>
                    <BoardIcon name="trash" size={16} />
                  </button>
                </div>
              </div>
              </ClampedToolbar>
            </NodeToolbar>
            ) : null}

            <Panel position="top-right">
              <BoardExportButton busy={exporter.busy} onClick={() => setExportDialog({})} />
            </Panel>

            <Panel position="bottom-right" className="board-zoom">
              <button type="button" className="board-zoom-button" aria-label={t("board.zoomOut")} data-tooltip={t("board.zoomOut")} data-testid="board-zoom-out" onClick={() => void flow.zoomOut({ duration: 150 })}>
                <BoardIcon name="minus" size={16} />
              </button>
              <button type="button" className="board-zoom-value" aria-label={t("board.resetZoom")} data-tooltip={t("board.zoomTo100")} data-testid="board-zoom-value" onClick={() => void flow.zoomTo(1, { duration: motionMs(150) })}>
                <ZoomPercent />
              </button>
              <button type="button" className="board-zoom-button" aria-label={t("board.zoomIn")} data-tooltip={t("board.zoomIn")} data-testid="board-zoom-in" onClick={() => void flow.zoomIn({ duration: 150 })}>
                <BoardIcon name="plus" size={16} />
              </button>
              <span className="board-zoom-divider" />
              <button type="button" className="board-zoom-button" aria-label={t("board.fitToScreen")} data-tooltip={`${t("board.fit")} · Shift+1`} data-testid="board-fit" onClick={fit}>
                <BoardIcon name="fit" size={16} />
              </button>
            </Panel>
          </ReactFlow>


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

          {tool === "connector" ? (
            <div
              className="board-overlay board-overlay-connector"
              data-testid="board-connector-overlay"
              onPointerDown={onConnectorDown}
              onPointerMove={onConnectorMove}
              onPointerUp={onConnectorUp}
              onPointerCancel={() => setLink(null)}
            >
              {linkFrom ? <div className="board-link-pick" style={local(linkFrom.rect)} data-testid="board-link-from" /> : null}
              {link?.target ? <div className="board-link-pick" style={local(link.target.rect)} /> : null}
              {link
                ? (() => {
                    const from = local(link.fromRect);
                    const root = rootRef.current?.getBoundingClientRect();
                    const x2 = link.current.x - (root?.left ?? 0);
                    const y2 = link.current.y - (root?.top ?? 0);
                    return (
                      <svg className="board-link-preview" width="100%" height="100%" aria-hidden="true">
                        <line x1={from.left + from.width / 2} y1={from.top + from.height / 2} x2={x2} y2={y2} />
                      </svg>
                    );
                  })()
                : null}
              {connectorHint ? (
                <div className="board-tool-hint" role="status" data-testid="board-connector-hint">
                  {t("board.connectorHint")}
                </div>
              ) : null}
            </div>
          ) : null}

          {toolbarEdge ? <ConnectorToolbar edge={toolbarEdge} rootRef={rootRef} layoutKey={board} /> : null}

          {exporter.stage}
          {exportDialog ? (
            <BoardExportDialog
              hasSelection={selectedNodeIds.length > 0}
              busy={exporter.busy}
              {...(exportDialog.format ? { initialFormat: exportDialog.format } : {})}
              onExport={exporter.start}
              onClose={() => setExportDialog(null)}
            />
          ) : null}

          {board.nodes.length === 0 ? (
            <div className="board-empty" data-testid="board-empty">
              <strong>{t("board.empty")}</strong>
              <span>{t("board.emptyHint")}</span>
            </div>
          ) : null}
        </div>
      </BoardRenderersContext.Provider>
      </BoardContentContext.Provider>
      </BoardLookContext.Provider>
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
      reject(new Error(t("board.upload.notImage")));
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
