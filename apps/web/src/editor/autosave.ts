/**
 * Debounced autosave with serialised writes.
 *
 * One instance per open page. The UI shows `state` through `save-status`;
 * e2e waits for `data-state="saved"`. Writes never reject: failures keep the
 * pending value so the next edit or `flush()` retries, and surface as
 * `state === "error"`.
 */

export type SaveState = "idle" | "saving" | "saved" | "error";

export interface AutosaveOptions {
  /** Persist one snapshot. May reject; Autosave converts that to `error`. */
  save: (value: string) => Promise<void>;
  onState?: (state: SaveState) => void;
  /** Debounce in ms (default 600). */
  delay?: number;
}

export class Autosave {
  private readonly saveValue: (value: string) => Promise<void>;
  private readonly onState: ((state: SaveState) => void) | undefined;
  private readonly delay: number;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: string | null = null;
  private lastSaved = "";
  private status: SaveState = "idle";
  private chain: Promise<void> = Promise.resolve();

  constructor(options: AutosaveOptions) {
    this.saveValue = options.save;
    this.onState = options.onState;
    this.delay = options.delay ?? 600;
  }

  get state(): SaveState {
    return this.status;
  }

  /** Treat `value` as the persisted baseline (call after loading a page). */
  reset(value: string): void {
    this.clearTimer();
    this.pending = null;
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
    this.setStatus("saving");
    this.clearTimer();
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
    void this.flush();
  }

  private async drain(): Promise<void> {
    while (this.pending !== null) {
      const value = this.pending;
      this.pending = null;

      if (value === this.lastSaved) continue;

      this.setStatus("saving");
      try {
        await this.saveValue(value);
        this.lastSaved = value;
      } catch {
        // Keep the newest unsaved snapshot for the next attempt.
        if (this.pending === null) this.pending = value;
        this.setStatus("error");
        return;
      }
    }

    if (this.status === "saving") this.setStatus("saved");
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private setStatus(next: SaveState): void {
    if (this.status === next) return;
    this.status = next;
    this.onState?.(next);
  }
}
