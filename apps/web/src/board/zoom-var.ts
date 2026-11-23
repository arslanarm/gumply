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

/**
 * Where dots can show: the whole board with the connector tool, else the
 * selected objects and the hovered one. The hovered object is passed in
 * (tracked from pointer events): matching `:hover` in a query can make the
 * browser bring styles up to date first, on every step.
 */
export function zoomVarTargets(
  root: Element,
  wholeBoard: boolean,
  hovered: Element | null = null,
  /** The selected objects when the caller already has them (a hover change needn't query the board again). */
  selected?: readonly HTMLElement[],
): HTMLElement[] {
  if (wholeBoard) return [root as HTMLElement];
  const targets = selected ? [...selected] : [...root.querySelectorAll<HTMLElement>(".react-flow__node.selected")];
  if (hovered && hovered.isConnected && root.contains(hovered) && !targets.includes(hovered as HTMLElement)) targets.push(hovered as HTMLElement);
  return targets;
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
