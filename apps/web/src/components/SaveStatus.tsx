import type { SaveState } from "../editor/autosave.js";
import { useT } from "../i18n/index.js";

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
  const t = useT();
  return (
    <span
      className={`save-status save-status-${state}`}
      data-testid="save-status"
      data-state={state}
      aria-live="polite"
      title={
        state === "saving"
          ? t("save.savingTitle")
          : state === "saved"
            ? t("save.savedTitle")
            : state === "error"
              ? t("save.errorTitle")
              : state === "conflict"
                ? t("save.conflictTitle")
                : undefined
      }
    >
      {state === "saving" ? t("save.saving") : null}
      {state === "saved" ? t("save.saved") : null}
      {state === "error" ? (
        <>
          <span className="save-status-long">{t("save.errorLong")}</span>
          <span className="save-status-short">
            {t("save.errorShort")}
          </span>{" "}
          <button type="button" className="link-button" onClick={onRetry} data-testid="save-retry">
            {t("common.retry")}
          </button>
        </>
      ) : null}
      {state === "conflict" ? (
        <>
          <span className="save-status-long">{t("save.conflictLong")}</span>
          <span className="save-status-short">
            {t("save.conflictShort")}
          </span>{" "}
          <button
            type="button"
            className="link-button"
            onClick={onReload}
            data-testid="conflict-reload"
          >
            {t("save.reload")}
          </button>{" "}
          <button
            type="button"
            className="link-button"
            onClick={onKeepMine}
            data-testid="conflict-keep-mine"
          >
            {t("save.keepMine")}
          </button>
        </>
      ) : null}
    </span>
  );
}
