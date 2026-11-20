import { useEffect, type RefObject } from "react";

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
