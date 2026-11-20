/** What the board content renderers need from the app (#5hme2fwj). */
import { createContext, useContext } from "react";
import type { BoardPageOption } from "../BoardEditor.js";

export interface BoardContent {
  pages: readonly BoardPageOption[];
  /** Open a page or board by vault path. */
  openFile: (path: string) => void;
  /** The Markdown body of a page (for live page cards); null when unavailable. */
  loadPage?: (path: string) => Promise<string | null>;
}

export const BoardContentContext = createContext<BoardContent>({ pages: [], openFile: () => {} });

export function useBoardContent(): BoardContent {
  return useContext(BoardContentContext);
}
