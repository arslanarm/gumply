import { useCallback, useEffect, useRef, type RefObject } from "react";

/**
 * Keep the keyboard-selected option inside its menu's scroll container.
 * Menus are capped at 300px and page through more items than fit, so without
 * this the active row can sit below the fold while ↑/↓ keep moving the index
 * (walkthrough #wkjnj4fz).
 */
export function useActiveOptionVisible(
  containerRef: RefObject<HTMLElement | null>,
  index: number,
  itemCount: number,
): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const option = container.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
    if (!option) return;

    const menuRect = container.getBoundingClientRect();
    const optionRect = option.getBoundingClientRect();
    if (optionRect.top < menuRect.top) {
      container.scrollTop -= menuRect.top - optionRect.top;
    } else if (optionRect.bottom > menuRect.bottom) {
      container.scrollTop += optionRect.bottom - menuRect.bottom;
    }
  }, [containerRef, index, itemCount]);
}

// Last pointer position seen anywhere, so a menu can tell a real move from
// the synthetic hover a row gets when it appears under a resting mouse.
let lastPointer: { x: number; y: number } | null = null;
if (typeof window !== "undefined") {
  window.addEventListener(
    "mousemove",
    (event) => {
      lastPointer = { x: event.clientX, y: event.clientY };
    },
    { capture: true, passive: true },
  );
}

/**
 * Hover selects a row only after the pointer really moved since the menu
 * opened (#smwaixfp): opening Cmd+K or `/` under a resting mouse must keep
 * the first row active. Use the returned function in `onMouseMove`.
 */
export function usePointerMovedSinceOpen(): (event: { clientX: number; clientY: number }) => boolean {
  const origin = useRef(lastPointer);
  const moved = useRef(false);
  return useCallback((event) => {
    if (moved.current) return true;
    const start = origin.current;
    if (!start || start.x !== event.clientX || start.y !== event.clientY) moved.current = true;
    return moved.current;
  }, []);
}
