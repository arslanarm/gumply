/**
 * JSON Canvas colours → CSS. Presets `"1"`–`"6"` map to theme variables
 * (`--board-c1`… in board.css, tuned for light and dark); hex colours are used
 * as they are, with soft fills mixed against the page surface.
 */
import { isPresetColor } from "@gumply/core";
import type { CSSProperties } from "react";

export interface PaletteEntry {
  value: string | undefined;
  label: string;
}

/** The palette offered in the UI: default plus Obsidian's six presets. */
export const PALETTE: readonly PaletteEntry[] = [
  { value: undefined, label: "Default" },
  { value: "1", label: "Red" },
  { value: "2", label: "Orange" },
  { value: "3", label: "Yellow" },
  { value: "4", label: "Green" },
  { value: "5", label: "Cyan" },
  { value: "6", label: "Purple" },
];

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** The solid colour (lines, borders, ink) for a node/edge colour. */
export function solidColor(color: unknown): string | undefined {
  if (isPresetColor(color)) return `var(--board-c${color})`;
  if (typeof color === "string" && HEX.test(color)) return color;
  return undefined;
}

/**
 * CSS variables for a node: `--node-color` (solid), `--node-fill` (soft
 * background) and `--node-sticky` (sticky-note paper).
 */
export function colorStyle(color: unknown): CSSProperties {
  if (isPresetColor(color)) {
    return {
      "--node-color": `var(--board-c${color})`,
      "--node-fill": `var(--board-c${color}-fill)`,
      "--node-sticky": `var(--board-c${color}-sticky)`,
    } as CSSProperties;
  }
  if (typeof color === "string" && HEX.test(color)) {
    return {
      "--node-color": color,
      "--node-fill": `color-mix(in srgb, ${color} 16%, var(--board-surface))`,
      "--node-sticky": `color-mix(in srgb, ${color} 34%, var(--board-surface))`,
    } as CSSProperties;
  }
  return {};
}
