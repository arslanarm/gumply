import { useEffect, useMemo, useRef, useState } from "react";
import type { PageId, PageMeta } from "@gumply/core";
import { preloadGraph } from "../lazy-parts.js";
import { buildPageTree, pageTrail } from "../lib/tree.js";
import { Icon } from "./Icon.js";
import { PageItem, TreeChunks } from "./PageItem.js";
import { TagsPane, type TagRenameRequest } from "./TagsPane.js";
import { useT } from "../i18n/index.js";

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
  /** New whiteboard at the top level or inside a page (spec/whiteboard §4). */
  onCreateBoard: (parentId: PageId | null) => void;
  /** New database view at the top level or inside a page or folder (D34). */
  onCreateBase?: (parentId: PageId | null) => void;
  onRename: (id: PageId, title: string) => Promise<void>;
  onDelete: (id: PageId) => void;
  onMove: (id: PageId, parentId: PageId | null) => void;
  onStartMove: (id: PageId) => void;
  /** ⋯ → Duplicate and Copy link (#ux5cukze). */
  onDuplicate: (id: PageId) => void;
  onCopyLink: (id: PageId) => void;
  onRetry: () => void;
  onSearch: () => void;
  onGraph: () => void;
  /** v0.7 C: open (or make) today's daily note. */
  onToday?: () => void;
  /** v0.7 C: ⋯ → New page from template… inside a page or folder. */
  onNewFromTemplate?: (parentId: PageId | null) => void;
  /** The global graph view is open (sidebar active state). */
  graphActive?: boolean;
  /** #ppag3ugh: the Trash row (with how many pages and boards are in it). */
  trashActive?: boolean;
  trashCount?: number;
  onTrash?: () => void;
  /** #9bx3aznb: the Tags section. */
  onOpenTag?: (tag: string) => void;
  onRenameTag?: (request: TagRenameRequest) => void;
}

