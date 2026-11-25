/**
 * The sidebar rows' share of the selection and the rename (#8gudbajp).
 *
 * Every row used to get `selectedId` (and the rename draft) as props, so a
 * route change or one keystroke in a rename re-rendered every row of the tree
 * (5,200 in a big vault), defeating the rows' `memo`. Rows now read through a
 * selector instead: only a row whose answer changes ("am I selected?", "am I
 * being renamed, and to what?") renders again.
 */
import { useSyncExternalStore } from "react";
import type { PageId } from "@gumply/core";

export interface RowState {
  selectedId: PageId | null;
  renamingId: PageId | null;
  renameDraft: string;
}

export interface RowStateStore {
  get(): RowState;
  set(next: RowState): void;
  subscribe(listener: () => void): () => void;
}

export function createRowStateStore(initial: RowState): RowStateStore {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(next) {
      if (next.selectedId === state.selectedId && next.renamingId === state.renamingId && next.renameDraft === state.renameDraft) {
        return;
      }
      state = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Whether this row is the selected page. */
export function useRowSelected(store: RowStateStore, id: PageId): boolean {
  return useSyncExternalStore(store.subscribe, () => store.get().selectedId === id);
}

/** This row's rename text while it is being renamed, else null. */
export function useRowRename(store: RowStateStore, id: PageId): string | null {
  return useSyncExternalStore(store.subscribe, () => {
    const state = store.get();
    return state.renamingId === id ? state.renameDraft : null;
  });
}

/** Dev builds count row renders, so a test can check that only the affected rows render. */
export function countRowRender(): void {
  if (!import.meta.env.DEV || typeof window === "undefined") return;
  const counter = window as unknown as { __gumplyRowRenders?: number };
  counter.__gumplyRowRenders = (counter.__gumplyRowRenders ?? 0) + 1;
}
