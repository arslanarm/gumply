/**
 * Attachment storage (D18) and safe vault-file resolution for `GET /api/files`.
 * Attachments live at `vault/attachments/` and keep plain file names.
 */
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { extname, join, basename as pathBasename, resolve, sep } from "node:path";
import type { Attachment } from "@gumply/core";
import { badRequest, payloadTooLarge } from "./errors.js";

export const ATTACHMENTS_DIR = "attachments";
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
  avif: "image/avif",
  bmp: "image/bmp",
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  gif: "image/gif",
  gz: "application/gzip",
  html: "text/html; charset=utf-8",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  pdf: "application/pdf",
  png: "image/png",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  svg: "image/svg+xml",
  tar: "application/x-tar",
  txt: "text/plain; charset=utf-8",
  wav: "audio/wav",
  webm: "video/webm",
  webp: "image/webp",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  zip: "application/zip",
};

export function mimeForName(name: string): string {
  const extension = extname(name).slice(1).toLowerCase();
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

/** Keep only a safe basename; spaces collapse to `-` and unsafe chars to `-`. */
export function sanitizeAttachmentName(raw: string): string {
  const withSlashes = raw.replace(/\\/g, "/");
  const base = pathBasename(withSlashes).normalize("NFKC");
  const extension = extname(base);
  const stem = base
    .slice(0, base.length - extension.length)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^\p{L}\p{N}._ -]/gu, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.\s-]+|[.\s-]+$/g, "")
    .slice(0, 100);
  const cleanExtension = extension
    .replace(/[^\p{L}\p{N}.]/gu, "")
    .slice(0, 20)
    .toLowerCase();
  return `${stem || "file"}${cleanExtension}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function freeName(dir: string, name: string): Promise<string> {
  const extension = extname(name);
  const stem = name.slice(0, name.length - extension.length) || "file";
  let candidate = name;
  let suffix = 1;
  while (await exists(join(dir, candidate))) {
    candidate = `${stem}-${suffix}${extension}`;
    suffix += 1;
  }
  return candidate;
}

export interface SaveAttachmentInput {
  name: string;
  data: Uint8Array;
  /** Browser-provided MIME; falls back to the extension map. */
  mime?: string;
}

/** Save a file into `vault/attachments/`, deduplicating its name. */
export async function saveAttachment(
  vaultRoot: string,
  input: SaveAttachmentInput,
): Promise<Attachment> {
  if (input.data.byteLength > MAX_ATTACHMENT_BYTES) {
    throw payloadTooLarge("File is too large (max 25 MB)");
  }
  if (input.data.byteLength === 0) throw badRequest("File is empty");

  const dir = join(vaultRoot, ATTACHMENTS_DIR);
  await mkdir(dir, { recursive: true });

  const desired = sanitizeAttachmentName(input.name || "file");
  const name = await freeName(dir, desired);

  // `wx` makes deduplication race-safe: another upload that picked the same
  // free name fails with EEXIST, and we try the next suffix.
  let finalName = name;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await writeFile(join(dir, finalName), input.data, { flag: "wx" });
      return {
        path: `${ATTACHMENTS_DIR}/${finalName}`,
        name: finalName,
        size: input.data.byteLength,
        mime: mimeForName(finalName),
      };
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      finalName = await freeName(dir, desired);
    }
  }
  throw new Error("Could not allocate an attachment name");
}

/** List files directly under `vault/attachments/`, sorted by name. */
export async function listAttachments(vaultRoot: string): Promise<Attachment[]> {
  const dir = join(vaultRoot, ATTACHMENTS_DIR);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return [];
    throw error;
  }

  const attachments: Attachment[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue;
    const info = await stat(join(dir, entry.name));
    attachments.push({
      path: `${ATTACHMENTS_DIR}/${entry.name}`,
      name: entry.name,
      size: info.size,
      mime: mimeForName(entry.name),
    });
  }
  return attachments.sort((a, b) => a.name.localeCompare(b.name));
}

export interface VaultFile {
  absolutePath: string;
  name: string;
  size: number;
  mime: string;
  /** True when the file lives under `attachments/` (safe to cache forever). */
  attachmentPath: boolean;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Resolve a URL path to a file inside the vault. Rejects traversal, hidden
 * directories (`.trash`, `.gumply`) and directories. Returns null if invalid.
 */
export async function resolveVaultFile(
  vaultRoot: string,
  urlPath: string,
): Promise<VaultFile | null> {
  const decoded = safeDecode(urlPath).replace(/\\/g, "/");
  if (decoded.length === 0 || decoded.startsWith("/")) return null;

  const segments = decoded.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return null;
  }
  if (segments.some((segment) => segment.startsWith("."))) return null;

  const root = resolve(vaultRoot);
  const absolutePath = resolve(root, ...segments);
  if (!absolutePath.startsWith(`${root}${sep}`)) return null;

  try {
    const info = await stat(absolutePath);
    if (!info.isFile()) return null;
    return {
      absolutePath,
      name: pathBasename(absolutePath),
      size: info.size,
      mime: mimeForName(absolutePath),
      attachmentPath: segments[0] === ATTACHMENTS_DIR,
    };
  } catch {
    return null;
  }
}
