/**
 * Notion import jobs (v0.8 B2, #znyztw3t; spec/notion-import, spec/api-import).
 *
 * 1. Read the zip with fflate. Every entry's declared size is checked before
 *    it's inflated: zip-slip names, symlinks, too many entries, too many
 *    bytes, a suspicious compression ratio, attachments over 25 MB. Anything
 *    refused is skipped and reported, never truncated.
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
import { mkdir, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { unzipSync } from "fflate";
import { notionReportMarkdown, planNotionImport, type NotionEntry, type NotionImportReport, type PageId } from "@gumply/core";
import { conflict, notFound } from "./errors.js";
import type { VaultStore } from "./vault-store.js";

export const NOTION_IMPORT_LIMITS = {
  /** The uploaded zip itself. */
  uploadBytes: 1024 * 1024 * 1024,
  /** Everything inflated. */
  totalBytes: 2 * 1024 * 1024 * 1024,
  entries: 50_000,
  /** Compression ratio cap per entry, for entries over `ratioFloorBytes` (small text compresses well). */
  ratio: 200,
  ratioFloorBytes: 1024 * 1024,
  attachmentBytes: 25 * 1024 * 1024,
};

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
  error?: string;
}

/** Why a zip entry name is refused (zip-slip), or null when it's safe. */
export function unsafeEntryName(name: string): string | null {
  if (name.includes("\u0000")) return "a NUL character in the name";
  if (/^[a-zA-Z]:/.test(name) || name.startsWith("/") || name.startsWith("\\")) return "an absolute path";
  if (name.split(/[\\/]/).some((segment) => segment === "..")) return "a path that leaves the export";
  return null;
}

/**
 * Names of the entries the zip marks as symlinks (Unix mode in the central
 * directory). fflate doesn't expose the mode, so the directory is read here.
 */
export function zipSymlinks(zip: Uint8Array): Set<string> {
  const links = new Set<string>();
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // End of central directory: the last 0x06054b50 within the final 64 KB + 22 bytes.
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) return links;
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  for (let n = 0; n < count && at + 46 <= zip.length; n += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) break;
    const host = view.getUint8(at + 5);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const mode = view.getUint32(at + 38, true) >>> 16;
    const name = decoder.decode(zip.subarray(at + 46, at + 46 + nameLength));
    if (host === 3 && (mode & 0o170000) === 0o120000) links.add(name);
    at += 46 + nameLength + extraLength + commentLength;
  }
  return links;
}

/** Read the export: the entries to import, and what was refused. */
export function readNotionZip(zip: Uint8Array, limits = NOTION_IMPORT_LIMITS): { entries: NotionEntry[]; skipped: Array<{ path: string; reason: string }> } {
  const skipped: Array<{ path: string; reason: string }> = [];
  const symlinks = zipSymlinks(zip);
  let files = 0;
  let total = 0;
  let tooMany = false;
  let tooBig = false;
  const declared = new Map<string, number>();
  const out = unzipSync(zip, {
    filter: (file) => {
      const name = file.name;
      if (name.endsWith("/")) return false;
      if (name.startsWith("__MACOSX/") || /(^|\/)\.DS_Store$/.test(name)) return false;
      const unsafe = unsafeEntryName(name);
      if (unsafe) {
        skipped.push({ path: name, reason: unsafe });
        return false;
      }
      if (symlinks.has(name)) {
        skipped.push({ path: name, reason: "a symbolic link" });
        return false;
      }
      files += 1;
      if (files > limits.entries) {
        tooMany = true;
        return false;
      }
      if (!/\.(md|csv)$/i.test(name) && file.originalSize > limits.attachmentBytes) {
        skipped.push({ path: name, reason: "larger than 25 MB" });
        return false;
      }
      if (file.originalSize > limits.ratioFloorBytes && file.originalSize > file.size * limits.ratio) {
        skipped.push({ path: name, reason: "compressed suspiciously well (a possible zip bomb)" });
        return false;
      }
      if (total + file.originalSize > limits.totalBytes) {
        tooBig = true;
        return false;
      }
      total += file.originalSize;
      declared.set(name, file.originalSize);
      return true;
    },
  });
  if (tooMany) throw new Error(`The export has more than ${limits.entries} files.`);
  if (tooBig) throw new Error("The export is larger than 2 GB once unpacked.");
  const entries: NotionEntry[] = [];
  for (const [path, data] of Object.entries(out)) {
    // A size that doesn't match its header is a damaged or crafted entry.
    if (data.length !== declared.get(path)) {
      skipped.push({ path, reason: "its size doesn't match the zip's header" });
      continue;
    }
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
    void cleanupStaleImports(store.root);
  }

  get(id: string): NotionImportJob | undefined {
    return this.jobs.get(id);
  }

  /** Start an import into `parentId` (a folder page or plain folder; null = the vault root). */
  start(zip: Uint8Array, parentId: PageId | null): NotionImportJob {
    if (this.running) throw conflict(`An import is already running (job ${this.running.id}).`);
    if (parentId !== null && !this.store.list().some((meta) => meta.id === parentId)) throw notFound("No such folder");
    const job: NotionImportJob = { id: randomUUID(), state: "reading", done: 0, total: 0 };
    this.jobs.set(job.id, job);
    this.running = job;
    void this.run(job, zip, parentId).finally(() => {
      this.running = null;
    });
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

  private async run(job: NotionImportJob, zip: Uint8Array, parentId: PageId | null): Promise<void> {
    const root = this.store.root;
    const temp = join(root, IMPORT_TMP, job.id);
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
        });
        plan.report.skipped.push(...skipped);
        plan.files.push({ path: `${folder}/Import report.md`, content: notionReportMarkdown(plan.report, folder) });

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
        job.folder = folder;
        job.report = plan.report;
        break;
      }
      await this.store.rescan();
      job.state = "done";
    } catch (error) {
      job.state = "failed";
      job.error = error instanceof Error ? error.message : String(error);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
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
