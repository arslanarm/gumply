/**
 * Colour, arrow/line and delete for a lone selected connector, floating just
 * above it. Rendered over the canvas (React Flow draws edge toolbars under
 * the nodes, where short connectors would hide it).
 */
import type { CanvasEdge } from "@gumply/core";
import { useViewport } from "@xyflow/react";
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useBoardActions } from "./context.js";
import { BoardIcon } from "./icons.js";
import { Palette } from "./Swatch.js";
import { t, useT } from "../i18n/index.js";

/** The room kept between the toolbar and the board's edge or the tool rail. */
const EDGE_GAP = 8;

export function ConnectorToolbar({ edge, rootRef, layoutKey }: {
  edge: CanvasEdge;
  rootRef: RefObject<HTMLDivElement | null>;
  /** Changes whenever the board does (connected objects may have moved). */
  layoutKey: unknown;
}) {
  useT();
  const actions = useBoardActions();
  const viewport = useViewport();
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const end = edge.toEnd ?? "arrow";

  useLayoutEffect(() => {
    const measure = (): void => {
      const root = rootRef.current;
      const path = root?.querySelector(`.react-flow__edge[data-id="${CSS.escape(edge.id)}"] .board-edge-path`);
      if (!root || !path) {
        setPosition(null);
        return;
      }
      const box = path.getBoundingClientRect();
      const frame = root.getBoundingClientRect();
      const top = Math.round(box.top - frame.top - 12);
      // #4quachkv: centred on the line, but kept inside the board and clear of the tool rail (on a
      // narrow window a connector near the left put the toolbar under the rail, off the edge).
      const width = toolbarRef.current?.offsetWidth ?? 0;
      const height = toolbarRef.current?.offsetHeight ?? 0;
      let min = EDGE_GAP + width / 2;
      const rail = root.querySelector<HTMLElement>(".board-toolbar")?.getBoundingClientRect();
      if (rail && top - height < rail.bottom - frame.top && top > rail.top - frame.top) min = Math.max(min, rail.right - frame.left + EDGE_GAP + width / 2);
      const max = frame.width - EDGE_GAP - width / 2;
      const middle = box.left + box.width / 2 - frame.left;
      const next = { left: Math.round(Math.max(min, Math.min(max, middle))), top };
      setPosition((current) => (current && current.left === next.left && current.top === next.top ? current : next));
    };
    measure();
    // React Flow may redraw the line after this commit: measure again then.
    const frame = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(frame);
  }, [edge, layoutKey, rootRef, viewport.x, viewport.y, viewport.zoom]);

  if (!position) return null;
  const id = edge.id;
  return (
    <div
      ref={toolbarRef}
      className="board-context board-connector-toolbar"
      style={{ left: position.left, top: position.top }}
      data-testid="board-edge-toolbar"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <Palette current={edge.color} onPick={(value) => actions.updateEdge(id, { color: value })} />
      <div className="board-context-group">
        <button
          type="button"
          className={`board-context-button${end === "arrow" ? " is-active" : ""}`}
          aria-label={t("board.connector.arrow")}
          aria-pressed={end === "arrow"}
          data-tooltip={t("board.connector.arrow")}
          data-testid="board-edge-arrow"
          onClick={() => actions.updateEdge(id, { toEnd: undefined })}
        >
          <BoardIcon name="arrowEnd" size={16} />
        </button>
        <button
          type="button"
          className={`board-context-button${end === "none" ? " is-active" : ""}`}
          aria-label={t("board.connector.line")}
          aria-pressed={end === "none"}
          data-tooltip={t("board.connector.line")}
          data-testid="board-edge-line"
          onClick={() => actions.updateEdge(id, { toEnd: "none" })}
        >
          <BoardIcon name="arrowNone" size={16} />
        </button>
        <button
          type="button"
          className="board-context-button is-danger"
          aria-label={t("common.delete")}
          data-tooltip={`${t("common.delete")} · Del`}
          data-testid="board-delete"
          onClick={() => actions.deleteEdge(id)}
        >
          <BoardIcon name="trash" size={16} />
        </button>
      </div>
    </div>
  );
}
