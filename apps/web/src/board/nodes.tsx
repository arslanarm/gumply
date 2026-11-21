/**
 * Board node components (React Flow custom nodes). Each node fills the box
 * React Flow gives it; geometry lives in the canvas node itself.
 */
import { gumplyNodeData, type CanvasNode, type GumplyShape, type InkPoint } from "@gumply/core";
import { Handle, NodeResizer, Position, type NodeProps } from "@xyflow/react";
import { createContext, memo, useContext, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { fileUrl } from "../api/client.js";
import { colorStyle, solidColor } from "./colors.js";
import { useBoardActions, useBoardRenderers, type BoardCardRenderProps } from "./context.js";
import type { BoardFlowNode } from "./flow.js";
import { BoardIcon } from "./icons.js";
import { inkExtent, inkPath } from "./ink.js";
import { useBoardContent } from "./content/context.js";
import { useLinkAutocomplete } from "./content/LinkAutocomplete.js";
import type { FitBatch } from "./fit-batch.js";
import { textBucket } from "./lod.js";
import { safeExternalUrl } from "./model.js";
import { t, useT } from "../i18n/index.js";

type BoardNodeProps = NodeProps<BoardFlowNode>;

const SIDES = [
  { id: "top", position: Position.Top },
  { id: "right", position: Position.Right },
  { id: "bottom", position: Position.Bottom },
  { id: "left", position: Position.Left },
] as const;

/** Connection dots on all four sides; shown on hover and in connector mode. */
function ConnectHandles() {
  return (
    <>
      {SIDES.map((side) => (
        <Handle
          key={side.id}
          id={side.id}
          type="source"
          position={side.position}
          className="board-handle"
          data-testid={`board-handle-${side.id}`}
        />
      ))}
    </>
  );
}

function Resizer({ id, selected, keepAspectRatio = false, minWidth = 24, minHeight = 24 }: {
  id: string;
  selected: boolean;
  keepAspectRatio?: boolean;
  minWidth?: number;
  minHeight?: number;
}) {
  const actions = useBoardActions();
  if (!selected) return null;
  return (
    <NodeResizer
      isVisible={selected}
      minWidth={minWidth}
      minHeight={minHeight}
      keepAspectRatio={keepAspectRatio}
      lineClassName="board-resize-line"
      handleClassName="board-resize-handle"
      onResizeEnd={(_event, params) => actions.commitResize(id, params)}
    />
  );
}

/* ------------------------------------------------------------------------ */
/* Text                                                                      */
/* ------------------------------------------------------------------------ */

function PlainText({ text }: { text: string }) {
  return <>{text}</>;
}

function TextView({ text, node }: { text: string; node: BoardFlowNode["data"] }) {
  const renderers = useBoardRenderers();
  return <>{renderers.text ? renderers.text({ text, kind: node.kind }) : <PlainText text={text} />}</>;
}

/**
 * The in-place text editor. Saves on blur, Escape and Cmd/Ctrl+Enter; Enter
 * is a new line, as on sticky notes everywhere.
 */
function TextEditor({ node, className, placeholder, onHeight }: {
  node: CanvasNode;
  className: string;
  placeholder?: string;
  /** Measure the content height to grow the node on commit. */
  onHeight?: (element: HTMLTextAreaElement) => number | undefined;
}) {
  const actions = useBoardActions();
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  const initial = typeof node.text === "string" ? node.text : "";
  // W2b: `[[` opens page/board suggestions under the caret.
  const links = useLinkAutocomplete(ref, useBoardContent().pages);

  useLayoutEffect(() => {
    const area = ref.current;
    if (!area) return;
    area.focus({ preventScroll: true });
    area.setSelectionRange(area.value.length, area.value.length);
  }, []);

  const finish = (): void => {
    if (done.current || !ref.current) return;
    done.current = true;
    const height = onHeight?.(ref.current);
    actions.commitText(node.id, ref.current.value, height === undefined ? undefined : { height });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    event.stopPropagation();
    if (links.onKeyDown(event)) return;
    if (event.key === "Escape" || (event.key === "Enter" && (event.metaKey || event.ctrlKey))) {
      event.preventDefault();
      finish();
    }
  };

  return (
    <>
    <textarea
      ref={ref}
      className={`${className} nodrag nowheel nopan`}
      defaultValue={initial}
      placeholder={placeholder}
      spellCheck
      data-testid="board-text-editor"
      onBlur={finish}
      onKeyDown={onKeyDown}
      onInput={() => {
        links.update();
        if (ref.current) actions.draftText(node.id, ref.current.value);
      }}
      onKeyUp={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End") links.update();
      }}
      onClick={links.update}
      onPointerDown={(event) => event.stopPropagation()}
    />
    {links.popup}
    </>
  );
}

