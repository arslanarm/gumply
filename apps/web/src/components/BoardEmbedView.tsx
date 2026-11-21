/**
 * `![[Board.canvas]]` in a page (spec/v0-6 B, D30): a live, read-only view of
 * the board, fitted to the frame. Hover shows the title and Open; a click
 * opens the board; the bottom edge drags to set the height (`|480` on disk).
 * A missing board shows a calm notice with Create.
 *
 * The board view (React Flow) is lazy and only mounts once the embed is near
 * the viewport, so a long page with embeds opens as fast as one without.
 */
import { linkTargetFor, resolveWikilink, type CanvasBoard, type PageMeta } from "@gumply/core";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { Suspense, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { api } from "../api/client.js";
import { LazyBoardPreview, type BoardPageOption } from "../board/index.js";
import {
  BOARD_EMBED_DEFAULT_HEIGHT,
  BOARD_EMBED_MAX_HEIGHT,
  BOARD_EMBED_MIN_HEIGHT,
} from "../editor/board-embed/constants.js";
import { embedHeight } from "../editor/board-embed/markdown-plugin.js";
import { getBoardEmbedActions } from "../editor/whiteboard-link.js";
import { useWikiLinkEnvironment } from "../editor/wikilink/link-store.js";
import { isBoard, vaultPathOf } from "../lib/boards.js";
import { errorMessage } from "../lib/errors.js";
import { Icon } from "./Icon.js";
import { t, useT } from "../i18n/index.js";

async function loadPagePreview(path: string): Promise<string | null> {
  try {
    return (await api.getPage(path.replace(/\.md$/i, ""))).content;
  } catch {
    return null;
  }
}

/** The title a missing `Folder/Plan.canvas` would get: `Plan`. */
function titleOfTarget(target: string): string {
  return (target.split("/").pop() ?? target).replace(/\.canvas$/i, "").trim() || t("defaults.untitledBoard");
}

/** Mount `true` once the element comes within `margin` of the viewport. */
function useNearViewport(ref: React.RefObject<HTMLElement | null>, margin = "600px"): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (near) return;
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { rootMargin: margin },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [near, ref, margin]);
  return near;
}

