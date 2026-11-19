import { useMemo, useState } from "react";
import type { PageId, PageMeta } from "@gumply/core";
import { buildPageTree } from "../lib/tree.js";
import { PageItem } from "./PageItem.js";

export interface SidebarProps {
  pages: readonly PageMeta[];
  selectedId: PageId | null;
  status: "loading" | "ready" | "error";
  error: string | null;
  onOpen: (id: PageId) => void;
  onCreate: (parentId: PageId | null) => void;
  onRename: (id: PageId, title: string) => Promise<void>;
  onDelete: (id: PageId) => void;
  onMove: (id: PageId, parentId: PageId | null) => void;
  onRetry: () => void;
}

export function Sidebar(props: SidebarProps) {
  const { pages, selectedId, status, error } = props;
  const tree = useMemo(() => buildPageTree(pages), [pages]);

  const [renamingId, setRenamingId] = useState<PageId | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [draggingId, setDraggingId] = useState<PageId | null>(null);

  const startRename = (id: PageId, title: string) => {
    setRenamingId(id);
    setRenameDraft(title);
  };

  const commitRename = () => {
    const id = renamingId;
    if (!id) return;
    const title = renameDraft.trim();
    setRenamingId(null);
    setRenameDraft("");
    const current = pages.find((page) => page.id === id);
    if (title.length > 0 && title !== current?.title) void props.onRename(id, title);
  };

  const cancelRename = () => {
    setRenamingId(null);
    setRenameDraft("");
  };

  return (
    <aside className="sidebar" data-testid="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">Pages</span>
        <button
          type="button"
          className="icon-button"
          data-testid="new-page-button"
          title="New page"
          aria-label="New page"
          onClick={() => props.onCreate(null)}
        >
          +
        </button>
      </div>

      <div
        className="page-tree"
        data-testid="page-tree"
        role="tree"
        aria-label="Pages"
        onDragOver={(event) => {
          if (!draggingId) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }}
        onDrop={(event) => {
          if (!draggingId) return;
          event.preventDefault();
          const id = draggingId;
          setDraggingId(null);
          props.onMove(id, null);
        }}
      >
        {status === "loading" ? (
          <p className="tree-note">Loading pages…</p>
        ) : status === "error" ? (
          <div className="tree-error">
            <p>{error ?? "Could not load pages."}</p>
            <button type="button" className="button-secondary" onClick={props.onRetry}>
              Retry
            </button>
          </div>
        ) : tree.length === 0 ? (
          <p className="tree-note">No pages yet — create your first one.</p>
        ) : (
          tree.map((node) => (
            <PageItem
              key={node.page.id}
              node={node}
              depth={0}
              pages={pages}
              selectedId={selectedId}
              renamingId={renamingId}
              renameDraft={renameDraft}
              draggingId={draggingId}
              onOpen={props.onOpen}
              onCreateChild={(id) => props.onCreate(id)}
              onDelete={props.onDelete}
              onRenameDraft={setRenameDraft}
              onStartRename={startRename}
              onCommitRename={commitRename}
              onCancelRename={cancelRename}
              onDragStartItem={setDraggingId}
              onDragEndItem={() => setDraggingId(null)}
              onMove={props.onMove}
            />
          ))
        )}
      </div>
    </aside>
  );
}
