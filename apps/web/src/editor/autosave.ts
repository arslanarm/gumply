/**
 * Debounced autosave with serialised writes.
 *
 * One instance per open page. The UI shows `state` through `save-status`;
 * e2e waits for `data-state="saved"`. Writes never reject: failures keep the
 * pending value so the next edit or `flush()` retries, and surface as
 * `state === "error"`.
 *
 * `saving` is deliberately delayed (spec/ux §7): a fast local write goes
 * straight from blank idle to `saved`, so "Saving…" never flashes on every
 * keystroke. It only appears if a write is still running after 500ms.
 */

export type SaveState = "idle" | "saving" | "saved" | "error";

export interface AutosaveOptions {
  /** Persist one snapshot. May reject; Autosave converts that to `error`. */
  save: (value: string) => Promise<void>;
  onState?: (state: SaveState) => void;
  /** Debounce in ms (default 600). */
  delay?: number;
  /** Show `saving` only after a write has been in flight this long (default 500). */
  indicatorDelay?: number;
}

export class Autosave {
  private readonly saveValue: (value: string) => Promise<void>;
  private readonly onState: ((state: SaveState) => void) | undefined;
  private readonly delay: number;
  private readonly indicatorDelay: number;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private indicatorTimer: ReturnType<typeof setTimeout> | null = null;
  private pending: string | null = null;
  private lastSaved = "";
  private status: SaveState = "idle";
  private writing = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(options: AutosaveOptions) {
    this.saveValue = options.save;
    this.onState = options.onState;
    this.delay = options.delay ?? 600;
    this.indicatorDelay = options.indicatorDelay ?? 500;
  }

  get state(): SaveState {
    return this.status;
  }

  /** Treat `value` as the persisted baseline (call after loading a page). */
  reset(value: string): void {
    this.clearTimer();
    this.clearIndicatorTimer();
    this.pending = null;
    this.writing = false;
    this.lastSaved = value;
    this.setStatus("idle");
  }

  /** Queue `value`; writes happen after `delay` of quiet. */
  schedule(value: string): void {
    if (value === this.lastSaved && this.pending === null) {
      this.clearTimer();
      return;
    }

    this.pending = value;
    this.clearTimer();
    // Typing hides a stale "Saved" label, but a write already in flight keeps
    // its "Saving…" state, and an unresolved error stays visible until retry.
    if (!this.writing && this.status !== "error") this.setStatus("idle");
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.delay);
  }

  /** Write immediately (page switch, Cmd+S, unmount). Safe to call anytime. */
  flush(): Promise<void> {
    this.clearTimer();
    this.chain = this.chain.then(() => this.drain());
    return this.chain;
  }

  /** Flush what is pending and stop the debounce timer. */
  dispose(): void {
    this.clearTimer();
    this.clearIndicatorTimer();
    void this.flush();
  }

  private async drain(): Promise<void> {
    let wrote = false;

    while (this.pending !== null) {
      const value = this.pending;
      this.pending = null;

      if (value === this.lastSaved) continue;

      this.writing = true;
      this.startIndicatorTimer();
      try {
        await this.saveValue(value);
        this.lastSaved = value;
        wrote = true;
      } catch {
        // Keep the newest unsaved snapshot for the next attempt.
        if (this.pending === null) this.pending = value;
        this.writing = false;
        this.clearIndicatorTimer();
        this.setStatus("error");
        return;
      }
      this.writing = false;
      this.clearIndicatorTimer();
    }

    if (wrote) this.setStatus("saved");
  }

  private startIndicatorTimer(): void {
    this.clearIndicatorTimer();
    this.indicatorTimer = setTimeout(() => {
      this.indicatorTimer = null;
      if (this.writing && this.status !== "error") this.setStatus("saving");
    }, this.indicatorDelay);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private clearIndicatorTimer(): void {
    if (this.indicatorTimer !== null) {
      clearTimeout(this.indicatorTimer);
      this.indicatorTimer = null;
    }
  }

  private setStatus(next: SaveState): void {
    if (this.status === next) return;
    this.status = next;
    this.onState?.(next);
  }
}
