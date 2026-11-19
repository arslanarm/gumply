import { useEffect, useRef, useState } from "react";
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
  collapsed: ReadonlySet<PageId>;
  onOpen: (id: PageId) => void;
  onCreateChild: (id: PageId) => void;
  onDelete: (id: PageId) => void;
  onToggle: (id: PageId) => void;
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
  const { node, depth, pages, selectedId, renamingId, draggingId, collapsed } = props;
  const page = node.page;
  const hasChildren = node.children.length > 0;
  const isSelected = selectedId === page.id;
  const isRenaming = renamingId === page.id;
  const expanded = hasChildren && !collapsed.has(page.id);
  const [dropTarget, setDropTarget] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLSpanElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  const canDrop = draggingId !== null && canMovePage(pages, draggingId, page.id);

  // Rename opens with the whole title selected, so typing replaces it instead
  // of appending to the end (walkthrough #7up8t6gm).
  useEffect(() => {
    if (!isRenaming) return;
    const input = renameInputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [isRenaming]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  return (
    <div className="tree-node">
      <div
        className={`page-item${isSelected ? " is-selected" : ""}${dropTarget ? " is-drop-target" : ""}`}
        data-testid={`page-item-${page.id}`}
        data-page-id={page.id}
        role="treeitem"
        tabIndex={0}
        aria-selected={isSelected}
        aria-expanded={hasChildren ? expanded : undefined}
        style={{ paddingLeft: `${6 + depth * 14}px` }}
        onClick={() => props.onOpen(page.id)}
        onDoubleClick={(event) => {
          event.stopPropagation();
          props.onStartRename(page.id, page.title);
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "Enter") {
            event.preventDefault();
            props.onOpen(page.id);
          }
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
            aria-label={expanded ? "Collapse sub-pages" : "Expand sub-pages"}
            onClick={(event) => {
              event.stopPropagation();
              props.onToggle(page.id);
            }}
          >
            {expanded ? "▾" : "▸"}
          </button>
        ) : (
          <span className="tree-toggle-spacer" />
        )}

        {isRenaming ? (
          <input
            ref={renameInputRef}
            className="page-rename-input"
            data-testid={`page-rename-input-${page.id}`}
            value={props.renameDraft}
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
            <span className="page-item-title" title={page.title}>
              {page.title}
            </span>
          </span>
        )}

        <span className="page-actions">
          <button
            type="button"
            className="tree-action"
            data-tooltip="New sub-page"
            data-testid={`new-child-button-${page.id}`}
            aria-label="New sub-page"
            onClick={(event) => {
              event.stopPropagation();
              props.onCreateChild(page.id);
            }}
          >
            +
          </button>

          <span className="page-menu" ref={menuRef}>
            <button
              type="button"
              className="tree-action"
              data-tooltip="More actions"
              data-testid={`page-menu-button-${page.id}`}
              aria-label="More actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={(event) => {
                event.stopPropagation();
                setMenuOpen((open) => !open);
              }}
            >
              ⋯
            </button>

            {menuOpen ? (
              <div className="page-menu-list" role="menu" data-testid={`page-menu-${page.id}`}>
                <button
                  type="button"
                  role="menuitem"
                  data-testid={`rename-page-${page.id}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    setMenuOpen(false);
                    props.onStartRename(page.id, page.title);
                  }}
                >
                  Rename
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="menu-danger"
                  data-testid={`delete-page-${page.id}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    setMenuOpen(false);
                    props.onDelete(page.id);
                  }}
                >
                  Delete page
                </button>
              </div>
            ) : null}
          </span>
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
