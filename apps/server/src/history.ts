/**
 * Version history (spec/version-history, D35 + D41).
 *
 *   .gumply/history/<page key>/<YYYYMMDDTHHMMSSmmmZ>.<md|canvas|base>   exact bytes of the file then
 *   .gumply/history/<page key>/index.jsonl                         one JSON line per entry
 *
 * The layout is D35's (MCP wrote the first entries); 0.9 adds the app's own
 * versions, outside edits, renames, pins and retention by age. A version is
 * written before the write that replaces the file, so a crash between the two
 * leaves an extra entry, never a lost version. History only ever writes under
 * `.gumply/history/`: page files are never touched here (D37).
 *
 * Index lines are append-only. Besides versions (with `file`) there are event
 * lines: `{ event: "rename" | "move", from, id, at }` and `{ event: "pin",
 * file, pinned, at }`. Readers merge the folder-sync tools' conflict copies of
 * the index (`index.sync-conflict-….jsonl`, `index (conflicted copy …).jsonl`)
 * and list version files no line mentions, so nothing becomes invisible.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic } from "./temp-files.js";

export const HISTORY_DIR = join(".gumply", "history");

export type HistorySource = "app" | "external" | "mcp" | "import" | "restore";
/** `before-reload` (spec/api v1.34, #chbpc9yb): the editor's unsaved text, kept before a save conflict's Reload dropped it. */
export type HistoryReason = "edit" | "session" | "rename" | "move" | "trash" | "before-restore" | "conflict" | "before-reload";

/** What a restore undid (spec/api v1.34): `keep-copy` is the Undo of a conflict's "Keep copy". */
export type HistoryUndid = "keep-copy";

/** One version (a file) of a page or board. */
export interface HistoryEntry {
  file: string;
  at: string;
  /** The page id when the version was made. */
  id: string;
  version: string;
  source: HistorySource;
  reason?: HistoryReason;
  tool?: string;
  client?: string;
  bytes: number;
  sha256: string;
  pinned?: boolean;
  /** On the entry a restore made: the version it restored. */
  restoredFrom?: string;
  /** On that entry, when the restore was an Undo of an action (spec/api v1.34). */
  undid?: HistoryUndid;
}

/**
 * A rename or move of the page (no file), or `recreated`: a file appeared
 * outside Gumply where an earlier page of that name had history. The versions
 * before it belong to that earlier page (the panel shows a divider).
 */
export interface HistoryMove {
  event: "rename" | "move" | "recreated";
  from: string;
  id: string;
  at: string;
}

interface PinLine {
  event: "pin";
  file: string;
  pinned: boolean;
  at: string;
}

const VERSION_FILE = /^\d{8}T\d{9}Z(-\d+)?\.(md|canvas|base)$/;
const INDEX_FILE = "index.jsonl";
/** Folder-sync conflict copies of the index (Syncthing, Dropbox, OneDrive, iCloud…). */
const INDEX_COPY = /^index.+\.jsonl$/;

/**
 * The page id as one directory name: `/` → `%2F`, and `%` plus characters
 * unsafe on Windows or macOS percent-encoded. Reversible with decodeURIComponent.
 */
export function pageKey(id: string): string {
  return id.replace(/[%/\\<>:"|?*\x00-\x1f\x7f]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

/** The id a key (or an orphan key `<key>~<stamp>`) was made from. */
export function keyToId(key: string): string {
  const base = key.replace(/~\d{8}T\d{9}Z$/, "");
  try {
    return decodeURIComponent(base);
  } catch {
    return base;
  }
}

/** UTC `YYYYMMDDTHHMMSSmmmZ`: sorts as text. */
export function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(".", "");
}

export const historyDir = (root: string, id: string) => join(root, HISTORY_DIR, pageKey(id));

export const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/**
 * Sort key of a version file: its timestamp, then its clash number
 * (`…Z.md` is 1, `…Z-2.md` is 2), so a clash sorts after its base.
 */
export const fileOrder = (name: string) =>
  name.replace(/(?:-(\d+))?\.(md|canvas|base)$/, (_all, n: string | undefined) => `#${(n ?? "1").padStart(6, "0")}`);
const byFile = (a: { file: string }, b: { file: string }) => {
  const x = fileOrder(a.file);
  const y = fileOrder(b.file);
  return x < y ? -1 : x > y ? 1 : 0;
};

/** True for a name that can be a version file (never a path). */
export const isVersionFile = (name: string) => VERSION_FILE.test(name);

/** The history of one page, oldest first, plus its move events. */
export interface PageHistory {
  entries: HistoryEntry[];
  moves: HistoryMove[];
}

async function readLines(path: string): Promise<unknown[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A torn line (crash mid-append, or a half-synced file): skip it.
    }
  }
  return out;
}

