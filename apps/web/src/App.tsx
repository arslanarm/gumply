import { flushSync } from "react-dom";
import {
  formatWikilink,
  resolveWikilink,
  type Backlink,
  type BoardDocument,
  type Page,
  type PageId,
  type PageMeta,
} from "@gumply/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, consumeNewVaultPage, fileUrl } from "./api/client.js";
// Only the board's shell: the editor (React Flow) is code-split inside it.
import { BoardView, type BoardViewControls } from "./board/BoardView.js";
import { BacklinksPanel } from "./components/BacklinksPanel.js";
import { DeleteDialog } from "./components/DeleteDialog.js";
import { Editor, type EditorControls } from "./components/Editor.js";
import { PageHeader } from "./components/PageHeader.js";
import { Icon, type IconName } from "./components/Icon.js";
import { QuickSwitcher } from "./components/QuickSwitcher.js";
import { SaveStatus } from "./components/SaveStatus.js";
import { Sidebar, type SidebarFocusTarget } from "./components/Sidebar.js";
import { ThemeToggle } from "./components/ThemeToggle.js";
import { UndoToast } from "./components/UndoToast.js";
import type { SaveState } from "./editor/autosave.js";
// Graph and dialogs load on demand (#evh35bn7).
import { GraphView, LocalGraphPanel, MoveDialog, ShortcutsDialog, TemplateGallery, preloadWhenIdle } from "./lazy-parts.js";
import type { BoardTemplateId } from "./board/templates.js";
import { idFromVaultPath, isBoard, isBoardId, NEW_BOARD_TITLE, vaultPathOf } from "./lib/boards.js";
import { focusAfterDelete } from "./lib/delete.js";
import { chooseLandingPage } from "./lib/first-run.js";
import { errorMessage, SERVER_DOWN_MESSAGE } from "./lib/errors.js";
import { moveToastMessage } from "./lib/move.js";
import { openPageNeedsReload } from "./lib/rename.js";
import { GRAPH_HASH, isGraphHash, pageHash, pageIdFromHash } from "./lib/routing.js";
import { installUnloadGuards } from "./lib/pending-saves.js";
import { isTypingTarget } from "./lib/shortcuts.js";
import { windowTitle } from "./lib/title.js";
import { buildPageTree, isSelfOrDescendant, pageTrail } from "./lib/tree.js";

type ListStatus = "loading" | "ready" | "error";
type PageStatus = "idle" | "loading" | "ready" | "error";

interface PendingDelete {
  page: PageMeta;
  subPages: number;
}

interface ToastState {
  message: string;
  /** What happened: deleting shows a bin, moving an arrow, notices an "i". */
  icon?: IconName;
  undo?: () => Promise<void>;
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
  title: string,
  templateId: BoardTemplateId | null,
): Promise<{ meta: PageMeta }> {
  // Templates load with the gallery's chunk, never with the app.
  const template = templateId ? (await import("./board/templates.js")).boardTemplate(templateId) : undefined;
  const created = await api.createBoard({ title: template && title === NEW_BOARD_TITLE ? template.name : title, parentId });
  if (!template) return created;
  const saved = await api.saveBoard(created.meta.id, {
    board: { ...template.build(), ...(created.board.gumply ? { gumply: created.board.gumply } : {}) },
    expectedUpdated: created.meta.updated,
  });
  return { meta: saved.meta };
}

