import { useLayoutEffect, useRef, type ReactNode } from "react";
import { useViewport } from "@xyflow/react";

/** The room kept between the toolbar and the board's edge or the tool rail. */
const GAP = 8;

/**
 * #4quachkv (visual QA 5): a selection's toolbar is centred over the selection, so on a narrow window
 * it ran under the tool rail and off the board's left edge, hiding its first swatches. This keeps it
 * inside the board and clear of the rail by sliding it sideways; it only moves when it would be cut.
 * It re-measures on every render and every pan or zoom (the toolbar follows the selection).
 */
export function ClampedToolbar({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Subscribed so a pan or a zoom re-renders this, and the effect below re-measures.
  useViewport();

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const current = Number(element.dataset.shift ?? 0);
    const rect = element.getBoundingClientRect();
    const left = rect.left - current;
    const right = rect.right - current;
    const flow = element.closest(".react-flow");
    if (!flow) return;
    const bounds = flow.getBoundingClientRect();
    let min = bounds.left + GAP;
    const rail = flow.parentElement?.querySelector<HTMLElement>(".board-toolbar");
    if (rail) {
      const railRect = rail.getBoundingClientRect();
      const overlapsVertically = rect.bottom > railRect.top && rect.top < railRect.bottom;
      if (overlapsVertically) min = Math.max(min, railRect.right + GAP);
    }
    const max = bounds.right - GAP;
    let shift = 0;
    if (left < min) shift = min - left;
    else if (right > max) shift = Math.max(min - left, max - right);
    if (shift !== current) {
      element.dataset.shift = String(shift);
      element.style.transform = shift ? `translateX(${shift}px)` : "";
    }
  });

  return (
    <div ref={ref} className="board-context-clamp">
      {children}
    </div>
  );
}
