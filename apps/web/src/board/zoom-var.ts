/**
 * `--board-zoom` only where it's used (#zkknytrs). Connection dots divide
 * their size by it so they stay ~11 px on screen at any zoom. Written on the
 * board root, every zoom step restyled every object and re-laid-out all four
 * dots of each, though they're hidden: at 1,000 objects that was most of each
 * Ctrl+wheel frame. Dots only show on the hovered object, on selected ones,
 * and everywhere with the connector tool, so the variable goes on those
 * elements alone (the root only for the connector tool).
 */

/** The smallest part of an element this needs (tests use plain objects). */
export interface ZoomVarElement {
  readonly isConnected: boolean;
  style: { setProperty(name: string, value: string): void; removeProperty(name: string): string };
}

/** Where dots can show: the whole board with the connector tool, else the hovered and selected objects. */
export function zoomVarTargets(root: Element, wholeBoard: boolean): HTMLElement[] {
  if (wholeBoard) return [root as HTMLElement];
  return [...root.querySelectorAll<HTMLElement>(".react-flow__node.selected, .react-flow__node:hover")];
}

/**
 * Keeps `--board-zoom` on exactly the given targets: writes only where the
 * value changed and removes it from elements that are no longer targets.
 */
export function createZoomVar<E extends ZoomVarElement = HTMLElement>() {
  const written = new Map<E, string>();
  return {
    sync(targets: Iterable<E>, zoom: number): void {
      const value = String(zoom);
      const next = new Set(targets);
      for (const element of [...written.keys()]) {
        if (next.has(element)) continue;
        written.delete(element);
        if (element.isConnected) element.style.removeProperty("--board-zoom");
      }
      for (const element of next) {
        if (written.get(element) === value) continue;
        written.set(element, value);
        element.style.setProperty("--board-zoom", value);
      }
    },
  };
}
