import { resolveWikilink, type Backlink, type Page, type PageId, type PageMeta } from "@gumply/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api/client.js";
import { BacklinksPanel } from "./components/BacklinksPanel.js";
import { DeleteDialog } from "./components/DeleteDialog.js";
import { Editor, type EditorControls } from "./components/Editor.js";
import { PageHeader } from "./components/PageHeader.js";
import { SaveStatus } from "./components/SaveStatus.js";
import { Sidebar, type SidebarFocusTarget } from "./components/Sidebar.js";
import { ThemeToggle } from "./components/ThemeToggle.js";
import { UndoToast } from "./components/UndoToast.js";
import type { SaveState } from "./editor/autosave.js";
import { GraphView } from "./graph/GraphView.js";
import { LocalGraphPanel } from "./graph/LocalGraphPanel.js";
import {
  buildDemoPages,
  DEMO_DISABLED_KEY,
  DEMO_FORCE_KEY,
  DEMO_SEEDED_KEY,
  WELCOME_TITLE,
} from "./lib/demo.js";
import { focusAfterDelete } from "./lib/delete.js";
import { errorMessage, SERVER_DOWN_MESSAGE } from "./lib/errors.js";
import { openPageNeedsReload } from "./lib/rename.js";
import { GRAPH_HASH, isGraphHash, pageHash, pageIdFromHash } from "./lib/routing.js";
import { buildPageTree, isSelfOrDescendant } from "./lib/tree.js";

type ListStatus = "loading" | "ready" | "error";
type PageStatus = "idle" | "loading" | "ready" | "error";
type AuxView = "search" | null;

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

function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string): void {
  try {
    window.localStorage.setItem(key, "1");
  } catch {
    // Private mode / storage disabled: seeding still works for this session.
  }
}

function demoSeedingEnabled(): boolean {
  if (readFlag(DEMO_DISABLED_KEY)) return false;
  if (readFlag(DEMO_FORCE_KEY)) return true;
  // E2E/automation expects a predictable empty vault; QA forces seeding to test it.
  return typeof navigator === "undefined" || !navigator.webdriver;
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
  const [pageError, setPageError] = useState<string | null>(null);
  const [pageReload, setPageReload] = useState(0);
  const [editorRevision, setEditorRevision] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [actionError, setActionError] = useState<string | null>(null);
  const [auxView, setAuxView] = useState<AuxView>(null);
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
  const reloadEditorAfterFetch = useRef(false);
  const focusBodyAfterOpen = useRef(false);
  const backlinksRequest = useRef(0);
  const demoSeedStarted = useRef(false);

  const moveFocus = useCallback((id: PageId | null) => {
    focusNonce.current += 1;
    setFocusTarget({ id, nonce: focusNonce.current });
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

  /** Create the demo vault once, on a truly empty first run (D10). */
  const seedDemo = useCallback(async (): Promise<PageMeta[] | null> => {
    for (const demo of buildDemoPages()) {
      await api.createPage({
        title: demo.title,
        parentId: demo.parentId,
        content: demo.content,
        icon: demo.icon,
      });
    }
    writeFlag(DEMO_SEEDED_KEY);
    return loadPages();
  }, [loadPages]);

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
    setAuxView(null);
  }, []);

  /** Refetch the open page and remount the editor with the new content. */
  const requestPageReload = useCallback(() => {
    reloadEditorAfterFetch.current = true;
    setPageReload((value) => value + 1);
  }, []);

  // Initial load: seed the demo on a first empty run, else open the first root.
  useEffect(() => {
    void (async () => {
      const list = await loadPages();
      if (!list) return;

      if (
        list.length === 0 &&
        !demoSeedStarted.current &&
        !readFlag(DEMO_SEEDED_KEY) &&
        demoSeedingEnabled()
      ) {
        demoSeedStarted.current = true;
        try {
          const seeded = await seedDemo();
          const welcome = seeded?.find((item) => item.title === WELCOME_TITLE);
          if (welcome) {
            focusBodyAfterOpen.current = true;
            navigate(welcome.id, true);
          }
          return;
        } catch (error) {
          setActionError(errorMessage(error));
        }
      }

      if (list.length === 0) return;
      if (selectedRef.current === null && !isGraphHash(window.location.hash)) {
        const first = buildPageTree(list)[0]?.page.id ?? null;
        if (first) navigate(first, true);
      }
    })();
  }, [loadPages, navigate, seedDemo]);

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
      setPageError(null);
      return;
    }

    let cancelled = false;
    setPageStatus("loading");
    setPageError(null);

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
      .catch((error) => {
        if (cancelled) return;
        setPage(null);
        setPageStatus("error");
        setPageError(errorMessage(error));
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
      setAuxView(null);
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
      setAuxView(null);
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
      setAuxView(null);

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

  const handleMove = useCallback(
    async (id: PageId, parentId: PageId | null) => {
      setActionError(null);
      try {
        await api.movePage(id, parentId);
        await loadPages();
      } catch (error) {
        setActionError(errorMessage(error));
        void loadPages();
      }
    },
    [loadPages],
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
    setAuxView(null);
    if (welcome) navigate(welcome.id);
    else navigate(null);
  }, [pages, navigate]);

  const showingPage = selectedId !== null && page !== null && page.id === selectedId;

  const serverError = listStatus === "error" && pages.length === 0;

  return (
    <div className="app">
      <header className="topbar">
        <span className="logo" aria-hidden="true">
          ◈
        </span>
        <h1 className="app-name">Gumply</h1>
        <span className="topbar-spacer" />
        <ThemeToggle />
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
          onRetry={handleRetry}
          onSearch={() => setAuxView("search")}
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
              {auxView === "search" ? (
                <div className="empty-state" data-testid="search-coming-soon">
                  <h2>Search is coming soon.</h2>
                  <p>You'll be able to find any page by title or text from here.</p>
                </div>
              ) : serverError ? (
                <div className="empty-state" data-testid="server-error">
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
                  />
                  <BacklinksPanel
                    items={backlinks}
                    loading={backlinksLoading}
                    onOpen={handleOpen}
                  />
                </>
              ) : pageStatus === "error" ? (
                <div className="empty-state" data-testid="page-not-found">
                  <h2>This page doesn't exist.</h2>
                  <p>{pageError ?? "It may have been deleted or renamed."}</p>
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

      {toast ? (
        <UndoToast
          message={toast.message}
          onUndo={toast.undo ? () => void toast.undo?.() : undefined}
          onDismiss={dismissToast}
        />
      ) : null}
    </div>
  );
}