export function Sidebar(props: SidebarProps) {
  const t = useT();
  const { pages, selectedId, status, error, focusTarget } = props;
  const tree = useMemo(() => buildPageTree(pages), [pages]);

  const [renamingId, setRenamingId] = useState<PageId | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [draggingId, setDraggingId] = useState<PageId | null>(null);
  // Rows toggled away from their default (pages expanded, D33 folders collapsed).
  const [toggled, setToggled] = useState<ReadonlySet<PageId>>(() => new Set());
  const isFolderId = (id: PageId) => pages.some((page) => page.id === id && page.kind === "folder");

  /** Show `ids`' children: a folder is open when toggled, a page when not. */
  const expand = (...ids: PageId[]) => {
    setToggled((previous) => {
      let next: Set<PageId> | null = null;
      for (const id of ids) {
        const open = isFolderId(id);
        if (previous.has(id) === open) continue;
        next ??= new Set(previous);
        if (open) next.add(id);
        else next.delete(id);
      }
      return next ?? previous;
    });
  };

  // D33: opening a page inside closed folders (search, a link) reveals it.
  // Once per opened page, so collapsing that folder again sticks.
  const revealedFor = useRef<PageId | null>(null);
  useEffect(() => {
    if (!selectedId || revealedFor.current === selectedId) return;
    const trail = pageTrail(pages, selectedId);
    if (trail.length === 0) return;
    revealedFor.current = selectedId;
    const ancestors = trail.slice(0, -1).map((page) => page.id);
    if (ancestors.length > 0) expand(...ancestors);
    scrollPending.current = selectedId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, pages]);

  // #ecnncm86: once per opened page (URL, search, a link, Today, back and
  // forward), bring its row into the sidebar's view, after the reveal has
  // rendered it. Only when it is outside the visible part, so a click on a
  // row (already visible) never moves the list.
  const treeRef = useRef<HTMLDivElement | null>(null);
  const scrollPending = useRef<PageId | null>(null);
  useEffect(() => {
    const id = scrollPending.current;
    if (!id || id !== selectedId) return;
    const frame = requestAnimationFrame(() => {
      const tree = treeRef.current;
      if (!tree) return;
      const row = [...tree.querySelectorAll<HTMLElement>("[data-page-id]")].find((item) => item.dataset.pageId === id);
      if (!row) return; // not rendered yet: the next render tries again
      scrollPending.current = null;
      const view = tree.getBoundingClientRect();
      const box = row.getBoundingClientRect();
      if (box.top >= view.top && box.bottom <= view.bottom) return;
      row.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  });

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
    setToggled((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const createChild = (parentId: PageId) => {
    expand(parentId);
    props.onCreate(parentId);
  };

  // Stable callbacks for the (memoized) rows: each forwards to the latest
  // handler, so App and Sidebar re-renders don't re-render every row.
  const latest = useRef({
    onOpen: props.onOpen,
    onDelete: props.onDelete,
    onStartMove: props.onStartMove,
    onDuplicate: props.onDuplicate,
    onCopyLink: props.onCopyLink,
    onMove: props.onMove,
    onCreateBoard: props.onCreateBoard,
    onCreateBase: props.onCreateBase,
    onNewFromTemplate: props.onNewFromTemplate,
    createChild,
    expand,
    toggle,
    startRename,
    commitRename,
    cancelRename,
  });
  latest.current = {
    onCreateBoard: props.onCreateBoard,
    onCreateBase: props.onCreateBase,
    onOpen: props.onOpen,
    onDelete: props.onDelete,
    onStartMove: props.onStartMove,
    onDuplicate: props.onDuplicate,
    onCopyLink: props.onCopyLink,
    onMove: props.onMove,
    onNewFromTemplate: props.onNewFromTemplate,
    createChild,
    expand,
    toggle,
    startRename,
    commitRename,
    cancelRename,
  };
  const rowHandlers = useMemo(
    () => ({
      onOpen: (id: PageId) => latest.current.onOpen(id),
      onCreateChild: (id: PageId) => latest.current.createChild(id),
      onCreateBoardChild: (id: PageId) => {
        latest.current.expand(id);
        latest.current.onCreateBoard(id);
      },
      onCreateBaseChild: (id: PageId) => {
        latest.current.expand(id);
        latest.current.onCreateBase?.(id);
      },
      onDelete: (id: PageId) => latest.current.onDelete(id),
      onToggle: (id: PageId) => latest.current.toggle(id),
      onStartMove: (id: PageId) => latest.current.onStartMove(id),
      onDuplicate: (id: PageId) => latest.current.onDuplicate(id),
      onCopyLink: (id: PageId) => latest.current.onCopyLink(id),
      onNewFromTemplate: (id: PageId) => {
        latest.current.expand(id);
        latest.current.onNewFromTemplate?.(id);
      },
      onStartRename: (id: PageId, title: string) => latest.current.startRename(id, title),
      onCommitRename: () => latest.current.commitRename(),
      onCancelRename: () => latest.current.cancelRename(),
      onDragEndItem: () => setDraggingId(null),
      onMove: (id: PageId, parentId: PageId | null) => latest.current.onMove(id, parentId),
    }),
    [],
  );

  return (
    <aside className="sidebar" data-testid="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">{t("sidebar.pages")}</span>
      </div>

      <button
        type="button"
        className="sidebar-row sidebar-new-page"
        data-testid="new-page-button"
        aria-label={t("sidebar.newPage")}
        onClick={() => props.onCreate(null)}
      >
        <span className="sidebar-row-icon" aria-hidden="true">
          <Icon name="plus" size={16} />
        </span>
        {t("sidebar.newPage")}
      </button>

      <button
        type="button"
        className="sidebar-row sidebar-new-board"
        data-testid="new-board-button"
        aria-label={t("sidebar.newBoard")}
        onClick={() => props.onCreateBoard(null)}
      >
        <span className="sidebar-row-icon" aria-hidden="true">
          <Icon name="board" size={16} />
        </span>
        {t("sidebar.newBoard")}
      </button>

      {props.onCreateBase ? (
        <button
          type="button"
          className="sidebar-row sidebar-new-base"
          data-testid="new-base-button"
          aria-label={t("bases.newBase")}
          onClick={() => props.onCreateBase?.(null)}
        >
          <span className="sidebar-row-icon" aria-hidden="true">
            <Icon name="database" size={16} />
          </span>
          {t("bases.newBase")}
        </button>
      ) : null}

      <button
        type="button"
        className="sidebar-row sidebar-search"
        data-testid="sidebar-search"
        onClick={props.onSearch}
      >
        <span className="sidebar-row-icon" aria-hidden="true">
          <Icon name="search" size={16} />
        </span>
        {t("sidebar.search")}
      </button>

      {props.onToday ? (
        <button
          type="button"
          className="sidebar-row sidebar-today"
          data-testid="sidebar-today"
          onClick={props.onToday}
        >
          <span className="sidebar-row-icon" aria-hidden="true">
            <Icon name="calendar" size={16} />
          </span>
          {t("sidebar.today")}
        </button>
      ) : null}

      <div
        ref={treeRef}
        className="page-tree"
        data-testid="page-tree"
        role="tree"
        aria-label={t("sidebar.pages")}
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
          <p className="tree-note">{t("sidebar.loading")}</p>
        ) : status === "error" ? (
          <div className="tree-error">
            <p>{error ?? t("sidebar.loadFailed")}</p>
            <button type="button" className="button-secondary" onClick={props.onRetry}>
              {t("common.retry")}
            </button>
          </div>
        ) : tree.length === 0 ? (
          <div className="sidebar-empty" data-testid="sidebar-empty">
            <p>
              <strong>{t("empty.noPages")}</strong> {t("empty.noPagesHint")}
            </p>
          </div>
        ) : (
          <TreeChunks
            items={tree}
            render={(node) => (
            <PageItem
              key={node.page.id}
              node={node}
              depth={0}
              pages={pages}
              selectedId={selectedId}
              renamingId={renamingId}
              renameDraft={renameDraft}
              draggingId={draggingId}
              toggled={toggled}
              {...rowHandlers}
              onRenameDraft={setRenameDraft}
              onDragStartItem={setDraggingId}
            />
            )}
          />
        )}
      </div>

      {props.onOpenTag && props.onRenameTag ? (
        <TagsPane pages={pages} onOpenTag={props.onOpenTag} onRenameTag={props.onRenameTag} />
      ) : null}

      <button
        type="button"
        className={`sidebar-row sidebar-row-bottom${props.graphActive ? " sidebar-row-active" : ""}`}
        data-testid="sidebar-graph"
        aria-current={props.graphActive ? "page" : undefined}
        onPointerEnter={preloadGraph}
        onFocus={preloadGraph}
        onClick={props.onGraph}
      >
        <span className="sidebar-row-icon" aria-hidden="true">
          <Icon name="graph" size={16} />
        </span>
        {t("graph.title")}
      </button>
      {props.onTrash ? (
        <button
          type="button"
          className={`sidebar-row sidebar-row-trash${props.trashActive ? " sidebar-row-active" : ""}`}
          data-testid="sidebar-trash"
          aria-current={props.trashActive ? "page" : undefined}
          aria-label={props.trashCount ? t("trash.withCount", { count: props.trashCount }) : t("trash.title")}
          onClick={props.onTrash}
        >
          <span className="sidebar-row-icon" aria-hidden="true">
            <Icon name="trash" size={16} />
          </span>
          {t("trash.title")}
          {props.trashCount ? (
            <span className="sidebar-row-count" data-testid="sidebar-trash-count">
              {props.trashCount}
            </span>
          ) : null}
        </button>
      ) : null}
    </aside>
  );
}
