import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { PageId, PageMeta } from "@gumply/core";
import { preloadGraph } from "../lazy-parts.js";
import { buildPageTree, canMovePage, pageTrail, shareTree, type PageTreeNode } from "../lib/tree.js";
import { createRowStateStore } from "./sidebar-row-state.js";
import { Icon } from "./Icon.js";
import { PageItem, TreeChunks } from "./PageItem.js";
import { TagsPane, type TagRenameRequest } from "./TagsPane.js";
import { useT } from "../i18n/index.js";

export interface SidebarFocusTarget {
  id: PageId | null;
  nonce: number;
}

export interface SidebarProps {
  /** Below the Trash row: the desktop app's update notice (spec/auto-update). */
  footer?: ReactNode;
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
  /** #7prbquxu phase 4: show or hide an owned database's rows folder in the sidebar. */
  onToggleRows?: (baseId: PageId, shown: boolean) => void;
  /** #7prbquxu: "New database", an empty table with its own rows folder. */
  onCreateDatabase?: (parentId: PageId | null) => void;
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
  /** G1: a page row's ⋯ → Export as HTML…. */
  onExportHtml?: (id: PageId) => void;
  /** G2: a page row's ⋯ → Export as PDF…. */
  onExportPdf?: (id: PageId) => void;
  /** D41: a page or board row's ⋯ → History…. */
  onShowHistory?: (id: PageId) => void;
  /** B4: a row's ⋯ → Import from Notion… into it. */
  onImportNotion?: (id: PageId) => void;
  /** The global graph view is open (sidebar active state). */
  graphActive?: boolean;
  /** #ppag3ugh: the Trash row (with how many pages and boards are in it). */
  trashActive?: boolean;
  trashCount?: number;
  onTrash?: () => void;
  /** D43 §8: a sync tool is changing many files right now. */
  syncing?: boolean;
  /** #im3em6tq: a rename in flight (its link rewrites are ours, not a sync). */
  renaming?: { title: string; count: number | null } | null;
  /** D43: the Conflicts row, shown only while sync conflict copies exist. */
  conflictsActive?: boolean;
  conflictsCount?: number;
  onConflicts?: () => void;
  /** #9bx3aznb: the Tags section. */
  onOpenTag?: (tag: string) => void;
  onRenameTag?: (request: TagRenameRequest) => void;
}

