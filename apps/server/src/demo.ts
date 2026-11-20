/**
 * Demo vault seeded by the server once on a truly empty first run
 * (D10, spec/ux §2). Contents are fixed so tests can rely on the copy.
 */
import { childPageId, type CanvasBoard } from "@gumply/core";

export const WELCOME_TITLE = "Welcome";
export const DEMO_FOLDER_TITLE = "Gumply demo";
/** D25: the demo whiteboard, in the demo folder (#dvnb8n2n). */
export const DEMO_BOARD_TITLE = "Project map";

export interface DemoPage {
  title: string;
  parentId: string | null;
  content: string;
  icon?: string;
}

export function buildDemoPages(): DemoPage[] {
  const folderId = childPageId(null, DEMO_FOLDER_TITLE);

  return [
    {
      title: WELCOME_TITLE,
      icon: "👋",
      parentId: null,
      content: [
        // No H1 here: the page title "Welcome" already heads the page.
        "Gumply is a quiet place for notes: simple blocks, no clutter.",
        "",
        "Your notes are plain Markdown files on your computer.",
        "",
        "## A tiny cheat sheet",
        "",
        "- Type `/` for commands.",
        "- Type `[[` to link a page.",
        "- Press Cmd/Ctrl+K to find anything.",
        "",
        "[[Getting started]] · [[Graph view]]",
        "",
        // Boards are linked with their extension so Obsidian resolves them too.
        `Plan visually on a whiteboard: [[${DEMO_BOARD_TITLE}.canvas|${DEMO_BOARD_TITLE}]]`,
        "",
        "## Try it",
        "",
        "- [ ] Create your first page",
        "- [ ] Link two pages together",
        "",
      ].join("\n"),
    },
    {
      title: DEMO_FOLDER_TITLE,
      icon: "📁",
      parentId: null,
      content: "Small examples you can ignore or delete whenever you like.\n",
    },
    {
      title: "Getting started",
      icon: "📝",
      parentId: folderId,
      content: [
        "# Getting started",
        "",
        "Create a page with **New page** in the sidebar. Hover a row to add a **New sub-page**.",
        "",
        "- `/` opens the block menu.",
        "- `[[` links to another page.",
        "- Everything saves automatically — there is no save button.",
        "",
        "Back to [[Welcome]].",
        "",
      ].join("\n"),
    },
    {
      title: "Graph view",
      icon: "🕸️",
      parentId: folderId,
      content: [
        "# Graph view",
        "",
        "The graph shows every page as a dot and every link as a line.",
        "",
        "Back to [[Welcome]], or read [[Getting started]].",
        "",
      ].join("\n"),
    },
  ];
}

/**
 * The demo board: page cards for the demo pages inside a frame, a sticky and
 * a labelled arrow. Cards use vault-root paths (JSON Canvas); keys follow
 * Obsidian's order (id, type, content, gumply, x, y, width, height, color),
 * and the frame comes first so it sits behind its cards.
 */
export function buildDemoBoard(): CanvasBoard {
  const folderId = childPageId(null, DEMO_FOLDER_TITLE);
  const md = (id: string) => `${id}.md`;
  return {
    nodes: [
      { id: "a1f0c2d3e4b5a6f7", type: "group", label: "Start with these pages", x: -40, y: -80, width: 1160, height: 400 },
      { id: "b2e1d3c4f5a6b7c8", type: "file", file: md(childPageId(null, WELCOME_TITLE)), x: 0, y: 0, width: 320, height: 280 },
      { id: "c3d2e4f5a6b7c8d9", type: "file", file: md(childPageId(folderId, "Getting started")), x: 400, y: 0, width: 320, height: 280 },
      { id: "d4c3f5a6b7c8d9e0", type: "file", file: md(childPageId(folderId, "Graph view")), x: 800, y: 0, width: 280, height: 280 },
      {
        id: "e5b4a6c7d8e9f0a1",
        type: "text",
        text: "Start here: double-click to add a sticky",
        gumply: { kind: "sticky" },
        x: 0,
        y: 380,
        width: 260,
        height: 140,
        color: "3",
      },
    ],
    edges: [
      {
        id: "f6a5b7c8d9e0f1a2",
        fromNode: "b2e1d3c4f5a6b7c8",
        fromSide: "right",
        toNode: "c3d2e4f5a6b7c8d9",
        toSide: "left",
        label: "read next",
      },
      {
        id: "a7b6c8d9e0f1a2b3",
        fromNode: "c3d2e4f5a6b7c8d9",
        fromSide: "right",
        toNode: "d4c3f5a6b7c8d9e0",
        toSide: "left",
      },
    ],
  } as CanvasBoard;
}
