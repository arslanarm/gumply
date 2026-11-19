import { useState } from "react";
import type { PageId, PageMeta } from "@gumply/core";
import { canMovePage, type PageTreeNode } from "../lib/tree.js";

export interface PageItemProps {
  node: PageTreeNode;
  depth: number;
  pages: readonly PageMeta[];
  selectedId: PageId | null;
  renamingId: PageId | null;
  renameDraft: string;
  draggingId: PageId | null;
  onOpen: (id: PageId) => void;
  onCreateChild: (id: PageId) => void;
  onDelete: (id: PageId) => void;
  onRenameDraft: (value: string) => void;
  onStartRename: (id: PageId, title: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onDragStartItem: (id: PageId) => void;
  onDragEndItem: () => void;
  onMove: (id: PageId, parentId: PageId | null) => void;
}

/** One row of the sidebar tree, rendered recursively for children. */
export function PageItem(props: PageItemProps) {
  const { node, depth, pages, selectedId, renamingId, draggingId } = props;
  const page = node.page;
  const hasChildren = node.children.length > 0;
  const isSelected = selectedId === page.id;
  const isRenaming = renamingId === page.id;
  const [expanded, setExpanded] = useState(true);
  const [dropTarget, setDropTarget] = useState(false);

  const canDrop = draggingId !== null && canMovePage(pages, draggingId, page.id);

  return (
    <div className="tree-node">
      <div
        className={`page-item${isSelected ? " is-selected" : ""}${dropTarget ? " is-drop-target" : ""}`}
        data-testid={`page-item-${page.id}`}
        data-page-id={page.id}
        role="treeitem"
        aria-selected={isSelected}
        aria-expanded={hasChildren ? expanded : undefined}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        onClick={() => props.onOpen(page.id)}
        onDoubleClick={(event) => {
          event.stopPropagation();
          props.onStartRename(page.id, page.title);
        }}
        draggable={!isRenaming}
        onDragStart={(event) => {
          event.stopPropagation();
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", page.id);
          props.onDragStartItem(page.id);
        }}
        onDragEnd={() => props.onDragEndItem()}
        onDragOver={(event) => {
          if (draggingId === null) return;
          event.stopPropagation();
          if (!canDrop) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setDropTarget(true);
        }}
        onDragLeave={() => setDropTarget(false)}
        onDrop={(event) => {
          if (draggingId === null) return;
          event.stopPropagation();
          if (!canDrop) return;
          event.preventDefault();
          setDropTarget(false);
          props.onMove(draggingId, page.id);
        }}
      >
        {hasChildren ? (
          <button
            type="button"
            className="tree-toggle"
            data-testid={`tree-toggle-${page.id}`}
            aria-label={expanded ? "Collapse" : "Expand"}
            onClick={(event) => {
              event.stopPropagation();
              setExpanded((value) => !value);
            }}
          >
            {expanded ? "▾" : "▸"}
          </button>
        ) : (
          <span className="tree-toggle-spacer" />
        )}

        {isRenaming ? (
          <input
            className="page-rename-input"
            data-testid={`page-rename-input-${page.id}`}
            value={props.renameDraft}
            autoFocus
            onChange={(event) => props.onRenameDraft(event.target.value)}
            onClick={(event) => event.stopPropagation()}
            onBlur={props.onCommitRename}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                props.onCommitRename();
              } else if (event.key === "Escape") {
                event.preventDefault();
                props.onCancelRename();
              }
            }}
          />
        ) : (
          <span className="page-item-label">
            {page.icon ? <span className="page-icon">{page.icon}</span> : null}
            <span className="page-item-title">{page.title}</span>
          </span>
        )}

        <span className="page-actions">
          <button
            type="button"
            className="tree-action"
            title="New child page"
            data-testid={`new-child-button-${page.id}`}
            onClick={(event) => {
              event.stopPropagation();
              props.onCreateChild(page.id);
            }}
          >
            +
          </button>
          <button
            type="button"
            className="tree-action"
            title="Delete page"
            data-testid={`delete-page-button-${page.id}`}
            onClick={(event) => {
              event.stopPropagation();
              props.onDelete(page.id);
            }}
          >
            ×
          </button>
        </span>
      </div>

      {hasChildren && expanded ? (
        <div className="tree-children" role="group">
          {node.children.map((child) => (
            <PageItem key={child.page.id} {...props} node={child} depth={depth + 1} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