export function App() {
  const [pages, setPages] = useState<PageMeta[]>([]);
  const [listStatus, setListStatus] = useState<ListStatus>("loading");
  const [listError, setListError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<PageId | null>(() =>
    pageIdFromHash(window.location.hash),
  );
  const [page, setPage] = useState<Page | null>(null);
  // The open board's document as loaded (BoardView starts from it).
  const [boardDoc, setBoardDoc] = useState<BoardDocument | null>(null);
  // A board created just now opens with its title selected (type to name it);
  // any other board opens with the canvas focused (#ksx7szar).
  const [editTitleId, setEditTitleId] = useState<PageId | null>(null);
  /**
   * The template gallery is open for a new board under this parent (spec/v0-6
   * §D). With `resolve`, the pick goes back to the caller (`/template`;
   * `undefined` is Cancel) instead of creating and opening the board here.
   */
  const [galleryParent, setGalleryParent] = useState<{
    parentId: PageId | null;
    resolve?: (template: BoardTemplateId | null | undefined) => void;
  } | null>(null);
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
  const [lastPageId, setLastPageId] = useState<PageId | null>(null);
  const [localGraphOpen, setLocalGraphOpen] = useState(() => {
    try {
      return sessionStorage.getItem("gumply:local-graph") === "open";
    } catch {
      return false;
    }
  });

  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
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
  const shownTitle = graphOpen ? "Graph" : (page?.title ?? null);
  useEffect(() => {
    document.title = windowTitle({ page: shownTitle, vaultPath });
  }, [shownTitle, vaultPath]);
  const openSearch = useCallback((query = "") => {
    const active = document.activeElement;
    searchTrigger.current = active instanceof HTMLElement ? active : null;
    setSearchQuery(typeof query === "string" ? query : "");
    setSearchOpen(true);
  }, []);
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
  }, []);

  const navigateGraph = useCallback(() => {
    if (window.location.hash !== GRAPH_HASH) window.location.hash = GRAPH_HASH;
    setSelectedId(null);
    setGraphOpen(true);
  }, []);

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
    let list: PageMeta[] | null = null;
    try {
      list = await api.listPages();
    } catch {
      return;
    }
    if (epoch !== renameEpoch.current || renamesInFlight.current.size > 0) return;
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
      if (selectedRef.current !== null || isGraphHash(window.location.hash)) return;

      const target = chooseLandingPage(list, newVaultPage);
      if (!target) return;
      const request = api.getPage(target);
      // A failure is handled where the request is used (the load effect).
      request.catch(() => undefined);
      landingPageRequest.current = { id: target, request };
      focusBodyAfterOpen.current = target === newVaultPage;
      navigate(target, true);
    })();
  }, [loadPages, navigate]);

  useEffect(() => {
    const onHashChange = () => {
      setSelectedId(pageIdFromHash(window.location.hash));
      setGraphOpen(isGraphHash(window.location.hash));
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

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

    let cancelled = false;
    setPageStatus("loading");

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
        const created = await api.createPage({ title: "Untitled", parentId });
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
    async (parentId: PageId | null, title: string = NEW_BOARD_TITLE, templateId: BoardTemplateId | null = null) => {
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
    return () => window.removeEventListener("gumply:command", onCommand);
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
      const title = `${meta.title} copy`;
      try {
        // Unsaved edits in the open document go into the copy too.
        if (id === selectedRef.current) await documentControls()?.flush();
        let createdId: PageId;
        if (isBoard(meta)) {
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

  /** ⋯ → Copy link (#ux5cukze): `[[Title]]`, or `[[Map.canvas|Map]]` for a board. */
  const handleCopyLink = useCallback(
    async (id: PageId) => {
      const meta = pages.find((item) => item.id === id);
      if (!meta) return;
      // A board's link always names its file (`[[Map.canvas|Map]]`, v1.7).
      const link = formatWikilink(meta, pages);
      try {
        await navigator.clipboard.writeText(link);
        setToast({ message: "Link copied", icon: "link" });
      } catch {
        setActionError("Couldn't copy the link. Your browser blocked the clipboard.");
      }
    },
    [pages],
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
        const created = await createBoardFile(parentId, options.title ?? NEW_BOARD_TITLE, templateId);
        await loadPages();
        return created.meta;
      } catch (error) {
        setActionError(errorMessage(error));
        return null;
      }
    },
    [loadPages],
  );

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
      const resolved = resolveWikilink(link.targetTitle, pages);

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
    [pages, page, loadPages, navigate, requestPageReload],
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
    if (!found) setToast({ message: "Couldn't find that heading", icon: "info" });
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
        const trashId = result.trashId;
        setToast({
          message: wasBoard ? "Whiteboard deleted" : "Page deleted",
          icon: "trash",
          undo: trashId
            ? async () => {
                try {
                  await api.restoreTrash(trashId);
                  await loadPages();
                  setAutoFocusTitle(true);
                  navigate(id);
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
    [pages, loadPages, navigate, moveFocus],
  );

  const requestDelete = useCallback(
    (id: PageId) => {
      const target = pages.find((item) => item.id === id);
      if (!target) return;
      if (target.childCount > 0) {
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
      else setToast({ message: "That page no longer exists", icon: "info" });
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
      pages
        .filter((item) => item.id !== selectedId)
        .map((item) => ({
          path: vaultPathOf(item),
          title: item.title,
          // Live page cards reload their preview when this moves (W2b).
          updated: item.updated,
          ...(item.icon ? { icon: item.icon } : {}),
        })),
    [pages, selectedId],
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
    setToast({ message: `Other version kept in ${path}`, icon: "info" });
  }, []);

  const dismissToast = useCallback(() => setToast(null), []);

  const goToWelcome = useCallback(() => {
    const welcome = pages.find((item) => item.title.trim().toLowerCase() === "welcome");
    if (welcome) navigate(welcome.id);
    else navigate(null);
  }, [pages, navigate]);

  const showingPage = selectedId !== null && page !== null && page.id === selectedId;
  const showingBoard = showingPage && isBoardId(page.id) && boardDoc !== null;
  const movingPage = movingId ? (pages.find((item) => item.id === movingId) ?? null) : null;

  const serverError = listStatus === "error" && pages.length === 0;
  const breadcrumb = selectedId ? pageTrail(pages, selectedId) : [];

  return (
    <div className={`app${sidebarOpen ? "" : " sidebar-collapsed"}`}>
      <header className="topbar">
        <button
          type="button"
          className="icon-button sidebar-toggle"
          data-testid="sidebar-toggle"
          data-tooltip={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
          aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
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
          <nav className="breadcrumb" aria-label="Page path">
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
        <button
          type="button"
          className="icon-button"
          data-testid="shortcuts-button"
          data-tooltip="Keyboard shortcuts (?)"
          aria-label="Keyboard shortcuts (?)"
          onClick={() => setShortcutsOpen(true)}
        >
          <Icon name="keyboard" size={16} />
        </button>
      </header>

      <div
        className={`layout${!graphOpen && showingPage && localGraphOpen ? " layout-with-panel" : ""}`}
      >
        <Sidebar
          onCreateBoard={(parentId) => setGalleryParent({ parentId })}
          pages={pages}
          selectedId={selectedId}
          status={listStatus}
          error={listError}
          focusTarget={focusTarget}
          graphActive={graphOpen}
          onOpen={handleOpen}
          onCreate={(parentId) => void handleCreate(parentId)}
          onRename={handleRename}
          onDelete={requestDelete}
          onMove={(id, parentId) => void handleMove(id, parentId)}
          onStartMove={startMove}
          onDuplicate={(id) => void handleDuplicate(id)}
          onCopyLink={(id) => void handleCopyLink(id)}
          onRetry={handleRetry}
          onSearch={openSearch}
          onGraph={navigateGraph}
        />
        {/* Narrow windows: the sidebar is an overlay; tapping the page closes it. */}
        <div
          className="sidebar-scrim"
          data-testid="sidebar-scrim"
          aria-hidden="true"
          onClick={() => setSidebarOpen(false)}
        />

        <main className="content">
          {deletedOnDisk ? (
            <div className="banner banner-error" role="alert" data-testid="deleted-on-disk-banner">
              <span>This page was deleted on disk. Your unsaved text is still here.</span>
              <button type="button" className="link-button" onClick={() => void restoreDeletedPage()}>
                Restore page
              </button>
              <button
                type="button"
                className="banner-close"
                aria-label="Dismiss"
                onClick={() => setDeletedOnDisk(null)}
              >
                ×
              </button>
            </div>
          ) : actionError ? (
            <div className="banner banner-error" role="alert">
              <span>{actionError}</span>
              <button type="button" className="banner-close" onClick={() => setActionError(null)}>
                ×
              </button>
            </div>
          ) : null}

          {graphOpen ? (
            <GraphView
              highlightId={lastPageId}
              onOpenPage={handleOpen}
              onCreatePage={handleGraphCreatePage}
              onNewPage={() => void handleCreate(null)}
            />
          ) : (
            <div className={`editor-pane${showingBoard ? " is-board" : ""}`} data-testid="editor">
              {serverError ? (
                <div className="empty-state" data-testid="server-error">
                  <span className="empty-state-icon" aria-hidden="true">
                    <Icon name="monitor" size={26} />
                  </span>
                  <h2>{SERVER_DOWN_MESSAGE}</h2>
                  <p>Your pages are safe on disk. Start the app again to reconnect.</p>
                  <button type="button" className="button-primary" onClick={handleRetry}>
                    Retry
                  </button>
                  <p className="empty-hint">
                    Run <code>npm run dev</code> in the Gumply folder.
                  </p>
                </div>
              ) : selectedId === null ? (
                <div className="empty-state" data-testid="empty-state">
                  <span className="empty-state-icon" aria-hidden="true">
                    <Icon name={pages.length === 0 ? "file" : "search"} size={26} />
                  </span>
                  <h2>{pages.length === 0 ? "No pages yet." : "No page selected"}</h2>
                  <p>
                    {pages.length === 0
                      ? "Create a page to get started."
                      : "Choose a page in the sidebar, or create a new one."}
                  </p>
                  <button
                    type="button"
                    className="button-primary"
                    data-testid="empty-new-page"
                    onClick={() => void handleCreate(null)}
                  >
                    New page
                  </button>
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
                  <PageHeader
                    page={page}
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
                  />
                  <Editor
                    key={`${sessionKeyOf(page.id)}:${editorRevision}`}
                    page={page}
                    pages={pages}
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
                    onOpenTag={openTagSearch}
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
                  <h2>This page doesn't exist.</h2>
                  <p>It may have been deleted or renamed.</p>
                  <div className="empty-actions">
                    <button type="button" className="button-secondary" onClick={goToWelcome}>
                      Go to Welcome
                    </button>
                    <button
                      type="button"
                      className="button-primary"
                      onClick={() => void handleCreate(null)}
                    >
                      Create page
                    </button>
                  </div>
                </div>
              ) : (
                <p className="editor-note">Loading page…</p>
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
          onCancel={cancelDelete}
          onConfirm={confirmDelete}
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
            else void handleCreateBoard(galleryParent.parentId, NEW_BOARD_TITLE, templateId);
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
          message={toast.message}
          icon={toast.icon}
          onUndo={toast.undo ? () => void toast.undo?.() : undefined}
          onDismiss={dismissToast}
        />
      ) : null}

      {searchOpen ? (
        <QuickSwitcher
          pages={pages}
          initialQuery={searchQuery}
          onOpen={openSearchResult}
          onCreate={createSearchPage}
          onCreateBoard={createSearchBoard}
          onNewFromTemplate={() => {
            dismissSearch();
            setGalleryParent({ parentId: null });
          }}
          onClose={closeSearch}
        />
      ) : null}

      {shortcutsOpen ? <ShortcutsDialog onClose={() => setShortcutsOpen(false)} /> : null}
    </div>
  );
}
