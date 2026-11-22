import { useEffect, useState } from "react";
import type { PageId } from "@gumply/core";
import { api, type HistoryOrphan } from "../api/client.js";
import { useT } from "../i18n/index.js";
import { errorMessage } from "../lib/errors.js";
import { versionTime } from "./HistoryDialog.js";
import { Icon } from "./Icon.js";

/**
 * The Trash view's "Earlier versions of deleted pages" (spec/version-history
 * §2.3): histories whose page is gone (deleted or renamed outside Gumply).
 * Each comes back as a new page, never over another one. Pages in Gumply's
 * own Trash aren't listed: Restore brings their history back (D41).
 */
export function HistoryOrphans({ onRestored }: { onRestored: (id: PageId) => void }) {
  const t = useT();
  const [orphans, setOrphans] = useState<HistoryOrphan[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    api.historyOrphans().then(setOrphans, () => setOrphans([]));
  }, []);

  if (!orphans || orphans.length === 0) return null;

  const restore = async (orphan: HistoryOrphan) => {
    setBusy(orphan.key);
    setStatus(null);
    try {
      const result = await api.restoreOrphan(orphan.key);
      const id = "meta" in result ? result.meta.id : result.id;
      const title = "meta" in result ? result.meta.title : result.title;
      setOrphans((current) => (current ?? []).filter((item) => item.key !== orphan.key));
      setStatus(t("history.orphanRestored", { title }));
      onRestored(id);
    } catch (error) {
      setStatus(t("history.restoreFailed", { error: errorMessage(error) }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="trash-orphans" aria-labelledby="trash-orphans-title" data-testid="history-orphans">
      <h2 id="trash-orphans-title">{t("history.orphans")}</h2>
      {status ? (
        <p className="trash-note" role="status" data-testid="history-orphans-status">
          {status}
        </p>
      ) : null}
      <ul className="trash-list">
        {orphans.map((orphan) => (
          <li key={orphan.key} className="trash-entry" data-testid={`history-orphan-${orphan.title}`}>
            <div className="trash-row">
              <span className="trash-row-main">
                <span className="trash-item-icon" aria-hidden="true">
                  <Icon name={orphan.lastId.endsWith(".canvas") ? "board" : "clock"} size={16} />
                </span>
                <span className="trash-item-text">
                  <span className="trash-item-title">{orphan.title}</span>
                  <span className="trash-item-meta">{t("history.orphanMeta", { count: orphan.versions, time: versionTime(orphan.lastAt) })}</span>
                </span>
              </span>
              <span className="trash-row-actions">
                <button
                  type="button"
                  className="button-secondary"
                  data-testid="history-orphan-restore"
                  disabled={busy !== null}
                  onClick={() => void restore(orphan)}
                >
                  {t("history.orphanRestore")}
                </button>
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
