import { resolveWikilink, type Backlink, type Page, type PageId, type PageMeta } from "@gumply/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, consumeNewVaultPage } from "./api/client.js";
import { BacklinksPanel } from "./components/BacklinksPanel.js";
import { DeleteDialog } from "./components/DeleteDialog.js";
import { Editor, type EditorControls } from "./components/Editor.js";
import { MoveDialog } from "./components/MoveDialog.js";
import { PageHeader } from "./components/PageHeader.js";
import { Icon } from "./components/Icon.js";
import { QuickSwitcher } from "./components/QuickSwitcher.js";
import { SaveStatus } from "./components/SaveStatus.js";
import { ShortcutsDialog } from "./components/ShortcutsDialog.js";
import { Sidebar, type SidebarFocusTarget } from "./components/Sidebar.js";
import { ThemeToggle } from "./components/ThemeToggle.js";
import { UndoToast } from "./components/UndoToast.js";
import type { SaveState } from "./editor/autosave.js";
import { GraphView } from "./graph/GraphView.js";
import { LocalGraphPanel } from "./graph/LocalGraphPanel.js";
import { focusAfterDelete } from "./lib/delete.js";
import { errorMessage, SERVER_DOWN_MESSAGE } from "./lib/errors.js";
import { moveToastMessage } from "./lib/move.js";
import { openPageNeedsReload } from "./lib/rename.js";
import { GRAPH_HASH, isGraphHash, pageHash, pageIdFromHash } from "./lib/routing.js";
import { isTypingTarget } from "./lib/shortcuts.js";
import { buildPageTree, isSelfOrDescendant } from "./lib/tree.js";

type ListStatus = "loading" | "ready" | "error";
type PageStatus = "idle" | "loading" | "ready" | "error";

interface PendingDelete {
  page: PageMeta;
  subPages: number;
}

interface ToastState {
  message: string;
  undo?: () => Promise<void>;
}

interface PendingHeading {
  pageId: PageId;
  heading: string;
}

