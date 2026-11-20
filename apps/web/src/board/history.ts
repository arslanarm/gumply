/**
 * Undo/redo over immutable board snapshots. Snapshots share structure
 * (unchanged nodes are the same objects), so keeping many is cheap.
 */
import type { CanvasBoard } from "@gumply/core";

export const HISTORY_LIMIT = 200;

export interface BoardHistory {
  past: CanvasBoard[];
  present: CanvasBoard;
  future: CanvasBoard[];
}

export function createHistory(board: CanvasBoard): BoardHistory {
  return { past: [], present: board, future: [] };
}

/** Record a new state. A no-op change (same object) records nothing. */
export function commit(history: BoardHistory, next: CanvasBoard): BoardHistory {
  if (next === history.present) return history;
  const past = [...history.past, history.present];
  if (past.length > HISTORY_LIMIT) past.splice(0, past.length - HISTORY_LIMIT);
  return { past, present: next, future: [] };
}

/**
 * Fold `next` into the last undo step (typing a new sticky's first text is
 * part of creating it). Redo is cleared, as for any new change.
 */
export function amend(history: BoardHistory, next: CanvasBoard): BoardHistory {
  if (next === history.present) return history;
  if (history.past.length === 0) return commit(history, next);
  return { past: history.past, present: next, future: [] };
}

/** Forget the last step entirely (a new text box left empty). */
export function dropLast(history: BoardHistory): BoardHistory {
  const previous = history.past[history.past.length - 1];
  if (!previous) return history;
  return { past: history.past.slice(0, -1), present: previous, future: [] };
}

/** Replace the present without an undo step (e.g. a reload from disk). */
export function reset(board: CanvasBoard): BoardHistory {
  return createHistory(board);
}

export function undo(history: BoardHistory): BoardHistory {
  const previous = history.past[history.past.length - 1];
  if (!previous) return history;
  return { past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future] };
}

export function redo(history: BoardHistory): BoardHistory {
  const next = history.future[0];
  if (!next) return history;
  return { past: [...history.past, history.present], present: next, future: history.future.slice(1) };
}

export const canUndo = (history: BoardHistory): boolean => history.past.length > 0;
export const canRedo = (history: BoardHistory): boolean => history.future.length > 0;
