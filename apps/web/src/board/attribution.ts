import { useEffect, type RefObject } from "react";

/**
 * #b9425ktw (#fzrwse3y's P4 8): React Flow's attribution link stays visible (its licence asks for it), but it isn't
 * a Tab stop: it sat between the board's controls and the page, one more stop with nothing to do there. Checked
 * after every render, as React Flow may render it again.
 */
export function useAttributionOutOfTabOrder(root: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const link = root.current?.querySelector<HTMLElement>(".react-flow__attribution a");
    if (link && link.tabIndex !== -1) link.tabIndex = -1;
  });
}
