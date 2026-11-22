/**
 * Settings → MCP (v0.8 A3, spec/mcp §5): whether AI apps may use this vault
 * and how much (`.gumply/mcp.json`), the setup snippets for Claude Code and
 * Claude Desktop, and the recent MCP writes from the audit log.
 */
import type { McpAccess, McpAuditEntry, McpSettingsPatch, McpSettingsResponse } from "@gumply/core";
import { useEffect, useId, useRef, useState } from "react";
import { api } from "../api/client.js";
import { relativeTime, useT, type MessageKey } from "../i18n/index.js";
import { errorMessage } from "../lib/errors.js";
import { claudeCodeSnippet, claudeDesktopConfigPath, claudeDesktopSnippet } from "../lib/mcp-snippets.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { Icon } from "./Icon.js";

const RANK: Record<McpAccess, number> = { read: 0, append: 1, edit: 2 };

/** Raising the level asks first (@lead, A3 review); lowering is instant. */
const RAISE: Record<Exclude<McpAccess, "read">, { heading: MessageKey; body: MessageKey }> = {
  // Standalone sentences: the radio hints start "Also…", which read as a fragment here (#jn9vhndu).
  append: { heading: "settings.mcp.raiseAppend", body: "settings.mcp.raiseAppendBody" },
  edit: { heading: "settings.mcp.raiseEdit", body: "settings.mcp.raiseEditBody" },
};

const LEVELS: Array<[McpAccess, MessageKey, MessageKey]> = [
  ["read", "settings.mcp.accessRead", "settings.mcp.accessReadHint"],
  ["append", "settings.mcp.accessAppend", "settings.mcp.accessAppendHint"],
  ["edit", "settings.mcp.accessEdit", "settings.mcp.accessEditHint"],
];

export interface McpSettingsDialogProps {
  onClose: () => void;
  /** A page named in the activity list. */
  onOpenPage: (id: string) => void;
  /** D41: Undo on a row restored that page (the open page reloads). */
  onRestored?: (id: string) => void;
}

/** A setup snippet: its heading with Copy, a hint, then the text. */
function Snippet({ id, title, hint, text }: { id: string; title: string; hint: string; text: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <div className="mcp-snippet">
      <div className="mcp-snippet-head">
        <h4>{title}</h4>
        <button
        type="button"
        className="button-secondary mcp-copy"
        data-testid={`mcp-copy-${id}`}
        onClick={() => {
          void navigator.clipboard.writeText(text).then(
            () => setCopied(true),
            () => undefined,
          );
        }}
      >
          <Icon name="copy" size={14} />
          {copied ? t("settings.mcp.copied") : t("settings.mcp.copy")}
        </button>
      </div>
      <p className="mcp-note">{hint}</p>
      <pre data-testid={`mcp-snippet-${id}`}>{text}</pre>
    </div>
  );
}

