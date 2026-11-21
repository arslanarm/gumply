/**
 * A board as an open document: loads it from the API, autosaves every change
 * (debounced, like pages) and handles D22 conflicts. The app shell (W2a)
 * mounts this for a whiteboard and shows `onSaveState` in its save status.
 */
import { serializeCanvas, type BoardDocument, type CanvasBoard, type PageMeta } from "@gumply/core";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiRequestError, api } from "../api/client.js";
import { Autosave, type SaveState } from "../editor/autosave.js";
import { newWriterId, registerSaver } from "../lib/pending-saves.js";
import type { BoardEditorControls, BoardPageOption } from "./BoardEditor.js";
import type { BoardRenderers } from "./context.js";
import { LazyBoardEditor } from "./index.js";
import { t, useT } from "../i18n/index.js";

export interface BoardViewControls {
  /** Write pending changes now (navigation, Cmd+S). */
  flush: () => Promise<void>;
  isDirty: () => boolean;
  /** Conflict: save this tab's version over the disk one (backed up first). */
  keepMine: () => Promise<void>;
  /** Conflict or external change: load the disk version (drops local edits). */
  reload: () => Promise<void>;
  /** Drop a page/board card onto the board (e.g. from the sidebar). */
  addFileCard: (path: string, clientPoint?: { x: number; y: number }) => void;
}

export interface BoardViewProps {
  /** The board's id; when a rename changes it, pass the new one (same mount). */
  boardId: string;
  /**
   * The board's `meta.updated` as the app last saw it. After the app renames
   * the board (its own PUT), pass the new value so autosave doesn't 409.
   */
  updated?: string;
  /** The board as the app already loaded it (skips a second request). */
  initial?: BoardDocument;
  pages?: readonly BoardPageOption[];
  onSaveState: (state: SaveState) => void;
  /** After a save: the server's metadata and the id it was saved under. */
  onSaved?: (meta: PageMeta, savedId: string) => void;
  onConflictBackup?: (path: string) => void;
  /**
   * The file had entries Gumply couldn't keep; the original was backed up
   * here on the first save. The view shows its own notice too.
   */
  onRepairBackup?: (path: string) => void;
  onOpenFile?: (path: string) => void;
  onLoadError?: (error: unknown) => void;
  onReady?: (controls: BoardViewControls) => void;
  renderers?: BoardRenderers;
}

/** Page body for live page cards (W2b); null when it can't be read. */
async function loadPagePreview(path: string): Promise<string | null> {
  try {
    return (await api.getPage(path.replace(/\.md$/i, ""))).content;
  } catch {
    return null;
  }
}

