import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import type { PageId, PageMeta } from "@gumply/core";
import { BOARD_DRAG_MIME } from "../board/constants.js";
import { isBoard, vaultPathOf } from "../lib/boards.js";
import { isBase } from "../lib/bases.js";
import { canMovePage, type PageTreeNode } from "../lib/tree.js";
import { Icon } from "./Icon.js";
import { useT } from "../i18n/index.js";

export interface PageItemProps {
  node: PageTreeNode;
  depth: number;
  pages: readonly PageMeta[];
  selectedId: PageId | null;
  renamingId: PageId | null;
  renameDraft: string;
  draggingId: PageId | null;
  /**
   * Rows toggled away from their default: pages with sub-pages start
   * expanded, plain folders (D33) start collapsed, as in Obsidian.
   */
  toggled: ReadonlySet<PageId>;
  onOpen: (id: PageId) => void;
  onCreateChild: (id: PageId) => void;
  /** "Add whiteboard inside" (spec/whiteboard §4). */
  onCreateBoardChild: (id: PageId) => void;
  /** "Add database view inside" (D34). */
  onCreateBaseChild?: (id: PageId) => void;
  onDelete: (id: PageId) => void;
  onToggle: (id: PageId) => void;
  onStartMove: (id: PageId) => void;
  onDuplicate: (id: PageId) => void;
  onCopyLink: (id: PageId) => void;
  /** v0.7 C: ⋯ → New page from template… inside this page or folder. */
  onNewFromTemplate: (id: PageId) => void;
  /** G1: ⋯ → Export as HTML… (pages only). */
  onExportHtml?: (id: PageId) => void;
  onRenameDraft: (value: string) => void;
  onStartRename: (id: PageId, title: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onDragStartItem: (id: PageId) => void;
  onDragEndItem: () => void;
  onMove: (id: PageId, parentId: PageId | null) => void;
}

/**
 * One row of the sidebar tree, rendered recursively for children. Memoized:
 * with 1000 pages, re-rendering every row on each App update (autosave status,
 * page load) cost more than the editor itself (#evh35bn7). Sidebar passes
 * stable callbacks, so a row re-renders only when its own data changes.
 */
export const PageItem = memo(PageItemRow);

function PageItemRow(props: PageItemProps) {
  const t = useT();
  const { node, depth, pages, selectedId, renamingId, draggingId, toggled } = props;
  const page = node.page;
  const base = isBase(page);
  // Boards and database views have no sub-pages (D25, D34).
  const leaf = isBoard(page) || base;
  const board = isBoard(page);
  const folder = page.kind === "folder";
  const hasChildren = node.children.length > 0;
  const isSelected = selectedId === page.id;
  const isRenaming = renamingId === page.id;
  const expanded = hasChildren && (folder ? toggled.has(page.id) : !toggled.has(page.id));
  const [dropTarget, setDropTarget] = useState(false);
  // The ⋯ menu: under the button, or at the pointer for a right-click
  // (#ux5cukze). `focus` puts focus on the first item (keyboard opening).
  const [menu, setMenu] = useState<{ at?: { x: number; y: number }; focus: boolean } | null>(null);
  const menuOpen = menu !== null;
  const setMenuOpen = (open: boolean | ((open: boolean) => boolean)) =>
    setMenu((current) => {
      const next = typeof open === "function" ? open(current !== null) : open;
      return next ? (current ?? { focus: false }) : null;
    });
  const menuRef = useRef<HTMLSpanElement | null>(null);
  const menuListRef = useRef<HTMLDivElement | null>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);
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
      if (event.key === "Escape") {
        setMenu(null);
        rowRef.current?.focus();
        return;
      }
      const list = menuListRef.current;
      if (!list || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
      const items = [...list.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
      if (items.length === 0) return;
      event.preventDefault();
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const step = event.key === "ArrowDown" ? 1 : -1;
      items[(index + step + items.length) % items.length]?.focus();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!menu?.focus) return;
    menuListRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [menu]);

  /** Right-click or Shift+F10 / the context-menu key: the same menu as ⋯. */
  const openMenuAt = (x: number, y: number, focus: boolean) => {
    // Keep the menu on screen (it's about 200 × 270 px).
    const left = Math.max(8, Math.min(x, window.innerWidth - 216));
    const top = Math.max(8, Math.min(y, window.innerHeight - 280));
    setMenu({ at: { x: left, y: top }, focus });
  };

