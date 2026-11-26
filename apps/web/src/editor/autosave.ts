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
 *
 * Leaving the page (#3t6v62cb): `flushOnExit()` sends what is pending right
 * now, synchronously, with `exitSave` (a `keepalive` request that outlives
 * the page). It reports whether that was possible, so the caller can warn
 * instead (too big for keepalive, a conflict, no `exitSave`).
 */

export type SaveState = "idle" | "saving" | "saved" | "error" | "conflict";

export interface AutosaveOptions {
  /**
   * Persist one snapshot. May reject; Autosave converts that to `error`. May resolve to the text
   * the server actually wrote when it differs from `value` (N10: a Keep mine that kept a rename's
   * link changes); that becomes the saved baseline.
   */
  save: (value: string) => Promise<void | string>;
  onState?: (state: SaveState) => void;
  /** Debounce in ms (default 600). */
  delay?: number;
  /** Show `saving` only after a write has been in flight this long (default 500). */
  indicatorDelay?: number;
  /** Treat this error as "page changed on disk" and stop automatic retries. */
  isConflict?: (error: unknown) => boolean;
  /** #bajn9rna: the error a failed write ended with (shown as the reason, e.g. a read-only file). */
  onError?: (error: unknown) => void;
  /**
   * Start a write that survives the page unloading (`fetch` with
   * `keepalive`), synchronously. `afterInFlight`: a normal write is still
   * running, so this one lands after it. Return null when it can't be sent
   * (e.g. over the 64 KB keepalive limit).
   */
  exitSave?: (value: string, afterInFlight: boolean) => Promise<void> | null;
}

export class Autosave {
  private readonly saveValue: (value: string) => Promise<void | string>;
  private readonly onState: ((state: SaveState) => void) | undefined;
  private readonly delay: number;
  private readonly indicatorDelay: number;
  private readonly isConflict: ((error: unknown) => boolean) | undefined;
  private readonly exitSave: AutosaveOptions["exitSave"];
  private readonly onError: AutosaveOptions["onError"];

  private timer: ReturnType<typeof setTimeout> | null = null;
  private indicatorTimer: ReturnType<typeof setTimeout> | null = null;
  private pending: string | null = null;
  private lastSaved = "";
  private status: SaveState = "idle";
  private writing = false;
  /** The value a normal write is sending right now. */
  private inFlight: string | null = null;
  /** The value an exit (keepalive) write is sending right now. */
  private exiting: string | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(options: AutosaveOptions) {
    this.saveValue = options.save;
    this.onState = options.onState;
    this.delay = options.delay ?? 600;
    this.indicatorDelay = options.indicatorDelay ?? 500;
    this.isConflict = options.isConflict;
    this.exitSave = options.exitSave;
    this.onError = options.onError;
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
    this.inFlight = null;
    this.exiting = null;
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
    // Stay in conflict until the user chooses Reload / Keep mine.
    if (this.status === "conflict") return;
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

  /** Retry after a conflict (used by "Keep mine"). */
  retry(): Promise<void> {
    if (this.status === "conflict") this.setStatus("idle");
    return this.flush();
  }

  /** #z9hufufn: the persisted baseline (what the server last had from or gave this editor). */
  baseline(): string {
    return this.lastSaved;
  }

  /**
   * #z9hufufn: the server rewrote the page itself (a rename's link changes) and the editor took that in
   * place: `value` is the new baseline. Pending and in-flight writes are left as they are.
   */
  rebase(value: string): void {
    this.lastSaved = value;
  }

  /** True while local edits are newer than the last successful save. */
  isDirty(): boolean {
    return this.pending !== null || this.writing || this.exiting !== null;
  }

  /** The last write failed or conflicted: these edits are not on disk. */
  hasFailed(): boolean {
    return this.status === "error" || this.status === "conflict";
  }

  /**
   * The page is going away (reload, close, quit): send the newest unsaved
   * value now with `exitSave`. True when nothing is left unsent; false when it
   * couldn't be sent (the caller warns before unloading).
   */
  flushOnExit(): boolean {
    this.clearTimer();
    if (this.status === "conflict") return false;
    // A normal write still in flight may be cancelled by the unload: resend it.
    const value = this.pending ?? (this.writing ? this.inFlight : null);
    if (value === null) return true;
    if (value === this.lastSaved && !this.writing) {
      this.pending = null;
      return true;
    }
    if (value === this.exiting) return true;
    const request = this.exitSave?.(value, this.writing) ?? null;
    if (!request) return false;
    if (this.pending === value) this.pending = null;
    this.exiting = value;
    request.then(
      () => {
        if (this.exiting === value) this.exiting = null;
        this.lastSaved = value;
        if (!this.isDirty()) this.setStatus("saved");
      },
      (error: unknown) => {
        if (this.exiting === value) this.exiting = null;
        if (this.pending === null && value !== this.lastSaved) this.pending = value;
        this.onError?.(error);
        this.setStatus(this.isConflict?.(error) ? "conflict" : "error");
      },
    );
    return true;
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
      this.inFlight = value;
      this.startIndicatorTimer();
      try {
        const written = await this.saveValue(value);
        this.lastSaved = typeof written === "string" ? written : value;
        wrote = true;
      } catch (error) {
        // Keep the newest unsaved snapshot for the next attempt.
        if (this.pending === null) this.pending = value;
        this.writing = false;
        this.inFlight = null;
        this.clearIndicatorTimer();
        this.onError?.(error);
        if (this.isConflict?.(error)) {
          this.setStatus("conflict");
          return;
        }
        this.setStatus("error");
        return;
      }
      this.writing = false;
      this.inFlight = null;
      this.clearIndicatorTimer();
    }

    if (wrote && !this.isDirty()) this.setStatus("saved");
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
