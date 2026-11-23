import type { PageId } from "@gumply/core";

/**
 * #4tquqqdv: this app's own confirmed saves of a page, as a chain of
 * `from` (the version a save replaced) → `to` (the version it answered with).
 *
 * The History dialog reads its page's version when it opens. If the editor's
 * autosave lands after that, the dialog's version is one of *our own* saves
 * behind, and a restore with it was refused ("changed while you were
 * looking"). `follow` moves a version forward through our own saves only:
 * an outside change, or a save whose answer we never saw, leaves a gap, so the
 * version stays as it was and the server still refuses (D41: a real outside
 * change is never restored over silently).
 *
 * Per page, bounded, and cleared when the open page changes.
 */
export class OwnSaves {
  private readonly chains = new Map<PageId, Array<{ from: string; to: string }>>();

  constructor(private readonly limit = 20) {}

  /** A save of `id` that replaced `from` was confirmed as `to`. */
  record(id: PageId, from: string | null | undefined, to: string): void {
    if (!from || from === to) return;
    const chain = this.chains.get(id) ?? [];
    chain.push({ from, to });
    if (chain.length > this.limit) chain.splice(0, chain.length - this.limit);
    this.chains.set(id, chain);
  }

  /** `version` moved forward through our own saves of `id` (unchanged when none follows it). */
  follow(id: PageId, version: string): string {
    const chain = this.chains.get(id);
    if (!chain) return version;
    let current = version;
    // At most one step per link: the chain can't loop us forever.
    for (let step = 0; step < chain.length; step += 1) {
      const link = chain.find((candidate) => candidate.from === current);
      if (!link) break;
      current = link.to;
    }
    return current;
  }

  /** Forget every page but `keep` (the open page changed). */
  keepOnly(keep: PageId | null): void {
    for (const id of [...this.chains.keys()]) if (id !== keep) this.chains.delete(id);
  }
}
