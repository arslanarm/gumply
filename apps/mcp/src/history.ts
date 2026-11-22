/**
 * Version history (spec/mcp §4, D35): the layout 0.9's version history uses,
 * so 0.9 extends it with no migration.
 *
 *   .gumply/history/<page key>/<YYYYMMDDTHHMMSSmmmZ>.<md|canvas>   exact bytes
 *   .gumply/history/<page key>/index.jsonl                         one line per version
 *
 * Every MCP write saves the version it replaces here first, so a crash between
 * the two leaves an extra entry, never a lost version. Retention per page: the
 * newest 50 versions or 30 days, whichever keeps more; never the newest.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const HISTORY_DIR = join(".gumply", "history");
export const KEEP_VERSIONS = 50;
export const KEEP_MS = 30 * 86_400_000;

export interface HistoryEntry {
  file: string;
  at: string;
  id: string;
  version: string;
  source: "mcp" | "app" | "external";
  tool?: string;
  client?: string;
  bytes: number;
  sha256: string;
}

/**
 * The page id as one directory name: `/` → `%2F`, and `%` plus characters
 * unsafe on Windows or macOS percent-encoded. Reversible with decodeURIComponent.
 */
export function pageKey(id: string): string {
  return id.replace(/[%/\\<>:"|?*\x00-\x1f\x7f]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

/** UTC `YYYYMMDDTHHMMSSmmmZ`: sorts as text. */
export function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(".", "");
}

export interface SaveVersion {
  id: string;
  ext: "md" | "canvas";
  bytes: Buffer;
  version: string;
  tool: string;
  client: string;
  now?: Date;
}

/** Save one version and its index line; then prune. Returns the entry. */
export async function saveVersion(vaultRoot: string, input: SaveVersion): Promise<HistoryEntry> {
  const now = input.now ?? new Date();
  const dir = join(vaultRoot, HISTORY_DIR, pageKey(input.id));
  await mkdir(dir, { recursive: true });
  const base = stamp(now);
  let file = `${base}.${input.ext}`;
  for (let n = 2; existsSync(join(dir, file)); n += 1) file = `${base}-${n}.${input.ext}`;
  await writeFile(join(dir, file), input.bytes, { flag: "wx" });
  const entry: HistoryEntry = {
    file,
    at: now.toISOString(),
    id: input.id,
    version: input.version,
    source: "mcp",
    tool: input.tool,
    client: input.client,
    bytes: input.bytes.length,
    sha256: createHash("sha256").update(input.bytes).digest("hex"),
  };
  await appendFile(join(dir, "index.jsonl"), `${JSON.stringify(entry)}\n`);
  await prune(dir, now.getTime());
  return entry;
}

export async function readIndex(dir: string): Promise<HistoryEntry[]> {
  let text: string;
  try {
    text = await readFile(join(dir, "index.jsonl"), "utf8");
  } catch {
    return [];
  }
  const out: HistoryEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as HistoryEntry);
    } catch {
      // A torn line (crash mid-append): skip it, keep the rest.
    }
  }
  return out;
}

/** Keep the newest 50 or those under 30 days old, whichever keeps more. */
export async function prune(dir: string, now: number, keepVersions = KEEP_VERSIONS, keepMs = KEEP_MS): Promise<void> {
  const entries = await readIndex(dir);
  if (entries.length <= keepVersions) return;
  // Oldest first by file name (timestamps sort as text).
  const sorted = [...entries].sort((a, b) => a.file.localeCompare(b.file));
  const newest = new Set(sorted.slice(-keepVersions).map((entry) => entry.file));
  const keep = sorted.filter((entry) => newest.has(entry.file) || now - Date.parse(entry.at) < keepMs);
  if (keep.length === sorted.length) return;
  const dropped = sorted.filter((entry) => !keep.includes(entry));
  const temp = join(dir, `index.jsonl.${process.pid}.tmp`);
  await writeFile(temp, keep.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  await rename(temp, join(dir, "index.jsonl"));
  for (const entry of dropped) await rm(join(dir, entry.file), { force: true });
}
