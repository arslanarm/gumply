import { useEffect, useState } from "react";
import type { PageId, PageMeta, TrashedDocument, TrashItem } from "@gumply/core";
import { api } from "../api/client.js";
import { errorMessage } from "../lib/errors.js";
import { relativeTime } from "../lib/search.js";
import { Editor } from "./Editor.js";
import { Icon } from "./Icon.js";

export interface TrashedPageViewProps {
  trashId: string;
  /** A sub-page of the entry; null = its top page. */
  id: PageId | null;
  pages: readonly PageMeta[];
  desktop: boolean;
  onRestore: (item: TrashItem, openId: PageId) => void;
  onDeleteForever: (item: TrashItem) => void;
  onOpenTrash: () => void;
  /** Open a page of a trashed folder (or a sub-page), read-only. */
  onOpenChild: (item: TrashItem, id: PageId) => void;
  onOpenLink: (link: { targetTitle: string; heading: string }) => void;
}

const noop = () => undefined;

function RevealLink({ item, testId, desktop }: { item: TrashItem; testId: string; desktop: boolean }) {
  if (!desktop) return null;
  return (
    <a
      className="link-button"
      href={`/api/trash/${encodeURIComponent(item.trashId)}/reveal`}
      target="_blank"
      rel="noreferrer"
      data-testid={testId}
    >
      Show in file manager
    </a>
  );
}

/** A plain folder in the trash (D33): what was in it, read-only. */
function TrashedFolder(props: TrashedPageViewProps & { item: TrashItem }) {
  const { item } = props;
  const others = item.otherFiles ?? 0;
  return (
    <div className="trashed-page" data-testid="trashed-page">
      <div className="banner banner-trash" role="status" data-testid="trashed-banner">
        <Icon name="trash" size={15} />
        <span>This folder is in the trash.</span>
        <button type="button" className="link-button" data-testid="trashed-restore" onClick={() => props.onRestore(item, item.id)}>
          Restore
        </button>
        <button
          type="button"
          className="link-button trashed-delete-forever"
          data-testid="trashed-delete-forever"
          onClick={() => props.onDeleteForever(item)}
        >
          Delete forever
        </button>
        <RevealLink item={item} testId="trashed-reveal" desktop={props.desktop} />
      </div>
      <div className="editor-pane trashed-page-body">
        <header className="page-header">
          <div className="page-heading">
            <span className="trashed-page-icon trashed-folder-icon" aria-hidden="true">
              <Icon name="folder" size={34} />
            </span>
            <h1 className="page-title trashed-title" data-testid="trashed-title">
              {item.title}
            </h1>
          </div>
          <p className="page-meta">Deleted {relativeTime(item.deletedAt)}</p>
        </header>
        {item.children.length > 0 ? (
          <ul className="trash-children trashed-folder-list">
            {item.children.map((child) => (
              <li key={child.id}>
                <button type="button" className="trash-child" onClick={() => props.onOpenChild(item, child.id)}>
                  <span className="trash-item-icon" aria-hidden="true">
                    {child.icon ? (
                      <span className="trash-item-emoji">{child.icon}</span>
                    ) : (
                      <Icon name={child.kind === "whiteboard" ? "board" : "file"} size={16} />
                    )}
                  </span>
                  <span className="trash-item-title">{child.title}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="trash-note">No pages or whiteboards in it.</p>
        )}
        {others > 0 ? (
          <p className="trash-note" data-testid="trashed-folder-files">
            And {others === 1 ? "1 other file" : `${others} other files`} (images, PDFs…), restored with it.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** A page or board in the trash, read-only, with a Restore banner (#ppag3ugh). */
export function TrashedPageView(props: TrashedPageViewProps) {
  const { trashId, id } = props;
  const [doc, setDoc] = useState<TrashedDocument | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setFailed(null);
    api.getTrashed(trashId, id ?? undefined).then(
      (result) => {
        if (!cancelled) setDoc(result);
      },
      (error: unknown) => {
        if (!cancelled) setFailed(errorMessage(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [trashId, id]);

  if (failed) {
    return (
      <div className="empty-state" data-testid="trashed-missing">
        <span className="empty-state-icon" aria-hidden="true">
          <Icon name="trash" size={26} />
        </span>
        <h2>This page is no longer in the trash</h2>
        <p>It was restored or deleted for good.</p>
        <button type="button" className="button-secondary" onClick={props.onOpenTrash}>
          Open the trash
        </button>
      </div>
    );
  }
  if (!doc) return <p className="trash-note">Loading…</p>;

  const { item, page, board } = doc;
  if (!page) return <TrashedFolder {...props} item={item} />;
  const isTop = page.id === item.id;
  const kindName = page.kind === "whiteboard" ? "whiteboard" : "page";

  return (
    <div className="trashed-page" data-testid="trashed-page">
      <div className="banner banner-trash" role="status" data-testid="trashed-banner">
        <Icon name="trash" size={15} />
        <span>
          {isTop ? (
            <>This {kindName} is in the trash.</>
          ) : (
            <>
              This {kindName} is in the trash with “{item.title}”.
            </>
          )}
        </span>
        <button
          type="button"
          className="link-button"
          data-testid="trashed-restore"
          onClick={() => props.onRestore(item, page.id)}
        >
          Restore{isTop ? "" : ` “${item.title}”`}
        </button>
        <button
          type="button"
          className="link-button trashed-delete-forever"
          data-testid="trashed-delete-forever"
          onClick={() => props.onDeleteForever(item)}
        >
          Delete forever
        </button>
        <RevealLink item={item} testId="trashed-reveal" desktop={props.desktop} />
      </div>

      <div className="editor-pane trashed-page-body">
        <header className="page-header">
          <div className="page-heading">
            {page.icon ? <span className="trashed-page-icon">{page.icon}</span> : null}
            <h1 className="page-title trashed-title" data-testid="trashed-title">
              {page.title}
            </h1>
          </div>
          <p className="page-meta">Deleted {relativeTime(item.deletedAt)}</p>
        </header>
        {page.kind === "whiteboard" ? (
          <div className="empty-state trashed-board-note">
            <span className="empty-state-icon" aria-hidden="true">
              <Icon name="board" size={26} />
            </span>
            <h2>Restore this whiteboard to open it</h2>
            <p>
              It has {board?.nodes.length ?? 0} {board?.nodes.length === 1 ? "object" : "objects"}.
            </p>
          </div>
        ) : (
          <Editor
            key={`${item.trashId}:${page.id}`}
            page={page}
            pages={props.pages}
            readOnly
            onSaveState={noop}
            onOpenLink={props.onOpenLink}
            onCreateLink={noop}
          />
        )}
      </div>
    </div>
  );
}