/** Read a page's history: the index, its sync-conflict copies, and any unindexed version files. */
export async function readHistory(dir: string): Promise<PageHistory> {
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return { entries: [], moves: [] };
  }
  const lines: unknown[] = [];
  for (const name of [INDEX_FILE, ...names.filter((name) => name !== INDEX_FILE && INDEX_COPY.test(name)).sort()]) {
    lines.push(...(await readLines(join(dir, name))));
  }
  const entries = new Map<string, HistoryEntry>();
  const pins = new Map<string, PinLine>();
  const moves = new Map<string, HistoryMove>();
  for (const value of lines) {
    if (!value || typeof value !== "object") continue;
    const line = value as Record<string, unknown>;
    if (line.event === "pin" && typeof line.file === "string") {
      const pin = line as unknown as PinLine;
      const known = pins.get(pin.file);
      if (!known || known.at <= pin.at) pins.set(pin.file, pin);
    } else if ((line.event === "rename" || line.event === "move" || line.event === "recreated") && typeof line.id === "string") {
      const move = line as unknown as HistoryMove;
      moves.set(`${move.at}\u0000${move.id}`, move);
    } else if (typeof line.file === "string" && isVersionFile(line.file) && !entries.has(line.file)) {
      entries.set(line.file, { ...(line as unknown as HistoryEntry), source: (line.source as HistorySource) ?? "app" });
    }
  }
  // A version file with no line (its line was lost in a sync conflict): still listed.
  for (const name of names) {
    if (!isVersionFile(name) || entries.has(name)) continue;
    const bytes = await readFile(join(dir, name)).catch(() => null);
    if (!bytes) continue;
    const at = new Date(Date.UTC(+name.slice(0, 4), +name.slice(4, 6) - 1, +name.slice(6, 8), +name.slice(9, 11), +name.slice(11, 13), +name.slice(13, 15), +name.slice(15, 18)));
    entries.set(name, { file: name, at: at.toISOString(), id: keyToId(dir.split(/[\\/]/).pop() ?? ""), version: "", source: "external", bytes: bytes.length, sha256: sha256(bytes) });
  }
  // A line whose file is gone (pruned on another device): dropped.
  for (const file of [...entries.keys()]) if (!names.includes(file)) entries.delete(file);
  for (const [file, pin] of pins) {
    const entry = entries.get(file);
    if (entry) entry.pinned = pin.pinned;
  }
  const sorted = [...entries.values()].sort(byFile);
  return { entries: sorted, moves: [...moves.values()].sort((a, b) => (a.at < b.at ? -1 : 1)) };
}

/** D35's reader: the versions only, oldest first. */
export async function readIndex(dir: string): Promise<HistoryEntry[]> {
  return (await readHistory(dir)).entries;
}

export interface SaveVersion {
  id: string;
  /** N1 (#kw8th869): `base` for a database view. */
  ext: "md" | "canvas" | "base";
  bytes: Buffer;
  version: string;
  source?: HistorySource;
  reason?: HistoryReason;
  tool?: string;
  client?: string;
  restoredFrom?: string;
  undid?: HistoryUndid;
  now?: Date;
}

/**
 * Save one version and its index line, then prune that page's history.
 * A version whose bytes equal the newest entry's isn't written (returns that entry).
 */
