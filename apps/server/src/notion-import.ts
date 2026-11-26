/**
 * Notion import jobs (v0.8 B2, #znyztw3t; spec/notion-import, spec/api-import).
 *
 * 1. Read the zip with fflate. Every entry's declared size is checked before
 *    it's inflated: zip-slip names, symlinks, too many entries, too many
 *    bytes, a suspicious compression ratio, attachments over 25 MB. Anything
 *    refused is skipped and reported, never truncated. Every entry read is
 *    then checked against the central directory's CRC-32 and size (fflate
 *    checks neither): a damaged export fails the whole import, naming the
 *    entry, before anything is written (#4zzay6mn).
 * 2. Plan everything in memory (core `planNotionImport`).
 * 3. Write it under `.gumply/import/<job>/` (hidden, never indexed), claim
 *    the target folders with an exclusive `mkdir` (no `recursive`: it fails
 *    when the folder exists, so nothing is ever merged or overwritten), and
 *    move the planned files into them. A failure removes what was claimed:
 *    the vault ends up with the whole import or none of it.
 *
 * One import runs at a time per vault; a second request gets a 409 naming it.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import {
  NOTION_IMPORT_LIMITS,
  formatImportLimit,
  notionReportMarkdown,
  planNotionImport,
  skipEntry,
  type NotionEntry,
  type NotionImportReport,
  type NotionReportLanguage,
  type NotionSkipCode,
  type PageId,
} from "@gumply/core";

type Skipped = NotionImportReport["skipped"][number];
import { conflict, notFound } from "./errors.js";
import { saveVersion, setAsideHistory } from "./history.js";
import type { VaultStore } from "./vault-store.js";

/** The limits live in core so the web app's messages use the same numbers (#bswmpt63). */
export { NOTION_IMPORT_LIMITS } from "@gumply/core";

/** Leftover job folders older than this are removed on startup. */
const STALE_JOB_MS = 60 * 60 * 1000;
const IMPORT_TMP = join(".gumply", "import");
const BASE_NAME = "Notion import";

export type NotionImportState = "reading" | "planning" | "writing" | "done" | "failed";

export interface NotionImportJob {
  id: string;
  state: NotionImportState;
  /** Files written so far, of `total`. */
  done: number;
  total: number;
  /** The new folder's vault path, once chosen. */
  folder?: string;
  report?: NotionImportReport;
  /** Why it failed, in English (the API's words). */
  error?: string;
  /** `damaged`: the zip is corrupt or cut short; the client shows its own words for it (#4zzay6mn). */
  errorCode?: "damaged";
  /** With `damaged`: the entry that failed its check, when one can be named. */
  errorFile?: string;
}

