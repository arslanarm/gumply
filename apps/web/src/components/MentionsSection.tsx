/**
 * v0.8 C1 (#sipu2nxn): "Unlinked mentions" under "Linked from": pages that
 * mention this page's title or one of its aliases as plain text, each
 * mention with **Link**, and **Link all** per page. Collapsed by default, as
 * in Obsidian; the count shows without opening it.
 */
import type { PageId, PageMentions } from "@gumply/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiRequestError } from "../api/client.js";
import { useT } from "../i18n/index.js";
import { Icon } from "./Icon.js";

export interface MentionsSectionProps {
  pageId: PageId;
  /** Changes when the page was saved (its title or aliases may differ): reload. */
  refreshKey: unknown;
  onOpen: (id: PageId) => void;
  /** After a Link: the backlinks changed. */
  onLinked: () => void;
}

export function MentionsSection({ pageId, refreshKey, onOpen, onLinked }: MentionsSectionProps) {
  const t = useT();
  const [items, setItems] = useState<PageMentions[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const request = useRef(0);

  const load = useCallback(async () => {
    const token = (request.current += 1);
    try {
      const next = await api.mentions(pageId);
      if (request.current === token) setItems(next);
    } catch {
      if (request.current === token) setItems([]);
    }
  }, [pageId]);

  useEffect(() => {
    setNotice(null);
    void load();
  }, [load, refreshKey]);

  const link = async (entry: PageMentions, positions: number[] | "all") => {
    setBusy(true);
    setNotice(null);
    try {
      await api.linkMentions(pageId, {
        source: entry.page.id,
        expectedUpdated: entry.updated,
        ...(positions === "all" ? { all: true } : { positions }),
      });
      onLinked();
    } catch (error) {
      setNotice(error instanceof ApiRequestError && error.status === 409 ? t("backlinks.mentions.changed") : t("backlinks.mentions.failed"));
    } finally {
      await load();
      setBusy(false);
    }
  };

  const count = items.reduce((total, entry) => total + entry.mentions.length, 0);

  return (
    <div className="mentions" data-testid="mentions-section">
      <button
        type="button"
        className="mentions-toggle"
        data-testid="mentions-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name={open ? "chevronDown" : "chevronRight"} size={13} />
        {t("backlinks.mentions.title")}
        {count > 0 ? <span className="backlinks-count">{count}</span> : null}
      </button>
      {open ? (
        <div className="mentions-body">
          {notice ? (
            <p className="mentions-notice" role="status">
              {notice}
            </p>
          ) : null}
          {items.length === 0 ? (
            <p className="backlinks-empty">{t("backlinks.mentions.empty")}</p>
          ) : (
            <ul className="mentions-list">
              {items.map((entry) => (
                <li key={entry.page.id} className="mentions-page" data-testid={`mentions-${entry.page.id}`}>
                  <div className="mentions-page-head">
                    <button type="button" className="mentions-page-title" onClick={() => onOpen(entry.page.id)}>
                      {entry.page.icon ? `${entry.page.icon} ` : ""}
                      {entry.page.title}
                    </button>
                    {entry.mentions.length > 1 ? (
                      <button
                        type="button"
                        className="mentions-link mentions-link-all"
                        data-testid="mentions-link-all"
                        disabled={busy}
                        onClick={() => void link(entry, "all")}
                      >
                        {t("backlinks.mentions.linkAll")}
                      </button>
                    ) : null}
                  </div>
                  {entry.mentions.map((mention) => (
                    <div key={mention.index} className="mention">
                      <span className="mention-snippet">
                        {mention.snippet.text.slice(0, mention.snippet.start)}
                        <mark>{mention.snippet.text.slice(mention.snippet.start, mention.snippet.end)}</mark>
                        {mention.snippet.text.slice(mention.snippet.end)}
                      </span>
                      <button
                        type="button"
                        className="mentions-link"
                        data-testid="mentions-link"
                        aria-label={t("backlinks.mentions.linkLabel", { text: mention.text, page: entry.page.title })}
                        disabled={busy}
                        onClick={() => void link(entry, [mention.index])}
                      >
                        {t("backlinks.mentions.link")}
                      </button>
                    </div>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
