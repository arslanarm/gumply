import { flushSync } from "react-dom";
import {
  convertPropertyValue,
  formatWikilink,
  pageLook,
  resolveWikilink,
  type Backlink,
  type BoardDocument,
  type Page,
  type PageId,
  type PageMeta,
  type PropertiesPatch,
  type PropertyType,
  type TrashItem,
  type DailyNoteSettings,
} from "@gumply/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, consumeNewVaultPage, fileUrl, type BaseDocument } from "./api/client.js";
// Only the board's shell: the editor (React Flow) is code-split inside it.
import { BoardView, type BoardViewControls } from "./board/BoardView.js";
import { BacklinksPanel } from "./components/BacklinksPanel.js";
import { ConfirmDialog } from "./components/ConfirmDialog.js";
import { DeleteDialog } from "./components/DeleteDialog.js";
import { PropertiesBlock } from "./components/PropertiesBlock.js";
import { backgroundStyle, PageCover } from "./components/PageCover.js";
import { FolderView } from "./components/FolderView.js";
import { TemplatePicker } from "./components/TemplatePicker.js";
import type { PageTemplateRequest } from "./editor/page-template.js";
import { dailyNeighbours, todayDay } from "./lib/daily.js";
import { TrashedPageView } from "./components/TrashedPageView.js";
import { TrashView } from "./components/TrashView.js";
import { Editor, type EditorControls } from "./components/Editor.js";
import { PageHeader } from "./components/PageHeader.js";
import { Icon, type IconName } from "./components/Icon.js";
import { QuickSwitcher } from "./components/QuickSwitcher.js";
import { SaveStatus } from "./components/SaveStatus.js";
import { Sidebar, type SidebarFocusTarget } from "./components/Sidebar.js";
import { ThemeToggle } from "./components/ThemeToggle.js";
import { SettingsMenu } from "./components/SettingsMenu.js";
import { UndoToast } from "./components/UndoToast.js";
import type { SaveState } from "./editor/autosave.js";
// Graph and dialogs load on demand (#evh35bn7).
import { GraphView, LocalGraphPanel, MoveDialog, ShortcutsDialog, TemplateGallery, preloadWhenIdle } from "./lazy-parts.js";
import type { BoardTemplateId } from "./board/templates.js";
import { idFromVaultPath, isBoard, isBoardId, newBoardTitle, vaultPathOf } from "./lib/boards.js";
import { isBase, isBaseId, newBaseTitle } from "./lib/bases.js";
import { BaseView } from "./bases/BaseView.js";
import { focusAfterDelete, folderContents, folderDeleteBody } from "./lib/delete.js";
import { chooseLandingPage } from "./lib/first-run.js";
import { errorMessage, serverDownMessage } from "./lib/errors.js";
import { moveToastMessage } from "./lib/move.js";
import { openPageNeedsReload } from "./lib/rename.js";
import { flushAllSaves, installUnloadGuards } from "./lib/pending-saves.js";
import { TagRenameDialog } from "./components/TagRenameDialog.js";
import type { TagRenameRequest } from "./components/TagsPane.js";
import {
  GRAPH_HASH,
  isGraphHash,
  pageHash,
  pageIdFromHash,
  trashHash,
  trashRouteFromHash,
  type TrashRoute,
} from "./lib/routing.js";
import { deleteForeverBody, emptyTrashBody, restoredId, restoredMessage, trashedCount } from "./lib/trash.js";
import { isTypingTarget } from "./lib/shortcuts.js";
import { windowTitle } from "./lib/title.js";
import { buildPageTree, isSelfOrDescendant, pageTrail } from "./lib/tree.js";
import { t, useT } from "./i18n/index.js";
import { ExportDialog } from "./components/ExportDialog.js";

type ListStatus = "loading" | "ready" | "error";
type PageStatus = "idle" | "loading" | "ready" | "error";

interface PendingDelete {
  page: PageMeta;
  subPages: number;
  /** D33: a folder's own confirm line ("Its 3 pages and 2 other files …"). */
  body?: string;
}

interface ToastState {
  message: string;
  /** What happened: deleting shows a bin, moving an arrow, notices an "i". */
  icon?: IconName;
  undo?: () => Promise<void>;
}

const toastKeys = new WeakMap<object, number>();
let lastToastKey = 0;
/** One key per toast shown (each `setToast` makes a new object). */
function toastKey(toast: object): number {
  let key = toastKeys.get(toast);
  if (key === undefined) {
    lastToastKey += 1;
    key = lastToastKey;
    toastKeys.set(toast, key);
  }
  return key;
}

/** A board shown through the page UI (header, tree): metadata, no body. */
function boardAsPage(meta: PageMeta): Page {
  return { ...meta, content: "" };
}

/** What both document views (page editor, board) offer the shell. */
interface DocumentControls {
  flush: () => Promise<void>;
  isDirty: () => boolean;
  keepMine: () => Promise<void>;
}

interface PendingHeading {
  pageId: PageId;
  heading: string;
}

/**
 * Create a board file; with a template (spec/v0-6 §D) its content is saved
 * right after, so the file is a normal `.canvas` named after the template.
 */
async function createBoardFile(
  parentId: PageId | null,
  /** Undefined: the template's name, or "Untitled whiteboard" (in the UI language). */
  title: string | undefined,
  templateId: BoardTemplateId | null,
): Promise<{ meta: PageMeta }> {
  // Templates load with the gallery's chunk, never with the app.
  const template = templateId ? (await import("./board/templates.js")).boardTemplate(templateId) : undefined;
  const created = await api.createBoard({ title: title ?? template?.name() ?? newBoardTitle(), parentId });
  if (!template) return created;
  const saved = await api.saveBoard(created.meta.id, {
    board: { ...template.build(), ...(created.board.gumply ? { gumply: created.board.gumply } : {}) },
    expectedUpdated: created.meta.updated,
  });
  return { meta: saved.meta };
}

