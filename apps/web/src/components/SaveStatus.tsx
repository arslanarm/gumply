import type { SaveState } from "../editor/autosave.js";

const LABELS: Record<SaveState, string> = {
  idle: "Ready",
  saving: "Saving…",
  saved: "Saved",
  error: "Save failed",
};

const TITLES: Record<SaveState, string> = {
  idle: "Changes save automatically",
  saving: "Saving changes…",
  saved: "All changes saved",
  error: "Could not save — check that the Gumply server is running",
};

/** Autosave indicator. `data-state` is the contract used by e2e. */
export function SaveStatus({ state }: { state: SaveState }) {
  return (
    <span
      className={`save-status save-status-${state}`}
      data-testid="save-status"
      data-state={state}
      title={TITLES[state]}
      aria-live="polite"
    >
      {LABELS[state]}
    </span>
  );
}
