import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { E2E_VAULT } from './env';

/**
 * #w284vn2u: the vault-level settings files tests change (a property's type, graph groups, the AI-app
 * settings, templates and daily notes, "not a copy"), put back before and after every test, so file order
 * can't change what a test sees. The server reads these per request (the types file is cached by its
 * mtime), so a put-back file is read again.
 *
 * - `.gumply/<name>` for the names below: the bytes, or absent.
 * - `.obsidian/`: absent, or every file under it, at any depth (bytes; symlinks skipped): a test may create the
 *   folder, or add or change a file anywhere in it (`snippets/`, `plugins/`; @polish-dev's review).
 *
 * **The baseline is taken once per run**, in the Playwright main process when the config loads (before the
 * web server starts and before any worker), and handed to the workers through a file named in
 * `GUMPLY_E2E_SETTINGS_BASELINE`. A per-worker snapshot would be wrong: Playwright starts a new worker after a
 * failed test, and that worker would take the failed test's leftovers as its baseline (@lead's review).
 *
 * History, conflicts, Trash and logs aren't settings, and the `vault` fixture's reset already clears pages.
 */
const GUMPLY_FILES = ['types.json', 'graph.json', 'mcp.json', 'templates.json', 'daily-notes.json', 'sync-dismissed.json'];
const BASELINE_ENV = 'GUMPLY_E2E_SETTINGS_BASELINE';

export interface SettingsSnapshot {
  gumply: Map<string, string | null>;
  /** Path under `.obsidian/` → its bytes as base64; null: no `.obsidian/`. */
  obsidian: Map<string, string> | null;
}

const gumplyPath = (name: string) => path.join(E2E_VAULT, '.gumply', name);
const obsidianDir = () => path.join(E2E_VAULT, '.obsidian');
const readOrNull = (file: string) => readFile(file, 'utf8').catch(() => null);
/** `.obsidian/` may hold binary files (plugins): its bytes are kept as base64. */
const bytesB64Sync = (file: string): string | null => {
  try {
    return readFileSync(file).toString('base64');
  } catch {
    return null;
  }
};
const bytesB64 = (file: string) => readFile(file).then((data) => data.toString('base64'), () => null);
const readOrNullSync = (file: string): string | null => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

function obsidianFilesSync(): Map<string, string> | null {
  const files = new Map<string, string>();
  const walk = (dir: string, prefix: string): boolean => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else if (entry.isFile()) {
        const text = bytesB64Sync(path.join(dir, entry.name));
        if (text !== null) files.set(rel, text);
      }
    }
    return true;
  };
  return walk(obsidianDir(), '') ? files : null;
}

function snapshotSettingsSync(): SettingsSnapshot {
  const gumply = new Map<string, string | null>();
  for (const name of GUMPLY_FILES) gumply.set(name, readOrNullSync(gumplyPath(name)));
  const obsidian = obsidianFilesSync();
  return { gumply, obsidian };
}

/**
 * The run's baseline. The first call (the main process, from the config) snapshots the vault and writes it to
 * a temp file named in the env; the workers inherit the env and read that file. Without it (a config that
 * didn't call this), a worker snapshots on its own.
 */
export function runSettingsBaseline(): SettingsSnapshot {
  const file = process.env[BASELINE_ENV];
  if (file) {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as { gumply: Array<[string, string | null]>; obsidian: Array<[string, string]> | null };
      return { gumply: new Map(data.gumply), obsidian: data.obsidian === null ? null : new Map(data.obsidian) };
    } catch {
      // Unreadable: fall through and take one now.
    }
  }
  const snapshot = snapshotSettingsSync();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gumply-e2e-settings-'));
  const target = path.join(dir, 'baseline.json');
  writeFileSync(target, JSON.stringify({ gumply: [...snapshot.gumply], obsidian: snapshot.obsidian === null ? null : [...snapshot.obsidian] }));
  process.env[BASELINE_ENV] = target;
  return snapshot;
}

/** Global teardown: remove the baseline's temp folder. */
export function removeRunSettingsBaseline(): void {
  const file = process.env[BASELINE_ENV];
  if (file) rmSync(path.dirname(file), { recursive: true, force: true });
}

async function obsidianFiles(): Promise<Map<string, string> | null> {
  const files = new Map<string, string>();
  const walk = async (dir: string, prefix: string): Promise<boolean> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
      else if (entry.isFile()) {
        const text = await bytesB64(path.join(dir, entry.name));
        if (text !== null) files.set(rel, text);
      }
    }
    return true;
  };
  return (await walk(obsidianDir(), '')) ? files : null;
}

const sameFiles = (a: Map<string, string>, b: Map<string, string>) =>
  a.size === b.size && [...a].every(([name, text]) => b.get(name) === text);

/** Put the settings files back as `snapshot` had them. A file already equal is left alone (no mtime churn). */
export async function restoreSettings(snapshot: SettingsSnapshot): Promise<void> {
  for (const [name, text] of snapshot.gumply) {
    const file = gumplyPath(name);
    const now = await readOrNull(file);
    if (now === text) continue;
    if (text === null) await rm(file, { force: true });
    else {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, text, 'utf8');
    }
  }
  const now = await obsidianFiles();
  if (snapshot.obsidian === null) {
    if (now !== null) await rm(obsidianDir(), { recursive: true, force: true });
    return;
  }
  if (now !== null && sameFiles(now, snapshot.obsidian)) return;
  // Anything differs (a file added, changed or removed at any depth): the folder is put back whole.
  await rm(obsidianDir(), { recursive: true, force: true });
  await mkdir(obsidianDir(), { recursive: true });
  for (const [name, text] of snapshot.obsidian) {
    const file = path.join(obsidianDir(), ...name.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, Buffer.from(text, 'base64'));
  }
}