  return (
    <div className="tree-node">
      <div
        className={`page-item${folder ? " is-folder" : ""}${isSelected ? " is-selected" : ""}${dropTarget ? " is-drop-target" : ""}${menuOpen ? " has-menu" : ""}`}
        data-testid={`page-item-${page.id}`}
        data-page-id={page.id}
        role="treeitem"
        tabIndex={0}
        aria-selected={isSelected}
        aria-expanded={hasChildren ? expanded : undefined}
        ref={rowRef}
        style={{ paddingLeft: `${6 + depth * 14}px` }}
        onClick={() => {
          // D33: a folder click opens and closes it, and shows its overview.
          if (folder && hasChildren && (isSelected || !expanded)) props.onToggle(page.id);
          props.onOpen(page.id);
        }}
        onContextMenu={(event) => {
          if (isRenaming) return;
          event.preventDefault();
          event.stopPropagation();
          openMenuAt(event.clientX, event.clientY, false);
        }}
        onDoubleClick={(event) => {
          event.stopPropagation();
          props.onStartRename(page.id, page.title);
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "Enter") {
            event.preventDefault();
            props.onOpen(page.id);
          } else if (event.key === "F2") {
            event.preventDefault();
            props.onStartRename(page.id, page.title);
          } else if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            openMenuAt(rect.left + 24, rect.bottom + 2, true);
          }
        }}
        draggable={!isRenaming}
        onDragStart={(event) => {
          event.stopPropagation();
          // Move within the tree, or copy onto an open board as a card.
          event.dataTransfer.effectAllowed = "copyMove";
          event.dataTransfer.setData("text/plain", page.id);
          // A folder isn't a card: it only moves within the tree.
          if (!folder) event.dataTransfer.setData(BOARD_DRAG_MIME, vaultPathOf(page));
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
            aria-label={
              folder
                ? t(expanded ? "sidebar.collapseFolder" : "sidebar.expandFolder")
                : t(expanded ? "sidebar.collapse" : "sidebar.expand")
            }
            onClick={(event) => {
              event.stopPropagation();
              props.onToggle(page.id);
            }}
          >
            <Icon name={expanded ? "chevronDown" : "chevronRight"} size={14} />
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
            {folder ? (
              <span className="page-icon page-icon-folder" data-testid={`folder-icon-${page.id}`} aria-hidden="true">
                <Icon name={expanded ? "folderOpen" : "folder"} size={15} />
              </span>
            ) : page.icon ? (
              <span className="page-icon">{page.icon}</span>
            ) : board ? (
              <span className="page-icon page-icon-board" data-testid={`board-icon-${page.id}`} aria-hidden="true">
                <Icon name="board" size={15} />
              </span>
            ) : base ? (
              <span className="page-icon page-icon-board" data-testid={`base-icon-${page.id}`} aria-hidden="true">
                <Icon name="database" size={15} />
              </span>
            ) : null}
            <span className="page-item-title" title={page.title}>
              {page.title}
            </span>
          </span>
        )}

        <span className="page-actions">
          {leaf ? null : (
          <button
            type="button"
            className="tree-action"
            data-tooltip={folder ? t("sidebar.newPageInside") : t("sidebar.newSubPage")}
            data-testid={`new-child-button-${page.id}`}
            aria-label={folder ? t("sidebar.newPageInside") : t("sidebar.newSubPage")}
            onClick={(event) => {
              event.stopPropagation();
              props.onCreateChild(page.id);
            }}
          >
            <Icon name="plus" size={15} />
          </button>
          )}

          <span className="page-menu" ref={menuRef}>
            <button
              type="button"
              className="tree-action"
              data-tooltip={t("sidebar.moreActions")}
              data-testid={`page-menu-button-${page.id}`}
              aria-label={t("sidebar.moreActions")}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={(event) => {
                event.stopPropagation();
                setMenuOpen((open) => !open);
              }}
            >
              <Icon name="more" size={16} />
            </button>

            {menuOpen ? (
              <div
                ref={menuListRef}
                className={`page-menu-list${menu?.at ? " is-at-pointer" : ""}`}
                role="menu"
                aria-label={t("sidebar.actionsFor", { title: page.title })}
                data-testid={`page-menu-${page.id}`}
                style={menu?.at ? { left: menu.at.x, top: menu.at.y } : undefined}
                onContextMenu={(event) => event.preventDefault()}
              >
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
                  {t("sidebar.rename")}
                </button>
                {folder ? null : (
                <>
                <button
                  type="button"
                  role="menuitem"
                  data-testid={`duplicate-page-${page.id}`}
                  title={!leaf && hasChildren ? t("sidebar.subPagesNotCopied") : undefined}
                  onClick={(event) => {
                    event.stopPropagation();
                    setMenuOpen(false);
                    props.onDuplicate(page.id);
                  }}
                >
                  {t("sidebar.duplicate")}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-testid={`copy-link-${page.id}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    setMenuOpen(false);
                    props.onCopyLink(page.id);
                  }}
                >
                  {t("sidebar.copyLink")}
                </button>
                </>
                )}
                <button
                  type="button"
                  role="menuitem"
                  data-testid={`move-page-${page.id}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    setMenuOpen(false);
                    props.onStartMove(page.id);
                  }}
                >
                  {t("sidebar.moveTo")}
                </button>
                {leaf ? null : (
                  <button
                    type="button"
                    role="menuitem"
                    data-testid={`add-board-${page.id}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      setMenuOpen(false);
                      props.onCreateBoardChild(page.id);
                    }}
                  >
                    {t("sidebar.addBoardInside")}
                  </button>
                )}
                {leaf || !props.onCreateBaseChild ? null : (
                  <button
                    type="button"
                    role="menuitem"
                    data-testid={`add-base-${page.id}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      setMenuOpen(false);
                      props.onCreateBaseChild?.(page.id);
                    }}
                  >
                    {t("bases.addBaseInside")}
                  </button>
                )}
                {board ? null : (
                  <button
                    type="button"
                    role="menuitem"
                    data-testid={`new-from-template-${page.id}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      setMenuOpen(false);
                      props.onNewFromTemplate(page.id);
                    }}
                  >
                    {t("sidebar.newFromTemplate")}
                  </button>
                )}
                {leaf || folder || !props.onExportHtml ? null : (
                  <button
                    type="button"
                    role="menuitem"
                    data-testid={`export-html-${page.id}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      setMenuOpen(false);
                      props.onExportHtml?.(page.id);
                    }}
                  >
                    {t("export.menuItem")}
                  </button>
                )}
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
                  {board
                    ? t("sidebar.deleteBoard")
                    : base
                      ? t("bases.deleteBase")
                      : folder
                        ? t("sidebar.deleteFolder")
                        : t("sidebar.deletePage")}
                </button>
              </div>
            ) : null}
          </span>
        </span>
      </div>

      {hasChildren && expanded ? (
        <div className="tree-children" role="group">
          <TreeChunks
            items={node.children}
            render={(child) => <PageItem key={child.page.id} {...props} node={child} depth={depth + 1} />}
          />
        </div>
      ) : null}
    </div>
  );
}

/** Rows per chunk, and how long a list must be before it is chunked. */
const CHUNK_ROWS = 50;
const ROW_HEIGHT = 30;

/**
 * Long row lists in chunks the browser can skip while off screen
 * (#dvy946h5). A 2,000-page folder expanded in the sidebar otherwise keeps
 * ~40k layout objects alive, which every scroll of the page pays for.
 * Chunks, not rows: thousands of separately skipped rows made the first
 * layout 25× slower. Short lists render as before.
 */
export function TreeChunks<T extends { page: { id: string } }>({
  items,
  render,
}: {
  items: readonly T[];
  render: (item: T) => ReactNode;
}) {
  if (items.length <= CHUNK_ROWS * 2) return <>{items.map(render)}</>;
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += CHUNK_ROWS) chunks.push(items.slice(index, index + CHUNK_ROWS));
  return (
    <>
      {chunks.map((chunk, index) => (
        <div
          // By position: a row moving across a boundary remounts, nothing else does.
          key={index}
          className="tree-chunk"
          style={{ containIntrinsicSize: `auto ${chunk.length * ROW_HEIGHT}px` }}
        >
          {chunk.map(render)}
        </div>
      ))}
    </>
  );
}

