/**
 * The audit log (spec/mcp §4): `.gumply/mcp-log.jsonl`, one line per MCP
 * write: `{ at, tool, id, before, after, client }`. Versions and ids only,
 * **never page text** (the history files hold the bytes), so the log is safe
 * to attach to a bug report. Rotates at ~5 MB, keeping 3 files.
 */
import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export const AUDIT_FILE = join(".gumply", "mcp-log.jsonl");
const KEEP_FILES = 3;

export interface AuditLine {
  tool: string;
  /** The item written (its id after the write, e.g. a renamed page's new id). */
  id: string;
  /** The version replaced (null for a new page or board card added to a new board). */
  before: string | null;
  /** The version written (null when the write moved it to the trash). */
  after: string | null;
  client: string;
}

export async function audit(vaultRoot: string, line: AuditLine, maxBytes: number, now = new Date()): Promise<void> {
  const file = join(vaultRoot, AUDIT_FILE);
  await mkdir(join(vaultRoot, ".gumply"), { recursive: true });
  try {
    if ((await stat(file)).size >= maxBytes) await rotate(file);
  } catch {
    // No log yet.
  }
  // Exactly these fields, written explicitly: nothing from the page can slip in.
  const entry = { at: now.toISOString(), tool: line.tool, id: line.id, before: line.before, after: line.after, client: line.client };
  await appendFile(file, `${JSON.stringify(entry)}\n`);
}

/** `mcp-log.jsonl` → `.1` → `.2`; the oldest beyond three files goes. */
async function rotate(file: string): Promise<void> {
  await rm(`${file}.${KEEP_FILES - 1}`, { force: true });
  for (let n = KEEP_FILES - 2; n >= 1; n -= 1) {
    await rename(`${file}.${n}`, `${file}.${n + 1}`).catch(() => undefined);
  }
  await rename(file, `${file}.1`);
}
