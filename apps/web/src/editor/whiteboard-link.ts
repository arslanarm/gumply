/**
 * Boards in pages (spec/whiteboard §4, spec/v0-6 B, D30). The slash items and
 * the embed node views ask the open editor (or the app) to act; the editor
 * registers how, because it owns the app's callbacks and its own caret.
 */
import type { PageMeta } from "@gumply/core";

export interface WhiteboardRequest {
  /** The new board's title (a missing embed's Create); default "Untitled whiteboard". */
  title?: string;
  /** `/template`: pick a template in the gallery first (spec/v0-6 §D). */
  pickTemplate?: boolean;
}

let creator: (request: WhiteboardRequest) => void = () => {};

/** `/whiteboard` → New board here (and `/template`): create a board inside the page and embed it. */
export function setWhiteboardCreator(next: (request: WhiteboardRequest) => void): void {
  creator = next;
}

export function requestWhiteboard(request: WhiteboardRequest = {}): void {
  creator(request);
}

export interface BoardEmbedActions {
  /** Create a board titled `title` inside the open page (the missing-board Create). */
  createBoard: (title: string) => Promise<PageMeta | null>;
}

let embedActions: BoardEmbedActions = { createBoard: async () => null };

export function setBoardEmbedActions(next: BoardEmbedActions): void {
  embedActions = next;
}

export function getBoardEmbedActions(): BoardEmbedActions {
  return embedActions;
}
