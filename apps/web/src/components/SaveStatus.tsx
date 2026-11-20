import type { SaveState } from "../editor/autosave.js";

export interface SaveStatusProps {
  state: SaveState;
  onRetry?: () => void;
  onReload?: () => void;
  onKeepMine?: () => void;
}

/**
 * Autosave indicator (D14 §7). Idle is blank but keeps its width so the
 * header never shifts; `data-state` is the e2e contract.
 */
export function SaveStatus({ state, onRetry, onReload, onKeepMine }: SaveStatusProps) {
  return (
    <span
      className={`save-status save-status-${state}`}
      data-testid="save-status"
      data-state={state}
      aria-live="polite"
      title={
        state === "saving"
          ? "Saving changes…"
          : state === "saved"
            ? "All changes saved"
            : state === "error"
              ? "Your edits are kept in this tab — retry saving"
              : state === "conflict"
                ? "This page changed on disk — choose Reload or Keep mine"
                : undefined
      }
    >
      {state === "saving" ? "Saving…" : null}
      {state === "saved" ? "Saved" : null}
      {state === "error" ? (
        <>
          <span className="save-status-long">Couldn't save —</span>
          <span className="save-status-short">
            Not saved
          </span>{" "}
          <button type="button" className="link-button" onClick={onRetry} data-testid="save-retry">
            Retry
          </button>
        </>
      ) : null}
      {state === "conflict" ? (
        <>
          <span className="save-status-long">This page changed on disk.</span>
          <span className="save-status-short">
            Changed on disk
          </span>{" "}
          <button
            type="button"
            className="link-button"
            onClick={onReload}
            data-testid="conflict-reload"
          >
            Reload
          </button>{" "}
          <button
            type="button"
            className="link-button"
            onClick={onKeepMine}
            data-testid="conflict-keep-mine"
          >
            Keep mine
          </button>
        </>
      ) : null}
    </span>
  );
}
