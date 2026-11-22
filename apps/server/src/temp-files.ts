import { lstat, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Temp files for atomic writes (#e9hs2zgq, spec/sync-conflicts §7).
 *
 * Every write into the vault goes to a temp file in the **same folder**, then
 * a rename over the target, so the replace stays atomic. The temp is named
 * `.~gumply-<pid>-<ms>-<n>.tmp`:
 * - the leading dot hides it in Finder and file managers, and Gumply's own
 *   scan and watcher skip dot-names;
 * - `.~` is a prefix Dropbox never syncs;
 * - `<n>` keeps two writes in one folder in the same millisecond apart.
 *
 * A crash can leave one behind; `sweepTempFiles` removes **only these**, once
 * they're a day old, and never anything else.
 */

const TEMP_NAME = /^\.~gumply-\d+-\d+-\d+\.tmp$/;
const DAY_MS = 24 * 60 * 60 * 1000;
let counter = 0;

/** A fresh temp path beside `file`, for write-then-rename. */
export function tempPathBeside(file: string): string {
  counter = (counter + 1) % 1_000_000;
  return join(dirname(file), `.~gumply-${process.pid}-${Date.now()}-${counter}.tmp`);
}

/**
 * Write `data` to `file` atomically: a temp beside it, then a rename. If either
 * step fails the temp is removed at once (not left for the sweep) and the
 * original error is thrown.
 */
export async function writeAtomic(file: string, data: string | Uint8Array): Promise<void> {
  const temp = tempPathBeside(file);
  try {
    await writeFile(temp, data);
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** True for a name `tempPathBeside` makes. */
export function isGumplyTempName(name: string): boolean {
  return TEMP_NAME.test(basename(name));
}

/**
 * Remove Gumply's own temp files older than `maxAgeMs` (a day): in the vault's
 * page folders (dot-folders and `node_modules` aside, as the scan does), in
 * `.gumply/` at any depth, and at the top of `.obsidian/`. Only regular files
 * with exactly the temp name; never a symlink, never another tool's file.
 * Best effort: errors are ignored (the next start tries again).
 */
export async function sweepTempFiles(root: string, now = Date.now(), maxAgeMs = DAY_MS): Promise<string[]> {
  const removed: string[] = [];
  const sweepDir = async (dir: string, descend: (name: string) => boolean): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        if (descend(entry.name)) await sweepDir(path, descend);
        continue;
      }
      if (!entry.isFile() || !TEMP_NAME.test(entry.name)) continue;
      try {
        const stats = await lstat(path);
        if (!stats.isFile() || now - stats.mtimeMs <= maxAgeMs) continue;
        await rm(path, { force: true });
        removed.push(path);
      } catch {
        // Gone already, or not ours to fail on.
      }
    }
  };
  await sweepDir(root, (name) => !name.startsWith(".") && name !== "node_modules");
  await sweepDir(join(root, ".gumply"), () => true);
  await sweepDir(join(root, ".obsidian"), () => false);
  return removed;
}