export function Sidebar(props: SidebarProps) {
  const t = useT();
  const { pages, selectedId, status, error, focusTarget } = props;
  // #8gudbajp: unchanged nodes keep their identity across list refreshes, so only changed rows render.
  const sharedNodes = useRef<ReadonlyMap<PageId, PageTreeNode>>(new Map());
  const tree = useMemo(() => {
    const shared = shareTree(buildPageTree(pages), sharedNodes.current);
    sharedNodes.current = shared.nodes;
    return shared.roots;
  }, [pages]);

  const [renamingId, setRenamingId] = useState<PageId | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [draggingId, setDraggingId] = useState<PageId | null>(null);
  // Rows toggled away from their default (pages expanded, D33 folders collapsed).
  const [toggled, setToggled] = useState<ReadonlySet<PageId>>(() => new Set());
  // #8gudbajp: rows read the selection and the rename through this store, not as props.
  const rowState = useMemo(() => createRowStateStore({ selectedId, renamingId: null, renameDraft: "" }), []);
  useLayoutEffect(() => {
    rowState.set({ selectedId, renamingId, renameDraft });
  }, [rowState, selectedId, renamingId, renameDraft]);
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const canDropOn = useCallback((draggingId: PageId, targetId: PageId) => canMovePage(pagesRef.current, draggingId, targetId), []);
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

  /*
   * #ifcn6pvx: the tree is ONE Tab stop (the WAI-ARIA tree pattern). Every row
   * renders tabIndex=-1; one row is 0: the row last focused, else the open
   * page's, else the first. Set on the DOM, not as a prop: a prop that changes
   * on every arrow key would re-render every (memoized) row of a big tree.
   * Re-checked after each render and when rows mount or unmount.
   */
  const tabStop = useRef<PageId | null>(null);
  const selectedRef = useRef(selectedId);
  if (selectedRef.current !== selectedId) {
    // Another page opened: the stop follows it.
    selectedRef.current = selectedId;
    tabStop.current = null;
  }
  const placeTabStop = useCallback(() => {
    const tree = treeRef.current;
    if (!tree) return;
    const rows = treeRows(tree);
    if (rows.length === 0) return;
    const stop =
      rows.find((row) => row.dataset.pageId === tabStop.current) ?? rows.find((row) => row.dataset.pageId === selectedRef.current) ?? rows[0];
    for (const row of rows) {
      const index = row === stop ? 0 : -1;
      if (row.tabIndex !== index) row.tabIndex = index;
    }
  }, []);
  useLayoutEffect(placeTabStop);
  useEffect(() => {
    const tree = treeRef.current;
    if (!tree) return;
    const observer = new MutationObserver(placeTabStop);
    observer.observe(tree, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [placeTabStop]);

  const typeahead = useRef({ text: "", at: 0 });
  const onTreeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const tree = treeRef.current;
    const row = event.target instanceof HTMLElement && event.target.getAttribute("role") === "treeitem" ? event.target : null;
    if (!tree || !row || event.altKey || event.ctrlKey || event.metaKey) return;
    const rows = treeRows(tree);
    const index = rows.indexOf(row);
    const go = (target: HTMLElement | undefined) => {
      event.preventDefault();
      if (!target) return;
      target.focus();
      target.scrollIntoView({ block: "nearest" });
    };
    const expanded = row.getAttribute("aria-expanded");
    const toggle = () => row.querySelector<HTMLButtonElement>(":scope > .tree-toggle")?.click();
    switch (event.key) {
      case "ArrowDown":
        return go(rows[index + 1]);
      case "ArrowUp":
        return go(rows[index - 1]);
      case "Home":
        return go(rows[0]);
      case "End":
        return go(rows.at(-1));
      case "ArrowRight":
        event.preventDefault();
        if (expanded === "false") toggle();
        else if (expanded === "true" && rows[index + 1] && row.parentElement?.contains(rows[index + 1]!)) go(rows[index + 1]);
        return;
      case "ArrowLeft": {
        event.preventDefault();
        if (expanded === "true") return toggle();
        const parent = row.closest(".tree-children")?.parentElement?.querySelector<HTMLElement>(':scope > [role="treeitem"]');
        return go(parent ?? undefined);
      }
      default: {
        // Type-ahead: the next row whose title starts with what was typed.
        if (event.key.length !== 1 || event.key === " " || event.shiftKey && event.key === "?") return;
        const now = Date.now();
        const text = now - typeahead.current.at < 700 ? typeahead.current.text + event.key : event.key;
        typeahead.current = { text, at: now };
        const needle = text.toLocaleLowerCase();
        const start = text.length === 1 ? index + 1 : index;
        for (let step = 0; step < rows.length; step += 1) {
          const candidate = rows[(start + step) % rows.length]!;
          const title = candidate.querySelector(".page-item-title")?.textContent?.toLocaleLowerCase() ?? "";
          if (title.startsWith(needle)) return go(candidate);
        }
      }
    }
  };

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
    onToggleRows: props.onToggleRows,
    onNewFromTemplate: props.onNewFromTemplate,
    onExportHtml: props.onExportHtml,
    onImportNotion: props.onImportNotion,
    onExportPdf: props.onExportPdf,
    onShowHistory: props.onShowHistory,
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
    onToggleRows: props.onToggleRows,
    onOpen: props.onOpen,
    onDelete: props.onDelete,
    onStartMove: props.onStartMove,
    onDuplicate: props.onDuplicate,
    onCopyLink: props.onCopyLink,
    onMove: props.onMove,
    onNewFromTemplate: props.onNewFromTemplate,
    onExportHtml: props.onExportHtml,
    onImportNotion: props.onImportNotion,
    onExportPdf: props.onExportPdf,
    onShowHistory: props.onShowHistory,
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
      onToggleRows: (id: PageId, shown: boolean) => latest.current.onToggleRows?.(id, shown),
      onDelete: (id: PageId) => latest.current.onDelete(id),
      onToggle: (id: PageId) => latest.current.toggle(id),
      onStartMove: (id: PageId) => latest.current.onStartMove(id),
      onDuplicate: (id: PageId) => latest.current.onDuplicate(id),
      onCopyLink: (id: PageId) => latest.current.onCopyLink(id),
      onNewFromTemplate: (id: PageId) => {
        latest.current.expand(id);
        latest.current.onNewFromTemplate?.(id);
      },
      onExportHtml: (id: PageId) => latest.current.onExportHtml?.(id),
      onImportNotion: (id: PageId) => latest.current.onImportNotion?.(id),
      onExportPdf: (id: PageId) => latest.current.onExportPdf?.(id),
      onShowHistory: (id: PageId) => latest.current.onShowHistory?.(id),
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

      {props.onCreateDatabase ? (
        <button
          type="button"
          className="sidebar-row sidebar-new-base"
          data-testid="new-base-button"
          aria-label={t("bases.newDatabase")}
          onClick={() => props.onCreateDatabase?.(null)}
        >
          <span className="sidebar-row-icon" aria-hidden="true">
            <Icon name="database" size={16} />
          </span>
          {t("bases.newDatabase")}
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
        // A tree only while it has items: loading, error and an empty vault
        // show a note instead (an empty role=tree is invalid, WCAG 1.3.1, #jchhjepb).
        role={status !== "loading" && status !== "error" && tree.length > 0 ? "tree" : undefined}
        aria-label={t("sidebar.pages")}
        onKeyDown={onTreeKeyDown}
        onFocus={(event) => {
          const row = event.target instanceof HTMLElement && event.target.getAttribute("role") === "treeitem" ? event.target : null;
          if (!row) return;
          tabStop.current = row.dataset.pageId ?? null;
          placeTabStop();
        }}
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
              rowState={rowState}
              canDropOn={canDropOn}
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
      {props.onConflicts && (props.conflictsCount || props.conflictsActive) ? (
        <button
          type="button"
          className={`sidebar-row sidebar-row-conflicts${props.conflictsActive ? " sidebar-row-active" : ""}`}
          data-testid="sidebar-conflicts"
          aria-current={props.conflictsActive ? "page" : undefined}
          aria-label={props.conflictsCount ? t("conflicts.sidebarWithCount", { count: props.conflictsCount }) : t("conflicts.sidebar")}
          onClick={props.onConflicts}
        >
          <span className="sidebar-row-icon" aria-hidden="true">
            <Icon name="alert" size={16} />
          </span>
          {t("conflicts.sidebar")}
          {props.conflictsCount ? (
            <span className="sidebar-row-count" data-testid="sidebar-conflicts-count">
              {props.conflictsCount}
            </span>
          ) : null}
        </button>
      ) : null}
      <div className="sidebar-syncing" role="status" data-testid="sidebar-syncing">
        {props.renaming
          ? props.renaming.count
            ? t("sidebar.renamingCount", { title: props.renaming.title, count: props.renaming.count })
            : t("sidebar.renaming", { title: props.renaming.title })
          : props.syncing
            ? t("conflicts.syncing")
            : null}
      </div>
      {props.footer ?? null}
    </aside>
  );
}

/** The tree's rows as shown, top to bottom (collapsed children aren't rendered). */
function treeRows(tree: HTMLElement): HTMLElement[] {
  return [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')];
}
