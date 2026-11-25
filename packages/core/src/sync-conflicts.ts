/**
 * Sync tools' conflict copies (spec/sync-conflicts §1, §3; D43).
 *
 * When two devices change one file, Syncthing, Nextcloud, Obsidian Sync,
 * Dropbox and a cloud drive's Russian client (`(копия с компьютера X)`) keep
 * the losing side beside it under a recognisable name, with the
 * marker before the last extension (`Board.sync-conflict-….canvas`). iCloud
 * (`Note 2.md`), OneDrive (`Note-PC.md`) and Google Drive (`Note (1).md`)
 * names can't be told from real pages: those are only *possible* copies,
 * which also need the original beside them and mostly the same content.
 */

export type ConflictTool = "syncthing" | "nextcloud" | "obsidian" | "dropbox" | "cloud";

export interface ConflictCopyName {
  tool: ConflictTool;
  /** The original's file name in the same folder (`Note.md`). */
  originalName: string;
  /** Device or user as the tool wrote it, if any. */
  device?: string;
  /** The tool's own local time, `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM[:SS]` (no zone). */
  at?: string;
}

export interface PossibleCopyName {
  /** iCloud ` 2`, Google Drive ` (1)`, OneDrive `-PC`. */
  form: "number" | "paren" | "device";
  originalName: string;
}

/** `Note.sync-conflict-x.md` → [`Note.sync-conflict-x`, `.md`]; no extension → [name, ""]. */
function splitExtension(name: string): [string, string] {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? [name, ""] : [name.slice(0, dot), name.slice(dot)];
}

const dateOf = (yyyymmdd: string): string => `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
const timeOf = (hhmmss: string): string => `${hhmmss.slice(0, 2)}:${hhmmss.slice(2, 4)}${hhmmss.length > 4 ? `:${hhmmss.slice(4, 6)}` : ""}`;

const PATTERNS: Array<{ tool: ConflictTool; pattern: RegExp; read: (match: RegExpExecArray) => Omit<ConflictCopyName, "tool" | "originalName"> }> = [
  {
    // Syncthing (lib/model/folder_sendrecv.go conflictName): receiving device's local time, 7-char device id.
    tool: "syncthing",
    pattern: /^(.+)\.sync-conflict-(\d{8})-(\d{6})-([A-Z2-7]{7})$/,
    read: (m) => ({ device: m[4], at: `${dateOf(m[2]!)}T${timeOf(m[3]!)}` }),
  },
  {
    // Nextcloud desktop (utility.cpp makeConflictFileName): `(conflicted copy [user ]yyyy-MM-dd hhmmss)`.
    tool: "nextcloud",
    pattern: /^(.+) \(conflicted copy (?:(.+) )?(\d{4}-\d{2}-\d{2}) (\d{6})\)$/,
    read: (m) => ({ ...(m[2] ? { device: m[2] } : {}), at: `${m[3]}T${timeOf(m[4]!)}` }),
  },
  {
    // Nextcloud's older form, still recognised by its isConflictFile.
    tool: "nextcloud",
    pattern: /^(.+)_conflict-(\d{8})-(\d{6})$/,
    read: (m) => ({ at: `${dateOf(m[2]!)}T${timeOf(m[3]!)}` }),
  },
  {
    // Obsidian Sync (1.9.7+, "Create conflict file" on): `(Conflicted copy <device> YYYYMMDDHHMM)`.
    tool: "obsidian",
    pattern: /^(.+) \(Conflicted copy (.+) (\d{12})\)$/,
    read: (m) => ({ device: m[2], at: `${dateOf(m[3]!.slice(0, 8))}T${timeOf(m[3]!.slice(8))}` }),
  },
  {
    // Dropbox (help.dropbox.com "conflicted copy"): `(<user or computer>'s conflicted copy YYYY-MM-DD)`, maybe ` (n)`.
    tool: "dropbox",
    pattern: /^(.+) \((.+?)['’]s [Cc]onflicted copy (\d{4}-\d{2}-\d{2})\)(?: \(\d+\))?$/,
    read: (m) => ({ device: m[2], at: m[3] }),
  },
  {
    // #f5n87bfd: a cloud drive's Russian desktop client (very likely Yandex Disk; its public docs only show
    // `document (2).docx`): `(копия с компьютера <computer>)`, further copies of one conflict ` (n)`.
    // Seen in a real vault; there's no time in the name. The English form isn't confirmed, so it isn't here.
    tool: "cloud",
    pattern: /^(.+) \(копия с компьютера (.+?)\)(?: \(\d+\))?$/,
    read: (m) => ({ device: m[2]!.trim() }),
  },
];

/**
 * The conflict copy a file name is, or null. `fileName` is a base name. Dot
 * names are never copies (sync tools' own files, Gumply's temps).
 */
export function conflictCopyOf(fileName: string): ConflictCopyName | null {
  if (fileName.startsWith(".") || fileName.includes("/")) return null;
  // With an extension the marker sits before it; without one (`README.sync-conflict-…`)
  // the marker's own dot is the last one, so the whole name is tried too.
  for (const [stem, extension] of [splitExtension(fileName), [fileName, ""] as [string, string]]) {
    for (const { tool, pattern, read } of PATTERNS) {
      const match = pattern.exec(stem);
      if (!match) continue;
      const base = match[1]!.trim();
      if (base.length === 0) continue;
      return { tool, originalName: `${base}${extension}`, ...read(match) };
    }
  }
  return null;
}

/**
 * A name that *might* be a copy (iCloud, OneDrive, Google Drive), by name
 * alone; the caller also needs the original beside it and shared content
 * (`sharedRatio`). Null for names that can't be one.
 */
export function possibleCopyOf(fileName: string): PossibleCopyName | null {
  if (fileName.startsWith(".") || fileName.includes("/") || conflictCopyOf(fileName)) return null;
  const [stem, extension] = splitExtension(fileName);
  const forms: Array<[PossibleCopyName["form"], RegExp]> = [
    ["number", /^(.+) ([2-9]|[1-9]\d+)$/],
    ["paren", /^(.+) \((\d+)\)$/],
    ["device", /^(.+)-([A-Za-z0-9_]{1,15})$/],
  ];
  for (const [form, pattern] of forms) {
    const match = pattern.exec(stem);
    const base = match?.[1]?.trim();
    if (base) return { form, originalName: `${base}${extension}` };
  }
  return null;
}

/**
 * How much two files share, 0–1: the multiset of non-blank lines (or board
 * card ids) both have, over the larger of the two. Two empty files share 0.
 */
export function sharedRatio(a: readonly string[], b: readonly string[]): number {
  const left = a.filter((item) => item.trim().length > 0);
  const right = b.filter((item) => item.trim().length > 0);
  const larger = Math.max(left.length, right.length);
  if (larger === 0) return 0;
  const counts = new Map<string, number>();
  for (const item of left) counts.set(item, (counts.get(item) ?? 0) + 1);
  let shared = 0;
  for (const item of right) {
    const count = counts.get(item) ?? 0;
    if (count > 0) {
      shared += 1;
      counts.set(item, count - 1);
    }
  }
  return shared / larger;
}

/** D43: possible copies share at least this much with their original. */
export const POSSIBLE_COPY_MIN_SHARED = 0.6;
