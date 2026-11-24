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

/** Whether the character at `index` is escaped: an odd run of backslashes before it. */
function escapedAt(text: string, index: number): boolean {
  let slashes = 0;
  for (let at = index - 1; at >= 0 && text[at] === "\\"; at--) slashes += 1;
  return slashes % 2 === 1;
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
  const caption = size && !escapedAt(alt, size.index) ? alt.slice(0, size.index) : alt;
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
 * The width to write for "the full column". No size means the image's natural size (capped at the
 * column), so that's only right when the picture is at least as wide as the column; a narrower one
 * gets the column in pixels, or "full width" would shrink it back to its natural size.
 */
export function fullColumnWidth(natural: number | null | undefined, column: number): number | null {
  return natural !== null && natural !== undefined && natural > 0 && natural < column ? Math.round(column) : null;
}

/**
 * The next width for a keyboard step: `direction` +1 grows to the next snap,
 * -1 shrinks to the one below. The full column is `fullColumnWidth(natural, column)`.
 */
export function steppedWidth(current: number | null, column: number, direction: 1 | -1, natural?: number | null): number | null {
  const share = current === null || column <= 0 ? 1 : Math.min(1, current / column);
  const steps = [...WIDTH_STEPS];
  const next =
    direction > 0 ? (steps.find((step) => step > share + 0.01) ?? 1) : ([...steps].reverse().find((step) => step < share - 0.01) ?? steps[0]!);
  return next >= 1 ? fullColumnWidth(natural, column) : Math.round(next * column);
}

interface ImageAttrsLike {
  src?: unknown;
  alt?: unknown;
  title?: unknown;
  obsidian?: unknown;
  markdownRaw?: unknown;
  markdownRawKey?: unknown;
  /** The whole alt is a caption: a `|N` the user typed at its end is text, not a width. */
  altLiteral?: unknown;
}

/**
 * An image's alt split into caption and size (#3zpgenmw). The parsed alt no longer shows whether
 * a `|` was escaped: `![A\\|300](a.png)` is the caption "A|300" (how Gumply writes a caption typed
 * that way), not a width. So while the image's text as written is current, it decides: a size only
 * when its alt ends in an unescaped `|N`. With no such text (made in the editor), the alt as is.
 */
export function altParts(attrs: ImageAttrsLike): AltWidth {
  const alt = String(attrs.alt ?? "");
  if (attrs.altLiteral === true) return { text: alt, width: null, size: null };
  const raw = typeof attrs.markdownRaw === "string" ? attrs.markdownRaw : "";
  if (raw && attrs.markdownRawKey === rawKey(attrs.src, attrs.alt, attrs.title)) {
    const written = /^!\[((?:\\.|[^\]\\])*)\]/.exec(raw)?.[1];
    if (written !== undefined) {
      const size = SIZE.exec(written);
      if (!size || escapedAt(written, size.index) || Number(size[1]) === 0) return { text: alt, width: null, size: null };
    }
  }
  return splitAltWidth(alt);
}

/** A block image's width in pixels (from its embed or its alt), or null. */
export function imageWidthOf(attrs: ImageAttrsLike): number | null {
  if (typeof attrs.obsidian === "string" && attrs.obsidian) return embedWidth(attrs.obsidian);
  return altParts(attrs).width;
}

/** A block image's caption: its alt without the size. */
export function imageCaptionOf(attrs: ImageAttrsLike): string {
  return altParts(attrs).text;
}

/**
 * The attributes that change when a block image gets `width` (null: none).
 * Only the size changes in its text as written (D37): an embed's `|N`, or a
 * Markdown image's alt and its recorded original text.
 */
export function widthPatch(attrs: ImageAttrsLike, width: number | null): Record<string, unknown> {
  if (typeof attrs.obsidian === "string" && attrs.obsidian) return { obsidian: embedWithWidth(attrs.obsidian, width) };
  const { alt, altLiteral } = altFor(imageCaptionOf(attrs), width);
  // The text as written only while it still describes this image: after a caption edit it's stale
  // (the serializer ignores it), and stamping it with a fresh key would write the old caption back.
  const current = typeof attrs.markdownRaw === "string" && attrs.markdownRaw && attrs.markdownRawKey === rawKey(attrs.src, attrs.alt, attrs.title);
  const raw = current ? markdownWithWidth(attrs.markdownRaw as string, width) : null;
  return raw === null
    ? { alt, altLiteral, markdownRaw: null, markdownRawKey: null }
    : { alt, altLiteral, markdownRaw: raw, markdownRawKey: rawKey(attrs.src, alt, attrs.title) };
}

/**
 * The alt for `caption` at `width`, and whether it must be read as a caption only: with no width,
 * a caption that itself ends in `|digits` (typed by the user, or a literal `A\\|300`) would read
 * back as a size, so it's marked literal and the serializers escape its pipe.
 */
export function altFor(caption: string, width: number | null): { alt: string; altLiteral: boolean } {
  if (width !== null) return { alt: joinAltWidth(caption, width), altLiteral: false };
  return { alt: caption, altLiteral: SIZE.test(caption) };
}

/**
 * The `altLiteral` node attribute. It goes into the HTML as `data-alt-literal`, so a copy and paste
 * (which goes through HTML) keeps «B|300» a caption instead of turning it into a 300 px width.
 * A sized image says `"false"`, so the copy keeps its width. Where the HTML has no mark:
 * - from Markdown (`data-md-raw`), the text as written decides (`altParts`);
 * - from another app or a web page, an alt ending in `|N` is caption text: HTML alt has no
 *   Obsidian meaning (@opus-editor's review: `<img alt="Revenue | 2024">` isn't 2024 px wide).
 */
export const altLiteralAttribute = {
  default: false,
  parseHTML: (element: { getAttribute(name: string): string | null; hasAttribute?(name: string): boolean }) => {
    const mark = element.getAttribute("data-alt-literal");
    if (mark !== null) return mark === "true";
    if (element.hasAttribute?.("data-md-raw")) return false;
    return SIZE.test(element.getAttribute("alt") ?? "");
  },
  // The effective reading (`altParts`): a file's `![A\|301]` is a caption through its kept raw
  // text, which the HTML doesn't carry, so the mark has to say it (@opus-editor's re-read).
  renderHTML: (attributes: Record<string, unknown>) => {
    if (attributes.altLiteral === true) return { "data-alt-literal": "true" };
    if (!SIZE.test(String(attributes.alt ?? ""))) return {};
    return { "data-alt-literal": altParts(attributes as ImageAttrsLike).width === null ? "true" : "false" };
  },
};

/** The attributes for a new caption the user typed, keeping the image's size as written. */
export function captionPatch(attrs: ImageAttrsLike, caption: string): { alt: string; altLiteral: boolean } {
  const { size } = altParts(attrs);
  // With a size, the last `|N` is it and everything before is the caption, so no mark is needed.
  return size === null ? altFor(caption, null) : { alt: `${caption}|${size}`, altLiteral: false };
}
