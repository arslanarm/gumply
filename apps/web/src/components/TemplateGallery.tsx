/**
 * "New whiteboard" gallery (spec/v0-6 §D): Blank plus the built-in templates,
 * each with a small preview drawn from the template's own data. Arrow keys
 * move, Enter picks, Escape closes; Blank is picked by default, so New
 * whiteboard + Enter still makes an empty board.
 */
import type { CanvasBoard, CanvasNode } from "@gumply/core";
import { canvasBounds, gumplyNodeData, isPresetColor } from "@gumply/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { BOARD_TEMPLATES, type BoardTemplateId } from "../board/templates.js";
// The board palette (--board-c1…) lives with the board styles.
import "../board/board.css";
import { useLanguage, useT } from "../i18n/index.js";

export interface TemplateGalleryProps {
  onCancel: () => void;
  /** `null` is Blank. */
  onSelect: (template: BoardTemplateId | null) => void;
}

interface Choice {
  id: BoardTemplateId | null;
  name: string;
  description: string;
  board: CanvasBoard | null;
}

const COLUMNS = 3;

function fill(node: CanvasNode, kind: string): string {
  const color = isPresetColor(node.color) ? node.color : null;
  if (kind === "sticky") return color ? `var(--board-c${color}-sticky)` : "var(--board-sticky-default)";
  if (kind === "group") return color ? `var(--board-c${color}-fill)` : "color-mix(in srgb, var(--board-ink) 4%, transparent)";
  return color ? `var(--board-c${color}-fill)` : "var(--panel)";
}

function stroke(node: CanvasNode): string {
  return isPresetColor(node.color) ? `var(--board-c${node.color})` : "color-mix(in srgb, var(--board-ink) 30%, transparent)";
}

/** A miniature of a board: frames, stickies, shapes, text lines and connectors. */
export function TemplatePreview({ board }: { board: CanvasBoard }) {
  const bounds = canvasBounds(board.nodes) ?? { x: 0, y: 0, width: 1, height: 1 };
  const pad = Math.max(bounds.width, bounds.height) * 0.06;
  const byId = new Map(board.nodes.map((node) => [node.id, node]));
  const centre = (node: CanvasNode) => ({ x: node.x + node.width / 2, y: node.y + node.height / 2 });
  return (
    <svg
      className="template-preview"
      viewBox={`${bounds.x - pad} ${bounds.y - pad} ${bounds.width + pad * 2} ${bounds.height + pad * 2}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      {board.edges.map((edge) => {
        const from = byId.get(edge.fromNode);
        const to = byId.get(edge.toNode);
        if (!from || !to) return null;
        const a = centre(from);
        const b = centre(to);
        return <line key={edge.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="template-preview-edge" />;
      })}
      {board.nodes.map((node) => {
        const data = gumplyNodeData(node);
        const kind = node.type === "group" ? "group" : (data?.kind ?? node.type);
        const common = { key: node.id, fill: fill(node, kind), stroke: stroke(node), strokeWidth: 0, vectorEffect: "non-scaling-stroke" };
        if (kind === "group") return <rect {...common} x={node.x} y={node.y} width={node.width} height={node.height} rx={8} strokeWidth={1} />;
        if (kind === "sticky") return <rect {...common} x={node.x} y={node.y} width={node.width} height={node.height} rx={3} />;
        if (kind === "shape" && data?.kind === "shape") {
          const { x, y, width: w, height: h } = node;
          if (data.shape === "ellipse") return <ellipse {...common} cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} strokeWidth={1.25} />;
          if (data.shape === "diamond")
            return <polygon {...common} points={`${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}`} strokeWidth={1.25} />;
          return <rect {...common} x={x} y={y} width={w} height={h} rx={data.shape === "rounded" ? 14 : 0} strokeWidth={1.25} />;
        }
        // Plain text: a line where the words would be.
        const h = Math.min(node.height, 18);
        return <rect key={node.id} className="template-preview-text" x={node.x} y={node.y + (node.height - h) / 2} width={node.width * 0.7} height={h} rx={h / 2} />;
      })}
    </svg>
  );
}

export function TemplateGallery({ onCancel, onSelect }: TemplateGalleryProps) {
  const t = useT();
  const language = useLanguage();
  const choices = useMemo<Choice[]>(
    () => [
      { id: null, name: t("templates.blank.name"), description: t("templates.blank.description"), board: null },
      ...BOARD_TEMPLATES.map((template) => ({
        id: template.id,
        name: template.name(),
        description: template.description(),
        board: template.build(),
      })),
    ],
    // Previews and names follow the language.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [language],
  );
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.focus();
  }, [index]);

  // The gallery owns the keyboard while open, wherever focus is (the page
  // editor can take focus back while the gallery's code loads).
  const latest = useRef({ onCancel, onSelect, index, choices });
  latest.current = { onCancel, onSelect, index, choices };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const { onCancel: cancel, onSelect: select, index: current, choices: all } = latest.current;
      const step = ({ ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLUMNS, ArrowUp: -COLUMNS } as Record<string, number>)[event.key];
      if (event.key === "Escape") cancel();
      else if (event.key === "Enter" || event.key === " ") select(all[current]?.id ?? null);
      else if (step !== undefined) setIndex(Math.min(all.length - 1, Math.max(0, current + step)));
      // Focus stays in the dialog.
      else if (event.key === "Tab") setIndex((current + (event.shiftKey ? -1 : 1) + all.length) % all.length);
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        className="modal template-gallery"
        role="dialog"
        aria-modal="true"
        aria-labelledby="template-gallery-title"
        data-testid="template-gallery"
      >
        <h2 id="template-gallery-title">{t("templates.galleryTitle")}</h2>
        <div className="template-grid" ref={listRef} role="listbox" aria-label={t("templates.galleryLabel")}>
          {choices.map((choice, choiceIndex) => (
            <button
              key={choice.id ?? "blank"}
              type="button"
              role="option"
              aria-selected={choiceIndex === index}
              data-index={choiceIndex}
              tabIndex={choiceIndex === index ? 0 : -1}
              className={`template-card${choiceIndex === index ? " is-active" : ""}`}
              data-testid={`template-${choice.id ?? "blank"}`}
              onFocus={() => setIndex(choiceIndex)}
              onClick={() => onSelect(choice.id)}
            >
              <span className="template-thumb">
                {choice.board ? <TemplatePreview board={choice.board} /> : <span className="template-blank" aria-hidden="true">+</span>}
              </span>
              <span className="template-name">{choice.name}</span>
              <span className="template-description">{choice.description}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
