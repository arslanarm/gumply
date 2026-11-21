/**
 * Shrink-to-fit for many boxes at once (the export stage, spec/v0-6 §D).
 * Fitting one box is a binary search where every step writes a font size
 * and reads the layout back: about seven synchronous layouts per box, so a
 * 1000-object board needed thousands of them. Here every box takes each step
 * together: all writes, then all reads, so a step costs one layout for all.
 * Results are the same as fitting each box on its own.
 */

export interface FitTarget {
  element: HTMLElement;
  max: number;
  min: number;
  done: (size: number) => void;
}

const fits = (element: HTMLElement): boolean =>
  element.scrollHeight <= element.clientHeight + 1 && element.scrollWidth <= element.clientWidth + 1;

/** Fit every target; each `done` gets the largest size that fits (in 0.5 px steps). */
export function fitAll(targets: readonly FitTarget[]): void {
  const live = targets.filter((target) => target.element.isConnected);
  for (const target of live) target.element.style.fontSize = `${target.max}px`;
  const searching: Array<FitTarget & { low: number; high: number; mid: number }> = [];
  for (const target of live) {
    if (fits(target.element)) target.done(target.max);
    else searching.push({ ...target, low: target.min, high: target.max, mid: target.max });
  }
  while (searching.length > 0) {
    for (const item of searching) {
      item.mid = (item.low + item.high) / 2;
      item.element.style.fontSize = `${item.mid}px`;
    }
    for (const item of searching) {
      if (fits(item.element)) item.low = item.mid;
      else item.high = item.mid;
    }
    for (let index = searching.length - 1; index >= 0; index -= 1) {
      const item = searching[index]!;
      if (item.high - item.low > 0.5) continue;
      searching.splice(index, 1);
      item.element.style.fontSize = `${item.low}px`;
      item.done(Math.floor(item.low * 2) / 2);
    }
  }
}

/** Collects the boxes of one render and fits them together after it. */
export class FitBatch {
  private pending: FitTarget[] = [];
  private scheduled = false;

  add(target: FitTarget): void {
    this.pending.push(target);
    if (this.scheduled) return;
    this.scheduled = true;
    // After the commit's layout effects (all boxes registered), before paint.
    queueMicrotask(() => this.flush());
  }

  /** Fit everything registered so far. */
  flush(): void {
    this.scheduled = false;
    const batch = this.pending;
    this.pending = [];
    if (batch.length > 0) fitAll(batch);
  }

  /** Whether boxes are waiting to be fitted. */
  get busy(): boolean {
    return this.scheduled || this.pending.length > 0;
  }
}