/** The export is corrupt or truncated: nothing of it is imported (#4zzay6mn). */
export class NotionZipDamaged extends Error {
  readonly code = "damaged";
  constructor(readonly file?: string) {
    super(file ? `The export looks damaged (file ${file}). Download it again from Notion.` : "The export looks damaged. Download it again from Notion.");
    this.name = "NotionZipDamaged";
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 as zip stores it (IEEE 802.3, the one zlib computes). */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Why a zip entry name is refused (zip-slip), as a skip code, or null when it's safe. */
export function unsafeEntryCode(name: string): NotionSkipCode | null {
  if (name.includes("\u0000")) return "nul";
  if (/^[a-zA-Z]:/.test(name) || name.startsWith("/") || name.startsWith("\\")) return "absolute";
  if (name.split(/[\\/]/).some((segment) => segment === "..")) return "outside";
  return null;
}

/** Why a zip entry name is refused (zip-slip), in English, or null when it's safe. */
export function unsafeEntryName(name: string): string | null {
  const code = unsafeEntryCode(name);
  return code ? skipEntry(code).reason : null;
}

interface DirectoryRecord {
  name: string;
  crc: number;
  /** Unix mode (0 unless the zip was made on Unix). */
  mode: number;
}

/**
 * The central directory's records, in order: what fflate doesn't expose
 * (each entry's CRC-32 and Unix mode). It's found as fflate finds it (the
 * last end-of-directory record, ZIP64 when present), so record `n` is the
 * `n`th entry fflate reads. Stops at the first record that isn't one.
 */
function centralDirectory(zip: Uint8Array): DirectoryRecord[] {
  const records: DirectoryRecord[] = [];
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // End of central directory: the last 0x06054b50 within the final 64 KB + 22 bytes.
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_558); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) return records;
  let count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  if (end >= 20 && view.getUint32(end - 20, true) === 0x07064b50) {
    const zip64 = Number(view.getBigUint64(end - 12, true));
    if (zip64 + 56 <= zip.length && view.getUint32(zip64, true) === 0x06064b50) {
      count = Number(view.getBigUint64(zip64 + 32, true));
      at = Number(view.getBigUint64(zip64 + 48, true));
    }
  }
  for (let n = 0; n < count && at + 46 <= zip.length; n += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) break;
    const host = view.getUint8(at + 5);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    records.push({
      // Decoded as fflate does: UTF-8 when the entry's flag says so, else Latin-1.
      name: strFromU8(zip.subarray(at + 46, at + 46 + nameLength), !(view.getUint16(at + 8, true) & 0x800)),
      crc: view.getUint32(at + 16, true),
      mode: host === 3 ? view.getUint32(at + 38, true) >>> 16 : 0,
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return records;
}

/**
 * Names of the entries the zip marks as symlinks (Unix mode in the central
 * directory). fflate doesn't expose the mode, so the directory is read here.
 */
export function zipSymlinks(zip: Uint8Array): Set<string> {
  return new Set(centralDirectory(zip).filter((record) => (record.mode & 0o170000) === 0o120000).map((record) => record.name));
}

/** fflate's errors while inflating or reading one entry (its `code`): the entry it was on is the damaged one. */
const ENTRY_ERRORS = new Set([0, 1, 2, 3, 14]);

/** Read the export: the entries to import, and what was refused. */
export function readNotionZip(zip: Uint8Array, limits = NOTION_IMPORT_LIMITS): { entries: NotionEntry[]; skipped: Skipped[] } {
  const skipped: Skipped[] = [];
  const directory = centralDirectory(zip);
  const symlinks = new Set(directory.filter((record) => (record.mode & 0o170000) === 0o120000).map((record) => record.name));
  let files = 0;
  let total = 0;
  let tooMany = false;
  let tooBig = false;
  /** Each entry read: its size and CRC-32 from the central directory. */
  const declared = new Map<string, { size: number; crc: number | undefined }>();
  let index = -1;
  /** The entry fflate is reading now (the filter accepted it; it's inflated right after). */
  let reading: string | undefined;
  const filter = (file: { name: string; size: number; originalSize: number }): boolean => {
    index += 1;
    reading = undefined;
    const name = file.name;
    if (name.endsWith("/")) return false;
    if (name.startsWith("__MACOSX/") || /(^|\/)\.DS_Store$/.test(name)) return false;
    const unsafe = unsafeEntryCode(name);
    if (unsafe) {
      skipped.push({ path: name, ...skipEntry(unsafe) });
      return false;
    }
    if (symlinks.has(name)) {
      skipped.push({ path: name, ...skipEntry("symlink") });
      return false;
    }
    files += 1;
    if (files > limits.entries) {
      tooMany = true;
      return false;
    }
    if (!/\.(md|csv)$/i.test(name) && file.originalSize > limits.attachmentBytes) {
      skipped.push({ path: name, ...skipEntry("tooLarge", { limit: formatImportLimit(limits.attachmentBytes) }) });
      return false;
    }
    if (file.originalSize > limits.ratioFloorBytes && file.originalSize > file.size * limits.ratio) {
      skipped.push({ path: name, ...skipEntry("zipBomb") });
      return false;
    }
    if (total + file.originalSize > limits.totalBytes) {
      tooBig = true;
      return false;
    }
    total += file.originalSize;
    declared.set(name, { size: file.originalSize, crc: directory[index]?.name === name ? directory[index]!.crc : undefined });
    reading = name;
    return true;
  };
  let out: Record<string, Uint8Array>;
  try {
    out = unzipSync(zip, { filter });
  } catch (error) {
    // Cut short (no end-of-directory record), or an entry that doesn't inflate.
    const code = (error as { code?: unknown }).code;
    throw new NotionZipDamaged(typeof code === "number" && ENTRY_ERRORS.has(code) ? reading : undefined);
  }
  if (tooMany) throw new Error(`The export has more than ${limits.entries} files.`);
  if (tooBig) throw new Error(`The export is larger than ${formatImportLimit(limits.totalBytes)} once unpacked.`);
  const entries: NotionEntry[] = [];
  for (const [path, data] of Object.entries(out)) {
    // A size or CRC-32 that doesn't match the central directory: the bytes aren't the ones zipped.
    const expected = declared.get(path);
    if (!expected || data.length !== expected.size || expected.crc === undefined || crc32(data) !== expected.crc) throw new NotionZipDamaged(path);
    entries.push({ path: path.replace(/\\/g, "/").normalize("NFC"), data });
  }
  return { entries, skipped };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Remove job folders a crashed or restarted server left behind (older than an hour). */
export async function cleanupStaleImports(root: string, now = Date.now()): Promise<void> {
  const dir = join(root, IMPORT_TMP);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    try {
      const info = await stat(join(dir, name));
      if (now - info.mtimeMs > STALE_JOB_MS) await rm(join(dir, name), { recursive: true, force: true });
    } catch {
      // Gone already.
    }
  }
}

export class NotionImports {
  private readonly jobs = new Map<string, NotionImportJob>();
  private running: NotionImportJob | null = null;

  constructor(
    private readonly store: VaultStore,
    /** Test hook: runs right before the target folders are claimed. */
    private readonly beforeClaim?: (folder: string) => Promise<void>,
  ) {
    void cleanupStaleImports(store.root).catch((error: unknown) => console.error("[gumply] stale import cleanup failed:", error));
  }

  get(id: string): NotionImportJob | undefined {
    return this.jobs.get(id);
  }

  /** Start an import into `parentId` (a folder page or plain folder; null = the vault root). */
  start(zip: Uint8Array, parentId: PageId | null, language: NotionReportLanguage = "en"): NotionImportJob {
    if (this.running) throw conflict(`An import is already running (job ${this.running.id}).`);
    if (parentId !== null && !this.store.list().some((meta) => meta.id === parentId)) throw notFound("No such folder");
    const job: NotionImportJob = { id: randomUUID(), state: "reading", done: 0, total: 0 };
    this.jobs.set(job.id, job);
    this.running = job;
    void this.run(job, zip, parentId, language).catch((error: unknown) => console.error("[gumply] Notion import failed:", error));
    return job;
  }

  /** Wait for a job to finish (tests). */
  async settled(id: string): Promise<NotionImportJob> {
    for (;;) {
      const job = this.jobs.get(id);
      if (!job || job.state === "done" || job.state === "failed") return job!;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  private async run(job: NotionImportJob, zip: Uint8Array, parentId: PageId | null, language: NotionReportLanguage): Promise<void> {
    const root = this.store.root;
    const temp = join(root, IMPORT_TMP, job.id);
    let outcome: Pick<NotionImportJob, "error" | "errorCode" | "errorFile"> & { state: "done" | "failed" } = { state: "failed", error: "The import stopped." };
    let imported: string[] = [];
    try {
      const { entries, skipped } = readNotionZip(zip);
      const parentDir = parentId ?? "";
      // A fresh target: re-planned if a folder appears before it's claimed.
      for (let attempt = 0; ; attempt += 1) {
        job.state = "planning";
        const name = await this.freeName(parentDir);
        const folder = parentDir ? `${parentDir}/${name}` : name;
        const attachmentsFolder = `attachments/${name}`;
        const plan = planNotionImport(entries, {
          folder,
          attachmentsFolder,
          vaultTitles: this.store.list().map((meta) => meta.title),
          vaultTypes: await this.store.storedPropertyTypes(),
        });
        plan.report.skipped.push(...skipped);
        plan.files.push({ path: `${folder}/Import report.md`, content: notionReportMarkdown(plan.report, folder, language) });

        job.state = "writing";
        job.total = plan.files.length;
        job.done = 0;
        await rm(temp, { recursive: true, force: true });
        for (const file of plan.files) {
          const path = join(temp, file.path);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, file.content, { flag: "wx" });
          job.done += 1;
        }

        await this.beforeClaim?.(folder);
        const claimed = await this.claim([folder, attachmentsFolder]);
        if (!claimed) {
          if (attempt >= 3) throw new Error("Couldn't find a free folder name for the import.");
          continue;
        }
        try {
          for (const target of [attachmentsFolder, folder]) await this.moveInto(join(temp, target), join(root, target));
        } catch (error) {
          for (const target of [folder, attachmentsFolder]) await rm(join(root, target), { recursive: true, force: true });
          throw error;
        }
        // No attachments: don't leave an empty folder behind.
        if ((await readdir(join(root, attachmentsFolder))).length === 0) await rmdir(join(root, attachmentsFolder));
        // B3: types for the new property keys (the vault's own types are kept; only missing keys are added).
        try {
          await this.store.addPropertyTypes(plan.types);
        } catch (error) {
          plan.report.skipped.push({ path: "types.json", ...skipEntry("typesNotRecorded", { error: error instanceof Error ? error.message : String(error) }) });
        }
        job.folder = folder;
        job.report = plan.report;
        imported = plan.files.map((file) => file.path).filter((path) => /\.(md|canvas)$/i.test(path));
        break;
      }
      await this.store.rescan();
      // spec/version-history §3: each imported page and board starts its history.
      for (const path of imported) {
        const canvas = /\.canvas$/i.test(path);
        const bytes = await readFile(join(root, path)).catch(() => null);
        if (!bytes) continue;
        const id = canvas ? path : path.replace(/\.md$/i, "");
        await setAsideHistory(root, id).catch(() => undefined);
        await saveVersion(root, {
          id,
          ext: canvas ? "canvas" : "md",
          bytes,
          version: new Date().toISOString(),
          source: "import",
        }).catch(() => undefined);
      }
      outcome = { state: "done" };
    } catch (error) {
      outcome = { state: "failed", error: error instanceof Error ? error.message : String(error) };
      if (error instanceof NotionZipDamaged) {
        outcome.errorCode = "damaged";
        if (error.file !== undefined) outcome.errorFile = error.file;
      }
    }
    // Clean up first, then publish the outcome and free the vault together:
    // a client that sees `done` can start the next import at once (no 409).
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
    if (outcome.error !== undefined) job.error = outcome.error;
    if (outcome.errorCode !== undefined) job.errorCode = outcome.errorCode;
    if (outcome.errorFile !== undefined) job.errorFile = outcome.errorFile;
    this.running = null;
    job.state = outcome.state;
  }

  /** `Notion import`, else `Notion import 2`… free as a folder, a page and an attachments folder (D20, case-insensitive). */
  private async freeName(parentDir: string): Promise<string> {
    const root = this.store.root;
    const lower = async (dir: string) => {
      try {
        return new Set((await readdir(join(root, dir))).map((name) => name.toLowerCase()));
      } catch {
        return new Set<string>();
      }
    };
    const siblings = await lower(parentDir);
    const attachments = await lower("attachments");
    for (let n = 1; ; n += 1) {
      const name = n === 1 ? BASE_NAME : `${BASE_NAME} ${n}`;
      const key = name.toLowerCase();
      if (!siblings.has(key) && !siblings.has(`${key}.md`) && !siblings.has(`${key}.canvas`) && !attachments.has(key)) return name;
    }
  }

  /**
   * Claim each folder with an exclusive `mkdir`. If one exists already (it
   * appeared after planning), release the ones claimed and report false.
   */
  private async claim(folders: string[]): Promise<boolean> {
    const done: string[] = [];
    for (const folder of folders) {
      const path = join(this.store.root, folder);
      await mkdir(dirname(path), { recursive: true });
      try {
        await mkdir(path);
        done.push(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        for (const claimed of done.reverse()) await rmdir(claimed).catch(() => undefined);
        return false;
      }
    }
    return true;
  }

  /** Move the planned tree into the claimed (empty, ours) folder. */
  private async moveInto(from: string, to: string): Promise<void> {
    if (!(await exists(from))) return;
    for (const name of await readdir(from)) await rename(join(from, name), join(to, name));
  }
}
