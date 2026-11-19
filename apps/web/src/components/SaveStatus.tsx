import type { SaveState } from "../editor/autosave.js";

export interface SaveStatusProps {
  state: SaveState;
  onRetry?: () => void;
}

/**
 * Autosave indicator (D14 §7). Idle is blank but keeps its width so the
 * header never shifts; `data-state` is the e2e contract.
 */
export function SaveStatus({ state, onRetry }: SaveStatusProps) {
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
              : undefined
      }
    >
      {state === "saving" ? "Saving…" : null}
      {state === "saved" ? "Saved" : null}
      {state === "error" ? (
        <>
          Couldn't save —{" "}
          <button type="button" className="link-button" onClick={onRetry} data-testid="save-retry">
            Retry
          </button>
        </>
      ) : null}
    </span>
  );
}