export async function saveVersion(root: string, input: SaveVersion): Promise<HistoryEntry> {
  const now = input.now ?? new Date();
  const dir = historyDir(root, input.id);
  await mkdir(dir, { recursive: true });
  const hash = sha256(input.bytes);
  const { entries } = await readHistory(dir);
  const newest = entries[entries.length - 1];
  if (newest && newest.sha256 === hash && input.restoredFrom === undefined) return newest;
  const base = stamp(now);
  let file = `${base}.${input.ext}`;
  for (let n = 2; existsSync(join(dir, file)); n += 1) file = `${base}-${n}.${input.ext}`;
  await writeFile(join(dir, file), input.bytes, { flag: "wx" });
  const entry: HistoryEntry = {
    file,
    at: now.toISOString(),
    id: input.id,
    version: input.version,
    source: input.source ?? "mcp",
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.tool ? { tool: input.tool } : {}),
    ...(input.client ? { client: input.client } : {}),
    bytes: input.bytes.length,
    sha256: hash,
    ...(input.restoredFrom ? { restoredFrom: input.restoredFrom } : {}),
    ...(input.undid ? { undid: input.undid } : {}),
  };
  await appendFile(join(dir, INDEX_FILE), `${JSON.stringify(entry)}\n`);
  await prune(dir, now.getTime());
  return entry;
}

/** The newest version of a page, or undefined. */
export async function newestVersion(root: string, id: string): Promise<HistoryEntry | undefined> {
  const { entries } = await readHistory(historyDir(root, id));
  return entries[entries.length - 1];
}

/** Append a pin line (append-only, so it survives folder sync). */
export async function setPinned(root: string, id: string, file: string, pinned: boolean, now = new Date()): Promise<void> {
  const line: PinLine = { event: "pin", file, pinned, at: now.toISOString() };
  await appendFile(join(historyDir(root, id), INDEX_FILE), `${JSON.stringify(line)}\n`);
}

/**
 * The page moved from `from` to `to` (D20): its history directory follows.
 * If `to` already has a history (an older, deleted page of that name), that
 * one is kept aside as an orphan `<key>~<stamp>`.
 */
export async function moveHistory(root: string, from: string, to: string, event: "rename" | "move", now = new Date()): Promise<void> {
  if (from === to) return;
  await moveHistoryDir(root, historyDir(root, from), from, to, event, now);
}

/**
 * Move one history directory (a page's, or an orphan's) to page `to`. A
 * history already at `to` is kept aside as an orphan first, even when there's
 * nothing to move in: it belonged to another page of that name.
 */
export async function moveHistoryDir(root: string, source: string, from: string, to: string, event: "rename" | "move", now = new Date()): Promise<void> {
  const target = historyDir(root, to);
  if (source === target) return;
  if (existsSync(target)) await rename(target, `${target}~${stamp(now)}`);
  if (!existsSync(source)) return;
  await mkdir(join(root, HISTORY_DIR), { recursive: true });
  await rename(source, target);
  const line: HistoryMove = { event, from, id: to, at: now.toISOString() };
  await appendFile(join(target, INDEX_FILE), `${JSON.stringify(line)}\n`);
}

/**
 * A new page or board is being created at `id`: a history already there
 * belongs to an earlier page of that name (deleted), so it's kept aside as an
 * orphan `<key>~<stamp>` and the new page starts its own.
 */
export async function setAsideHistory(root: string, id: string, now = new Date()): Promise<void> {
  const dir = historyDir(root, id);
  if (existsSync(dir)) await rename(dir, `${dir}~${stamp(now)}`);
}

/**
 * A page or board file appeared outside Gumply at `id`, where history already
 * is (a page of that name was deleted earlier, or the file came back, e.g. a
 * git checkout). The history stays (it may be this page's own), with a marker.
 */
export async function markRecreated(root: string, id: string, now = new Date()): Promise<boolean> {
  const dir = historyDir(root, id);
  if (!existsSync(dir)) return false;
  const line: HistoryMove = { event: "recreated", from: id, id, at: now.toISOString() };
  await appendFile(join(dir, INDEX_FILE), `${JSON.stringify(line)}\n`);
  return true;
}

// --- retention (D41) -------------------------------------------------------

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const KEEP_ALL_MS = DAY;
export const KEEP_HOURLY_MS = 7 * DAY;
export const KEEP_DAILY_MS = 90 * DAY;
/** A version this big is kept only as the last of each day, at most 10. */
export const BIG_VERSION_BYTES = 5 * 1024 * 1024;
export const BIG_VERSION_KEEP = 10;

