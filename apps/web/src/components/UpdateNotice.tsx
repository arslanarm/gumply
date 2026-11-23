/**
 * The update notice (spec/auto-update §9, D42): a quiet bar at the bottom of
 * the sidebar when there's something to say: an update is ready (Restart now /
 * Later), available to download (.deb, macOS, "only tell me"), or waiting for
 * AI apps to close. Never modal and never takes focus; "Later" hides it until
 * the next start, once per version.
 */
import type { DesktopUpdatesState } from "@gumply/core";
import { api } from "../api/client.js";
import { useT } from "../i18n/index.js";
import { Icon } from "./Icon.js";

const SHOWN: ReadonlySet<DesktopUpdatesState["status"]> = new Set(["available", "ready", "pending-running", "read-only", "install-failed", "verify-failed"]);

/**
 * What the notice is about (`version:status`), or null when it has nothing to
 * say. "Later" hides one key; the app keeps that, so a closed sidebar's toggle
 * can show a dot only while the notice would show (#h4tyk92t).
 */
export function updateNoticeKey(state: DesktopUpdatesState | null): string | null {
  if (!state || !SHOWN.has(state.status) || !state.version) return null;
  // The notice is for news; with updates off, only Settings shows the state.
  if (state.mode === "off") return null;
  return `${state.version}:${state.status}`;
}

export function UpdateNotice({ state, hidden, onHide }: { state: DesktopUpdatesState | null; hidden: string | null; onHide: (key: string) => void }) {
  const t = useT();
  const key = updateNoticeKey(state);
  if (!state || !state.version || key === null || hidden === key) return null;

  const text =
    state.status === "ready"
      ? t("update.ready", { version: state.version })
      : state.status === "pending-running"
        ? t("settings.updates.pendingRunning")
        : state.status === "read-only"
          ? t("update.readOnly")
          : state.status === "install-failed"
            ? t("update.installFailed")
            : state.status === "verify-failed"
              ? t("update.verifyFailed")
              : t("update.available", { version: state.version });
  const hint = state.status === "available" ? (state.kind === "deb" ? t("update.debHint") : state.kind === "mac" ? t("update.macHint") : null) : null;

  return (
    <div className="update-notice" role="status" data-testid="update-notice" data-status={state.status}>
      <div className="update-notice-text">
        <Icon name="download" size={14} />
        <span>{text}</span>
      </div>
      {hint ? <p className="update-notice-hint">{hint}</p> : null}
      <div className="update-notice-actions">
        {state.status === "ready" ? (
          <button type="button" className="button-primary update-notice-button" data-testid="update-notice-restart" onClick={() => void api.restartForUpdate()}>
            {t("update.restart")}
          </button>
        ) : null}
        {state.releaseUrl && state.status !== "pending-running" ? (
          <a className="update-notice-link" href={state.releaseUrl} target="_blank" rel="noreferrer" data-testid="update-notice-release">
            {state.status === "ready" ? t("update.whatsNew") : t("update.download")}
          </a>
        ) : null}
        <button type="button" className="update-notice-later" data-testid="update-notice-later" onClick={() => onHide(key)}>
          {t("update.later")}
        </button>
      </div>
    </div>
  );
}