/**
 * Fitted sizes by `max|width×height|text`. Measuring forces several
 * synchronous layouts, and nodes remount whenever they scroll back into view
 * (`onlyRenderVisibleElements`), so zooming a big board out re-measured
 * hundreds of nodes per frame (#r6biyzx6). The same text in the same box fits
 * the same way, so remembered sizes skip the measuring.
 */
const fitCache = new Map<string, number>();

/**
 * The export stage (spec/v0-6 §D) fits all its text in one batch, and in its
 * own font, so its sizes are remembered apart from the screen's.
 */
export const FitBatchContext = createContext<FitBatch | null>(null);
const FIT_CACHE_LIMIT = 4000;

function rememberFit(key: string, size: number): void {
  if (fitCache.size >= FIT_CACHE_LIMIT) {
    // Drop the oldest entry (Map keeps insertion order).
    const oldest = fitCache.keys().next().value;
    if (oldest !== undefined) fitCache.delete(oldest);
  }
  fitCache.set(key, size);
}

/** Shrink-to-fit font size (stickies, shapes), like Miro: big when short. */
function useFitText(
  deps: unknown[],
  max: number,
  min = 10,
  cacheKey: string | null = null,
) {
  const ref = useRef<HTMLDivElement>(null);
  const batch = useContext(FitBatchContext);
  const key = cacheKey === null ? null : `${batch ? "export" : ""}|${max}|${cacheKey}`;
  const [size, setSize] = useState(() => (key !== null ? fitCache.get(key) : undefined) ?? max);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const known = key !== null ? fitCache.get(key) : undefined;
    if (known !== undefined) {
      setSize(known);
      return;
    }
    if (batch) {
      batch.add({
        element,
        max,
        min,
        done: (fitted) => {
          if (key !== null) rememberFit(key, fitted);
          setSize(fitted);
        },
      });
      return;
    }
    let low = min;
    let high = max;
    element.style.fontSize = `${high}px`;
    if (element.scrollHeight <= element.clientHeight + 1 && element.scrollWidth <= element.clientWidth + 1) {
      if (key !== null) rememberFit(key, high);
      setSize(high);
      return;
    }
    // Binary search the largest size that fits.
    while (high - low > 0.5) {
      const mid = (low + high) / 2;
      element.style.fontSize = `${mid}px`;
      if (element.scrollHeight <= element.clientHeight + 1 && element.scrollWidth <= element.clientWidth + 1) low = mid;
      else high = mid;
    }
    element.style.fontSize = `${low}px`;
    const fitted = Math.floor(low * 2) / 2;
    if (key !== null) rememberFit(key, fitted);
    setSize(fitted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { ref, size };
}

function nodeText(node: CanvasNode): string {
  return typeof node.text === "string" ? node.text : "";
}

export const StickyNode = memo(function StickyNode({ id, data, selected, width, height }: BoardNodeProps) {
  const { node, editing } = data;
  const text = nodeText(node);
  const w = width ?? node.width;
  const h = height ?? node.height;
  // While editing the textarea is measured live, so no cached size.
  const fit = useFitText([text, w, h, editing], 28, 10, editing ? null : `sticky|${w}x${h}|${text}`);
  return (
    <>
      <Resizer id={id} selected={data.resizable} minWidth={60} minHeight={60} />
      <ConnectHandles />
      <div className="board-sticky" style={colorStyle(node.color)} data-testid="board-sticky">
        <div ref={fit.ref} className="board-fit" style={{ fontSize: fit.size }}>
          {editing ? (
            <TextEditor node={node} className="board-textarea board-textarea-center" />
          ) : (
            <div className="board-text" data-text-size={textBucket(fit.size)}>
              {text ? <TextView text={text} node={data} /> : null}
            </div>
          )}
        </div>
      </div>
    </>
  );
});

export const TextNode = memo(function TextNode({ id, data, selected }: BoardNodeProps) {
  useT();
  const { node, editing } = data;
  const text = nodeText(node);
  return (
    <>
      <Resizer id={id} selected={data.resizable} minWidth={40} minHeight={24} />
      <ConnectHandles />
      <div className={`board-plain${text ? "" : " is-empty"}`} style={colorStyle(node.color)} data-testid="board-text">
        {editing ? (
          <TextEditor
            node={node}
            className="board-textarea"
            placeholder={t("board.typeSomething")}
            onHeight={(area) => (area.scrollHeight > node.height ? area.scrollHeight + 4 : undefined)}
          />
        ) : (
          <div className="board-text" data-text-size={textBucket(16)}>
            {text ? <TextView text={text} node={data} /> : t("board.typeSomething")}
          </div>
        )}
      </div>
    </>
  );
});

function ShapeOutline({ shape, width, height }: { shape: GumplyShape; width: number; height: number }) {
  const inset = 1;
  const w = Math.max(1, width - inset * 2);
  const h = Math.max(1, height - inset * 2);
  let outline: ReactNode;
  switch (shape) {
    case "ellipse":
      outline = <ellipse cx={width / 2} cy={height / 2} rx={w / 2} ry={h / 2} />;
      break;
    case "diamond":
      outline = (
        <polygon points={`${width / 2},${inset} ${width - inset},${height / 2} ${width / 2},${height - inset} ${inset},${height / 2}`} />
      );
      break;
    case "rounded":
      outline = <rect x={inset} y={inset} width={w} height={h} rx={Math.min(18, w / 4, h / 4)} />;
      break;
    default:
      outline = <rect x={inset} y={inset} width={w} height={h} rx={2} />;
  }
  return (
    <svg className="board-shape-svg" width={width} height={height} aria-hidden="true">
      {outline}
    </svg>
  );
}

export const ShapeNode = memo(function ShapeNode({ id, data, selected, width, height }: BoardNodeProps) {
  const { node, editing } = data;
  const extras = gumplyNodeData(node);
  const shape = extras?.kind === "shape" ? extras.shape : "rect";
  const text = nodeText(node);
  // Live size while resizing; the canvas node only changes on commit.
  const w = width ?? node.width;
  const h = height ?? node.height;
  const fit = useFitText([text, w, h, editing, shape], 18, 10, editing ? null : `${shape}|${w}x${h}|${text}`);
  return (
    <>
      <Resizer id={id} selected={data.resizable} />
      <ConnectHandles />
      <div className={`board-shape board-shape-${shape}`} style={colorStyle(node.color)} data-testid="board-shape" data-shape={shape}>
        <ShapeOutline shape={shape} width={w} height={h} />
        <div ref={fit.ref} className="board-fit board-shape-text" style={{ fontSize: fit.size }}>
          {editing ? (
            <TextEditor node={node} className="board-textarea board-textarea-center" />
          ) : (
            <div className="board-text" data-text-size={textBucket(fit.size)}>
              {text ? <TextView text={text} node={data} /> : null}
            </div>
          )}
        </div>
      </div>
    </>
  );
});

/* ------------------------------------------------------------------------ */
/* Ink                                                                       */
/* ------------------------------------------------------------------------ */

export const InkNode = memo(function InkNode({ id, data, selected }: BoardNodeProps) {
  const { node } = data;
  const extras = gumplyNodeData(node);
  const points: InkPoint[] = extras?.kind === "ink" ? extras.points : [];
  const width = extras?.kind === "ink" ? extras.width : 4;
  const path = useMemo(() => inkPath(points, width), [points, width]);
  const extent = useMemo(() => inkExtent(points, width), [points, width]);
  return (
    <>
      <Resizer id={id} selected={data.resizable} minWidth={8} minHeight={8} />
      <svg
        className="board-ink"
        width="100%"
        height="100%"
        viewBox={`0 0 ${extent.width} ${extent.height}`}
        preserveAspectRatio="none"
        style={{ color: solidColor(node.color) }}
        data-testid="board-ink"
      >
        <path d={path} />
      </svg>
    </>
  );
});

/* ------------------------------------------------------------------------ */
/* Frame                                                                     */
/* ------------------------------------------------------------------------ */

function FrameLabelEditor({ node }: { node: CanvasNode }) {
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
    actions.commitText(node.id, ref.current.value);
  };
  return (
    <input
      ref={ref}
      className="board-frame-input nodrag"
      defaultValue={typeof node.label === "string" ? node.label : ""}
      aria-label={t("board.frameName")}
      data-testid="board-frame-input"
      onInput={() => {
        if (ref.current) actions.draftText(node.id, ref.current.value);
      }}
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

export const FrameNode = memo(function FrameNode({ id, data, selected }: BoardNodeProps) {
  useT();
  const { node, editing } = data;
  const actions = useBoardActions();
  const label = typeof node.label === "string" ? node.label : "";
  return (
    <>
      <Resizer id={id} selected={data.resizable} minWidth={80} minHeight={60} />
      <div className="board-frame" style={colorStyle(node.color)} data-testid="board-frame">
        <div className="board-frame-label" onDoubleClick={(event) => {
          event.stopPropagation();
          actions.startEditing(id);
        }}>
          {editing ? <FrameLabelEditor node={node} /> : <span>{label || t("board.frame")}</span>}
        </div>
      </div>
    </>
  );
});

/* ------------------------------------------------------------------------ */
/* Cards: page, board, image, file, web link, unknown                        */
/* ------------------------------------------------------------------------ */

function baseName(path: string): string {
  const name = path.split("/").pop() ?? path;
  return name.replace(/\.(md|canvas)$/i, "");
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

function OpenButton({ node, label }: { node: CanvasNode; label: string }) {
  const actions = useBoardActions();
  return (
    <button
      type="button"
      className="board-card-open nodrag"
      aria-label={label}
      data-tooltip={label}
      data-testid="board-card-open"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        actions.openNode(node);
      }}
    >
      <BoardIcon name="open" size={14} />
    </button>
  );
}

/** Built-in card content; W2b's renderer replaces it with live previews. */
export function DefaultCard({ node, kind }: BoardCardRenderProps) {
  const file = typeof node.file === "string" ? node.file : "";
  switch (kind) {
    case "image":
      return <img className="board-card-image" src={fileUrl(file)} alt={baseName(file)} draggable={false} />;
    case "page":
    case "board":
      return (
        <div className="board-card-body">
          <div className="board-card-title">
            <BoardIcon name={kind === "board" ? "board" : "page"} size={16} />
            <span>{baseName(file)}</span>
          </div>
          <OpenButton node={node} label={kind === "board" ? t("board.cards.openBoard") : t("board.cards.openPage")} />
        </div>
      );
    case "file":
      return (
        <div className="board-card-body">
          <div className="board-card-title">
            <BoardIcon name="page" size={16} />
            <span>{file.split("/").pop()}</span>
          </div>
          <OpenButton node={node} label={t("board.cards.openFile")} />
        </div>
      );
    case "link": {
      const url = typeof node.url === "string" ? node.url : "";
      const safe = safeExternalUrl(url);
      // Unsafe URLs (javascript:, data:…) are shown as inert text, never opened.
      return (
        <div className="board-card-body">
          <div className="board-card-title">
            <BoardIcon name="link" size={16} />
            <span>{safe ? hostOf(url) : t("board.cards.link")}</span>
          </div>
          <div className="board-card-sub">{url}</div>
          {safe ? <OpenButton node={node} label={t("board.cards.openLink")} /> : null}
        </div>
      );
    }
    default:
      return (
        <div className="board-card-body">
          <div className="board-card-sub">{t("board.cards.unsupported", { type: String(node.type) })}</div>
        </div>
      );
  }
}

export const CardNode = memo(function CardNode({ id, data, selected }: BoardNodeProps) {
  useT();
  const { node, kind } = data;
  const renderers = useBoardRenderers();
  const props: BoardCardRenderProps = { node, kind, selected };
  return (
    <>
      <Resizer id={id} selected={data.resizable} keepAspectRatio={kind === "image"} minWidth={60} minHeight={40} />
      <ConnectHandles />
      <div className={`board-card board-card-${kind}`} style={colorStyle(node.color)} data-testid={`board-card-${kind}`}>
        {renderers.card ? renderers.card(props) : <DefaultCard {...props} />}
      </div>
    </>
  );
});

export const NODE_TYPES = {
  sticky: StickyNode,
  text: TextNode,
  shape: ShapeNode,
  ink: InkNode,
  frame: FrameNode,
  card: CardNode,
};