export function McpSettingsDialog({ onClose, onOpenPage, onRestored }: McpSettingsDialogProps) {
  const t = useT();
  const id = useId();
  const [settings, setSettings] = useState<McpSettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** A higher level waiting for "Allow". */
  const [raising, setRaising] = useState<Exclude<McpAccess, "read"> | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  /** D41: the row whose Undo is running, and what the last Undo did. */
  const [undoing, setUndoing] = useState<McpAuditEntry | null>(null);
  const [undoStatus, setUndoStatus] = useState<string | null>(null);

  /**
   * Undo an AI app's write (spec/version-history §6.1): restore the version it
   * saved before writing, the history entry whose version is the row's `before`.
   * It's an ordinary restore, so it can itself be undone in History.
   */
  const undo = async (row: McpAuditEntry) => {
    setUndoing(row);
    setUndoStatus(null);
    try {
      const list = await api.history(row.id);
      const entry = list.items.find((item) => item.source === "mcp" && item.version === row.before);
      if (!entry) {
        setUndoStatus(t("history.undoNothing"));
        return;
      }
      const result = await api.restoreVersion(row.id, entry.file, list.current.version);
      const restoredId = "meta" in result ? result.meta.id : result.id;
      const title = "meta" in result ? result.meta.title : result.title;
      onRestored?.(restoredId);
      setUndoStatus(t("history.undone", { title }));
    } catch (caught) {
      setUndoStatus(t("history.restoreFailed", { error: errorMessage(caught) }));
    } finally {
      setUndoing(null);
    }
  };

  useEffect(() => {
    closeRef.current?.focus();
    api.mcpSettings().then(setSettings, (caught: unknown) => setError(t("settings.mcp.loadFailed", { error: errorMessage(caught) })));
  }, [t]);

  useEffect(() => {
    // While the confirmation is open, Escape is its Cancel, not this dialog's close.
    if (raising) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, raising]);

  const pickLevel = (level: McpAccess) => {
    if (!settings || level === settings.access) return;
    if (level !== "read" && RANK[level] > RANK[settings.access]) setRaising(level);
    else save({ access: level });
  };

  const save = (patch: McpSettingsPatch) => {
    if (!settings) return;
    // Shown at once; the server's answer (or the old state) follows.
    const before = settings;
    setSettings({ ...settings, ...patch });
    setSaving(true);
    setError(null);
    api
      .setMcpSettings(patch)
      .then(setSettings, (caught: unknown) => {
        setSettings(before);
        setError(t("settings.mcp.saveFailed", { error: errorMessage(caught) }));
      })
      .finally(() => setSaving(false));
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal mcp-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} data-testid="mcp-settings">
        <div className="mcp-dialog-head">
          <h2 id={`${id}-title`}>{t("settings.mcp.title")}</h2>
          <button type="button" className="icon-button" aria-label={t("common.close")} data-testid="mcp-close" onClick={onClose} ref={closeRef}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <p>{t("settings.mcp.intro")}</p>
        {error ? (
          <p className="mcp-error" role="alert" data-testid="mcp-error">
            {error}
          </p>
        ) : null}
        {!settings ? (
          error ? null : <p data-testid="mcp-loading">{t("settings.mcp.loading")}</p>
        ) : (
          <>
            <label className="mcp-switch">
              <input
                type="checkbox"
                role="switch"
                data-testid="mcp-enabled"
                checked={settings.enabled}
                disabled={saving}
                onChange={(event) => save({ enabled: event.target.checked })}
              />
              <span>{t("settings.mcp.enabled")}</span>
            </label>

            <fieldset className="mcp-section" disabled={!settings.enabled}>
              <legend>{t("settings.mcp.access")}</legend>
              {LEVELS.map(([level, label, hint]) => (
                <label key={level} className={`mcp-level${settings.access === level ? " is-active" : ""}`}>
                  <input
                    type="radio"
                    name={`${id}-access`}
                    value={level}
                    data-testid={`mcp-access-${level}`}
                    checked={settings.access === level}
                    onChange={() => pickLevel(level)}
                  />
                  <span>
                    <span className="mcp-level-name">{t(label)}</span>
                    <span className="mcp-level-hint">{t(hint)}</span>
                  </span>
                </label>
              ))}
              <p className="mcp-note">{t("settings.mcp.restartNote")}</p>
            </fieldset>
            {settings.enabled ? null : <p className="mcp-note">{t("settings.mcp.offNote")}</p>}

            <section className="mcp-section">
              <h3>{t("settings.mcp.setup")}</h3>
              <Snippet
                id="claude-code"
                title={t("settings.mcp.claudeCode")}
                hint={t("settings.mcp.claudeCodeHint")}
                text={claudeCodeSnippet(settings.command, settings.vaultPath, settings.platform)}
              />
              <Snippet
                id="claude-desktop"
                title={t("settings.mcp.claudeDesktop")}
                hint={t("settings.mcp.claudeDesktopHint", { path: claudeDesktopConfigPath(settings.platform) })}
                text={claudeDesktopSnippet(settings.command, settings.vaultPath)}
              />
              {settings.command.hint === "npm" ? <p className="mcp-note" data-testid="mcp-hint">{t("settings.mcp.npmHint")}</p> : null}
              {settings.command.hint === "appimage" ? <p className="mcp-note" data-testid="mcp-hint">{t("settings.mcp.appImageHint")}</p> : null}
              {settings.command.warning === "fuse" ? <p className="mcp-note mcp-error" data-testid="mcp-fuse-warning">{t("settings.mcp.fuseWarning")}</p> : null}
              {settings.command.hint === "macos-location" ? <p className="mcp-note" data-testid="mcp-hint">{t("settings.mcp.macLocationHint")}</p> : null}
            </section>

            <section className="mcp-section">
              <h3>{t("settings.mcp.recent")}</h3>
              {undoStatus ? (
                <p className="mcp-note" role="status" data-testid="mcp-undo-status">
                  {undoStatus}
                </p>
              ) : null}
              {settings.recent.length === 0 ? (
                <p className="mcp-note" data-testid="mcp-recent-empty">
                  {t("settings.mcp.recentEmpty")}
                </p>
              ) : (
                <ul className="mcp-recent" data-testid="mcp-recent">
                  {settings.recent.map((row, index) => (
                    <li key={`${row.at}-${index}`}>
                      <button
                        type="button"
                        className="mcp-recent-page"
                        disabled={row.after === null}
                        onClick={() => {
                          onOpenPage(row.id);
                          onClose();
                        }}
                      >
                        {row.id}
                      </button>
                      <span className="mcp-recent-meta">{t("settings.mcp.recentRow", { tool: row.tool, client: row.client || "—" })}</span>
                      <time dateTime={row.at} title={row.at}>
                        {relativeTime(row.at)}
                      </time>
                      {row.before !== null && row.after !== null ? (
                        <button
                          type="button"
                          className="link-button mcp-recent-undo"
                          title={t("history.undoTitle")}
                          data-testid="mcp-recent-undo"
                          disabled={undoing !== null}
                          onClick={() => void undo(row)}
                        >
                          {t("history.undo")}
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
      {raising ? (
        <ConfirmDialog
          testId="mcp-raise"
          heading={t(RAISE[raising].heading)}
          body={t(RAISE[raising].body)}
          confirmLabel={t("settings.mcp.allow")}
          onCancel={() => setRaising(null)}
          onConfirm={() => {
            const level = raising;
            setRaising(null);
            save({ access: level });
          }}
        />
      ) : null}
    </div>
  );
}
