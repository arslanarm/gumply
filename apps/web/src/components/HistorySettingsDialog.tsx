import { useEffect, useId, useRef, useState } from "react";
import { api, type HistoryUsage } from "../api/client.js";
import { currentLanguage, useT } from "../i18n/index.js";
import { errorMessage } from "../lib/errors.js";
import { Icon } from "./Icon.js";

/**
 * Settings → Version history (spec/version-history §2.5, §5; D41): how much
 * space it takes, "Clear history older than…", and the Syncthing hint with a
 * Copy line button. Gumply never writes `.stignore` itself (D41).
 */

/**
 * The ignore lines a Syncthing user adds to the folder's `.stignore`: what each
 * device keeps for itself (D41, extended by D43: the AI-app log, Keep-mine
 * backups and import scratch too).
 */
export const STIGNORE_LINES = [".gumply/history", ".gumply/mcp-log.jsonl", ".gumply/conflicts", ".gumply/import"];

const CLEAR_DAYS = [7, 30, 90] as const;

export function useFormatSize() {
  const t = useT();
  return (bytes: number): string => {
    const number = (value: number) => new Intl.NumberFormat(currentLanguage(), { maximumFractionDigits: value < 10 ? 1 : 0 }).format(value);
    if (bytes < 1024) return t("history.size.bytes", { n: number(bytes) });
    if (bytes < 1024 ** 2) return t("history.size.kb", { n: number(bytes / 1024) });
    if (bytes < 1024 ** 3) return t("history.size.mb", { n: number(bytes / 1024 ** 2) });
    return t("history.size.gb", { n: number(bytes / 1024 ** 3) });
  };
}

export function HistorySettingsDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const id = useId();
  const formatSize = useFormatSize();
  const [usage, setUsage] = useState<HistoryUsage | null>(null);
  const [days, setDays] = useState<(typeof CLEAR_DAYS)[number]>(90);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
    api.historyUsage().then(setUsage, (error: unknown) => setStatus(errorMessage(error)));
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  const clear = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const next = await api.clearHistory(days);
      setUsage(next);
      setStatus(t("history.settings.cleared", { size: formatSize(next.bytes) }));
    } catch (error) {
      setStatus(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const copyLine = async () => {
    try {
      await navigator.clipboard.writeText(`${STIGNORE_LINES.join("\n")}\n`);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      setStatus(errorMessage(error));
    }
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div className="modal history-settings" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} data-testid="history-settings">
        <header className="history-header">
          <h2 id={`${id}-title`}>{t("history.title")}</h2>
          <button type="button" className="icon-button" aria-label={t("history.close")} data-testid="history-settings-close" ref={closeRef} onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </header>
        <p data-testid="history-usage">{usage ? t("history.settings.size", { size: formatSize(usage.bytes) }) : t("history.loading")}</p>
        <div className="history-clear">
          <label htmlFor={`${id}-days`}>{t("history.settings.clearOlder")}</label>
          <select id={`${id}-days`} value={days} data-testid="history-clear-days" onChange={(event) => setDays(Number(event.target.value) as (typeof CLEAR_DAYS)[number])}>
            {CLEAR_DAYS.map((count) => (
              <option key={count} value={count}>
                {t("history.settings.days", { count })}
              </option>
            ))}
          </select>
          <button type="button" className="button-secondary" data-testid="history-clear" disabled={busy || usage === null} onClick={() => void clear()}>
            {t("history.settings.clear")}
          </button>
        </div>
        {status ? (
          <p className="history-status" role="status" data-testid="history-settings-status">
            {status}
          </p>
        ) : null}
        <div className="history-sync-hint" data-testid="history-sync-hint">
          <p>{t("history.syncHint")}</p>
          <div className="history-sync-line">
            <pre className="history-sync-lines" data-testid="history-sync-line">{STIGNORE_LINES.join("\n")}</pre>
            <button type="button" className="button-secondary" data-testid="history-copy-line" onClick={() => void copyLine()}>
              {copied ? t("history.copied") : t("history.copyLine")}
            </button>
          </div>
          <p className="history-muted">{t("history.syncHintOther")}</p>
        </div>
      </div>
    </div>
  );
}
