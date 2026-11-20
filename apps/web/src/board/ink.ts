/** Freehand strokes with `perfect-freehand` (spec/whiteboard §3, Pen). */
import type { InkPoint } from "@gumply/core";
import { getStroke } from "perfect-freehand";

export const DEFAULT_INK_WIDTH = 4;

/** Mouse input reports a flat 0.5 pressure; let the stroke simulate it then. */
function hasRealPressure(points: readonly (readonly number[])[]): boolean {
  return points.some((point) => point[2] !== undefined && point[2] !== 0.5 && point[2] !== 0);
}

/** An SVG path (`d`) for the outline of a stroke through `points`. */
export function inkPath(points: readonly (readonly number[])[], width: number, complete = true): string {
  if (points.length === 0) return "";
  const outline = getStroke(points as number[][], {
    size: width,
    thinning: 0.55,
    smoothing: 0.5,
    streamline: 0.45,
    simulatePressure: !hasRealPressure(points),
    last: complete,
  });
  return outlineToPath(outline);
}

/** Smooth closed path through an outline's points (quadratic midpoints). */
export function outlineToPath(outline: number[][]): string {
  const count = outline.length;
  if (count < 2) return "";
  const fmt = (value: number): string => (Math.round(value * 100) / 100).toString();
  const first = outline[0] as number[];
  let d = `M${fmt(first[0] ?? 0)},${fmt(first[1] ?? 0)}Q`;
  for (let i = 0; i < count; i += 1) {
    const a = outline[i] as number[];
    const b = outline[(i + 1) % count] as number[];
    const ax = a[0] ?? 0;
    const ay = a[1] ?? 0;
    d += `${fmt(ax)},${fmt(ay)} ${fmt((ax + (b[0] ?? 0)) / 2)},${fmt((ay + (b[1] ?? 0)) / 2)} `;
  }
  return `${d.trimEnd()}Z`;
}

/** The natural box of stored points (what the node was drawn at), for scaling. */
export function inkExtent(points: readonly InkPoint[], width: number): { width: number; height: number } {
  let maxX = 0;
  let maxY = 0;
  for (const [x, y] of points) {
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const pad = Math.ceil(width / 2) + 2;
  return { width: Math.max(1, maxX + pad), height: Math.max(1, maxY + pad) };
}
