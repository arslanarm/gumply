import { rawKey } from "./image-raw.js";

/**
 * #e9bd64bb (D46): a block image's width, in Obsidian's own syntax, so
 * Obsidian shows the same size:
 * - an embed `![[photo.png|300]]` (also read: `|300x200`, kept as written);
 * - a Markdown image `![Caption|300](photo.png)`: the width ends the alt text.
 * Pixels, as Obsidian reads them. No width means the image's natural size,
 * capped at the page column. An untouched image keeps its bytes (D37); a
 * resize rewrites only that image's text, and clearing the width gives the
 * original text back.
 */

/** `|300` or `|300x200` at the end of an alt text or an embed's target. */
const SIZE = /\|\s*(\d{1,4})(?:\s*x\s*(\d{1,4}))?\s*$/;

export interface AltWidth {
  /** The caption without the size. */
  text: string;
  /** Width in pixels, or null. */
  width: number | null;
  /** The size as written (`300`, `300x200`), kept while the width is unchanged. */
  size: string | null;
}

/** Split a Markdown image's alt text (`Caption|300`) into caption and width. */
export function splitAltWidth(alt: string): AltWidth {
  const match = SIZE.exec(alt);
  if (!match || Number(match[1]) === 0) return { text: alt, width: null, size: null };
  return { text: alt.slice(0, match.index), width: Number(match[1]), size: alt.slice(match.index + 1).trim() };
}

/** The alt text for `caption` at `width` (null: no size). */
export function joinAltWidth(caption: string, width: number | null): string {
  return width === null ? caption : `${caption}|${Math.round(width)}`;
}

/** An embed's width (`![[x.png|300]]`, `|300x200`), or null. */
export function embedWidth(embed: string | null | undefined): number | null {
  const match = embed ? /\|\s*(\d{1,4})(?:\s*x\s*\d{1,4})?\s*\]\]$/.exec(embed) : null;
  return match && Number(match[1]) > 0 ? Number(match[1]) : null;
}

/** The embed with its width set to `width` (null: removed). Other `|text` stays. */
export function embedWithWidth(embed: string, width: number | null): string {
  const close = embed.lastIndexOf("]]");
  if (close < 0) return embed;
  const inner = embed.slice(0, close);
  const match = SIZE.exec(inner);
  const base = match ? inner.slice(0, match.index) : inner;
  return `${base}${width === null ? "" : `|${Math.round(width)}`}${embed.slice(close)}`;
}

/**
 * The Markdown image text as written, with its alt's size set to `width`
 * (null: removed); null when it isn't a plain `![alt](…)` the caller can edit.
 */
export function markdownWithWidth(markdown: string, width: number | null): string | null {
  const match = /^!\[((?:\\.|[^\]\\])*)\]\(/.exec(markdown);
  if (!match) return null;
  const alt = match[1]!;
  const size = SIZE.exec(alt);
  // A `|` written escaped (`\|`) is part of the caption, not a size.
  const caption = size && alt[size.index - 1] !== "\\" ? alt.slice(0, size.index) : alt;
  const next = width === null ? caption : `${caption}|${Math.round(width)}`;
  return `![${next}](${markdown.slice(match[0].length)}`;
}

/** Widths a resize snaps to: these shares of the page column. */
export const WIDTH_STEPS = [0.25, 0.5, 0.75, 1] as const;

/** The snap step nearest to `width` in a `column` px wide (as a share). */
export function nearestStep(width: number, column: number): number {
  const share = column > 0 ? width / column : 1;
  return WIDTH_STEPS.reduce((best, step) => (Math.abs(step - share) < Math.abs(best - share) ? step : best), WIDTH_STEPS[0]);
}

/**
 * The next width for a keyboard step: `direction` +1 grows to the next snap,
 * -1 shrinks to the one below. Null means "full column" (no size written).
 */
export function steppedWidth(current: number | null, column: number, direction: 1 | -1): number | null {
  const share = current === null || column <= 0 ? 1 : Math.min(1, current / column);
  const steps = [...WIDTH_STEPS];
  const next =
    direction > 0 ? (steps.find((step) => step > share + 0.01) ?? 1) : ([...steps].reverse().find((step) => step < share - 0.01) ?? steps[0]!);
  return next >= 1 ? null : Math.round(next * column);
}

interface ImageAttrsLike {
  src?: unknown;
  alt?: unknown;
  title?: unknown;
  obsidian?: unknown;
  markdownRaw?: unknown;
  markdownRawKey?: unknown;
}

/** A block image's width in pixels (from its embed or its alt), or null. */
export function imageWidthOf(attrs: ImageAttrsLike): number | null {
  if (typeof attrs.obsidian === "string" && attrs.obsidian) return embedWidth(attrs.obsidian);
  return splitAltWidth(String(attrs.alt ?? "")).width;
}

/** A block image's caption: its alt without the size. */
export function imageCaptionOf(attrs: ImageAttrsLike): string {
  return splitAltWidth(String(attrs.alt ?? "")).text;
}

/**
 * The attributes that change when a block image gets `width` (null: none).
 * Only the size changes in its text as written (D37): an embed's `|N`, or a
 * Markdown image's alt and its recorded original text.
 */
export function widthPatch(attrs: ImageAttrsLike, width: number | null): Record<string, unknown> {
  if (typeof attrs.obsidian === "string" && attrs.obsidian) return { obsidian: embedWithWidth(attrs.obsidian, width) };
  const alt = joinAltWidth(imageCaptionOf(attrs), width);
  // The text as written only while it still describes this image: after a caption edit it's stale
  // (the serializer ignores it), and stamping it with a fresh key would write the old caption back.
  const current = typeof attrs.markdownRaw === "string" && attrs.markdownRaw && attrs.markdownRawKey === rawKey(attrs.src, attrs.alt, attrs.title);
  const raw = current ? markdownWithWidth(attrs.markdownRaw as string, width) : null;
  return raw === null
    ? { alt, markdownRaw: null, markdownRawKey: null }
    : { alt, markdownRaw: raw, markdownRawKey: rawKey(attrs.src, alt, attrs.title) };
}

/** The alt for a new caption, keeping the image's size as written. */
export function altWithCaption(attrs: ImageAttrsLike, caption: string): string {
  const { size } = splitAltWidth(String(attrs.alt ?? ""));
  return size === null ? caption : `${caption}|${size}`;
}
