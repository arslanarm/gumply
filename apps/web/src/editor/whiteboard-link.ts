/**
 * Boards in pages (spec/whiteboard §4, spec/v0-6 B, D30). The slash items and
 * the embed node views ask the open editor (or the app) to act; the editor
 * registers how, because it owns the app's callbacks and its own caret.
 */
import type { PageMeta } from "@gumply/core";

let creator: () => void = () => {};

/** `/whiteboard` → New board here: create a board inside the page and embed it. */
export function setWhiteboardCreator(next: () => void): void {
  creator = next;
}

export function requestWhiteboard(): void {
  creator();
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
