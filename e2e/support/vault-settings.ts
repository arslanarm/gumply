import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { E2E_VAULT } from './env';

/**
 * #w284vn2u: the vault-level settings files tests change (a property's type, graph groups, the AI-app
 * settings, templates and daily notes, "not a copy"), snapshotted once per worker and put back before and
 * after every test, so file order can't change what a test sees. The server reads these per request
 * (the types file is cached by its mtime), so a put-back file is read again.
 *
 * - `.gumply/<name>` for the names below: the bytes, or absent.
 * - `.obsidian/`: absent, or its top-level files (bytes); a test may create the folder or add a file there.
 *
 * History, conflicts, Trash and logs aren't settings, and the `vault` fixture's reset already clears pages.
 */
const GUMPLY_FILES = ['types.json', 'graph.json', 'mcp.json', 'templates.json', 'daily-notes.json', 'sync-dismissed.json'];

export interface SettingsSnapshot {
  gumply: Map<string, string | null>;
  obsidian: Map<string, string> | null;
}

const gumplyPath = (name: string) => path.join(E2E_VAULT, '.gumply', name);
const obsidianDir = () => path.join(E2E_VAULT, '.obsidian');
const readOrNull = (file: string) => readFile(file, 'utf8').catch(() => null);

async function obsidianFiles(): Promise<Map<string, string> | null> {
  let entries;
  try {
    entries = await readdir(obsidianDir(), { withFileTypes: true });
  } catch {
    return null;
  }
  const files = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const text = await readOrNull(path.join(obsidianDir(), entry.name));
    if (text !== null) files.set(entry.name, text);
  }
  return files;
}

export async function snapshotSettings(): Promise<SettingsSnapshot> {
  const gumply = new Map<string, string | null>();
  for (const name of GUMPLY_FILES) gumply.set(name, await readOrNull(gumplyPath(name)));
  return { gumply, obsidian: await obsidianFiles() };
}

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
  await mkdir(obsidianDir(), { recursive: true });
  for (const name of now?.keys() ?? []) {
    if (!snapshot.obsidian.has(name)) await rm(path.join(obsidianDir(), name), { force: true });
  }
  for (const [name, text] of snapshot.obsidian) {
    if (now?.get(name) !== text) await writeFile(path.join(obsidianDir(), name), text, 'utf8');
  }
}
