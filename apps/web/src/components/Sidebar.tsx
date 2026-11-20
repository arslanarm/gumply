import { useEffect, useMemo, useState } from "react";
import type { PageId, PageMeta } from "@gumply/core";
import { buildPageTree } from "../lib/tree.js";
import { Icon } from "./Icon.js";
import { PageItem } from "./PageItem.js";

export interface SidebarFocusTarget {
  id: PageId | null;
  nonce: number;
}

export interface SidebarProps {
  pages: readonly PageMeta[];
  selectedId: PageId | null;
  status: "loading" | "ready" | "error";
  error: string | null;
  focusTarget: SidebarFocusTarget | null;
  onOpen: (id: PageId) => void;
  onCreate: (parentId: PageId | null) => void;
  onRename: (id: PageId, title: string) => Promise<void>;
  onDelete: (id: PageId) => void;
  onMove: (id: PageId, parentId: PageId | null) => void;
  onStartMove: (id: PageId) => void;
  onRetry: () => void;
  onSearch: () => void;
  onGraph: () => void;
  /** The global graph view is open (sidebar active state). */
  graphActive?: boolean;
}

export function Sidebar(props: SidebarProps) {
  const { pages, selectedId, status, error, focusTarget } = props;
  const tree = useMemo(() => buildPageTree(pages), [pages]);

  const [renamingId, setRenamingId] = useState<PageId | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [draggingId, setDraggingId] = useState<PageId | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<PageId>>(() => new Set());

  // D11: focus the next sibling after a delete, else the New page button.
  useEffect(() => {
    if (!focusTarget) return;
    if (focusTarget.id) {
      for (const item of document.querySelectorAll<HTMLElement>("[data-page-id]")) {
        if (item.dataset.pageId === focusTarget.id) {
          item.focus();
          return;
        }
      }
    }
    document.querySelector<HTMLElement>('[data-testid="new-page-button"]')?.focus();
  }, [focusTarget]);

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

  const toggle = (id: PageId) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const createChild = (parentId: PageId) => {
    setCollapsed((previous) => {
      if (!previous.has(parentId)) return previous;
      const next = new Set(previous);
      next.delete(parentId);
      return next;
    });
    props.onCreate(parentId);
  };

  return (
    <aside className="sidebar" data-testid="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">Pages</span>
      </div>

      <button
        type="button"
        className="sidebar-row sidebar-new-page"
        data-testid="new-page-button"
        data-tooltip="New page"
        aria-label="New page"
        onClick={() => props.onCreate(null)}
      >
        <span className="sidebar-row-icon" aria-hidden="true">
          <Icon name="plus" size={16} />
        </span>
        New page
      </button>

      <button
        type="button"
        className="sidebar-row"
        data-testid="sidebar-search"
        onClick={props.onSearch}
      >
        <span className="sidebar-row-icon" aria-hidden="true">
          <Icon name="search" size={16} />
        </span>
        Search
      </button>

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
          <div className="sidebar-empty" data-testid="sidebar-empty">
            <p>
              <strong>No pages yet.</strong> Create a page to get started.
            </p>
          </div>
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
              collapsed={collapsed}
              onOpen={props.onOpen}
              onCreateChild={createChild}
              onDelete={props.onDelete}
              onToggle={toggle}
              onStartMove={props.onStartMove}
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

      <button
        type="button"
        className={`sidebar-row sidebar-row-bottom${props.graphActive ? " sidebar-row-active" : ""}`}
        data-testid="sidebar-graph"
        aria-current={props.graphActive ? "page" : undefined}
        onClick={props.onGraph}
      >
        <span className="sidebar-row-icon" aria-hidden="true">
          <Icon name="graph" size={16} />
        </span>
        Graph
      </button>
    </aside>
  );
}
