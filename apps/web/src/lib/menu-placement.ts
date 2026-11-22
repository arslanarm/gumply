/**
 * Where a floating menu goes (#sjts42ue): measured, never off-screen, never
 * under the sidebar footer (the menu is a fixed-position portal above it).
 *
 * - **Below a button:** right-aligned to it, just under it; flipped above it
 *   when there's no room below.
 * - **At a point** (right-click): its top-left corner at the pointer; flipped
 *   up and/or left when it would run past the bottom or right edge.
 * - **Taller than the space either way:** moved to fit inside the viewport,
 *   and if it's taller than the viewport itself, pinned to the top with a
 *   `maxHeight`, so it scrolls inside.
 *
 * Always at least `MENU_MARGIN` px inside the viewport.
 */

export const MENU_MARGIN = 8;
const GAP = 4;

export interface AnchorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type MenuAnchor = { button: AnchorRect } | { point: { x: number; y: number } };

export interface MenuPlacement {
  left: number;
  top: number;
  /** Set only when the menu is taller than the viewport allows: it scrolls. */
  maxHeight?: number;
  /** The menu opens upwards (for the pop-in animation's origin). */
  above: boolean;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

export function placeMenu(
  anchor: MenuAnchor,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): MenuPlacement {
  const room = viewport.height - 2 * MENU_MARGIN;
  const tooTall = size.height > room;
  const height = tooTall ? room : size.height;
  const lowest = viewport.height - MENU_MARGIN - height;

  let left: number;
  let top: number;
  let above = false;
  if ("button" in anchor) {
    const { button } = anchor;
    left = button.right - size.width;
    const below = button.bottom + GAP;
    const up = button.top - GAP - height;
    if (below <= lowest) top = below;
    else if (up >= MENU_MARGIN) {
      top = up;
      above = true;
    } else top = clamp(below, MENU_MARGIN, lowest);
  } else {
    const { point } = anchor;
    left = point.x + size.width > viewport.width - MENU_MARGIN ? point.x - size.width : point.x;
    if (point.y <= lowest) top = point.y;
    else if (point.y - height >= MENU_MARGIN) {
      top = point.y - height;
      above = true;
    } else top = clamp(point.y, MENU_MARGIN, lowest);
  }

  left = clamp(left, MENU_MARGIN, Math.max(MENU_MARGIN, viewport.width - MENU_MARGIN - size.width));
  top = Math.max(MENU_MARGIN, top);
  return tooTall ? { left, top, maxHeight: room, above } : { left, top, above };
}