export function App() {
  const [pages, setPages] = useState<PageMeta[]>([]);
  const [listStatus, setListStatus] = useState<ListStatus>("loading");
  const [listError, setListError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<PageId | null>(() =>
    pageIdFromHash(window.location.hash),
  );
  const [page, setPage] = useState<Page | null>(null);
  const [pageStatus, setPageStatus] = useState<PageStatus>("idle");
  const [pageReload, setPageReload] = useState(0);
  const [editorRevision, setEditorRevision] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [actionError, setActionError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [movingId, setMovingId] = useState<PageId | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
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
  const editorControls = useRef<EditorControls | null>(null);
  const focusNonce = useRef(0);
  const searchTrigger = useRef<HTMLElement | null>(null);
  const reloadEditorAfterFetch = useRef(false);
  const focusBodyAfterOpen = useRef(false);
  const backlinksRequest = useRef(0);
  const initialLoadStarted = useRef(false);

  const moveFocus = useCallback((id: PageId | null) => {
    focusNonce.current += 1;
    setFocusTarget({ id, nonce: focusNonce.current });
  }, []);

  // D13: one overlay, opened by Cmd/Ctrl+K and by the sidebar Search row.
  const openSearch = useCallback(() => {
    const active = document.activeElement;
    searchTrigger.current = active instanceof HTMLElement ? active : null;
    setSearchOpen(true);
  }, []);

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

  // Initial load: the server seeds a fresh vault; open its Welcome page once.
  // Otherwise open the first root page.
  useEffect(() => {
    if (initialLoadStarted.current) return;
    initialLoadStarted.current = true;
    void (async () => {
      const list = await loadPages();
      if (!list) return;

      // Consume even when a hash is present so it never leaks into a later load.
      const newVaultPage = consumeNewVaultPage();

      if (list.length === 0) return;
      if (selectedRef.current !== null || isGraphHash(window.location.hash)) return;

      const firstPage =
        newVaultPage && list.some((page) => page.id === newVaultPage) ? newVaultPage : null;
      const target = firstPage ?? buildPageTree(list)[0]?.page.id ?? null;
      if (!target) return;
      focusBodyAfterOpen.current = target === firstPage;
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
    setSaveState("idle");

    if (!selectedId) {
      setPage(null);
      setPageStatus("idle");
      return;
    }

    let cancelled = false;
    setPageStatus("loading");

    api
      .getPage(selectedId)
      .then((loaded) => {
        if (cancelled) return;
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
  }, [selectedId, pageReload]);

  // beforeunload guard while edits are pending or a save has failed (D14 §7).
  useEffect(() => {
    if (saveState !== "saving" && saveState !== "error") return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [saveState]);

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
    if (!found) setToast({ message: "Couldn't find that heading" });
  }, []);

  const handleRename = useCallback(
    async (id: PageId, title: string) => {
      setActionError(null);
      try {
        // Flush body edits first: a pending autosave could otherwise overwrite
        // the server's link rewrite with stale `[[Old Title]]` text.
        await editorControls.current?.flush();

        const updated = await api.updatePage(id, { title });
        setPages((previous) =>
          previous.map((item) =>
            item.id === id ? { ...item, title: updated.title, updated: updated.updated } : item,
          ),
        );
        setPage((previous) =>
          previous && previous.id === id
            ? { ...previous, title: updated.title, updated: updated.updated }
            : previous,
        );

        // D12: refetch the open page when the server rewrote its links.
        if (openPageNeedsReload(updated.rewrittenPages, selectedRef.current, id)) {
          requestPageReload();
        }
      } catch (error) {
        setActionError(errorMessage(error));
        void loadPages();
      }
    },
    [loadPages, requestPageReload],
  );

  const performDelete = useCallback(
    async (id: PageId) => {
      setActionError(null);

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
          message: "Page deleted",
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
        await editorControls.current?.flush();
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
    }
  }, []);

  const handleStartBody = useCallback(() => {
    editorControls.current?.focusBody();
  }, []);

  const handleRetrySave = useCallback(() => {
    void editorControls.current?.flush();
  }, []);

  const dismissToast = useCallback(() => setToast(null), []);

  const goToWelcome = useCallback(() => {
    const welcome = pages.find((item) => item.title.trim().toLowerCase() === "welcome");
    if (welcome) navigate(welcome.id);
    else navigate(null);
  }, [pages, navigate]);

  const showingPage = selectedId !== null && page !== null && page.id === selectedId;
  const movingPage = movingId ? (pages.find((item) => item.id === movingId) ?? null) : null;

  const serverError = listStatus === "error" && pages.length === 0;

  return (
    <div className="app">
      <header className="topbar">
        <span className="logo" aria-hidden="true">
          <Icon name="brand" size={18} />
        </span>
        <h1 className="app-name">Gumply</h1>
        <span className="topbar-spacer" />
        <ThemeToggle />
        <button
          type="button"
          className="icon-button"
          data-testid="shortcuts-button"
          data-tooltip="Keyboard shortcuts (?)"
          aria-label="Keyboard shortcuts (?)"
          onClick={() => setShortcutsOpen(true)}
        >
          <Icon name="help" size={16} />
        </button>
        <SaveStatus state={saveState} onRetry={handleRetrySave} />
      </header>

      <div
        className={`layout${!graphOpen && showingPage && localGraphOpen ? " layout-with-panel" : ""}`}
      >
        <Sidebar
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
          onRetry={handleRetry}
          onSearch={openSearch}
          onGraph={navigateGraph}
        />

        <main className="content">
          {actionError ? (
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
            <div className="editor-pane" data-testid="editor">
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
              ) : showingPage ? (
                <>
                  <PageHeader
                    page={page}
                    autoFocusTitle={autoFocusTitle}
                    localGraphOpen={localGraphOpen}
                    onToggleLocalGraph={() => setLocalGraphOpen((value) => !value)}
                    onRename={(title) => handleRename(page.id, title)}
                    onDelete={() => requestDelete(page.id)}
                    onStartBody={handleStartBody}
                  />
                  <Editor
                    key={`${page.id}:${editorRevision}`}
                    page={page}
                    pages={pages}
                    onSaveState={setSaveState}
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
          onUndo={toast.undo ? () => void toast.undo?.() : undefined}
          onDismiss={dismissToast}
        />
      ) : null}

      {searchOpen ? (
        <QuickSwitcher
          pages={pages}
          onOpen={openSearchResult}
          onCreate={createSearchPage}
          onClose={closeSearch}
        />
      ) : null}

      {shortcutsOpen ? <ShortcutsDialog onClose={() => setShortcutsOpen(false)} /> : null}
    </div>
  );
}