export function App() {
  // Re-render on a language switch (#7h5utv23).
  useT();
  const [pages, setPages] = useState<PageMeta[]>([]);
  // D33: plain folders are tree items only. Everything that means "documents"
  // (links, search, the board picker, the editor) uses this list.
  const documentPages = useMemo(() => pages.filter((item) => item.kind !== "folder"), [pages]);
  /** Changes when any page changed (database views re-run on it, D34). */
  const pagesStamp = useMemo(() => {
    let hash = 0;
    for (const item of pages) {
      const text = `${item.id}\u0000${item.updated}`;
      for (let i = 0; i < text.length; i += 1) hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0;
    }
    return `${pages.length}:${hash}`;
  }, [pages]);
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const [listStatus, setListStatus] = useState<ListStatus>("loading");
  const [listError, setListError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<PageId | null>(() =>
    pageIdFromHash(window.location.hash),
  );
  const selectedFolder = useMemo(
    () => (selectedId ? (pages.find((item) => item.id === selectedId && item.kind === "folder") ?? null) : null),
    [pages, selectedId],
  );
  const [page, setPage] = useState<Page | null>(null);
  // The open board's document as loaded (BoardView starts from it).
  const [boardDoc, setBoardDoc] = useState<BoardDocument | null>(null);
  // D34: the open database view's file as loaded (BaseView starts from it).
  const [baseDoc, setBaseDoc] = useState<BaseDocument | null>(null);
  // A board created just now opens with its title selected (type to name it);
  // any other board opens with the canvas focused (#ksx7szar).
  const [editTitleId, setEditTitleId] = useState<PageId | null>(null);
  /**
   * The template gallery is open for a new board under this parent (spec/v0-6
   * §D). With `resolve`, the pick goes back to the caller (`/template`;
   * `undefined` is Cancel) instead of creating and opening the board here.
   */
  /** The Settings popover (language, theme; #7h5utv23). */
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** G1: the page "Export as HTML…" was picked for. */
  const [exportTarget, setExportTarget] = useState<PageMeta | null>(null);
  const [galleryParent, setGalleryParent] = useState<{
    parentId: PageId | null;
    resolve?: (template: BoardTemplateId | null | undefined) => void;
  } | null>(null);
  /** v0.7 C: the page-template picker (new page inside a parent, or `/template` in the open page). */
  const [templatePicker, setTemplatePicker] = useState<
    | { mode: "new"; parentId: PageId | null }
    | { mode: "insert"; pageId: PageId; title: string; request: PageTemplateRequest }
    | null
  >(null);
  /** v0.7 C: daily-note settings (folder and format) for ‹ › and Today. */
  const [dailySettings, setDailySettings] = useState<DailyNoteSettings | null>(null);
  const [pageStatus, setPageStatus] = useState<PageStatus>("idle");
  const [pageReload, setPageReload] = useState(0);
  const [editorRevision, setEditorRevision] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [actionError, setActionError] = useState<string | null>(null);
  const [deletedOnDisk, setDeletedOnDisk] = useState<Page | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [movingId, setMovingId] = useState<PageId | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try {
      const stored = localStorage.getItem("gumply:sidebar");
      if (stored !== null) return stored !== "closed";
    } catch {
      // fall through to the width default
    }
    return window.innerWidth > 900;
  });
  const [graphOpen, setGraphOpen] = useState(() => isGraphHash(window.location.hash));
  // #ppag3ugh: the trash list (`#trash`) or a trashed page (`#trash/<id>`).
  const [trashRoute, setTrashRoute] = useState<TrashRoute | null>(() => trashRouteFromHash(window.location.hash));
  const [trashItems, setTrashItems] = useState<TrashItem[] | null>(null);
  const [trashError, setTrashError] = useState<string | null>(null);
  const [trashConfirm, setTrashConfirm] = useState<
    { kind: "forever"; item: TrashItem } | { kind: "empty"; items: TrashItem[] } | null
  >(null);
  // The desktop app offers "Show in file manager" (GET /api/health, v1.9).
  const [desktop, setDesktop] = useState(false);
  const [lastPageId, setLastPageId] = useState<PageId | null>(null);
  // v0.7 F (#385sexd6): bumped by "Add cover" to open the cover picker.
  const [coverPickerSignal, setCoverPickerSignal] = useState(0);
  const [localGraphOpen, setLocalGraphOpen] = useState(() => {
    try {
      return sessionStorage.getItem("gumply:local-graph") === "open";
    } catch {
      return false;
    }
  });

  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  /** #9bx3aznb: the tag being renamed (its dialog is open). */
  const [tagRename, setTagRename] = useState<TagRenameRequest | null>(null);
  const [focusTarget, setFocusTarget] = useState<SidebarFocusTarget | null>(null);
  // D14 §5: after a delete, focus stays on the next sibling; don't let an empty
  // next page's title steal it (walkthrough #4aepmkk4).
  const [autoFocusTitle, setAutoFocusTitle] = useState(true);
  const [backlinks, setBacklinks] = useState<Backlink[]>([]);
  const [backlinksLoading, setBacklinksLoading] = useState(false);
  const [pendingHeading, setPendingHeading] = useState<PendingHeading | null>(null);

  const selectedRef = useRef<PageId | null>(selectedId);
  selectedRef.current = selectedId;
  const pageRef = useRef<Page | null>(page);
  pageRef.current = page;
  // D20: stable identity of an open page across renames (new id → first id).
  const sessionKeys = useRef(new Map<PageId, string>());
  const sessionKeyOf = (id: PageId): string => sessionKeys.current.get(id) ?? id;
  // Set when App itself moved the URL to a renamed page's new id, so the load
  // effect keeps the open page instead of refetching and remounting it.
  const followedRename = useRef<PageId | null>(null);
  // Pages whose rename request is in flight. The disk poll may already see the
  // new file name; it must not treat the open page as deleted meanwhile.
  const renamesInFlight = useRef(new Set<PageId>());
  // Bumped when a rename starts and ends: a poll that began before then has a
  // list that may disagree with the ids the client now uses.
  const renameEpoch = useRef(0);
  // Bumped by every confirmed save (#m6ppcam2): a disk poll that started
  // before it has an older list and must not reload the editor.
  const saveEpoch = useRef(0);
  const lastPageReload = useRef(0);
  // The page id the load effect last loaded (or followed a rename to).
  const loadedSelection = useRef<PageId | null>(null);
  const editorControls = useRef<EditorControls | null>(null);
  const boardControls = useRef<BoardViewControls | null>(null);
  /** Save controls of whatever is open: the page editor or the board. */
  const documentControls = (): DocumentControls | null =>
    isBoardId(selectedRef.current) ? boardControls.current : editorControls.current;
  const focusNonce = useRef(0);
  const searchTrigger = useRef<HTMLElement | null>(null);
  const reloadEditorAfterFetch = useRef(false);
  const focusBodyAfterOpen = useRef(false);
  const restoreSelection = useRef<{ from: number; to: number } | null>(null);
  const backlinksRequest = useRef(0);
  const initialLoadStarted = useRef(false);
  // The landing page's request, started as soon as the list arrives instead of
  // after the sidebar has rendered (1000 rows take a while; #evh35bn7).
  const landingPageRequest = useRef<{ id: PageId; request: Promise<Page> } | null>(null);

  const moveFocus = useCallback((id: PageId | null) => {
    focusNonce.current += 1;
    setFocusTarget({ id, nonce: focusNonce.current });
  }, []);

  // D13: one overlay, opened by Cmd/Ctrl+K and by the sidebar Search row.
  const [searchQuery, setSearchQuery] = useState("");

  // "<Page> — <Vault folder> — Gumply" (#ux5cukze); the desktop window shows it.
  const [vaultPath, setVaultPath] = useState<string | null>(null);
  useEffect(() => {
    void api
      .health()
      .then((health) => setVaultPath(health.vaultPath))
      .catch(() => undefined);
  }, []);
  const shownTitle = graphOpen ? t("graph.title") : (page?.title ?? selectedFolder?.title ?? null);
  useEffect(() => {
    document.title = windowTitle({ page: shownTitle, vaultPath });
  }, [shownTitle, vaultPath]);
  const openSearch = useCallback((query = "") => {
    const active = document.activeElement;
    searchTrigger.current = active instanceof HTMLElement ? active : null;
    setSearchQuery(typeof query === "string" ? query : "");
    setSearchOpen(true);
  }, []);
  /**
   * #hy9dizhb: at <= 900 px the sidebar is an overlay, so every navigation
   * started from it (Trash, Graph, Search, a tag, New...) closes it first,
   * like the tree rows and Today do.
   */
  const closingSidebar =
    <A extends unknown[]>(action: (...args: A) => void) =>
    (...args: A) => {
      if (window.innerWidth <= 900) setSidebarOpen(false);
      action(...args);
    };
  /** A clicked inline `#tag` searches for it (#ux5cukze). */
  const openTagSearch = useCallback((tag: string) => openSearch(`#${tag}`), [openSearch]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    const trigger = searchTrigger.current;
    searchTrigger.current = null;
    // Restore focus after the overlay unmounts (spec/ux §5).
    window.requestAnimationFrame(() => {
      if (trigger?.isConnected) trigger.focus();
    });
  }, []);

  /** Pick/create: close without pulling focus back to the trigger. */
  const dismissSearch = useCallback(() => {
    searchTrigger.current = null;
    setSearchOpen(false);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") return;
      // The editor took it: Mod+K with text selected adds a link (#bg3cb83t).
      if (event.defaultPrevented) return;
      if (pendingDelete || movingId || shortcutsOpen) return;
      event.preventDefault();
      if (searchOpen) closeSearch();
      else openSearch();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [searchOpen, openSearch, closeSearch, pendingDelete, movingId, shortcutsOpen]);

  // `?` opens the shortcut help unless the user is typing (spec/ux §5/§9).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "?" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (pendingDelete || searchOpen || shortcutsOpen || movingId) return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      setShortcutsOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pendingDelete, searchOpen, shortcutsOpen, movingId]);

  useEffect(() => {
    try {
      localStorage.setItem("gumply:sidebar", sidebarOpen ? "open" : "closed");
    } catch {
      // storage unavailable: keep the in-memory state
    }
  }, [sidebarOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key !== "\\") return;
      event.preventDefault();
      setSidebarOpen((open) => !open);
    };
    // Close the sidebar only when the window becomes narrow, not on every
    // resize while narrow (a mobile keyboard appearing must not close a
    // sidebar the user just opened).
    let wasNarrow = window.innerWidth <= 900;
    const onResize = () => {
      const narrow = window.innerWidth <= 900;
      if (narrow && !wasNarrow) setSidebarOpen(false);
      wasNarrow = narrow;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  const loadPages = useCallback(async (): Promise<PageMeta[] | null> => {
    try {
      const list = await api.listPages();
      setPages(list);
      setListStatus("ready");
      setListError(null);
      return list;
    } catch (error) {
      setListStatus("error");
      setListError(errorMessage(error));
      return null;
    }
  }, []);

  const loadBacklinks = useCallback(async (id: PageId) => {
    const token = backlinksRequest.current + 1;
    backlinksRequest.current = token;
    setBacklinksLoading(true);
    try {
      const items = await api.backlinks(id);
      if (backlinksRequest.current === token) setBacklinks(items);
    } catch {
      if (backlinksRequest.current === token) setBacklinks([]);
    } finally {
      if (backlinksRequest.current === token) setBacklinksLoading(false);
    }
  }, []);

  const navigate = useCallback((id: PageId | null, replace = false) => {
    const hash = id ? pageHash(id) : "#/";
    if (window.location.hash !== hash) {
      if (replace) window.history.replaceState(null, "", hash);
      else window.location.hash = hash;
    }
    setSelectedId(id);
    setGraphOpen(false);
    setTrashRoute(null);
  }, []);

  const navigateGraph = useCallback(() => {
    if (window.location.hash !== GRAPH_HASH) window.location.hash = GRAPH_HASH;
    setSelectedId(null);
    setGraphOpen(true);
    setTrashRoute(null);
  }, []);

  const loadTrash = useCallback(async () => {
    try {
      setTrashItems(await api.listTrash());
      setTrashError(null);
    } catch (error) {
      setTrashError(errorMessage(error));
    }
  }, []);

  /** The trash list, or a trashed page read-only (#ppag3ugh). */
  const navigateTrash = useCallback(
    (trashId?: string, id?: PageId | null) => {
      const hash = trashHash(trashId, id);
      if (window.location.hash !== hash) window.location.hash = hash;
      setSelectedId(null);
      setGraphOpen(false);
      setTrashRoute({ trashId: trashId ?? null, id: id ?? null });
      if (!trashId) void loadTrash();
    },
    [loadTrash],
  );

  /** Refetch the open page and remount the editor with the new content. */
  const requestPageReload = useCallback(() => {
    reloadEditorAfterFetch.current = true;
    setPageReload((value) => value + 1);
  }, []);

  /**
   * D20: the id follows the title, so a rename changes it (and the ids of
   * every sub-page). Keep the list, the open page and the URL in sync without
   * refetching or remounting: the open editor stays as it is and simply saves
   * to the new id. `sessionKeys` gives the open page a stable identity across
   * such renames.
   */
  const applySavedPage = useCallback(
    (previousId: PageId, updated: Page) => {
      saveEpoch.current += 1;
      const newId = updated.id;
      const remap = (id: PageId): PageId =>
        newId === previousId
          ? id
          : id === previousId
            ? newId
            : id.startsWith(`${previousId}/`)
              ? `${newId}${id.slice(previousId.length)}`
              : id;

      setPages((previous) =>
        previous.map((item) => {
          if (item.id === previousId) {
            return {
              ...item,
              id: newId,
              title: updated.title,
              icon: updated.icon,
              tags: updated.tags,
              parentId: updated.parentId,
              updated: updated.updated,
            };
          }
          const id = remap(item.id);
          return id === item.id
            ? item
            : { ...item, id, parentId: item.parentId === null ? null : remap(item.parentId) };
        }),
      );
      setPage((previous) => {
        if (!previous) return previous;
        if (previous.id === previousId) {
          return {
            ...previous,
            id: newId,
            title: updated.title,
            icon: updated.icon,
            tags: updated.tags,
            parentId: updated.parentId,
            updated: updated.updated,
            // v1.12: every page save answers with the page's properties.
            ...(updated.properties ? { properties: updated.properties } : {}),
          };
        }
        const id = remap(previous.id);
        return id === previous.id
          ? previous
          : { ...previous, id, parentId: previous.parentId === null ? null : remap(previous.parentId) };
      });

      const open = selectedRef.current;
      if (open !== null && newId !== previousId) {
        const openNext = remap(open);
        if (openNext !== open) {
          sessionKeys.current.set(openNext, sessionKeyOf(open));
          followedRename.current = openNext;
          navigate(openNext, true);
        }
      }
    },
    [navigate],
  );

  const handlePageSaved = useCallback(
    (updated: Page, savedId: PageId) => {
      applySavedPage(savedId, updated);
    },
    [applySavedPage],
  );

  const handleConflictReload = useCallback(() => {
    requestPageReload();
  }, [requestPageReload]);

  const handleConflictKeepMine = useCallback(() => {
    void documentControls()?.keepMine();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll the lightweight page index so external file changes appear without a
  // restart. Only reload the open page when it has no local unsaved edits.
  const refreshFromDisk = useCallback(async () => {
    const epoch = renameEpoch.current;
    const saves = saveEpoch.current;
    let list: PageMeta[] | null = null;
    try {
      list = await api.listPages();
    } catch {
      return;
    }
    if (epoch !== renameEpoch.current || renamesInFlight.current.size > 0) return;
    // A save landed while this list was on its way: it is older than what we
    // hold (#m6ppcam2). The next poll brings the current one.
    if (saves !== saveEpoch.current) return;
    setPages((previous) =>
      JSON.stringify(previous) === JSON.stringify(list) ? previous : (list as PageMeta[]),
    );

    const currentId = selectedRef.current;
    if (!currentId) return;
    const meta = list.find((item) => item.id === currentId);
    const loaded = pageRef.current;

    if (!meta) {
      if (loaded) {
        // An external rename keeps the title in frontmatter; follow it.
        const moved = list.find((item) => item.title === loaded.title);
        if (moved && !documentControls()?.isDirty()) {
          setDeletedOnDisk(null);
          navigate(moved.id, true);
          return;
        }
      }
      if (documentControls()?.isDirty()) {
        if (!isBoardId(currentId)) setDeletedOnDisk(loaded);
        return;
      }
      setPage(null);
      setPageStatus("error");
      return;
    }

    if (
      loaded &&
      loaded.id === currentId &&
      meta.updated !== loaded.updated &&
      // Only a newer version on disk is an outside change (with the epoch
      // check above, our own saves never trigger a reload).
      meta.updated > loaded.updated &&
      !documentControls()?.isDirty()
    ) {
      const active = document.activeElement;
      restoreSelection.current =
        active instanceof HTMLElement && active.closest('[data-testid="editor-content"]')
          ? (editorControls.current?.getSelection() ?? null)
          : null;
      requestPageReload();
    }
  }, [navigate, requestPageReload]);

  useEffect(() => {
    const timer = window.setInterval(() => void refreshFromDisk(), 2000);
    return () => window.clearInterval(timer);
  }, [refreshFromDisk]);

  // Initial load: the server seeds a fresh vault; open its Welcome page once.
  // Otherwise open the first root page.
  useEffect(() => {
    if (initialLoadStarted.current) return;
    initialLoadStarted.current = true;
    void (async () => {
      // On a cold dev start the API may still be booting behind the Vite proxy.
      // Retry briefly instead of leaving the app on an empty shell.
      let list = await loadPages();
      for (let attempt = 0; !list && attempt < 4; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
        list = await loadPages();
      }
      if (!list) return;

      // Consume even when a hash is present so it never leaks into a later load.
      const newVaultPage = consumeNewVaultPage();

      if (list.length === 0) return;
      if (
        selectedRef.current !== null ||
        isGraphHash(window.location.hash) ||
        trashRouteFromHash(window.location.hash) !== null
      ) {
        return;
      }

      const target = chooseLandingPage(list, newVaultPage);
      if (!target) return;
      // Only a page is prefetched: a board or a database view loads through
      // its own endpoint, and `GET /pages/<id>` would 404 (#39mbij4a).
      if (!isBoardId(target) && !isBaseId(target)) {
        const request = api.getPage(target);
        // A failure is handled where the request is used (the load effect).
        request.catch(() => undefined);
        landingPageRequest.current = { id: target, request };
      }
      focusBodyAfterOpen.current = target === newVaultPage;
      navigate(target, true);
    })();
  }, [loadPages, navigate]);

  useEffect(() => {
    const onHashChange = () => {
      setSelectedId(pageIdFromHash(window.location.hash));
      setGraphOpen(isGraphHash(window.location.hash));
      const trash = trashRouteFromHash(window.location.hash);
      setTrashRoute(trash);
      // Back/forward or a typed `#trash`: show the trash as it is now.
      if (trash && !trash.trashId) void loadTrash();
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [loadTrash]);

  // The trash count in the sidebar, and whether this is the desktop app.
  useEffect(() => {
    void loadTrash();
    api.health().then(
      (health) => setDesktop(health.desktop === true),
      () => undefined,
    );
  }, [loadTrash]);

  // Fetch the graph and dialog code in the background once startup is done.
  useEffect(() => preloadWhenIdle(), []);

  // Remember the local graph panel for the session (spec/ux §9).
  useEffect(() => {
    try {
      sessionStorage.setItem("gumply:local-graph", localGraphOpen ? "open" : "closed");
    } catch {
      // Session storage is optional.
    }
  }, [localGraphOpen]);

  useEffect(() => {
    if (selectedId) setLastPageId(selectedId);
  }, [selectedId]);

  // Load the selected page; ignore stale responses when the user clicks fast.
  useEffect(() => {
    if (followedRename.current !== null) {
      const followed = followedRename.current;
      followedRename.current = null;
      if (followed === selectedId && pageRef.current?.id === selectedId && pageReload === lastPageReload.current) {
        // Same page under its new id: it is still the loaded one.
        loadedSelection.current = selectedId;
        return;
      }
    }
    lastPageReload.current = pageReload;
    // Opening another page starts a new session: old rename keys must not make
    // a different page that reuses a freed id look like the same editor. A
    // reload of the same page keeps its key, or the "loading" render below
    // would remount the editor early and use up the caret to restore.
    if (selectedId !== loadedSelection.current) sessionKeys.current.clear();
    loadedSelection.current = selectedId;
    setSaveState("idle");

    if (!selectedId) {
      setPage(null);
      setPageStatus("idle");
      return;
    }
    // D33: a plain folder has no file to load; FolderView is built from the tree.
    if (pagesRef.current.some((item) => item.id === selectedId && item.kind === "folder")) {
      setPage(null);
      setPageStatus("idle");
      return;
    }

    let cancelled = false;
    setPageStatus("loading");

    if (isBaseId(selectedId)) {
      api
        .getBase(selectedId)
        .then((loaded) => {
          if (cancelled) return;
          if (loaded.meta.id !== selectedId) {
            navigate(loaded.meta.id, true);
            return;
          }
          setBaseDoc(loaded);
          setPage(boardAsPage(loaded.meta));
          setPageStatus("ready");
        })
        .catch(() => {
          if (cancelled) return;
          setPage(null);
          setBaseDoc(null);
          setPageStatus("error");
        });
      return () => {
        cancelled = true;
      };
    }

    if (isBoardId(selectedId)) {
      api
        .getBoard(selectedId)
        .then((loaded) => {
          if (cancelled) return;
          if (loaded.meta.id !== selectedId) {
            // D20: an old id resolves to the renamed board; follow it.
            navigate(loaded.meta.id, true);
            return;
          }
          setBoardDoc(loaded);
          setPage(boardAsPage(loaded.meta));
          setPageStatus("ready");
          // Reload / external change: remount the board on the fresh document.
          if (reloadEditorAfterFetch.current) {
            reloadEditorAfterFetch.current = false;
            setEditorRevision((value) => value + 1);
          }
        })
        .catch(() => {
          if (cancelled) return;
          setPage(null);
          setBoardDoc(null);
          setPageStatus("error");
        });
      return () => {
        cancelled = true;
      };
    }

    const landing = landingPageRequest.current;
    landingPageRequest.current = null;
    const request = landing?.id === selectedId ? landing.request : api.getPage(selectedId);
    request
      .then((loaded) => {
        if (cancelled) return;
        if (loaded.id !== selectedId) {
          // D20: an old id resolves to the renamed page; follow it.
          navigate(loaded.id, true);
          return;
        }
        setPage(loaded);
        setPageStatus("ready");
        // Remount the editor once fresh content has arrived (D12 link rewrite,
        // or a manual refresh) so TipTap doesn't keep stale text.
        if (reloadEditorAfterFetch.current) {
          reloadEditorAfterFetch.current = false;
          setEditorRevision((value) => value + 1);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setPage(null);
        setPageStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, [selectedId, pageReload, navigate]);

  // Reload, close and quit never lose the last edits (D14 §7, #3t6v62cb):
  // pending saves go out as keepalive requests; the browser only asks
  // "Leave site?" when they can't (too big, a conflict, a failed save).
  useEffect(() => installUnloadGuards(), []);

  // backlinks follow the open page and refresh after a successful save.
  useEffect(() => {
    if (!selectedId || pageStatus !== "ready") return;
    void loadBacklinks(selectedId);
  }, [selectedId, pageStatus, loadBacklinks]);

  useEffect(() => {
    if (saveState !== "saved" || !selectedId) return;
    void loadBacklinks(selectedId);
  }, [saveState, selectedId, loadBacklinks]);

  const handleOpen = useCallback(
    (id: PageId) => {
      setAutoFocusTitle(true);
      setPendingHeading(null);
      setDeletedOnDisk(null);
      if (window.innerWidth <= 900) setSidebarOpen(false);
      if (id === selectedRef.current) {
        // Re-clicking the open page refreshes it (e.g. links rewritten elsewhere).
        requestPageReload();
        return;
      }
      navigate(id);
    },
    [navigate, requestPageReload],
  );

  const handleCreate = useCallback(
    async (parentId: PageId | null) => {
      setActionError(null);
      setAutoFocusTitle(true);
      if (window.innerWidth <= 900) setSidebarOpen(false);
      try {
        const created = await api.createPage({ title: t("defaults.untitledPage"), parentId });
        await loadPages();
        navigate(created.id);
      } catch (error) {
        setActionError(errorMessage(error));
      }
    },
    [loadPages, navigate],
  );

  /**
   * spec/whiteboard §4: + → New whiteboard, ⋯ → Add whiteboard inside, Cmd+K.
   * New whiteboard and Add whiteboard inside open the template gallery first.
   */
  const handleCreateBoard = useCallback(
    async (parentId: PageId | null, title?: string, templateId: BoardTemplateId | null = null) => {
      setActionError(null);
      setAutoFocusTitle(true);
      if (window.innerWidth <= 900) setSidebarOpen(false);
      try {
        const created = await createBoardFile(parentId, title, templateId);
        await loadPages();
        setEditTitleId(created.meta.id);
        navigate(created.meta.id);
      } catch (error) {
        setActionError(errorMessage(error));
      }
    },
    [loadPages, navigate],
  );

  /** D34: "New database view": a table of the folder it's created in. */
  const handleCreateBase = useCallback(
    async (parentId: PageId | null, title?: string) => {
      setActionError(null);
      setAutoFocusTitle(true);
      if (window.innerWidth <= 900) setSidebarOpen(false);
      try {
        const created = await api.createBase({
          title: title ?? newBaseTitle(),
          parentId,
          ...(parentId ? { source: { folder: parentId } } : {}),
        });
        await loadPages();
        if (!title) setEditTitleId(created.meta.id);
        navigate(created.meta.id);
      } catch (error) {
        setActionError(errorMessage(error));
      }
    },
    [loadPages, navigate],
  );

  // D26: the desktop app's native menu (New page, New whiteboard, Search)
  // sends the same commands as the in-app buttons and shortcuts.
  useEffect(() => {
    const onCommand = (event: Event) => {
      const command = (event as CustomEvent<unknown>).detail;
      if (command === "new-page") void handleCreate(null);
      else if (command === "new-whiteboard") setGalleryParent({ parentId: null });
      else if (command === "search") openSearch();
    };
    window.addEventListener("gumply:command", onCommand);
    // Toasts from parts of the editor that don't see the app (#5dpxwac4).
    const onToast = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: unknown; icon?: unknown }>).detail;
      if (typeof detail?.message === "string") setToast({ message: detail.message, icon: detail.icon === "link" ? "link" : "info" });
    };
    window.addEventListener("gumply:toast", onToast);
    return () => {
      window.removeEventListener("gumply:command", onCommand);
      window.removeEventListener("gumply:toast", onToast);
    };
  }, [handleCreate, openSearch]);

  /**
   * ⋯ → Duplicate (#ux5cukze): "<Title> copy" next to the original (D20 name;
   * sub-pages aren't copied). A board copies its whole canvas. The copy opens
   * with its title selected, ready to rename.
   */
  const handleDuplicate = useCallback(
    async (id: PageId) => {
      const meta = pages.find((item) => item.id === id);
      if (!meta) return;
      setActionError(null);
      setAutoFocusTitle(true);
      const title = t("sidebar.copyTitle", { title: meta.title });
      try {
        // Unsaved edits in the open document go into the copy too.
        if (id === selectedRef.current) await documentControls()?.flush();
        let createdId: PageId;
        if (isBase(meta)) {
          const original = await api.getBase(id);
          const created = await api.createBase({ title, parentId: meta.parentId });
          await api.saveBase(created.meta.id, { config: original.config, expectedUpdated: created.meta.updated });
          createdId = created.meta.id;
        } else if (isBoard(meta)) {
          const original = await api.getBoard(id);
          const created = await api.createBoard({ title, parentId: meta.parentId, ...(meta.icon ? { icon: meta.icon } : {}) });
          // The server re-applies the copy's own title and icon on save.
          await api.saveBoard(created.meta.id, {
            board: original.board,
            expectedUpdated: created.meta.updated,
            ...(meta.icon ? { icon: meta.icon } : {}),
          });
          createdId = created.meta.id;
        } else {
          const original = await api.getPage(id);
          const created = await api.createPage({
            title,
            parentId: meta.parentId,
            content: original.content,
            ...(meta.icon ? { icon: meta.icon } : {}),
          });
          createdId = created.id;
        }
        await loadPages();
        setEditTitleId(createdId);
        navigate(createdId);
      } catch (error) {
        setActionError(errorMessage(error));
      }
    },
    [pages, loadPages, navigate],
  );

  // --- templates and daily notes (v0.7 C, #5hrsrqsj) ---

  useEffect(() => {
    api
      .dailySettings()
      .then(setDailySettings)
      .catch(() => undefined);
  }, []);

  /** Today in the sidebar, Cmd+K and Ctrl/Cmd+Shift+D: open (or make) today's note. */
  const openToday = useCallback(async () => {
    setActionError(null);
    if (window.innerWidth <= 900) setSidebarOpen(false);
    try {
      const result = await api.dailyNote(todayDay());
      if (result.created) await loadPages();
      navigate(result.page.id);
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }, [loadPages, navigate]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey || event.key.toLowerCase() !== "d") return;
      if (pendingDelete || movingId || shortcutsOpen || searchOpen || templatePicker) return;
      // Browsers use it for "bookmark all tabs": ours wins inside the app.
      event.preventDefault();
      void openToday();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openToday, pendingDelete, movingId, shortcutsOpen, searchOpen, templatePicker]);

  /** `/template` in the open page: pick, then fill (empty page) or insert at the caret. */
  const insertTemplate = useCallback((request: PageTemplateRequest) => {
    const open = pageRef.current;
    if (!open) return;
    setTemplatePicker({ mode: "insert", pageId: open.id, title: open.title, request });
  }, []);

  const pickTemplate = useCallback(
    async (template: PageMeta) => {
      const picker = templatePicker;
      setTemplatePicker(null);
      if (!picker) return;
      setActionError(null);
      try {
        if (picker.mode === "new") {
          // Named after the template; opens with the title selected to rename.
          const created = await api.createPage({ title: template.title, parentId: picker.parentId, template: template.id });
          await loadPages();
          setAutoFocusTitle(true);
          setEditTitleId(created.id);
          navigate(created.id);
          return;
        }
        if (picker.request.empty) {
          // Body and missing properties on the server, then show the result.
          await documentControls()?.flush();
          await api.applyTemplate(picker.pageId, template.id);
          requestPageReload();
          return;
        }
        const { content } = await api.renderTemplate(template.id, picker.title);
        picker.request.insert(content);
      } catch (error) {
        setActionError(errorMessage(error));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [templatePicker, loadPages, navigate, requestPageReload],
  );

  const dailyNav = useMemo(
    () => (dailySettings && page ? dailyNeighbours(documentPages, dailySettings, page.id) : null),
    [dailySettings, documentPages, page],
  );

  /** ⋯ → Copy link (#ux5cukze): `[[Title]]`, or `[[Map.canvas|Map]]` for a board. */
  const handleCopyLink = useCallback(
    async (id: PageId) => {
      const meta = pages.find((item) => item.id === id);
      if (!meta) return;
      // A board's link always names its file (`[[Map.canvas|Map]]`, v1.7).
      const link = formatWikilink(meta, documentPages);
      try {
        await navigator.clipboard.writeText(link);
        setToast({ message: t("sidebar.linkCopied"), icon: "link" });
      } catch {
        setActionError(t("sidebar.copyLinkBlocked"));
      }
    },
    [pages, documentPages],
  );

  /**
   * `/whiteboard`, a missing embed's Create, and `/template`: a board inside
   * the open page; the editor embeds it (D30). `/template` opens the gallery
   * first and resolves to null on Cancel (spec/v0-6 §D).
   */
  const createBoardForLink = useCallback(
    async (options: { title?: string; pickTemplate?: boolean } = {}): Promise<PageMeta | null> => {
      const parentId = selectedRef.current;
      let templateId: BoardTemplateId | null = null;
      if (options.pickTemplate) {
        const picked = await new Promise<BoardTemplateId | null | undefined>((resolve) =>
          setGalleryParent({ parentId, resolve }),
        );
        if (picked === undefined) return null;
        templateId = picked;
      }
      try {
        const created = await createBoardFile(parentId, options.title, templateId);
        await loadPages();
        return created.meta;
      } catch (error) {
        setActionError(errorMessage(error));
        return null;
      }
    },
    [loadPages],
  );

  /** `/database` (D34): a database view inside the open page, of that page's sub-pages. */
  const createBaseInPage = useCallback(async (): Promise<PageMeta | null> => {
    const parentId = selectedRef.current;
    try {
      const created = await api.createBase({
        title: newBaseTitle(),
        parentId,
        ...(parentId ? { source: { folder: parentId } } : {}),
      });
      await loadPages();
      return created.meta;
    } catch (error) {
      setActionError(errorMessage(error));
      return null;
    }
  }, [loadPages]);

  /** D13: open a result from the quick switcher. */
  const openSearchResult = useCallback(
    (id: PageId) => {
      dismissSearch();
      handleOpen(id);
    },
    [dismissSearch, handleOpen],
  );

  /** D13: `Create “X”` in the quick switcher — top level, like New page. */
  const createSearchPage = useCallback(
    (title: string) => {
      dismissSearch();
      setActionError(null);
      setAutoFocusTitle(true);
      void (async () => {
        try {
          const created = await api.createPage({ title });
          await loadPages();
          navigate(created.id);
        } catch (error) {
          setActionError(errorMessage(error));
        }
      })();
    },
    [dismissSearch, loadPages, navigate],
  );

  /** `Create whiteboard “X”` in the quick switcher. */
  const createSearchBoard = useCallback(
    (title: string) => {
      dismissSearch();
      void handleCreateBoard(null, title);
    },
    [dismissSearch, handleCreateBoard],
  );

  const handleGraphCreatePage = useCallback(
    async (title: string) => {
      setActionError(null);
      try {
        const created = await api.createPage({ title });
        await loadPages();
        navigate(created.id);
      } catch (error) {
        setActionError(errorMessage(error));
      }
    },
    [loadPages, navigate],
  );

  const openWikiLink = useCallback(
    async (link: { targetTitle: string; heading: string }) => {
      const resolved = resolveWikilink(link.targetTitle, documentPages);

      if (!resolved) {
        try {
          const created = await api.createPage({
            title: link.targetTitle,
            parentId: page?.parentId ?? null,
          });
          focusBodyAfterOpen.current = true;
          setPendingHeading(null);
          await loadPages();
          navigate(created.id);
        } catch (error) {
          setActionError(errorMessage(error));
        }
        return;
      }

      setPendingHeading(
        link.heading.length > 0 ? { pageId: resolved.id, heading: link.heading } : null,
      );
      if (resolved.id === selectedRef.current) requestPageReload();
      else navigate(resolved.id);
    },
    [documentPages, page, loadPages, navigate, requestPageReload],
  );

  /** `Create “X”` in the `[[` menu: create but stay on the current page. */
  const createLinkedPage = useCallback(
    (title: string) => {
      void (async () => {
        try {
          await api.createPage({ title, parentId: page?.parentId ?? null });
          await loadPages();
        } catch (error) {
          setActionError(errorMessage(error));
        }
      })();
    },
    [page, loadPages],
  );

  const handleHeadingResult = useCallback((found: boolean) => {
    setPendingHeading(null);
    if (!found) setToast({ message: t("page.headingNotFound"), icon: "info" });
  }, []);

  const handleRename = useCallback(
    async (id: PageId, title: string) => {
      setActionError(null);
      // Optimistic: show the new title right away. With D20 the rename also
      // moves the file, and a stale title in the header meanwhile would be
      // the base of the next edit (ArrowUp straight back into the title).
      const previousTitle = pages.find((item) => item.id === id)?.title ?? null;
      const showTitle = (value: string) => {
        setPages((list) => list.map((item) => (item.id === id ? { ...item, title: value } : item)));
        setPage((open) => (open && open.id === id ? { ...open, title: value } : open));
      };
      showTitle(title);
      try {
        // Flush body edits first: a pending autosave could otherwise overwrite
        // the server's link rewrite with stale `[[Old Title]]` text.
        if (id === selectedRef.current) await documentControls()?.flush();

        renamesInFlight.current.add(id);
        renameEpoch.current += 1;
        let updated: Page & { rewrittenPages?: PageId[] };
        try {
          if (isBoardId(id)) {
            // A board's title is its file name: the server renames the file.
            const result = await api.saveBoard(id, { title });
            updated = { ...boardAsPage(result.meta), rewrittenPages: result.rewrittenPages };
          } else if (isBaseId(id)) {
            // So is a database view's (D34).
            const result = await api.saveBase(id, { title, force: true });
            updated = { ...boardAsPage(result.meta), rewrittenPages: result.rewrittenPages };
            if (id === selectedRef.current) setBaseDoc({ meta: result.meta, config: result.config });
          } else {
            updated = await api.updatePage(id, { title });
          }
          applySavedPage(id, updated);
        } finally {
          renamesInFlight.current.delete(id);
          renameEpoch.current += 1;
        }

        // D12/D23: refetch the open page when the server rewrote it. Under a
        // renamed parent the open sub-page has a new id (D20) by now.
        const open = selectedRef.current;
        const openNow =
          open !== null && open.startsWith(`${id}/`)
            ? `${updated.id}${open.slice(id.length)}`
            : open;
        // The renamed page itself is the live editor: never reload it.
        if (open !== id && openPageNeedsReload(updated.rewrittenPages, openNow, updated.id)) {
          requestPageReload();
        }
      } catch (error) {
        if (previousTitle !== null) showTitle(previousTitle);
        setActionError(errorMessage(error));
        void loadPages();
      }
    },
    [applySavedPage, loadPages, pages, requestPageReload],
  );

  // v0.7 A (D34): properties are saved like any page edit: the editor's
  // pending text first, then a conditional PUT of just the property change.
  // One property save at a time: each sends the version the previous one made.
  const propertySaves = useRef<Promise<unknown>>(Promise.resolve());
  // A patch, or a function computing it when its turn comes (from the page as
  // it is then; null = nothing to save).
  type QueuedPatch = PropertiesPatch | (() => PropertiesPatch | null);
  const savePropertiesRef = useRef<(patch: QueuedPatch) => Promise<boolean>>(async () => false);
  const handlePropertiesChange = useCallback((patch: QueuedPatch): Promise<boolean> => {
    const run = () => savePropertiesRef.current(patch);
    const next = propertySaves.current.then(run, run);
    propertySaves.current = next;
    return next;
  }, []);
  savePropertiesRef.current = async (queued: QueuedPatch): Promise<boolean> => {
    {
      const id = selectedRef.current;
      if (!id || isBoardId(id)) return false;
      const patch = typeof queued === "function" ? queued() : queued;
      if (!patch) return true;
      setActionError(null);
      try {
        await editorControls.current?.flush();
        const current = pageRef.current;
        const updated = await api.updatePage(id, {
          properties: patch,
          ...(current?.id === id ? { expectedUpdated: current.updated } : {}),
        });
        applySavedPage(id, updated);
        // The next queued save reads the new version from here before React re-renders.
        pageRef.current =
          pageRef.current && pageRef.current.id === id
            ? { ...pageRef.current, updated: updated.updated, properties: updated.properties ?? pageRef.current.properties }
            : pageRef.current;
        return true;
      } catch (error) {
        setActionError(errorMessage(error));
        return false;
      }
    }
  };

  const handleSetPropertyType = useCallback(async (key: string, type: PropertyType) => {
    const id = selectedRef.current;
    setActionError(null);
    // The row switches to the new type's editor at once; the server confirms.
    setPage((previous) =>
      previous && previous.id === id && previous.properties
        ? { ...previous, properties: previous.properties.map((item) => (item.key === key ? { ...item, type } : item)) }
        : previous,
    );
    try {
      const before = pageRef.current?.properties?.find((item) => item.key === key);
      await api.setPropertyType(key, type);
      if (!id) return;
      // Types are vault-wide: refresh just this page's properties.
      const fresh = await api.getPage(id);
      setPage((previous) => (previous && previous.id === fresh.id ? { ...previous, properties: fresh.properties ?? [] } : previous));
      // This page's value follows when it converts cleanly ("2" → 2, a
      // single value → a list): only that line is written. Other pages keep
      // theirs, as in Obsidian; a value that doesn't convert shows a hint.
      // Decided when its turn in the save queue comes, from the value then:
      // a value typed meanwhile (already in the new shape) is never
      // overwritten by the old one converted.
      await handlePropertiesChange(() => {
        const now = (pageRef.current?.id === id ? pageRef.current?.properties : undefined)?.find((item) => item.key === key) ?? before;
        if (!now?.editable) return null;
        const converted = convertPropertyValue(type, now.value);
        return converted === undefined ? null : { set: { [key]: converted } };
      });
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }, [handlePropertiesChange]);

  const handleSetIcon = useCallback(async (icon: string | null) => {
    const id = selectedRef.current;
    if (!id) return;
    setActionError(null);
    try {
      // Also takes the new `updated`, so the next autosave isn't a 409.
      if (isBoardId(id)) applySavedPage(id, boardAsPage((await api.saveBoard(id, { icon })).meta));
      else applySavedPage(id, await api.updatePage(id, { icon }));
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }, [applySavedPage]);

  const performDelete = useCallback(
    async (id: PageId) => {
      setActionError(null);

      const wasBoard = isBoardId(id);
      const wasBase = isBaseId(id);
      try {
        const result = await api.deletePage(id);
        const nextId = focusAfterDelete(pages, id);
        const list = await loadPages();

        const current = selectedRef.current;
        if (current && isSelfOrDescendant(id, current)) {
          const fallback = list ? (buildPageTree(list)[0]?.page.id ?? null) : null;
          const target = nextId && list?.some((item) => item.id === nextId) ? nextId : fallback;
          setAutoFocusTitle(false);
          navigate(target, true);
        }

        moveFocus(nextId);
        void loadTrash();
        const trashId = result.trashId;
        setToast({
          message: wasBoard ? t("delete.boardDeleted") : wasBase ? t("bases.deleted") : t("delete.pageDeleted"),
          icon: "trash",
          undo: trashId
            ? async () => {
                try {
                  const restored = await api.restoreTrash(trashId);
                  await loadPages();
                  void loadTrash();
                  setAutoFocusTitle(true);
                  navigate(restored.id);
                } catch (error) {
                  setActionError(errorMessage(error));
                }
              }
            : undefined,
        });
      } catch (error) {
        setActionError(errorMessage(error));
      }
    },
    [pages, loadPages, loadTrash, navigate, moveFocus],
  );

  // --- trash (#ppag3ugh) ---
  const restoreFromTrash = useCallback(
    async (item: TrashItem, openId?: PageId) => {
      setActionError(null);
      try {
        const result = await api.restoreTrash(item.trashId);
        await loadPages();
        await loadTrash();
        setToast({ message: restoredMessage(item, result), icon: "info" });
        if (openId !== undefined) {
          setAutoFocusTitle(false);
          // A folder (D33) opens its first page until folders are tree items.
          const target =
            item.kind === "folder" && openId === item.id
              ? (result.restored.find((meta) => meta.parentId === result.id)?.id ?? result.restored[0]?.id ?? null)
              : restoredId(item, result, openId);
          if (target) navigate(target);
          else navigateTrash();
        }
      } catch (error) {
        setActionError(errorMessage(error));
        void loadTrash();
      }
    },
    [loadPages, loadTrash, navigate],
  );

  const confirmTrashAction = useCallback(async () => {
    const pending = trashConfirm;
    setTrashConfirm(null);
    if (!pending) return;
    setActionError(null);
    try {
      if (pending.kind === "forever") {
        await api.deleteTrashed(pending.item.trashId);
        setToast({ message: t("trash.deletedForever", { title: pending.item.title }), icon: "trash" });
        // A trashed page that is gone now: back to the list.
        if (trashRoute?.trashId === pending.item.trashId) navigateTrash();
      } else {
        const { deleted } = await api.emptyTrash();
        setToast({ message: t("trash.deletedItemsForever", { count: deleted }), icon: "trash" });
      }
    } catch (error) {
      setActionError(errorMessage(error));
    }
    await loadTrash();
  }, [trashConfirm, trashRoute, navigateTrash, loadTrash]);

  const requestDelete = useCallback(
    (id: PageId) => {
      const target = pages.find((item) => item.id === id);
      if (!target) return;
      // D33: a folder asks first when it holds anything (pages, boards or
      // other files, at any depth); an empty one goes straight to the trash.
      if (target.kind === "folder") {
        const contents = folderContents(pages, id);
        if (contents.pages + contents.boards + contents.otherFiles > 0) {
          setPendingDelete({ page: target, subPages: 0, body: folderDeleteBody(contents) });
          return;
        }
      } else if (target.childCount > 0) {
        setPendingDelete({ page: target, subPages: target.childCount });
        return;
      }
      void performDelete(id);
    },
    [pages, performDelete],
  );

  const cancelDelete = useCallback(() => {
    const pending = pendingDelete;
    setPendingDelete(null);
    if (pending) moveFocus(pending.page.id);
  }, [pendingDelete, moveFocus]);

  const confirmDelete = useCallback(() => {
    const pending = pendingDelete;
    if (!pending) return;
    setPendingDelete(null);
    void performDelete(pending.page.id);
  }, [pendingDelete, performDelete]);

  /** Focus a page row if it is still rendered (after a move). */
  const focusPageRow = useCallback((id: PageId) => {
    window.requestAnimationFrame(() => {
      for (const item of document.querySelectorAll<HTMLElement>("[data-page-id]")) {
        if (item.dataset.pageId === id) {
          item.focus();
          return;
        }
      }
    });
  }, []);

  /** Moves change path-based ids; keep the open page (or a moved ancestor) open. */
  const followMovedPage = useCallback(
    (oldId: PageId, newId: PageId) => {
      const current = selectedRef.current;
      if (current === null) return;
      if (current !== oldId && !current.startsWith(`${oldId}/`)) return;
      navigate(`${newId}${current.slice(oldId.length)}`, true);
    },
    [navigate],
  );

  /** #9bx3aznb: rename a tag in every page and board, after the open editor has saved. */
  const handleRenameTag = useCallback(
    async (from: string, to: string) => {
      setTagRename(null);
      setActionError(null);
      // The open editor saves first. If it still can't (e.g. a conflict),
      // its file is skipped and reported, never overwritten.
      const saved = await flushAllSaves();
      const open = selectedRef.current;
      try {
        const result = await api.renameTag(from, to, !saved && open !== null ? [open] : []);
        await loadPages();
        if (open !== null && result.rewrittenPages.includes(open)) requestPageReload();
        const skipped = result.skippedPages.length;
        setToast({
          message: [
            t("tags.renamed", { from, to, count: result.renamed }),
            ...(skipped > 0 ? [t("tags.skipped", { count: skipped })] : []),
          ].join(". "),
          icon: "info",
        });
      } catch (error) {
        setActionError(errorMessage(error));
        void loadPages();
      }
    },
    [loadPages, requestPageReload],
  );

  const handleMove = useCallback(
    async (id: PageId, parentId: PageId | null, focusAfter = false) => {
      setActionError(null);
      // A move changes path-based ids; flush pending edits against the old id
      // first so a late autosave cannot 404 after the page has moved.
      const open = selectedRef.current;
      if (open === id || (open !== null && open.startsWith(`${id}/`))) {
        await documentControls()?.flush();
      }
      const previousParent = pages.find((page) => page.id === id)?.parentId ?? null;
      try {
        const moved = await api.movePage(id, parentId);
        await loadPages();
        followMovedPage(id, moved.id);
        if (focusAfter) focusPageRow(moved.id);
        // Dropping onto the current parent is a no-op: don't claim it moved.
        if (moved.id !== id) {
          setToast({
            message: moveToastMessage(pages, parentId),
            icon: "move",
            undo: async () => {
              try {
                const restored = await api.movePage(moved.id, previousParent);
                await loadPages();
                followMovedPage(moved.id, restored.id);
              } catch (error) {
                setActionError(errorMessage(error));
                void loadPages();
              }
            },
          });
        }
      } catch (error) {
        setActionError(errorMessage(error));
        void loadPages();
      }
    },
    [pages, loadPages, followMovedPage, focusPageRow],
  );

  const startMove = useCallback((id: PageId) => setMovingId(id), []);

  const cancelMove = useCallback(() => {
    const id = movingId;
    setMovingId(null);
    if (id) focusPageRow(id);
  }, [movingId, focusPageRow]);

  const chooseMoveTarget = useCallback(
    (parentId: PageId | null) => {
      const id = movingId;
      setMovingId(null);
      if (id) void handleMove(id, parentId, true);
    },
    [movingId, handleMove],
  );

  const handleRetry = useCallback(() => {
    void (async () => {
      const list = await loadPages();
      if (!list || list.length === 0) return;
      if (selectedRef.current === null) {
        const first = buildPageTree(list)[0]?.page.id ?? null;
        if (first) navigate(first, true);
      }
    })();
  }, [loadPages, navigate]);

  const handleOpenLink = useCallback(
    (link: { targetTitle: string; heading: string }) => {
      void openWikiLink(link);
    },
    [openWikiLink],
  );

  const handleEditorReady = useCallback((controls: EditorControls) => {
    editorControls.current = controls;
    if (focusBodyAfterOpen.current) {
      focusBodyAfterOpen.current = false;
      controls.focusBody();
    } else if (restoreSelection.current) {
      const position = restoreSelection.current.to;
      restoreSelection.current = null;
      controls.focusAt(position);
    }
  }, []);

  const handleStartBody = useCallback(() => {
    const controls = editorControls.current;
    // The editor of a just-opened page may not be ready yet: focus on ready.
    if (!controls || controls.pageId !== selectedRef.current) {
      focusBodyAfterOpen.current = true;
      return;
    }
    controls.focusBody();
  }, []);

  // ArrowUp / Backspace at the top of the body moves to the title (#d636gdxx).
  const [titleFocusSignal, setTitleFocusSignal] = useState(0);
  // Synchronous on purpose (with PageHeader's layout effect): keys typed right
  // after ArrowUp must reach the title, not the body (#d636gdxx follow-up).
  const handleExitTop = useCallback(
    () => flushSync(() => setTitleFocusSignal((value) => value + 1)),
    [],
  );

  const handleRetrySave = useCallback(() => {
    void documentControls()?.flush();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** A board card's target: a page or board opens here, other files in a tab. */
  const openVaultPath = useCallback(
    (path: string) => {
      const id = idFromVaultPath(path);
      if (id === null) {
        window.open(fileUrl(path), "_blank", "noopener,noreferrer");
        return;
      }
      if (pages.some((item) => item.id === id)) handleOpen(id);
      else setToast({ message: t("page.noLongerExists"), icon: "info" });
    },
    [pages, handleOpen],
  );

  const handleBoardSaved = useCallback(
    (meta: PageMeta, savedId: PageId) => applySavedPage(savedId, boardAsPage(meta)),
    [applySavedPage],
  );

  const editTitleRef = useRef(editTitleId);
  editTitleRef.current = editTitleId;
  const handleBoardReady = useCallback((controls: BoardViewControls) => {
    boardControls.current = controls;
    // An existing board: put focus on the canvas so its shortcuts (N, V,
    // Delete…) work right away instead of landing in the title or the tree.
    if (editTitleRef.current !== null && editTitleRef.current === selectedRef.current) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest('[data-testid^="page-rename-input-"]')) return;
    document.querySelector<HTMLElement>('[data-testid="board"]')?.focus({ preventScroll: true });
  }, []);

  // "New" lasts only while that board stays open.
  useEffect(() => {
    if (editTitleId !== null && selectedId !== editTitleId) setEditTitleId(null);
  }, [selectedId, editTitleId]);

  const boardPageOptions = useMemo(
    () =>
      documentPages
        .filter((item) => item.id !== selectedId)
        .map((item) => ({
          path: vaultPathOf(item),
          title: item.title,
          // Live page cards reload their preview when this moves (W2b).
          updated: item.updated,
          ...(item.icon ? { icon: item.icon } : {}),
        })),
    [documentPages, selectedId],
  );

  const restoreDeletedPage = useCallback(async () => {
    const loaded = deletedOnDisk ?? pageRef.current;
    if (!loaded) return;
    const controls = editorControls.current;
    const content = controls?.getMarkdown() ?? loaded.content;
    // Where the caret was before the click moved focus to the banner button.
    const selection = controls?.getSelection() ?? null;
    try {
      const created = await api.createPage({
        title: loaded.title,
        parentId: loaded.parentId,
        content,
        icon: loaded.icon,
      });
      // The editor already shows this text: keep it mounted. Point it at the
      // new file (version, and id if the old one was taken meanwhile) instead
      // of reloading, so nothing typed is lost and the next save isn't a 409.
      applySavedPage(loaded.id, created);
      if (controls && controls.pageId === loaded.id) {
        await controls.adoptRecreatedFile(created.id, created.updated);
      }
      setDeletedOnDisk(null);
      setActionError(null);
      void loadPages();
      // The Restore button is gone with the banner; put focus back where the
      // user was typing.
      const now = editorControls.current;
      if (now && selection) now.focusAt(selection.to);
      else now?.focusBody();
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }, [deletedOnDisk, loadPages, applySavedPage]);

  const handleConflictBackup = useCallback((path: string) => {
    setToast({ message: t("page.conflictKept", { path }), icon: "info" });
  }, []);

  const dismissToast = useCallback(() => setToast(null), []);

  const goToWelcome = useCallback(() => {
    const welcome = pages.find((item) => item.title.trim().toLowerCase() === "welcome");
    if (welcome) navigate(welcome.id);
    else navigate(null);
  }, [pages, navigate]);

  const showingPage = selectedId !== null && page !== null && page.id === selectedId;
  const showingBoard = showingPage && isBoardId(page.id) && boardDoc !== null;
  const showingBase = showingPage && isBaseId(page.id) && baseDoc !== null && baseDoc.meta.id === page.id;
  const movingPage = movingId ? (pages.find((item) => item.id === movingId) ?? null) : null;
  // v0.7 F (#385sexd6): cover and background, Markdown pages only.
  const showingNote = showingPage && !isBoardId(page.id) && !isBaseId(page.id);
  const look = useMemo(() => pageLook(showingNote ? page?.properties : undefined), [showingNote, page?.properties]);

  const serverError = listStatus === "error" && pages.length === 0;
  const breadcrumb = selectedId ? pageTrail(pages, selectedId) : [];

  // G1: Cmd+K → Export page as HTML, for the open page (not a board or a database view).
  const openPageMeta =
    page && page.id === selectedId ? (pages.find((item) => item.id === page.id && (item.kind ?? "page") === "page") ?? null) : null;

  return (
    <div className={`app${sidebarOpen ? "" : " sidebar-collapsed"}`}>
      <header className="topbar">
        <button
          type="button"
          className="icon-button sidebar-toggle"
          data-testid="sidebar-toggle"
          data-tooltip={sidebarOpen ? t("sidebar.hide") : t("sidebar.show")}
          aria-label={sidebarOpen ? t("sidebar.hide") : t("sidebar.show")}
          aria-pressed={sidebarOpen}
          onClick={() => setSidebarOpen((open) => !open)}
        >
          <Icon name="sidebar" size={17} />
        </button>
        <span className="logo" aria-hidden="true">
          <Icon name="brand" size={18} />
        </span>
        <h1 className="app-name">Gumply</h1>
        {breadcrumb.length > 0 ? (
          <nav className="breadcrumb" aria-label={t("page.path")}>
            {breadcrumb.map((item, index) => (
              <span className="breadcrumb-item" key={item.id}>
                {index > 0 ? (
                  <span className="breadcrumb-sep" aria-hidden="true">
                    ›
                  </span>
                ) : null}
                <button
                  type="button"
                  className={`breadcrumb-crumb${index === breadcrumb.length - 1 ? " is-current" : ""}`}
                  aria-current={index === breadcrumb.length - 1 ? "page" : undefined}
                  onClick={() => handleOpen(item.id)}
                >
                  {item.icon ? <span className="breadcrumb-icon">{item.icon}</span> : null}
                  <span className="breadcrumb-text">{item.title}</span>
                </button>
              </span>
            ))}
          </nav>
        ) : null}
        <span className="topbar-spacer" />
        <SaveStatus
          state={saveState}
          onRetry={handleRetrySave}
          onReload={handleConflictReload}
          onKeepMine={handleConflictKeepMine}
        />
        <ThemeToggle />
        <SettingsMenu open={settingsOpen} onOpenChange={setSettingsOpen} />
        <button
          type="button"
          className="icon-button"
          data-testid="shortcuts-button"
          data-tooltip={t("shortcuts.button")}
          aria-label={t("shortcuts.button")}
          onClick={() => setShortcutsOpen(true)}
        >
          <Icon name="keyboard" size={16} />
        </button>
      </header>

      <div
        className={`layout${!graphOpen && showingPage && localGraphOpen ? " layout-with-panel" : ""}`}
      >
        <Sidebar
          onCreateBoard={closingSidebar((parentId: PageId | null) => setGalleryParent({ parentId }))}
          onCreateBase={(parentId) => void handleCreateBase(parentId)}
          pages={pages}
          selectedId={selectedId}
          status={listStatus}
          error={listError}
          focusTarget={focusTarget}
          graphActive={graphOpen}
          trashActive={trashRoute !== null}
          trashCount={trashItems ? trashedCount(trashItems) : 0}
          onTrash={closingSidebar(() => navigateTrash())}
          onOpen={handleOpen}
          onCreate={(parentId) => void handleCreate(parentId)}
          onRename={handleRename}
          onDelete={requestDelete}
          onMove={(id, parentId) => void handleMove(id, parentId)}
          onStartMove={startMove}
          onDuplicate={(id) => void handleDuplicate(id)}
          onCopyLink={(id) => void handleCopyLink(id)}
          onRetry={handleRetry}
          onSearch={closingSidebar(() => openSearch())}
          onGraph={closingSidebar(navigateGraph)}
          onOpenTag={closingSidebar(openTagSearch)}
          onRenameTag={setTagRename}
          onToday={() => void openToday()}
          onNewFromTemplate={closingSidebar((parentId: PageId | null) => setTemplatePicker({ mode: "new", parentId }))}
          onExportHtml={closingSidebar((id: PageId) => setExportTarget(pages.find((item) => item.id === id) ?? null))}
        />
        {/* Narrow windows: the sidebar is an overlay; tapping the page closes it. */}
        <div
          className="sidebar-scrim"
          data-testid="sidebar-scrim"
          aria-hidden="true"
          onClick={() => setSidebarOpen(false)}
        />

        <main className={`content${look.background ? " has-page-tint" : ""}`} style={backgroundStyle(look)}>
          {deletedOnDisk ? (
            <div className="banner banner-error" role="alert" data-testid="deleted-on-disk-banner">
              <span>{t("page.deletedOnDisk")}</span>
              <button type="button" className="link-button" onClick={() => void restoreDeletedPage()}>
                {t("page.restore")}
              </button>
              <button
                type="button"
                className="banner-close"
                aria-label={t("common.dismiss")}
                onClick={() => setDeletedOnDisk(null)}
              >
                ×
              </button>
            </div>
          ) : actionError ? (
            <div className="banner banner-error" role="alert">
              <span>{actionError}</span>
              <button type="button" className="banner-close" aria-label={t("common.dismiss")} onClick={() => setActionError(null)}>
                ×
              </button>
            </div>
          ) : null}

          {trashRoute?.trashId ? (
            <TrashedPageView
              trashId={trashRoute.trashId}
              id={trashRoute.id}
              pages={pages}
              desktop={desktop}
              onRestore={(item, openId) => void restoreFromTrash(item, openId)}
              onDeleteForever={(item) => setTrashConfirm({ kind: "forever", item })}
              onOpenTrash={() => navigateTrash()}
              onOpenChild={(item, id) => navigateTrash(item.trashId, id)}
              onOpenLink={handleOpenLink}
            />
          ) : trashRoute ? (
            <div className="editor-pane">
              <TrashView
                items={trashItems}
                error={trashError}
                desktop={desktop}
                onOpen={(item, id) => navigateTrash(item.trashId, id ?? null)}
                onRestore={(item) => void restoreFromTrash(item)}
                onDeleteForever={(item) => setTrashConfirm({ kind: "forever", item })}
                onEmpty={() => trashItems && setTrashConfirm({ kind: "empty", items: trashItems })}
                onRetry={() => void loadTrash()}
              />
            </div>
          ) : graphOpen ? (
            <GraphView
              highlightId={lastPageId}
              onOpenPage={handleOpen}
              onCreatePage={handleGraphCreatePage}
              onNewPage={() => void handleCreate(null)}
            />
          ) : (
            <div
              className={`editor-pane${showingBoard ? " is-board" : showingBase ? " is-base" : ""}${showingNote && look.cover ? " has-cover" : ""}`}
              data-testid="editor"
            >
              {serverError ? (
                <div className="empty-state" data-testid="server-error">
                  <span className="empty-state-icon" aria-hidden="true">
                    <Icon name="monitor" size={26} />
                  </span>
                  <h2>{serverDownMessage()}</h2>
                  <p>{t("errors.serverDownHint")}</p>
                  <button type="button" className="button-primary" onClick={handleRetry}>
                    {t("common.retry")}
                  </button>
                  <p className="empty-hint">
                    {t("errors.runDevBefore")}<code>npm run dev</code>{t("errors.runDevAfter")}
                  </p>
                </div>
              ) : selectedId === null ? (
                <div className="empty-state" data-testid="empty-state">
                  <span className="empty-state-icon" aria-hidden="true">
                    <Icon name={documentPages.length === 0 ? "file" : "search"} size={26} />
                  </span>
                  <h2>{documentPages.length === 0 ? t("empty.noPages") : t("empty.noSelection")}</h2>
                  <p>
                    {documentPages.length === 0
                      ? t("empty.noPagesHint")
                      : t("empty.noSelectionHint")}
                  </p>
                  <button
                    type="button"
                    className="button-primary"
                    data-testid="empty-new-page"
                    onClick={() => void handleCreate(null)}
                  >
                    {t("sidebar.newPage")}
                  </button>
                </div>
              ) : selectedFolder ? (
                <FolderView
                  folder={selectedFolder}
                  pages={pages}
                  onOpen={handleOpen}
                  onNewPage={(parentId) => void handleCreate(parentId)}
                  onNewBoard={(parentId) => void handleCreateBoard(parentId)}
                />
              ) : showingBase && baseDoc ? (
                <div className="base-page" data-testid="base-page">
                  <PageHeader
                    page={page}
                    autoFocusTitle={autoFocusTitle}
                    onRename={(title) => handleRename(page.id, title)}
                    onDelete={() => requestDelete(page.id)}
                    onStartBody={() => document.querySelector<HTMLElement>('[data-testid="base-view"] button')?.focus()}
                    editTitleOnOpen={editTitleId === page.id}
                    focusTitleSignal={titleFocusSignal}
                    sessionKey={sessionKeyOf(page.id)}
                  />
                  <BaseView
                    key={`${sessionKeyOf(page.id)}:${editorRevision}`}
                    baseId={page.id}
                    initial={baseDoc}
                    pages={pages}
                    refreshKey={pagesStamp}
                    onOpen={handleOpen}
                    onError={setActionError}
                    onSaved={(meta) => setPage((current) => (current && current.id === meta.id ? { ...current, updated: meta.updated } : current))}
                  />
                </div>
              ) : showingBoard && boardDoc ? (
                <div className="board-page" data-testid="board-page">
                  <PageHeader
                    page={page}
                    autoFocusTitle={autoFocusTitle}
                    localGraphOpen={localGraphOpen}
                    onToggleLocalGraph={() => setLocalGraphOpen((value) => !value)}
                    onRename={(title) => handleRename(page.id, title)}
                    onSetIcon={handleSetIcon}
                    onDelete={() => requestDelete(page.id)}
                    onStartBody={() => document.querySelector<HTMLElement>('[data-testid="board"]')?.focus()}
                    editTitleOnOpen={editTitleId === page.id}
                    focusTitleSignal={titleFocusSignal}
                    sessionKey={sessionKeyOf(page.id)}
                  />
                  <div className="board-page-canvas">
                    <BoardView
                      key={`${sessionKeyOf(page.id)}:${editorRevision}`}
                      boardId={page.id}
                      updated={page.updated}
                      initial={boardDoc}
                      pages={boardPageOptions}
                      onSaveState={setSaveState}
                      onSaved={handleBoardSaved}
                      onConflictBackup={handleConflictBackup}
                      onOpenFile={openVaultPath}
                      onReady={handleBoardReady}
                    />
                  </div>
                </div>
              ) : showingPage ? (
                <>
                  <PageCover
                    key={sessionKeyOf(page.id)}
                    look={look}
                    pageId={page.id}
                    fileLinks={page.fileLinks}
                    pickerSignal={coverPickerSignal}
                    onChange={handlePropertiesChange}
                  />
                  <PageHeader
                    page={page}
                    fallbackIcon={look.bannerIcon}
                    onAddCover={look.cover ? undefined : () => setCoverPickerSignal((value) => value + 1)}
                    background={look.background}
                    onSetBackground={(color) =>
                      void handlePropertiesChange(color ? { set: { background: color } } : { remove: ["background"] })
                    }
                    autoFocusTitle={autoFocusTitle}
                    localGraphOpen={localGraphOpen}
                    onToggleLocalGraph={() => setLocalGraphOpen((value) => !value)}
                    onRename={(title) => handleRename(page.id, title)}
                    onSetIcon={handleSetIcon}
                    onDelete={() => requestDelete(page.id)}
                    onStartBody={handleStartBody}
                    // A duplicate opens with its title selected (#ux5cukze).
                    editTitleOnOpen={editTitleId === page.id ? true : undefined}
                    focusTitleSignal={titleFocusSignal}
                    sessionKey={sessionKeyOf(page.id)}
                    daily={
                      dailyNav
                        ? { previous: dailyNav.previous, next: dailyNav.next, onOpen: handleOpen }
                        : undefined
                    }
                  />
                  <PropertiesBlock
                    properties={page.properties ?? []}
                    onChange={handlePropertiesChange}
                    onSetType={handleSetPropertyType}
                  />
                  <Editor
                    key={`${sessionKeyOf(page.id)}:${editorRevision}`}
                    page={page}
                    pages={documentPages}
                    onSaveState={setSaveState}
                    onSaved={handlePageSaved}
                    onConflictBackup={handleConflictBackup}
                    onReady={handleEditorReady}
                    onOpenLink={handleOpenLink}
                    onCreateLink={createLinkedPage}
                    headingToReveal={
                      pendingHeading && pendingHeading.pageId === page.id
                        ? pendingHeading.heading
                        : null
                    }
                    onHeadingResult={handleHeadingResult}
                    onAttachmentError={setActionError}
                    onExitTop={handleExitTop}
                    onCreateBoard={createBoardForLink}
                    onCreateBase={createBaseInPage}
                    onOpenTag={openTagSearch}
                    onInsertTemplate={insertTemplate}
                  />
                  <BacklinksPanel
                    items={backlinks}
                    loading={backlinksLoading}
                    onOpen={handleOpen}
                  />
                </>
              ) : pageStatus === "error" ? (
                <div className="empty-state" data-testid="page-not-found">
                  <span className="empty-state-icon" aria-hidden="true">
                    <Icon name="file" size={26} />
                  </span>
                  <h2>{t("page.notFound")}</h2>
                  <p>{t("page.notFoundHint")}</p>
                  <div className="empty-actions">
                    <button type="button" className="button-secondary" onClick={goToWelcome}>
                      {t("page.goToWelcome")}
                    </button>
                    <button
                      type="button"
                      className="button-primary"
                      onClick={() => void handleCreate(null)}
                    >
                      {t("page.create")}
                    </button>
                  </div>
                </div>
              ) : (
                <p className="editor-note">{t("page.loading")}</p>
              )}
            </div>
          )}
        </main>

        {!graphOpen && showingPage && localGraphOpen ? (
          <LocalGraphPanel
            pageId={page.id}
            onOpenPage={handleOpen}
            onCreatePage={handleGraphCreatePage}
            onClose={() => setLocalGraphOpen(false)}
          />
        ) : null}
      </div>

      {pendingDelete ? (
        <DeleteDialog
          title={pendingDelete.page.title}
          subPages={pendingDelete.subPages}
          body={pendingDelete.body}
          onCancel={cancelDelete}
          onConfirm={confirmDelete}
        />
      ) : null}

      {tagRename !== null ? (
        <TagRenameDialog
          {...tagRename}
          onCancel={() => setTagRename(null)}
          onRename={(to) => void handleRenameTag(tagRename.tag, to)}
        />
      ) : null}
      {trashConfirm ? (
        <ConfirmDialog
          heading={
            trashConfirm.kind === "forever" ? <>{t("trash.confirmForever", { title: trashConfirm.item.title })}</> : <>{t("trash.confirmEmpty")}</>
          }
          body={trashConfirm.kind === "forever" ? deleteForeverBody(trashConfirm.item) : emptyTrashBody(trashConfirm.items)}
          confirmLabel={trashConfirm.kind === "forever" ? t("trash.deleteForever") : t("trash.empty")}
          testId="trash-confirm-dialog"
          onCancel={() => setTrashConfirm(null)}
          onConfirm={() => void confirmTrashAction()}
        />
      ) : null}

      {templatePicker ? (
        <TemplatePicker
          mode={templatePicker.mode}
          onCancel={() => setTemplatePicker(null)}
          onPick={(template) => void pickTemplate(template)}
        />
      ) : null}

      {galleryParent ? (
        <TemplateGallery
          onCancel={() => {
            setGalleryParent(null);
            galleryParent.resolve?.(undefined);
          }}
          onSelect={(templateId) => {
            setGalleryParent(null);
            if (galleryParent.resolve) galleryParent.resolve(templateId);
            else void handleCreateBoard(galleryParent.parentId, undefined, templateId);
          }}
        />
      ) : null}

      {movingPage ? (
        <MoveDialog
          page={movingPage}
          pages={pages}
          onCancel={cancelMove}
          onSelect={chooseMoveTarget}
        />
      ) : null}

      {toast ? (
        <UndoToast
          // A new toast starts its own timer (one replacing another mustn't
          // inherit what was left of the first one's 8 s).
          key={toastKey(toast)}
          message={toast.message}
          icon={toast.icon}
          onUndo={toast.undo ? () => void toast.undo?.() : undefined}
          onDismiss={dismissToast}
        />
      ) : null}

      {searchOpen ? (
        <QuickSwitcher
          pages={documentPages}
          initialQuery={searchQuery}
          onOpen={openSearchResult}
          onCreate={createSearchPage}
          onCreateBoard={createSearchBoard}
          onCreateBase={(title) => {
            dismissSearch();
            void handleCreateBase(null, title);
          }}
          onNewFromTemplate={() => {
            dismissSearch();
            setGalleryParent({ parentId: null });
          }}
          onOpenLanguage={() => {
            dismissSearch();
            setSettingsOpen(true);
          }}
          onOpenToday={() => {
            dismissSearch();
            void openToday();
          }}
          onNewPageFromTemplate={() => {
            dismissSearch();
            setTemplatePicker({ mode: "new", parentId: null });
          }}
          onExportHtml={
            openPageMeta
              ? () => {
                  dismissSearch();
                  setExportTarget(openPageMeta);
                }
              : undefined
          }
          onClose={closeSearch}
        />
      ) : null}

      {exportTarget ? (
        <ExportDialog
          title={exportTarget.title}
          onClose={() => setExportTarget(null)}
          onExport={async (options) => {
            const target = exportTarget;
            try {
              // Loaded on first use: the builder brings the highlighter and the export stylesheet.
              const { exportPageAsHtml } = await import("./export/run-export.js");
              const name = await exportPageAsHtml(target.id, documentPages, options);
              setToast({ message: t("export.done", { name }), icon: "info" });
            } catch (error) {
              setActionError(t("export.failed", { error: errorMessage(error) }));
            }
            setExportTarget(null);
          }}
        />
      ) : null}

      {shortcutsOpen ? <ShortcutsDialog onClose={() => setShortcutsOpen(false)} /> : null}
    </div>
  );
}
