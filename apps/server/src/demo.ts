/**
 * Demo vault seeded by the server once on a truly empty first run
 * (D10, spec/ux §2), in the interface language of the first request
 * (#93yv3ban): words live in `demo/<language>.ts`, English is the fallback.
 */
import { childPageId, type CanvasBoard } from "@gumply/core";
import { en } from "./demo/en.js";
import { ru } from "./demo/ru.js";
import type { DemoCopy } from "./demo/types.js";

const COPY: Readonly<Record<string, DemoCopy>> = { en, ru };
export type DemoLanguage = keyof typeof COPY & string;
export const DEMO_LANGUAGES: readonly string[] = Object.keys(COPY);

/** The demo's words in `language` (English when it has none). */
export function demoCopy(language = "en"): DemoCopy {
  return COPY[language] ?? en;
}

/**
 * The first language of an `Accept-Language` header the demo has, else
 * English: `"ru-RU,ru;q=0.9,en;q=0.8"` → `"ru"`.
 */
export function demoLanguageFor(acceptLanguage: string | null | undefined): string {
  const tags = (acceptLanguage ?? "")
    .split(",")
    .map((part) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params.map((param) => /^\s*q=([\d.]+)\s*$/.exec(param)?.[1]).find((value) => value !== undefined);
      return { base: tag.trim().toLowerCase().split("-")[0] ?? "", q: q === undefined ? 1 : Number(q) };
    })
    .filter((entry) => entry.base.length > 0 && entry.q > 0)
    .sort((a, b) => b.q - a.q);
  return tags.find((entry) => entry.base in COPY)?.base ?? "en";
}

/** English titles (kept for callers and tests that predate #93yv3ban). */
export const WELCOME_TITLE = en.welcome;
export const DEMO_FOLDER_TITLE = en.folder;
/** D25: the demo whiteboard, in the demo folder (#dvnb8n2n). */
export const DEMO_BOARD_TITLE = en.board;

export interface DemoPage {
  title: string;
  parentId: string | null;
  content: string;
  icon?: string;
}

export function buildDemoPages(language = "en"): DemoPage[] {
  const copy = demoCopy(language);
  const folderId = childPageId(null, copy.folder);
  // Boards are linked with their extension so Obsidian resolves them too.
  const boardLink = `[[${copy.board}.canvas|${copy.board}]]`;

  return [
    { title: copy.welcome, icon: "👋", parentId: null, content: copy.welcomeBody({ ...copy, boardLink }) },
    { title: copy.folder, icon: "📁", parentId: null, content: copy.folderBody },
    { title: copy.gettingStarted, icon: "📝", parentId: folderId, content: copy.gettingStartedBody(copy) },
    { title: copy.graphView, icon: "🕸️", parentId: folderId, content: copy.graphViewBody(copy) },
  ];
}

/**
 * The demo board: page cards for the demo pages inside a frame, a sticky and
 * a labelled arrow. Cards use vault-root paths (JSON Canvas); keys follow
 * Obsidian's order (id, type, content, gumply, x, y, width, height, color;
 * a frame's `label` comes last), and the frame comes first so it sits behind
 * its cards.
 */
export function buildDemoBoard(language = "en"): CanvasBoard {
  const copy = demoCopy(language);
  const folderId = childPageId(null, copy.folder);
  const md = (id: string) => `${id}.md`;
  return {
    nodes: [
      // Frames: Obsidian writes `label` last (after geometry and color).
      { id: "a1f0c2d3e4b5a6f7", type: "group", x: -40, y: -80, width: 1160, height: 400, label: copy.boardFrame },
      { id: "b2e1d3c4f5a6b7c8", type: "file", file: md(childPageId(null, copy.welcome)), x: 0, y: 0, width: 320, height: 280 },
      { id: "c3d2e4f5a6b7c8d9", type: "file", file: md(childPageId(folderId, copy.gettingStarted)), x: 400, y: 0, width: 320, height: 280 },
      { id: "d4c3f5a6b7c8d9e0", type: "file", file: md(childPageId(folderId, copy.graphView)), x: 800, y: 0, width: 280, height: 280 },
      {
        id: "e5b4a6c7d8e9f0a1",
        type: "text",
        text: copy.boardSticky,
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
        label: copy.boardArrow,
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
