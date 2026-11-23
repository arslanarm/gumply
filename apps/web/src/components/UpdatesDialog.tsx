/**
 * Settings → Updates (spec/auto-update §9, D42), desktop app only: how this
 * install updates (automatically, only tell me, off), Check now, when it last
 * checked, and what's waiting. The state comes from the desktop app
 * (`/api/desktop/updates`) and follows its `gumply:updates` events.
 */
import type { DesktopUpdatesState, UpdateMode } from "@gumply/core";
import { useEffect, useId, useRef, useState } from "react";
import { api } from "../api/client.js";
import { relativeTime, useT, type MessageKey } from "../i18n/index.js";
import { Icon } from "./Icon.js";
import { useModal } from "../lib/modal.js";

/** The desktop app's update state: null in the browser and in development (no route). */
export function useDesktopUpdates(desktop: boolean): [DesktopUpdatesState | null, (next: DesktopUpdatesState) => void] {
  const [state, setState] = useState<DesktopUpdatesState | null>(null);
  useEffect(() => {
    if (!desktop) return;
    let live = true;
    api.desktopUpdates().then(
      (next) => {
        if (live) setState(next);
      },
      () => undefined, // 404: this install doesn't update
    );
    const onUpdates = (event: Event) => {
      const next = (event as CustomEvent<DesktopUpdatesState>).detail;
      if (next && typeof next === "object") setState(next);
    };
    window.addEventListener("gumply:updates", onUpdates);
    return () => {
      live = false;
      window.removeEventListener("gumply:updates", onUpdates);
    };
  }, [desktop]);
  return [state, setState];
}

const MODE_LABEL: Record<UpdateMode, MessageKey> = {
  auto: "settings.updates.auto",
  notify: "settings.updates.notify",
  off: "settings.updates.off",
};

/** One line saying where things stand (Settings and the notice share it). */
export function updateStatusText(t: ReturnType<typeof useT>, state: DesktopUpdatesState): string | null {
  const version = state.version ?? state.currentVersion;
  switch (state.status) {
    case "checking":
      return t("settings.updates.checking");
    case "up-to-date":
      return t("settings.updates.upToDate", { version: state.currentVersion });
    case "available":
      return t("update.available", { version });
    case "downloading":
      return t("update.downloading", { version });
    case "ready":
      return t("update.ready", { version });
    case "pending-running":
      return t("settings.updates.pendingRunning");
    case "read-only":
      return t("update.readOnly");
    case "install-failed":
      return t("update.installFailed");
    case "verify-failed":
      return t("update.verifyFailed");
    case "error":
      return t("settings.updates.failed");
    default:
      return null;
  }
}

export interface UpdatesDialogProps {
  state: DesktopUpdatesState;
  onChange: (next: DesktopUpdatesState) => void;
  onClose: () => void;
}

export function UpdatesDialog({ state, onChange, onClose }: UpdatesDialogProps) {
  // Focus in on open, Tab kept inside, focus back to the opener on close (#vefk9dwg).
  const modalRef = useRef<HTMLDivElement | null>(null);
  useModal(modalRef);
  const t = useT();
  const id = useId();
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const pick = (mode: UpdateMode) => {
    if (mode === state.mode) return;
    const before = state;
    onChange({ ...state, mode });
    setError(null);
    api.setDesktopUpdatesMode(mode).then(onChange, () => {
      onChange(before);
      setError(t("settings.updates.saveFailed"));
    });
  };

  const checkNow = () => {
    setBusy(true);
    setError(null);
    onChange({ ...state, status: "checking" });
    api
      .checkDesktopUpdates()
      .then(onChange, () => onChange({ ...state, status: "error" }))
      .finally(() => setBusy(false));
  };

  const status = updateStatusText(t, state);
  const hint = state.status === "available" ? (state.kind === "deb" ? t("update.debHint") : state.kind === "mac" ? t("update.macHint") : null) : null;

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal mcp-dialog updates-dialog" role="dialog" ref={modalRef} aria-modal="true" aria-labelledby={`${id}-title`} data-testid="updates-settings">
        <div className="mcp-dialog-head">
          <h2 id={`${id}-title`}>{t("settings.updates.title")}</h2>
          <button type="button" className="icon-button" aria-label={t("common.close")} data-testid="updates-close" onClick={onClose} ref={closeRef}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <p className="mcp-note" data-testid="updates-version">
          {t("settings.updates.current", { version: state.currentVersion })}
        </p>
        {error ? (
          <p className="mcp-error" role="alert" data-testid="updates-error">
            {error}
          </p>
        ) : null}

        <fieldset className="mcp-section">
          <legend>{t("settings.updates.modeTitle")}</legend>
          {state.modes.map((mode) => (
            <label key={mode} className={`mcp-level${state.mode === mode ? " is-active" : ""}`}>
              <input type="radio" name={`${id}-mode`} value={mode} data-testid={`updates-mode-${mode}`} checked={state.mode === mode} onChange={() => pick(mode)} />
              <span>
                <span className="mcp-level-name">{t(MODE_LABEL[mode])}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <section className="mcp-section updates-status">
          <div className="updates-status-row">
            <button type="button" className="button-secondary" data-testid="updates-check" disabled={busy || state.status === "checking"} onClick={checkNow}>
              {t("settings.updates.checkNow")}
            </button>
            {state.lastChecked ? (
              <span className="updates-meta" data-testid="updates-last-checked">
                {t("settings.updates.lastChecked", { time: relativeTime(state.lastChecked) })}
              </span>
            ) : null}
          </div>
          {status ? (
            <p className={`mcp-note${state.status === "error" || state.status === "install-failed" || state.status === "verify-failed" ? " mcp-error" : ""}`} data-testid="updates-status" role="status">
              {status}
            </p>
          ) : null}
          {hint ? <p className="mcp-note" data-testid="updates-hint">{hint}</p> : null}
          {state.status === "ready" || (state.releaseUrl && ["available", "read-only", "install-failed", "verify-failed"].includes(state.status)) ? (
            <div className="updates-status-row updates-actions">
              {state.status === "ready" ? (
                <button type="button" className="button-primary" data-testid="updates-restart" onClick={() => void api.restartForUpdate()}>
                  {t("update.restart")}
                </button>
              ) : null}
              {state.releaseUrl ? (
                <a className="updates-link" href={state.releaseUrl} target="_blank" rel="noreferrer" data-testid="updates-release">
                  {state.status === "ready" ? t("update.whatsNew") : t("update.download")}
                </a>
              ) : null}
            </div>
          ) : null}
        </section>

        <p className="mcp-note" data-testid="updates-privacy">
          {t("settings.updates.privacy")}
        </p>
      </div>
    </div>
  );
}