export function BoardView(props: BoardViewProps) {
  useT();
  const { boardId, pages, onOpenFile, renderers } = props;
  const [loaded, setLoaded] = useState<{ meta: PageMeta; board: CanvasBoard } | null>(props.initial ?? null);
  const [failed, setFailed] = useState<string | null>(null);
  const [repairNotice, setRepairNotice] = useState<string | null>(null);
  // #f6v8z4ti: a dropped/pasted file that couldn't be added.
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const idRef = useRef(boardId);
  idRef.current = boardId;
  const versionRef = useRef<string | undefined>(undefined);
  const forceRef = useRef(false);
  // Identifies this view's saves to the server (spec/api `writer`).
  const writerRef = useRef(newWriterId());
  const editorRef = useRef<BoardEditorControls | null>(null);

  const autosave = useMemo(
    () =>
      new Autosave({
        save: async (value) => {
          const force = forceRef.current;
          const savedId = idRef.current;
          try {
            const result = await api.saveBoard(savedId, {
              board: JSON.parse(value) as CanvasBoard,
              ...(versionRef.current ? { expectedUpdated: versionRef.current } : {}),
              writer: writerRef.current,
              ...(force ? { force: true } : {}),
            });
            forceRef.current = false;
            versionRef.current = result.meta.updated;
            latest.current.onSaved?.(result.meta, savedId);
            if (result.conflictBackup) latest.current.onConflictBackup?.(result.conflictBackup);
            if (result.repairBackup) {
              setRepairNotice(result.repairBackup);
              latest.current.onRepairBackup?.(result.repairBackup);
            }
          } catch (error) {
            if (!force) forceRef.current = false;
            throw error;
          }
        },
        // Leaving the page (#3t6v62cb): a keepalive PUT (null over 64 KB).
        exitSave: (value) => {
          const savedId = idRef.current;
          const request = api.saveBoardOnExit(savedId, {
            board: JSON.parse(value) as CanvasBoard,
            ...(versionRef.current ? { expectedUpdated: versionRef.current } : {}),
            writer: writerRef.current,
          });
          return (
            request?.then((result) => {
              versionRef.current = result.meta.updated;
              latest.current.onSaved?.(result.meta, savedId);
            }) ?? null
          );
        },
        isConflict: (error) => error instanceof ApiRequestError && error.status === 409,
        onState: (state) => latest.current.onSaveState(state),
      }),
    [],
  );

  const load = useCallback(async (): Promise<{ meta: PageMeta; board: CanvasBoard } | null> => {
    try {
      const result = await api.getBoard(idRef.current);
      versionRef.current = result.meta.updated;
      autosave.reset(serializeCanvas(result.board));
      setFailed(null);
      return result;
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error));
      latest.current.onLoadError?.(error);
      return null;
    }
  }, [autosave]);

  // Load once per mount; the app keys this view by board session, and a
  // rename (new id, same board) keeps the open document.
  useEffect(() => {
    const initial = latest.current.initial;
    if (initial) {
      versionRef.current = initial.meta.updated;
      autosave.reset(serializeCanvas(initial.board));
      return;
    }
    let cancelled = false;
    void load().then((result) => {
      if (!cancelled && result) setLoaded(result);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A rename by the app (its own PUT) moves the version this view must send,
  // never back to an older one (#d5e4mawv).
  useEffect(() => {
    if (props.updated && (!versionRef.current || props.updated > versionRef.current)) versionRef.current = props.updated;
  }, [props.updated]);

  // Never lose the last edits when the view goes away, or the page does
  // (reload, close, quit: #3t6v62cb). Text being typed is already in the
  // queue as a draft (BoardEditor `onChange` while typing).
  useEffect(() => {
    const unregister = registerSaver({
      isDirty: () => autosave.isDirty(),
      hasFailed: () => autosave.hasFailed(),
      flush: () => autosave.flush(),
      flushOnExit: () => autosave.flushOnExit(),
    });
    return () => {
      unregister();
      autosave.dispose();
    };
  }, [autosave]);

  const onChange = useCallback((board: CanvasBoard) => autosave.schedule(serializeCanvas(board)), [autosave]);

  const onEditorReady = useCallback(
    (controls: BoardEditorControls) => {
      editorRef.current = controls;
      latest.current.onReady?.({
        flush: () => autosave.flush(),
        // Unsaved also means "mid-gesture": text being typed in a sticky or a
        // drag isn't in the save queue yet, and a reload would drop it (#x74uu7c3).
        isDirty: () => autosave.isDirty() || (editorRef.current?.isBusy() ?? false),
        keepMine: async () => {
          forceRef.current = true;
          await autosave.retry();
        },
        reload: async () => {
          const result = await load();
          if (result) editorRef.current?.replaceBoard(result.board);
        },
        addFileCard: (path, point) => editorRef.current?.addFileCard(path, point),
      });
    },
    [autosave, load],
  );

  if (failed && !loaded) {
    return (
      <div className="empty-state" data-testid="board-load-error">
        <h2>{t("board.loadFailed")}</h2>
        <p>{failed}</p>
      </div>
    );
  }
  if (!loaded) return <div className="board-loading" data-testid="board-loading" />;

  return (
    <div className="board-view">
      {uploadNotice ? (
        <div className="board-notice" role="status" data-testid="board-upload-notice">
          <span>{uploadNotice}</span>
          <button type="button" className="board-notice-close" aria-label={t("common.dismiss")} onClick={() => setUploadNotice(null)}>
            ×
          </button>
        </div>
      ) : null}
      {repairNotice ? (
        <div className="board-notice" role="status" data-testid="board-repair-notice">
          <span>
            {t("board.repairedBefore")}<code>{repairNotice}</code>{t("board.repairedAfter")}
          </span>
          <button type="button" className="board-notice-close" aria-label={t("common.dismiss")} onClick={() => setRepairNotice(null)}>
            ×
          </button>
        </div>
      ) : null}
      <Suspense fallback={<div className="board-loading" data-testid="board-loading" />}>
      <LazyBoardEditor
        boardId={boardId}
        fileLinks={props.initial?.fileLinks}
        board={loaded.board}
        onChange={onChange}
        pages={pages}
        onOpenFile={onOpenFile}
        uploadFile={async (file) => (await api.uploadAttachment(file)).path}
        onUploadError={setUploadNotice}
        renderers={renderers}
        loadPage={loadPagePreview}
        onReady={onEditorReady}
      />
      </Suspense>
    </div>
  );
}
