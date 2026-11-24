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

export interface BaseSaverOptions {
  /** Write `config` (conditional on `expectedUpdated`, or forced). */
  send: (config: BaseConfig, options: { expectedUpdated: string; force: boolean }) => Promise<SaveBaseResult>;
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
  private conflicted = false;
  private version: string;
  private chain: Promise<void> = Promise.resolve();

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

  /** Changes not yet on disk: queued, being written, or held by a conflict. */
  isDirty(): boolean {
    return this.pending !== null || this.writing || this.conflicted;
  }

  inConflict(): boolean {
    return this.conflicted;
  }

  /** Queue `config`; written at once unless a conflict waits for the user. */
  save(config: BaseConfig): Promise<void> {
    this.pending = config;
    if (this.conflicted) return this.chain;
    return this.run(false);
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
      try {
        const result = await this.options.send(config, { expectedUpdated: this.version, force });
        force = false;
        this.version = result.meta.updated;
        this.writing = false;
        this.options.onSaved(result, this.pending !== null);
      } catch (error) {
        this.writing = false;
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
