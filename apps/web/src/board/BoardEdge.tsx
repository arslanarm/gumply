/**
 * A connector (JSON Canvas edge): a bezier curve between two node sides,
 * arrowheads per `fromEnd`/`toEnd` (default: arrow at the end only) and an
 * optional label, edited by double-clicking the line.
 */
import { BaseEdge, EdgeLabelRenderer, getBezierPath, Position, type EdgeProps } from "@xyflow/react";
import { memo, useLayoutEffect, useRef } from "react";
import { solidColor } from "./colors.js";
import { useBoardActions } from "./context.js";
import type { BoardFlowEdge } from "./flow.js";

const ARROW_LENGTH = 11;
const ARROW_HALF_WIDTH = 5.5;
/** Distance from a connection dot's centre to the object (board.css: 14px out, 2px air). */
const HANDLE_GAP = 12;

/** Direction the line travels when it arrives at a side (bezier ends are perpendicular). */
function arrivalDirection(side: Position): [number, number] {
  switch (side) {
    case Position.Left:
      return [1, 0];
    case Position.Right:
      return [-1, 0];
    case Position.Top:
      return [0, 1];
    default:
      return [0, -1];
  }
}

function arrowHead(x: number, y: number, side: Position): string {
  const [dx, dy] = arrivalDirection(side);
  const baseX = x - dx * ARROW_LENGTH;
  const baseY = y - dy * ARROW_LENGTH;
  const px = -dy * ARROW_HALF_WIDTH;
  const py = dx * ARROW_HALF_WIDTH;
  return `M${x},${y} L${baseX + px},${baseY + py} L${baseX - px},${baseY - py} Z`;
}

/** Shorten the line end so it stops at the arrow's base, not its tip. */
function pullBack(x: number, y: number, side: Position, distance: number): [number, number] {
  const [dx, dy] = arrivalDirection(side);
  return [x - dx * distance, y - dy * distance];
}

function LabelEditor({ id, initial }: { id: string; initial: string }) {
  const actions = useBoardActions();
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useLayoutEffect(() => {
    ref.current?.focus({ preventScroll: true });
    ref.current?.select();
  }, []);
  const finish = (): void => {
    if (done.current || !ref.current) return;
    done.current = true;
    actions.commitEdgeLabel(id, ref.current.value);
  };
  return (
    <input
      ref={ref}
      className="board-edge-input nodrag nopan"
      defaultValue={initial}
      aria-label="Connector label"
      placeholder="Label"
      data-testid="board-edge-input"
      onBlur={finish}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter" || event.key === "Escape") {
          event.preventDefault();
          finish();
        }
      }}
    />
  );
}

export const BoardEdge = memo(function BoardEdge(props: EdgeProps<BoardFlowEdge>) {
  const { id, data, selected, sourcePosition, targetPosition } = props;
  const edge = data?.edge;
  const fromArrow = edge?.fromEnd === "arrow";
  const toArrow = (edge?.toEnd ?? "arrow") === "arrow";
  // The connection dots sit outside the object; the line touches the object.
  const [fromX, fromY] = pullBack(props.sourceX, props.sourceY, sourcePosition, -HANDLE_GAP);
  const [toX, toY] = pullBack(props.targetX, props.targetY, targetPosition, -HANDLE_GAP);
  const [sx, sy] = fromArrow ? pullBack(fromX, fromY, sourcePosition, ARROW_LENGTH - 1) : [fromX, fromY];
  const [tx, ty] = toArrow ? pullBack(toX, toY, targetPosition, ARROW_LENGTH - 1) : [toX, toY];
  const [path, labelX, labelY] = getBezierPath({
    sourceX: sx,
    sourceY: sy,
    sourcePosition,
    targetX: tx,
    targetY: ty,
    targetPosition,
  });
  const color = solidColor(edge?.color);
  const label = typeof edge?.label === "string" ? edge.label : "";
  const editing = data?.editing ?? false;

  return (
    <g className={`board-edge${selected ? " is-selected" : ""}`} style={color ? { color } : undefined} data-testid="board-edge">
      <BaseEdge id={id} path={path} interactionWidth={18} className="board-edge-path" />
      {toArrow ? <path className="board-edge-arrow" d={arrowHead(toX, toY, targetPosition)} /> : null}
      {fromArrow ? <path className="board-edge-arrow" d={arrowHead(fromX, fromY, sourcePosition)} /> : null}
      {label || editing ? (
        <EdgeLabelRenderer>
          <div
            className={`board-edge-label nodrag nopan${selected ? " is-selected" : ""}`}
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              ...(color ? { color } : {}),
            }}
            data-testid="board-edge-label"
          >
            {editing ? <LabelEditor id={id} initial={label} /> : label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </g>
  );
});

export const EDGE_TYPES = { board: BoardEdge };
