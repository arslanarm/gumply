/**
 * #ups4ikpj (D22): a database view's config saves, one at a time, with the
 * same conflict rule as pages. A save that meets a 409 (the `.base` changed
 * on disk: Obsidian, sync, a restore) keeps the user's change instead of
 * dropping it: the view stays as the user made it and reports `conflict`.
 * Later changes replace the pending one but aren't sent until the user
 * chooses: Keep mine sends it as a forced save (the server keeps the disk
 * version in `.gumply/conflicts/`), Reload drops it (the app reloads the view).
 */
import type { BaseConfig } from "@gumply/core";
import type { SaveBaseResult } from "../api/client.js";
import type { PendingSaver } from "../lib/pending-saves.js";

export interface BaseSaverOptions {
  /** Write `config` (conditional on `expectedUpdated`, or forced). */
  send: (config: BaseConfig, options: { expectedUpdated: string; force: boolean }) => Promise<SaveBaseResult>;
  /**
   * #wrr9fjn9: the page is going away (reload, close, quit): send `config` now with a request that
   * outlives it, conditional on `expectedUpdated`. Null when it can't be sent (too big).
   */
  sendOnExit?: (config: BaseConfig, options: { expectedUpdated: string }) => Promise<SaveBaseResult> | null;
  /** A save landed. `pending` is true when a newer change is still to be sent. */
  onSaved: (result: SaveBaseResult, pending: boolean) => void;
  /** A save met a changed file: the change is kept, waiting for the user's choice. */
  onConflict: () => void;
  /** Any other failure: the change is dropped (the view shows the file as it is). */
  onError: (error: unknown) => void;
  isConflict: (error: unknown) => boolean;
}

export class BaseSaver {
  private pending: BaseConfig | null = null;
  private writing = false;
  /** The change a normal save is sending right now (an exit resends it: the unload may cancel it). */
  private inFlight: BaseConfig | null = null;
  /** The change an exit (keepalive) save is sending. */
  private exiting: BaseConfig | null = null;
  private conflicted = false;
  private version: string;
  private chain: Promise<void> = Promise.resolve();
  /** #bg7c9bzk: failed sends (errors and conflicts) so far, so a save can tell whether its change landed. */
  private failures = 0;

  constructor(
    version: string,
    private readonly options: BaseSaverOptions,
  ) {
    this.version = version;
  }

  /** The version the next save is conditional on (the view loaded the file again). */
  setVersion(version: string): void {
    if (!this.isDirty()) this.version = version;
  }

  /** Changes not yet on disk: queued, being written (also on the way out), or held by a conflict. */
  isDirty(): boolean {
    return this.pending !== null || this.writing || this.conflicted || this.exiting !== null;
  }

  /**
   * #wrr9fjn9: the page is going away: send the newest change now with a keepalive save. True when
   * nothing is left unsent; false when it couldn't be (a conflict waits for the user, or too big).
   */
  flushOnExit(): boolean {
    if (this.conflicted) return false;
    const config = this.pending ?? (this.writing ? this.inFlight : null);
    if (config === null) return true;
    if (config === this.exiting) return true;
    const request = this.options.sendOnExit?.(config, { expectedUpdated: this.version }) ?? null;
    if (!request) return false;
    if (this.pending === config) this.pending = null;
    this.exiting = config;
    request.then(
      (result) => {
        if (this.exiting === config) this.exiting = null;
        this.version = result.meta.updated;
        this.options.onSaved(result, this.pending !== null);
      },
      () => {
        if (this.exiting === config) this.exiting = null;
        // Not sent after all (the page stayed): keep it for the next save.
        if (this.pending === null) this.pending = config;
      },
    );
    return true;
  }

  inConflict(): boolean {
    return this.conflicted;
  }

  /**
   * Queue `config`; written at once unless a conflict waits for the user. Resolves true when it was written,
   * false when a send failed meanwhile (an error, or a conflict that now holds it) or a conflict already held it.
   */
  async save(config: BaseConfig): Promise<boolean> {
    this.pending = config;
    if (this.conflicted) {
      await this.chain;
      return false;
    }
    const failures = this.failures;
    await this.run(false);
    return this.failures === failures && !this.conflicted;
  }

  /** Keep mine: send the held change as a forced save. */
  keepMine(): Promise<void> {
    if (!this.conflicted) return this.chain;
    this.conflicted = false;
    return this.run(true);
  }

  /** Drop the held change (Reload, or a view with no save bar); the caller shows the file again. */
  discard(): Promise<void> {
    this.pending = null;
    this.conflicted = false;
    return this.chain;
  }

  /** Wait for what is being written now. */
  flush(): Promise<void> {
    return this.chain;
  }

  private run(force: boolean): Promise<void> {
    this.chain = this.chain.then(() => this.drain(force));
    return this.chain;
  }

  private async drain(forceFirst: boolean): Promise<void> {
    let force = forceFirst;
    while (this.pending !== null && !this.conflicted) {
      const config = this.pending;
      this.pending = null;
      this.writing = true;
      this.inFlight = config;
      try {
        const result = await this.options.send(config, { expectedUpdated: this.version, force });
        force = false;
        this.version = result.meta.updated;
        this.writing = false;
        this.inFlight = null;
        this.options.onSaved(result, this.pending !== null);
      } catch (error) {
        this.writing = false;
        this.inFlight = null;
        this.failures += 1;
        if (this.options.isConflict(error)) {
          // Keep the newest change: the one that failed, unless the user made a newer one since.
          if (this.pending === null) this.pending = config;
          this.conflicted = true;
          this.options.onConflict();
          return;
        }
        this.pending = null;
        this.options.onError(error);
        return;
      }
    }
  }
}

/** #wrr9fjn9: the view's entry in the pending-saves registry (quit, History and a reload flush it). */
export function pendingSaverFor(saver: BaseSaver): PendingSaver {
  return {
    kind: "base",
    isDirty: () => saver.isDirty(),
    hasFailed: () => saver.inConflict(),
    flush: () => saver.flush(),
    flushOnExit: () => saver.flushOnExit(),
  };
}
