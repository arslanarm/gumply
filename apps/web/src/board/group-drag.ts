/**
 * Fast path for dragging many objects at once (#r6biyzx6).
 *
 * React Flow moves a selection by pushing a position change for every
 * selected node through React on each pointer move, so dragging 500 objects
 * re-rendered 500 node wrappers and 300 connectors per frame (~32 ms of JS).
 * For big selections the board instead:
 * - moves the node elements with one CSS `translate` each (it composes with
 *   React Flow's own `transform`), without React; when everything moves, it
 *   shifts React Flow's viewport instead (as cheap as a pan);
 * - lets connectors add the same offset to their moved ends (this store), so
 *   only connectors touching the selection re-render;
 * - commits the final positions once, on drop (one undo step, as before).
 */
import { useSyncExternalStore } from "react";

/** Below this many moving objects the normal (React) path is fast enough. */
export const GROUP_DRAG_MIN = 30;

export interface GroupOffset {
  /** Ids of every object that moves (selection plus frame followers). */
  ids: ReadonlySet<string>;
  dx: number;
  dy: number;
}

const NONE = { dx: 0, dy: 0 } as const;

let current: GroupOffset | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Publish the current offset (null when no group drag is running). */
export function setGroupOffset(next: GroupOffset | null): void {
  current = next;
  for (const listener of listeners) listener();
}

export function groupOffset(): GroupOffset | null {
  return current;
}

/**
 * The drag offset of one object: the shared offset object while it moves in a
 * group drag, else a constant zero (so unaffected connectors don't re-render).
 */
export function offsetOf(id: string): { dx: number; dy: number } {
  return current && current.ids.has(id) ? current : NONE;
}

export function useNodeOffset(id: string): { dx: number; dy: number } {
  return useSyncExternalStore(
    subscribe,
    () => offsetOf(id),
    () => NONE,
  );
}
