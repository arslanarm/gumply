/** What the board content renderers need from the app (#5hme2fwj). */
import { createContext, useContext } from "react";
import type { BoardPageOption } from "../BoardEditor.js";

export interface BoardContent {
  pages: readonly BoardPageOption[];
  /** Open a page or board by vault path. */
  openFile: (path: string) => void;
  /** The Markdown body of a page (for live page cards); null when unavailable. */
  loadPage?: (path: string) => Promise<string | null>;
  /** #8k4ssrkb: the board's id and its resolved Obsidian file links (`![[x.png]]` in text). */
  boardId?: string;
  fileLinks?: Readonly<Record<string, string | null>>;
}

export const BoardContentContext = createContext<BoardContent>({ pages: [], openFile: () => {} });

export function useBoardContent(): BoardContent {
  return useContext(BoardContentContext);
}