/**
 * Which versions of one page to keep (spec/version-history §2.4), oldest first in, a set of files out:
 * every version under 24 h, the last of each hour to 7 days, the last of each day to 90 days;
 * always the newest and pinned ones, and for 90 days the last version before each change of source.
 */
export function retained(entries: readonly HistoryEntry[], now: number): Set<string> {
  const keep = new Set<string>();
  if (entries.length === 0) return keep;
  const sorted = [...entries].sort(byFile);
  keep.add(sorted[sorted.length - 1]!.file);
  const lastPerBucket = new Map<string, string>();
  sorted.forEach((entry, index) => {
    const age = now - Date.parse(entry.at);
    if (entry.pinned) keep.add(entry.file);
    const next = sorted[index + 1];
    if (next && next.source !== entry.source && age < KEEP_DAILY_MS) keep.add(entry.file);
    if (entry.bytes > BIG_VERSION_BYTES) return;
    if (age < KEEP_ALL_MS) keep.add(entry.file);
    else if (age < KEEP_HOURLY_MS) lastPerBucket.set(`h${Math.floor(Date.parse(entry.at) / HOUR)}`, entry.file);
    else if (age < KEEP_DAILY_MS) lastPerBucket.set(`d${Math.floor(Date.parse(entry.at) / DAY)}`, entry.file);
  });
  for (const file of lastPerBucket.values()) keep.add(file);
  // Big versions (large boards): the last of each day, the newest 10 of those.
  const bigPerDay = new Map<number, string>();
  for (const entry of sorted) {
    if (entry.bytes > BIG_VERSION_BYTES && now - Date.parse(entry.at) < KEEP_DAILY_MS) bigPerDay.set(Math.floor(Date.parse(entry.at) / DAY), entry.file);
  }
  for (const file of [...bigPerDay.values()].slice(-BIG_VERSION_KEEP)) keep.add(file);
  return keep;
}

/** Prune one page's history by age and write one merged index (sync-conflict copies folded in). */
export async function prune(dir: string, now: number): Promise<void> {
  const { entries, moves } = await readHistory(dir);
  const keep = retained(entries, now);
  const names = await readdir(dir).catch(() => [] as string[]);
  const copies = names.filter((name) => name !== INDEX_FILE && INDEX_COPY.test(name));
  if (keep.size === entries.length && copies.length === 0) return;
  await writeIndex(dir, entries.filter((entry) => keep.has(entry.file)), moves);
  for (const entry of entries) if (!keep.has(entry.file)) await rm(join(dir, entry.file), { force: true });
  for (const copy of copies) await rm(join(dir, copy), { force: true });
}

async function writeIndex(dir: string, entries: readonly HistoryEntry[], moves: readonly HistoryMove[]): Promise<void> {
  const lines = [
    ...entries.map((entry) => ({ order: entry.at, text: JSON.stringify(entry) })),
    ...moves.map((move) => ({ order: move.at, text: JSON.stringify(move) })),
  ].sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
  // #e9hs2zgq: a hidden temp beside it, removed at once if the rename fails.
  await writeAtomic(join(dir, INDEX_FILE), lines.map((line) => `${line.text}\n`).join(""));
}

// --- the whole vault -------------------------------------------------------

/** The size budget (D41): max(200 MB, 50% of the vault's own size). */
export const budgetFor = (vaultBytes: number) => Math.max(200 * 1024 * 1024, Math.floor(vaultBytes / 2));

export interface HistoryUsage {
  bytes: number;
  pages: number;
  versions: number;
}

