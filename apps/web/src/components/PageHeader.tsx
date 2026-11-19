import { useEffect, useState } from "react";
import type { Page } from "@gumply/core";

export interface PageHeaderProps {
  page: Page;
  onRename: (title: string) => Promise<void>;
  onDelete: () => void;
}

function formatUpdated(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "just now";
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** Title, rename affordance and metadata for the open page. */
export function PageHeader({ page, onRename, onDelete }: PageHeaderProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(page.title);

  useEffect(() => {
    setEditing(false);
    setDraft(page.title);
  }, [page.id, page.title]);

  const commit = () => {
    const title = draft.trim();
    setEditing(false);
    if (title.length > 0 && title !== page.title) void onRename(title);
    else setDraft(page.title);
  };

  const cancel = () => {
    setEditing(false);
    setDraft(page.title);
  };

  return (
    <header className="page-header">
      <div className="page-heading">
        {page.icon ? <span className="page-icon-large">{page.icon}</span> : null}

        {editing ? (
          <input
            className="page-title-input"
            data-testid="page-title-input"
            value={draft}
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commit();
              } else if (event.key === "Escape") {
                event.preventDefault();
                cancel();
              }
            }}
          />
        ) : (
          <h1
            className="page-title"
            data-testid="page-title"
            title="Double-click to rename"
            onDoubleClick={() => setEditing(true)}
          >
            {page.title}
          </h1>
        )}

        <div className="page-header-actions">
          <button
            type="button"
            className="icon-button"
            data-testid="rename-page-button"
            title="Rename page"
            aria-label="Rename page"
            onClick={() => setEditing(true)}
          >
            ✎
          </button>
          <button
            type="button"
            className="icon-button icon-button-danger"
            data-testid="delete-page-button-page"
            title="Delete page"
            aria-label="Delete page"
            onClick={onDelete}
          >
            🗑
          </button>
        </div>
      </div>

      <p className="page-meta">
        Updated {formatUpdated(page.updated)}
        {page.tags.length > 0 ? ` · ${page.tags.map((tag) => `#${tag}`).join(" ")}` : ""}
      </p>
    </header>
  );
}
