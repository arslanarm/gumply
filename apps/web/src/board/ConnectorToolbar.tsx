/**
 * Colour, arrow/line and delete for a lone selected connector, floating just
 * above it. Rendered over the canvas (React Flow draws edge toolbars under
 * the nodes, where short connectors would hide it).
 */
import type { CanvasEdge } from "@gumply/core";
import { useViewport } from "@xyflow/react";
import { useLayoutEffect, useState, type RefObject } from "react";
import { useBoardActions } from "./context.js";
import { BoardIcon } from "./icons.js";
import { Palette } from "./Swatch.js";

export function ConnectorToolbar({ edge, rootRef, layoutKey }: {
  edge: CanvasEdge;
  rootRef: RefObject<HTMLDivElement | null>;
  /** Changes whenever the board does (connected objects may have moved). */
  layoutKey: unknown;
}) {
  const actions = useBoardActions();
  const viewport = useViewport();
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
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
      const next = { left: Math.round(box.left + box.width / 2 - frame.left), top: Math.round(box.top - frame.top - 12) };
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
          aria-label="Arrow"
          aria-pressed={end === "arrow"}
          data-tooltip="Arrow"
          data-testid="board-edge-arrow"
          onClick={() => actions.updateEdge(id, { toEnd: undefined })}
        >
          <BoardIcon name="arrowEnd" size={16} />
        </button>
        <button
          type="button"
          className={`board-context-button${end === "none" ? " is-active" : ""}`}
          aria-label="Line"
          aria-pressed={end === "none"}
          data-tooltip="Line"
          data-testid="board-edge-line"
          onClick={() => actions.updateEdge(id, { toEnd: "none" })}
        >
          <BoardIcon name="arrowNone" size={16} />
        </button>
        <button
          type="button"
          className="board-context-button is-danger"
          aria-label="Delete"
          data-tooltip="Delete · Del"
          data-testid="board-delete"
          onClick={() => actions.deleteEdge(id)}
        >
          <BoardIcon name="trash" size={16} />
        </button>
      </div>
    </div>
  );
}
