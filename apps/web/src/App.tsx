import type { Page, PageId, PageMeta } from "@gumply/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiRequestError } from "./api/client.js";
import { Editor } from "./components/Editor.js";
import { PageHeader } from "./components/PageHeader.js";
import { SaveStatus } from "./components/SaveStatus.js";
import { Sidebar } from "./components/Sidebar.js";
import type { SaveState } from "./editor/autosave.js";
import { pageHash, pageIdFromHash } from "./lib/routing.js";
import { buildPageTree, isSelfOrDescendant } from "./lib/tree.js";

type ListStatus = "loading" | "ready" | "error";
type PageStatus = "idle" | "loading" | "ready" | "error";

function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof Error) {
    if (/fetch|network|load failed/i.test(error.message)) {
      return "Cannot reach the Gumply server. Is it running?";
    }
    return error.message;
  }
  return "Something went wrong.";
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
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [actionError, setActionError] = useState<string | null>(null);

  const selectedRef = useRef<PageId | null>(selectedId);
  selectedRef.current = selectedId;

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

  const navigate = useCallback((id: PageId | null, replace = false) => {
    const hash = id ? pageHash(id) : "#/";
    if (window.location.hash !== hash) {
      if (replace) window.history.replaceState(null, "", hash);
      else window.location.hash = hash;
    }
    setSelectedId(id);
  }, []);

  // Initial load: open the first root page when no page is in the URL.
  useEffect(() => {
    void (async () => {
      const list = await loadPages();
      if (!list || list.length === 0) return;
      if (selectedRef.current === null) {
        const first = buildPageTree(list)[0]?.page.id ?? null;
        if (first) navigate(first, true);
      }
    })();
  }, [loadPages, navigate]);

  useEffect(() => {
    const onHashChange = () => setSelectedId(pageIdFromHash(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

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
  }, [selectedId]);

  const handleOpen = useCallback((id: PageId) => navigate(id), [navigate]);

  const handleCreate = useCallback(
    async (parentId: PageId | null) => {
      setActionError(null);
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

  const handleRename = useCallback(
    async (id: PageId, title: string) => {
      setActionError(null);
      try {
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
      } catch (error) {
        setActionError(errorMessage(error));
        void loadPages();
      }
    },
    [loadPages],
  );

  const handleDelete = useCallback(
    async (id: PageId) => {
      const target = pages.find((item) => item.id === id);
      const label = target?.title ?? id;
      if (!window.confirm(`Delete “${label}”? Child pages will be deleted too.`)) return;

      setActionError(null);
      try {
        await api.deletePage(id);
        const list = await loadPages();
        const current = selectedRef.current;
        if (current && isSelfOrDescendant(id, current)) {
          const next = list ? (buildPageTree(list)[0]?.page.id ?? null) : null;
          navigate(next, true);
        }
      } catch (error) {
        setActionError(errorMessage(error));
      }
    },
    [pages, loadPages, navigate],
  );

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

  const showingPage = selectedId !== null && page !== null && page.id === selectedId;

  return (
    <div className="app">
      <header className="topbar">
        <span className="logo" aria-hidden="true">
          ◈
        </span>
        <h1 className="app-name">Gumply</h1>
        <span className="topbar-spacer" />
        <SaveStatus state={saveState} />
      </header>

      <div className="layout">
        <Sidebar
          pages={pages}
          selectedId={selectedId}
          status={listStatus}
          error={listError}
          onOpen={handleOpen}
          onCreate={(parentId) => void handleCreate(parentId)}
          onRename={handleRename}
          onDelete={(id) => void handleDelete(id)}
          onMove={(id, parentId) => void handleMove(id, parentId)}
          onRetry={handleRetry}
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

          <div className="editor-pane" data-testid="editor">
            {selectedId === null ? (
              <div className="empty-state" data-testid="empty-state">
                <h2>{pages.length === 0 ? "Your vault is empty" : "No page selected"}</h2>
                <p>Start with a page — Markdown, nested pages and links are all local files.</p>
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
                  onRename={(title) => handleRename(page.id, title)}
                  onDelete={() => void handleDelete(page.id)}
                />
                <Editor key={page.id} page={page} onSaveState={setSaveState} />
              </>
            ) : pageStatus === "error" ? (
              <div className="empty-state" data-testid="page-not-found">
                <h2>Page not found</h2>
                <p>{pageError ?? "This page no longer exists."}</p>
                <button type="button" className="button-secondary" onClick={() => navigate(null)}>
                  Back to start
                </button>
              </div>
            ) : (
              <p className="editor-note">Loading page…</p>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
