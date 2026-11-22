import { Fragment, memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { PageId, PageMeta } from "@gumply/core";
import { BOARD_DRAG_MIME } from "../board/constants.js";
import { isBoard, vaultPathOf } from "../lib/boards.js";
import { isBase } from "../lib/bases.js";
import { canMovePage, type PageTreeNode } from "../lib/tree.js";
import { Icon } from "./Icon.js";
import { placeMenu, type MenuPlacement } from "../lib/menu-placement.js";
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
  /** G2: ⋯ → Export as PDF… (pages only). */
  onExportPdf?: (id: PageId) => void;
  /** D41: History… (pages and boards). */
  onShowHistory?: (id: PageId) => void;
  /** B4: ⋯ → Import from Notion… into this page or folder. */
  onImportNotion?: (id: PageId) => void;
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
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const menuListRef = useRef<HTMLDivElement | null>(null);
  // #sjts42ue: where the (portal, fixed-position) menu goes, once measured.
  const [placement, setPlacement] = useState<MenuPlacement | null>(null);
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
    // The list is a portal on <body> (#sjts42ue): a click inside it isn't "outside".
    const inside = (target: EventTarget | null) =>
      target instanceof Node && (menuRef.current?.contains(target) || menuListRef.current?.contains(target));
    const onPointerDown = (event: MouseEvent) => {
      if (!inside(event.target)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // Back where it was opened from: the ⋯ button, or the row for a
        // right-click / Shift+F10.
        const fromButton = !menu?.at;
        setMenu(null);
        (fromButton ? menuButtonRef.current : rowRef.current)?.focus();
        return;
      }
      const list = menuListRef.current;
      const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
      if (!list || !keys.includes(event.key)) return;
      const items = [...list.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
      if (items.length === 0) return;
      event.preventDefault();
      if (event.key === "Home" || event.key === "End") {
        items[event.key === "Home" ? 0 : items.length - 1]?.focus();
        return;
      }
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
  }, [menuOpen, menu?.at]);

  // Measure the open menu and place it (#sjts42ue): below the ⋯ button or at
  // the pointer, flipped up near the bottom, scrolling when it can't fit.
  // Before it's placed it's invisible, so it never flashes in the wrong spot.
  useLayoutEffect(() => {
    if (!menu) {
      setPlacement(null);
      return;
    }
    const place = () => {
      const list = menuListRef.current;
      const button = menuButtonRef.current;
      if (!list) return;
      list.style.maxHeight = "";
      const size = { width: list.offsetWidth, height: list.scrollHeight };
      const anchor = menu.at ? { point: menu.at } : button ? { button: button.getBoundingClientRect() } : null;
      if (!anchor) return;
      setPlacement(placeMenu(anchor, size, { width: window.innerWidth, height: window.innerHeight }));
    };
    place();
    // When the tree scrolls, a ⋯ menu follows its button (and closes once the
    // button has left the window); a right-click menu stays at the pointer.
    // Programmatic scrolls (revealing the open page) must not close it.
    const onScroll = (event: Event) => {
      if (menu.at || (event.target instanceof Node && menuListRef.current?.contains(event.target))) return;
      const rect = menuButtonRef.current?.getBoundingClientRect();
      if (!rect || rect.bottom < 0 || rect.top > window.innerHeight) setMenu(null);
      else place();
    };
    window.addEventListener("resize", place);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [menu]);

  const placed = placement !== null;
  useEffect(() => {
    if (!menu?.focus || !placed) return;
    menuListRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [menu, placed]);

  /** One menu row: closes the menu, then runs the action. */
  const menuItem = (testId: string, label: string, action: () => void, extra: { title?: string; danger?: boolean } = {}) => (
    <button
      key={testId}
      type="button"
      role="menuitem"
      className={extra.danger ? "menu-danger" : undefined}
      data-testid={`${testId}-${page.id}`}
      title={extra.title}
      onClick={(event) => {
        event.stopPropagation();
        setMenuOpen(false);
        action();
      }}
    >
      {label}
    </button>
  );

  // Notion-style groups, separated by a line (#sjts42ue): edit, add inside,
  // import/export, delete. Groups with no item for this row are left out.
  const menuGroups: ReactNode[][] = [
    [
      menuItem("rename-page", t("sidebar.rename"), () => props.onStartRename(page.id, page.title)),
      folder
        ? null
        : menuItem("duplicate-page", t("sidebar.duplicate"), () => props.onDuplicate(page.id), {
            title: !leaf && hasChildren ? t("sidebar.subPagesNotCopied") : undefined,
          }),
      folder ? null : menuItem("copy-link", t("sidebar.copyLink"), () => props.onCopyLink(page.id)),
      menuItem("move-page", t("sidebar.moveTo"), () => props.onStartMove(page.id)),
    ],
    [
      leaf ? null : menuItem("add-board", t("sidebar.addBoardInside"), () => props.onCreateBoardChild(page.id)),
      leaf || !props.onCreateBaseChild
        ? null
        : menuItem("add-base", t("bases.addBaseInside"), () => props.onCreateBaseChild?.(page.id)),
      board ? null : menuItem("new-from-template", t("sidebar.newFromTemplate"), () => props.onNewFromTemplate(page.id)),
    ],
    [
      leaf || !props.onImportNotion
        ? null
        : menuItem("import-notion", t("notionImport.menuItem"), () => props.onImportNotion?.(page.id)),
      leaf || folder || !props.onExportHtml
        ? null
        : menuItem("export-html", t("export.menuItem"), () => props.onExportHtml?.(page.id)),
      leaf || folder || !props.onExportPdf
        ? null
        : menuItem("export-pdf", t("export.pdf.menuItem"), () => props.onExportPdf?.(page.id)),
      folder || base || !props.onShowHistory
        ? null
        : menuItem("page-history", t("history.menuItem"), () => props.onShowHistory?.(page.id)),
    ],
    [
      menuItem(
        "delete-page",
        board
          ? t("sidebar.deleteBoard")
          : base
            ? t("bases.deleteBase")
            : folder
              ? t("sidebar.deleteFolder")
              : t("sidebar.deletePage"),
        () => props.onDelete(page.id),
        { danger: true },
      ),
    ],
  ]
    .map((group) => group.filter((item) => item !== null))
    .filter((group) => group.length > 0);

  /** Right-click or Shift+F10 / the context-menu key: the same menu as ⋯, placed by `placeMenu`. */
  const openMenuAt = (x: number, y: number, focus: boolean) => {
    setMenu({ at: { x, y }, focus });
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
              ref={menuButtonRef}
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

            {menuOpen
              ? createPortal(
                  <div
                    ref={menuListRef}
                    className={`page-menu-list${menu?.at ? " is-at-pointer" : ""}${placement?.above ? " is-above" : ""}`}
                    role="menu"
                    aria-label={t("sidebar.actionsFor", { title: page.title })}
                    data-testid={`page-menu-${page.id}`}
                    style={
                      placement
                        ? { left: placement.left, top: placement.top, maxHeight: placement.maxHeight }
                        : { left: 0, top: 0, visibility: "hidden" }
                    }
                    onContextMenu={(event) => event.preventDefault()}
                  >
                    {menuGroups.map((group, index) => (
                      <Fragment key={index}>
                        {index > 0 ? <div className="page-menu-separator" role="separator" /> : null}
                        {group}
                      </Fragment>
                    ))}
                  </div>,
                  document.body,
                )
              : null}
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