/** Every page key with a history directory. */
export async function historyKeys(root: string): Promise<string[]> {
  try {
    return (await readdir(join(root, HISTORY_DIR), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

export async function usage(root: string): Promise<HistoryUsage> {
  const out: HistoryUsage = { bytes: 0, pages: 0, versions: 0 };
  for (const key of await historyKeys(root)) {
    const dir = join(root, HISTORY_DIR, key);
    out.pages += 1;
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      const size = (await stat(join(dir, name)).catch(() => null))?.size ?? 0;
      out.bytes += size;
      if (isVersionFile(name)) out.versions += 1;
    }
  }
  return out;
}

/**
 * The daily vault-wide prune: age retention for every page, then, over the
 * budget, the oldest unpinned versions across the vault (never a page's
 * newest) until it's under 90% of it. With `olderThanMs`, drops every
 * unpinned version older than that instead ("Clear history older than…").
 */
export async function pruneVault(root: string, options: { budget: number; now?: number; olderThanMs?: number }): Promise<HistoryUsage> {
  const now = options.now ?? Date.now();
  for (const key of await historyKeys(root)) await prune(join(root, HISTORY_DIR, key), now);
  const candidates: Array<{ dir: string; entry: HistoryEntry }> = [];
  for (const key of await historyKeys(root)) {
    const dir = join(root, HISTORY_DIR, key);
    const { entries } = await readHistory(dir);
    entries.slice(0, -1).forEach((entry) => {
      if (!entry.pinned) candidates.push({ dir, entry });
    });
  }
  let current = await usage(root);
  candidates.sort((a, b) => (a.entry.at < b.entry.at ? -1 : 1));
  const drop: typeof candidates = [];
  if (options.olderThanMs !== undefined) {
    for (const candidate of candidates) if (now - Date.parse(candidate.entry.at) > options.olderThanMs) drop.push(candidate);
  } else if (current.bytes > options.budget) {
    let bytes = current.bytes;
    for (const candidate of candidates) {
      if (bytes <= options.budget * 0.9) break;
      drop.push(candidate);
      bytes -= candidate.entry.bytes;
    }
  }
  const byDir = new Map<string, Set<string>>();
  for (const { dir, entry } of drop) byDir.set(dir, (byDir.get(dir) ?? new Set()).add(entry.file));
  for (const [dir, files] of byDir) {
    const { entries, moves } = await readHistory(dir);
    await writeIndex(dir, entries.filter((entry) => !files.has(entry.file)), moves);
    for (const file of files) await rm(join(dir, file), { force: true });
  }
  if (drop.length) current = await usage(root);
  return current;
}

// --- diffs -----------------------------------------------------------------

export interface DiffLine {
  op: "same" | "add" | "remove";
  text: string;
}

/**
 * A line diff (LCS), for the History panel's Changes view. Notes are small;
 * past about four million cells it falls back to "all removed, all added".
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.replace(/\r\n/g, "\n").split("\n");
  const b = after.replace(/\r\n/g, "\n").split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const head = a.slice(0, start).map((text) => ({ op: "same" as const, text }));
  const tail = a.slice(endA).map((text) => ({ op: "same" as const, text }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length * midB.length > 4_000_000) {
    return [...head, ...midA.map((text) => ({ op: "remove" as const, text })), ...midB.map((text) => ({ op: "add" as const, text })), ...tail];
  }
  const rows = midA.length + 1;
  const cols = midB.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = midA.length - 1; i >= 0; i -= 1) {
    for (let j = midB.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] = midA[i] === midB[j] ? table[(i + 1) * cols + j + 1]! + 1 : Math.max(table[(i + 1) * cols + j]!, table[i * cols + j + 1]!);
    }
  }
  const middle: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < midA.length && j < midB.length) {
    if (midA[i] === midB[j]) {
      middle.push({ op: "same", text: midA[i]! });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * cols + j]! >= table[i * cols + j + 1]!) {
      middle.push({ op: "remove", text: midA[i]! });
      i += 1;
    } else {
      middle.push({ op: "add", text: midB[j]! });
      j += 1;
    }
  }
  while (i < midA.length) middle.push({ op: "remove", text: midA[i++]! });
  while (j < midB.length) middle.push({ op: "add", text: midB[j++]! });
  return [...head, ...middle, ...tail];
}

/** A board diff: cards added, removed and changed, by node id. */
export function boardDiff(before: string, after: string): { added: string[]; removed: string[]; changed: string[] } {
  const nodes = (text: string): Map<string, string> => {
    try {
      const parsed = JSON.parse(text) as { nodes?: Array<Record<string, unknown>> };
      return new Map((parsed.nodes ?? []).map((node) => [String(node.id), JSON.stringify(node)]));
    } catch {
      return new Map();
    }
  };
  const a = nodes(before);
  const b = nodes(after);
  return {
    added: [...b.keys()].filter((id) => !a.has(id)),
    removed: [...a.keys()].filter((id) => !b.has(id)),
    changed: [...b.keys()].filter((id) => a.has(id) && a.get(id) !== b.get(id)),
  };
}
