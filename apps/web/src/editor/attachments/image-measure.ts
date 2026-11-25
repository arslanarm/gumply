/**
 * #e9bd64bb (D46): one way to measure a block image, shared by the resize
 * handles, Shift+←/→ and the width announcement, so "50%" means the same
 * pixels whichever is used (also inside a callout, a column or a list).
 */

/** The image block's `<figure>` from its node view DOM (the renderer's wrapper, or the figure). */
export function imageFigureOf(dom: Element | null | undefined): HTMLElement | null {
  if (!dom) return null;
  if (dom instanceof HTMLElement && dom.matches("figure.image-block")) return dom;
  return dom.querySelector<HTMLElement>("figure.image-block");
}

/** The width the image can use: its figure's own width (the column it sits in). */
export function imageColumnWidth(figure: HTMLElement | null): number {
  return figure?.clientWidth ?? 0;
}

/** The picture's drawn width; with no width set, that's its natural size capped at the column. */
export function renderedImageWidth(figure: HTMLElement | null): number {
  return figure?.querySelector("img")?.getBoundingClientRect().width ?? 0;
}

/** The picture's own width in pixels (0 until it has loaded). */
export function naturalImageWidth(figure: HTMLElement | null): number {
  return figure?.querySelector("img")?.naturalWidth ?? 0;
}

/** The width as a share of the column, in %: a set width, else the drawn one. */
export function imageWidthPercent(width: number | null, figure: HTMLElement | null): number {
  const column = imageColumnWidth(figure);
  const shown = width ?? renderedImageWidth(figure);
  if (column <= 0 || shown <= 0) return 100;
  return Math.min(100, Math.round((shown / column) * 100));
}

/** Event a keyboard step sends to the image's view when the width is already at a limit. */
export const IMAGE_WIDTH_LIMIT_EVENT = "gumply-image-width-limit";
