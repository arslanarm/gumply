/**
 * D47 (#xhdjpaev): a title rename's link rewrite runs in batches after the
 * file has moved (#xgnvipyd). The journal lets it survive a crash: one entry
 * per running rename in `.gumply/rename-pending.json` (spec/file-format §3.4),
 * written right after the move, removed when the rewrite is done. At startup a
 * pending entry is finished (VaultStore.resumePendingRenames).
 *
 * The file is Gumply's own and safe to delete (links not yet rewritten then
 * stay as they are). One this version can't read is left untouched, never
 * overwritten.
 */
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic } from "./temp-files.js";

export const RENAME_JOURNAL = join(".gumply", "rename-pending.json");
const VERSION = 1;

export interface PendingRename {
  /** The renamed page's id before and after (equal for a title-only rename). */
  oldId: string;
  newId: string;
  oldTitle: string;
  newTitle: string;
  /** The installation that started it (app data, never the vault): only it resumes a recent one. */
  instance: string;
  /** ISO time; an entry older than RESUME_ANY_AFTER_MS may be finished by any installation. */
  startedAt: string;
}

/** D47: a rename left by another installation is finished by this one once it is this old (a lost device). */
export const RESUME_ANY_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

type Read = { ok: true; entries: PendingRename[] } | { ok: false };

function isEntry(value: unknown): value is PendingRename {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return ["oldId", "newId", "oldTitle", "newTitle", "instance", "startedAt"].every((key) => typeof entry[key] === "string");
}

export class RenameJournal {
  private readonly file: string;
  /** Writes one at a time (renames of different pages can run at once). */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly root: string) {
    this.file = join(root, RENAME_JOURNAL);
  }

  /** The entries, or `ok: false` for a file this version can't read (left as it is). No file = no entries. */
  async read(): Promise<Read> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch {
      return { ok: true, entries: [] };
    }
    try {
      const data = JSON.parse(text) as { version?: unknown; renames?: unknown };
      if (data.version !== VERSION || !Array.isArray(data.renames) || !data.renames.every(isEntry)) return { ok: false };
      return { ok: true, entries: data.renames };
    } catch {
      return { ok: false };
    }
  }

  add(entry: PendingRename): Promise<void> {
    return this.update((entries) => [...entries, entry]);
  }

  remove(match: (entry: PendingRename) => boolean): Promise<void> {
    return this.update((entries) => entries.filter((entry) => !match(entry)));
  }

  private update(change: (entries: PendingRename[]) => PendingRename[]): Promise<void> {
    const run = this.chain.then(async () => {
      const current = await this.read();
      if (!current.ok) {
        console.warn(`[gumply] ${RENAME_JOURNAL} is in a format this version can't read: left as it is`);
        return;
      }
      const next = change(current.entries);
      if (next.length === current.entries.length && next.every((entry, i) => entry === current.entries[i])) return;
      if (next.length === 0) {
        await rm(this.file, { force: true });
        return;
      }
      await mkdir(join(this.root, ".gumply"), { recursive: true });
      await writeAtomic(this.file, `${JSON.stringify({ version: VERSION, renames: next }, null, 2)}\n`);
    });
    this.chain = run.catch(() => undefined);
    return run;
  }
}