/** The board's document, refetched whenever its `updated` moves (Gumply or disk). */
function useBoardDocument(board: PageMeta | null, enabled: boolean): { board: CanvasBoard | null; error: string | null } {
  const [state, setState] = useState<{ id: string; board: CanvasBoard | null; error: string | null }>({
    id: "",
    board: null,
    error: null,
  });
  const id = board?.id ?? "";
  const updated = board?.updated ?? "";
  useEffect(() => {
    if (!enabled || !id) return;
    let cancelled = false;
    void api
      .getBoard(id)
      .then((doc) => {
        if (!cancelled) setState({ id, board: doc.board, error: null });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState((previous) => ({ ...previous, id, error: errorMessage(error) }));
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, id, updated]);
  // A renamed board keeps showing its last content until the new one loads.
  return { board: state.board, error: state.id === id ? state.error : null };
}

export function BoardEmbedView({ node, updateAttributes, selected }: NodeViewProps) {
  const t = useT();
  const target = String(node.attrs.target ?? "");
  const size = String(node.attrs.size ?? "");
  const env = useWikiLinkEnvironment();
  const frameRef = useRef<HTMLDivElement | null>(null);
  const near = useNearViewport(frameRef);

  const resolved = resolveWikilink(target, env.pages);
  const board = resolved && isBoard(resolved) ? resolved : null;
  const { board: document, error } = useBoardDocument(board, near);

  const pages = useMemo<BoardPageOption[]>(
    () =>
      env.pages.map((item) => ({
        path: vaultPathOf(item),
        title: item.title,
        updated: item.updated,
        ...(item.icon ? { icon: item.icon } : {}),
      })),
    [env.pages],
  );

  const storedHeight = embedHeight(size) ?? BOARD_EMBED_DEFAULT_HEIGHT;
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const height = dragHeight ?? storedHeight;

  const open = () => {
    if (!board) return;
    env.openLink({ targetTitle: target, heading: "" });
  };

  const [creating, setCreating] = useState(false);
  const create = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const created = await getBoardEmbedActions().createBoard(titleOfTarget(target));
      if (created) {
        // Point at the new file in the form Obsidian resolves too.
        const others = env.pages.some((item) => item.id === created.id) ? env.pages : [...env.pages, created];
        const next = linkTargetFor(created, others).target;
        if (next !== target) updateAttributes({ target: next });
      }
    } finally {
      setCreating(false);
    }
  };

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startHeight = height;
    const clamp = (value: number) =>
      Math.round(Math.min(BOARD_EMBED_MAX_HEIGHT, Math.max(BOARD_EMBED_MIN_HEIGHT, value)));
    const move = (moveEvent: PointerEvent) => setDragHeight(clamp(startHeight + moveEvent.clientY - startY));
    const finish = (upEvent: PointerEvent) => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", finish);
      const next = clamp(startHeight + upEvent.clientY - startY);
      setDragHeight(null);
      if (next === storedHeight) return;
      // One undo step; the default height needs no `|360` on disk.
      updateAttributes({ size: next === BOARD_EMBED_DEFAULT_HEIGHT && size === "" ? "" : String(next) });
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
  };

  const title = board?.title ?? titleOfTarget(target);

  return (
    <NodeViewWrapper
      className={`board-embed${selected ? " is-selected" : ""}${board ? "" : " is-missing"}${dragHeight !== null ? " is-resizing" : ""}`}
      data-testid="board-embed"
      data-target={target}
      data-board-id={board?.id ?? ""}
      contentEditable={false}
    >
      <div
        ref={frameRef}
        className="board-embed-frame"
        style={{ height }}
        data-testid="board-embed-frame"
        role={board ? "link" : undefined}
        aria-label={board ? t("embed.open", { title }) : undefined}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("button, .board-embed-resize")) return;
          open();
        }}
      >
        {board ? (
          <>
            {near && document ? (
              <Suspense fallback={<div className="board-embed-loading" aria-hidden="true" />}>
                <LazyBoardPreview board={document} pages={pages} loadPage={loadPagePreview} />
              </Suspense>
            ) : (
              <div className="board-embed-loading" aria-hidden="true">
                {error ? <span className="board-embed-error">{t("embed.loadFailed", { error })}</span> : null}
              </div>
            )}
            <div className="board-embed-bar" data-testid="board-embed-bar">
              <span className="board-embed-title" data-testid="board-embed-title">
                {board.icon ? (
                  <span className="board-embed-emoji" aria-hidden="true">
                    {board.icon}
                  </span>
                ) : (
                  <Icon name="board" size={15} />
                )}
                <span>{title}</span>
              </span>
              <button
                type="button"
                className="board-embed-open"
                data-testid="board-embed-open"
                onClick={(event) => {
                  event.stopPropagation();
                  open();
                }}
              >
                {t("common.open")}
              </button>
            </div>
            {document && document.nodes.length === 0 ? (
              <div className="board-embed-empty">{t("embed.empty")}</div>
            ) : null}
          </>
        ) : (
          <div className="board-embed-missing" data-testid="board-embed-missing">
            <Icon name="board" size={20} />
            <div className="board-embed-missing-text">
              <strong>{t("embed.notFound")}</strong>
              <span>{t("embed.notFoundHint", { target })}</span>
            </div>
            <button
              type="button"
              className="button-secondary"
              data-testid="board-embed-create"
              disabled={creating}
              onClick={(event) => {
                event.stopPropagation();
                void create();
              }}
            >
              {creating ? t("embed.creating") : t("embed.create")}
            </button>
          </div>
        )}
      </div>
      {board ? (
        <div
          className="board-embed-resize"
          data-testid="board-embed-resize"
          role="separator"
          aria-orientation="horizontal"
          aria-label={t("embed.resize")}
          aria-valuenow={height}
          aria-valuemin={BOARD_EMBED_MIN_HEIGHT}
          aria-valuemax={BOARD_EMBED_MAX_HEIGHT}
          onPointerDown={startResize}
        />
      ) : null}
    </NodeViewWrapper>
  );
}
