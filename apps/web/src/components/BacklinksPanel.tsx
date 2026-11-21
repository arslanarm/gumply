import type { Backlink, PageId } from "@gumply/core";
import { useState } from "react";
import { splitSnippet, visibleBacklinks } from "../lib/backlinks.js";
import { isBoard } from "../lib/boards.js";
import { Icon } from "./Icon.js";
import { useT } from "../i18n/index.js";

export interface BacklinksPanelProps {
  items: readonly Backlink[];
  loading: boolean;
  onOpen: (id: PageId) => void;
}

/** “Linked from” panel shown under the editor. */
export function BacklinksPanel({ items, loading, onOpen }: BacklinksPanelProps) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const visible = visibleBacklinks(items, expanded);

  return (
    <section className="backlinks" data-testid="backlinks-panel" aria-labelledby="backlinks-title">
      <h2 className="backlinks-title" id="backlinks-title">
        {t("backlinks.title")}
        {items.length > 0 ? <span className="backlinks-count">{items.length}</span> : null}
      </h2>

      {loading && items.length === 0 ? (
        <p className="backlinks-empty">{t("backlinks.loading")}</p>
      ) : items.length === 0 ? (
        <p className="backlinks-empty">
          {t("backlinks.emptyBefore")}<code>[[</code>{t("backlinks.emptyAfter")}
        </p>
      ) : (
        <>
          <ul className="backlinks-list">
            {visible.map(({ page, snippet }) => (
              <li key={page.id}>
                <button
                  type="button"
                  className="backlink"
                  data-testid={`backlink-${page.id}`}
                  onClick={() => onOpen(page.id)}
                >
                  <span className="backlink-title">
                    {page.icon ? (
                      `${page.icon} `
                    ) : isBoard(page) ? (
                      <span className="backlink-board-icon" data-testid={`backlink-board-icon-${page.id}`} aria-label={t("board.cards.whiteboard")}>
                        <Icon name="board" size={14} />
                      </span>
                    ) : null}
                    {page.title}
                  </span>
                  <span className="backlink-snippet">
                    {splitSnippet(snippet).map((part, index) =>
                      part.highlight ? (
                        <mark key={index}>{part.text}</mark>
                      ) : (
                        <span key={index}>{part.text}</span>
                      ),
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {items.length > 5 ? (
            <button
              type="button"
              className="backlinks-toggle"
              data-testid="backlinks-toggle"
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? t("backlinks.showFewer") : t("backlinks.showAll", { count: items.length })}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}
