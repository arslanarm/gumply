/**
 * Board lab: a dev/e2e harness that mounts the board engine without the app
 * (open `/board-lab.html`). The board is kept in localStorage so reloads
 * keep it; `window.__board` exposes it to tests.
 *
 *   ?id=name     which stored board (default "lab")
 *   ?seed=N      start from a generated board with N objects (perf checks)
 *   &mix=1       …with every 10th object a live page card, Markdown and
 *                [[links]] in stickies, and a label on every 5th connector
 *   ?theme=dark  force a theme
 *   ?reset=1     start empty
 *   ?api=ID      mount BoardView for board ID against `/api/boards` instead
 *                (e2e mocks that API), with a save status and Reload/Keep mine
 */
import { emptyCanvas, parseCanvas, serializeCanvas, type CanvasBoard, type CanvasNode } from "@gumply/core";
import { StrictMode, Suspense, useCallback, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { SaveStatus } from "../components/SaveStatus.js";
import type { SaveState } from "../editor/autosave.js";
import "../styles.css";
import { BoardView, type BoardViewControls } from "./BoardView.js";
import { LazyBoardEditor, type BoardPageOption } from "./index.js";
import type { BoardEditorControls } from "./BoardEditor.js";
import { createEdge, createFileNode, createShape, createSticky, createText } from "./model.js";

interface LabWindow extends Window {
  __board?: {
    get: () => CanvasBoard;
    serialized: () => string;
    saves: number;
    opened: string[];
  };
}

const params = new URLSearchParams(window.location.search);
const boardId = params.get("id") ?? "lab";
const storageKey = `gumply:board-lab:${boardId}`;

const MIX_CARDS = ["Welcome.md", "Projects/Q1 plan.md", "Ideas.md", "Boards/Project map.canvas"];

function seeded(count: number, mix = false): CanvasBoard {
  const nodes: CanvasNode[] = [];
  const columns = Math.ceil(Math.sqrt(count));
  for (let i = 0; i < count; i += 1) {
    const x = (i % columns) * 260;
    const y = Math.floor(i / columns) * 260;
    const rect = { x, y, width: 200, height: i % 3 === 2 ? 120 : 200 };
    const color = String((i % 6) + 1);
    if (mix && i % 10 === 5) nodes.push(createFileNode(rect, MIX_CARDS[(i / 10) % MIX_CARDS.length | 0]!));
    else if (mix && i % 3 === 0) nodes.push(createSticky(rect, color, `**Sticky ${i}**\n\n- see [[Welcome]]\n- \`code\` and _more_`));
    else if (i % 3 === 0) nodes.push(createSticky(rect, color, `Sticky ${i}`));
    else if (i % 3 === 1) nodes.push(createShape(rect, i % 2 ? "rounded" : "ellipse", color, `Shape ${i}`));
    else nodes.push(createText(rect, `Text ${i}`));
  }
  const edges = [];
  for (let i = 0; i + 1 < nodes.length && edges.length < Math.round(count * 0.6); i += 1) {
    const a = nodes[i];
    const b = nodes[i + 1];
    if (a && b && (i + 1) % columns !== 0) {
      const edge = createEdge(a.id, "right", b.id, "left");
      if (mix && edges.length % 5 === 0) edge.label = `step ${edges.length}`;
      edges.push(edge);
    }
  }
  return { nodes, edges };
}

function initialBoard(): CanvasBoard {
  const seed = Number(params.get("seed") ?? "0");
  if (seed > 0) return seeded(seed, params.get("mix") === "1");
  if (params.get("reset") === "1") {
    window.localStorage.removeItem(storageKey);
    return emptyCanvas();
  }
  const stored = window.localStorage.getItem(storageKey);
  if (stored) {
    try {
      return parseCanvas(stored);
    } catch {
      // Broken lab data: start over.
    }
  }
  return emptyCanvas();
}

const PAGES: BoardPageOption[] = [
  { path: "Welcome.md", title: "Welcome", icon: "👋" },
  { path: "Projects/Q1 plan.md", title: "Q1 plan", icon: "🗓️" },
  { path: "Projects/Roadmap.md", title: "Roadmap" },
  { path: "Ideas.md", title: "Ideas", icon: "💡" },
  { path: "Boards/Project map.canvas", title: "Project map" },
];

/** Page bodies for live page cards in the lab (no API). */
const LAB_PAGE_TEXT: Record<string, string> = {
  "Welcome.md": "# Welcome to Gumply\n\nGumply is a **quiet** place for notes.\n\n- Type `/` for blocks\n- Type `[[` to link a page",
  "Projects/Q1 plan.md": "Goals for the quarter:\n\n1. Ship v0.4\n2. Fewer meetings",
  "Ideas.md": "",
};

function Lab() {
  const board = useMemo(initialBoard, []);
  const lab = useMemo(() => {
    const state = { board, saves: 0, opened: [] as string[] };
    (window as LabWindow).__board = {
      get: () => state.board,
      serialized: () => serializeCanvas(state.board),
      get saves() {
        return state.saves;
      },
      set saves(value: number) {
        state.saves = value;
      },
      opened: state.opened,
    };
    return state;
  }, [board]);

  const onChange = useCallback(
    (next: CanvasBoard) => {
      lab.board = next;
      lab.saves += 1;
      window.localStorage.setItem(storageKey, serializeCanvas(next));
    },
    [lab],
  );

  // #pypzxe6i: the board has no ⋯ of its own any more (the app's is its sidebar row): the lab's Export… opens the
  // same dialog.
  const editor = useRef<BoardEditorControls | null>(null);

  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <button
        type="button"
        className="button-secondary"
        data-testid="lab-export"
        style={{ position: "fixed", top: 12, right: 12, zIndex: 20 }}
        onClick={() => editor.current?.openExport()}
      >
        Export…
      </button>
      <Suspense fallback={null}>
        <LazyBoardEditor
          onReady={(controls) => {
            editor.current = controls;
          }}
          boardId={`lab:${boardId}`}
          board={board}
          onChange={onChange}
          pages={PAGES}
          onOpenFile={(path) => lab.opened.push(path)}
          uploadFile={async (file) => `attachments/${file.name}`}
          loadPage={async (path) => LAB_PAGE_TEXT[path] ?? null}
        />
      </Suspense>
    </div>
  );
}

function ApiLab({ id }: { id: string }) {
  const [state, setState] = useState<SaveState>("idle");
  const controls = useRef<BoardViewControls | null>(null);
  return (
    <div style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column" }}>
      <div className="topbar" style={{ justifyContent: "flex-end", minHeight: 44 }}>
        <SaveStatus
          state={state}
          onRetry={() => void controls.current?.flush()}
          onReload={() => void controls.current?.reload()}
          onKeepMine={() => void controls.current?.keepMine()}
        />
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <BoardView
          boardId={id}
          pages={PAGES}
          onSaveState={setState}
          onReady={(value) => {
            controls.current = value;
          }}
        />
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  const apiBoard = params.get("api");
  createRoot(root).render(<StrictMode>{apiBoard ? <ApiLab id={apiBoard} /> : <Lab />}</StrictMode>);
}
