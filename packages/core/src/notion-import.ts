/**
 * Notion import planner (v0.8 B2, #znyztw3t; spec/notion-import).
 *
 * Pure: it takes the entries of a Notion "Markdown & CSV" export (already
 * unzipped and checked by the server) and returns every file to write, as
 * vault paths and exact contents, plus the report. Nothing here touches the
 * disk, so the whole import is planned before a single file is written.
 *
 * Databases (§6, B3 #cwi22mc6): each row page gets its properties as
 * frontmatter (types inferred from the CSV), and each database a `.base`
 * with a table view (plus a board where the export points to one); see
 * notion-databases.ts.
 */
import { attachmentHref } from "./attachment-paths.js";
import { pageSegment } from "./ids.js";
import { maskCode } from "./links.js";
import { isTagsKey } from "./frontmatter-keys.js";
import { orderedFrontmatterYaml } from "./note-template.js";
import {
  columnPropertyType,
  columnValue,
  inferNotionColumn,
  isSelectLike,
  KANBAN_MAX_GROUPS,
  notionBaseSource,
  notionPropertyKey,
  parseCsv,
  type NotionColumnKind,
  type RelationItem,
} from "./notion-databases.js";
import type { PropertyType } from "./properties.js";

/**
 * The import's limits (spec/api-import): the server enforces them, and the
 * web app quotes them in its messages, so they're defined once, here.
 */
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

/** A limit for messages: `1 GB`, `25 MB`, `1000 bytes`. */
export function formatImportLimit(bytes: number): string {
  const gb = 1024 * 1024 * 1024;
  const mb = 1024 * 1024;
  if (bytes >= gb && bytes % gb === 0) return `${bytes / gb} GB`;
  if (bytes >= mb && bytes % mb === 0) return `${bytes / mb} MB`;
  return `${bytes} bytes`;
}

/** One file from the export (a page, a CSV or an attachment). */
export interface NotionEntry {
  /** Path inside the zip, `/`-separated, e.g. `Private & Shared/Test page 41f9….md`. */
  path: string;
  data: Uint8Array;
}

export interface NotionImportOptions {
  /** Vault path of the new import folder, e.g. `Notion import` or `Work/Notion import 2`. */
  folder: string;
  /** Vault path of its attachments folder, e.g. `attachments/Notion import`. */
  attachmentsFolder: string;
  /** Titles of the pages already in the vault: a link to a title that isn't unique gets its path. */
  vaultTitles?: readonly string[];
  /** The vault's stored property types: they win over the import's guesses (B3). */
  vaultTypes?: Readonly<Record<string, PropertyType>>;
}

/** A file the import writes, at a vault path. */
export interface NotionPlannedFile {
  path: string;
  content: string | Uint8Array;
}

/** A database for B3 to finish (§6). */
export interface NotionPlannedDatabase {
  /** The database's name, e.g. `DB`. */
  name: string;
  /** Where its `.base` goes, e.g. `Notion import/Private & Shared/Test page/DB.base`. */
  basePath: string;
  /** The folder holding its row pages, e.g. `Notion import/Private & Shared/Test page/DB`. */
  rowsFolder: string;
  /** Zip paths of the view CSV and the all-properties CSV (either may be missing). */
  viewCsv: string | null;
  allCsv: string | null;
  /** Vault paths of its row pages, in the order of the export. */
  rows: string[];
}

export interface NotionImportReport {
  pages: number;
  databases: number;
  rows: number;
  attachments: number;
  converted: {
    pageLinks: number;
    mentions: number;
    databaseEmbeds: number;
    databaseLinks: number;
    attachmentLinks: number;
    callouts: number;
    /** Relation cells' items that became `[[links]]` (B3). */
    relations: number;
  };
  /** Each database: its `.base`, property types and the views made (B3). */
  databaseDetails: Array<{
    name: string;
    base: string;
    properties: Array<{ key: string; type: PropertyType }>;
    /** The board's grouping property, when one was made. */
    kanban: string | null;
    /** A board left out: its column had more than 12 values. */
    kanbanSkipped: { key: string; groups: number } | null;
  }>;
  /** Column names that had to change to be property keys. */
  renamedKeys: Array<{ database: string; from: string; to: string }>;
  /** Keys whose type the vault (or an earlier database) already set: kept. */
  keptTypes: Array<{ key: string; type: PropertyType; found: PropertyType }>;
  /** Sub-pages of row pages: imported as pages, but not rows. */
  notRows: Array<{ page: string; database: string }>;
  /** Links to files that aren't in the zip (kept as written). */
  missing: Array<{ page: string; link: string }>;
  /** Mentions of pages that aren't in the export (kept as web links). */
  outside: Array<{ page: string; url: string }>;
  /** Entries left out, with the reason (set by the server for zip checks, too). */
  skipped: Array<{ path: string; reason: string }>;
}

export interface NotionImportPlan {
  files: NotionPlannedFile[];
  databases: NotionPlannedDatabase[];
  report: NotionImportReport;
  /** Property types to record for keys the vault doesn't type yet (B3; never text). */
  types: Record<string, PropertyType>;
}

const ID_SUFFIX = / ([0-9a-f]{32})$/;
const decoder = new TextDecoder("utf-8");

const posixDirname = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const posixBasename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** `a/b/../c` → `a/c`; null when it climbs out of the export. */
function normalisePath(path: string): string | null {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(segment);
  }
  return out.join("/");
}

/** `Test page 41f9…` → { name: "Test page", id: "41f9…" }. */
export function stripNotionId(stem: string): { name: string; id: string | null } {
  const match = ID_SUFFIX.exec(stem);
  return match ? { name: stem.slice(0, match.index), id: match[1]! } : { name: stem, id: null };
}

/** The 32-hex id a Notion URL points at (`app.notion.com/p/<id>`, `www.notion.so/Slug-<id>`). */
export function notionUrlId(url: string): string | null {
  const match = /^https?:\/\/(?:app|www)\.notion\.(?:com|so)\/(?:[^?#]*?)([0-9a-f]{32})(?:[?#]|$)/i.exec(url);
  return match ? match[1]!.toLowerCase() : null;
}

function decodeHref(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

/** The same rules as an upload's name (spaces kept: the export's names are the user's). */
function attachmentName(raw: string): string {
  const base = raw.normalize("NFC");
  const dot = base.lastIndexOf(".");
  const stem = (dot > 0 ? base.slice(0, dot) : base)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:*?"<>|#^[\]]/g, "-")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 100);
  const extension = (dot > 0 ? base.slice(dot) : "").replace(/[^\p{L}\p{N}.]/gu, "").slice(0, 20).toLowerCase();
  return `${stem || "file"}${extension}`;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** The header row of a CSV (BOM and CRLF tolerated); B3 parses the rest. */
function csvHeader(text: string): string[] {
  const line = text.replace(/^﻿/, "").split(/\r?\n/, 1)[0] ?? "";
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      cells.push(cell);
      cell = "";
    } else cell += char;
  }
  cells.push(cell);
  return cells.map((value) => value.trim());
}

/** Notion's code-block language names → the editor's (lowlight) ids. */
function codeLanguage(name: string): string {
  const value = name.trim().toLowerCase();
  if (value === "plain text" || value === "plaintext" || value === "text") return "";
  const known: Record<string, string> = { "c++": "cpp", "c#": "csharp", "f#": "fsharp", shell: "bash", "objective-c": "objectivec" };
  return known[value] ?? value.replace(/\s+/g, "");
}

const CALLOUT_TYPES: Array<[RegExp, string]> = [
  [/^💡/u, "tip"],
  [/^⚠️?/u, "warning"],
  [/^(❗|🚨|❌)/u, "danger"],
  [/^ℹ️?/u, "info"],
  [/^(✅|✔️?)/u, "success"],
];

/** `<aside>` blocks → Obsidian callouts (D29); the leading emoji picks the type. */
function convertCallouts(text: string, onCallout: () => void): string {
  return text.replace(/^<aside>\n([\s\S]*?)\n<\/aside>$/gm, (_all, body: string) => {
    onCallout();
    const lines = body.split("\n");
    const first = lines.findIndex((line) => line.trim().length > 0);
    let type = "note";
    if (first >= 0) {
      const head = lines[first]!.trimStart();
      const known = CALLOUT_TYPES.find(([pattern]) => pattern.test(head));
      if (known) type = known[1];
      // Drop the icon (any leading emoji), keep the text after it.
      lines[first] = head.replace(/^\p{Extended_Pictographic}️?\s*/u, "");
    }
    while (lines.length && lines[0]!.trim() === "") lines.shift();
    while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
    return [`> [!${type}]`, ...lines.map((line) => (line.trim() === "" ? ">" : `> ${line}`))].join("\n");
  });
}

/** Rewrite the language on fence openers; everything inside fences stays. */
function convertCodeFences(text: string): string {
  let fence: string | null = null;
  return text
    .split("\n")
    .map((line) => {
      const match = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(line);
      if (!match) return line;
      if (fence) {
        if (match[2]!.startsWith(fence) && match[3]!.trim() === "") fence = null;
        return line;
      }
      fence = match[2]!;
      const info = match[3]!.trim();
      return info ? `${match[1]}${match[2]}${codeLanguage(info)}` : line;
    })
    .join("\n");
}

interface PageInfo {
  zipPath: string;
  vaultPath: string;
  title: string;
  /** The title as the export wrote it (before D20 cleaning), for the H1 check. */
  rawTitle: string;
  id: string | null;
  database: NotionPlannedDatabase | null;
}

/** Plan a Notion import (spec/notion-import §1–5, §7, §8). */
export function planNotionImport(entries: readonly NotionEntry[], options: NotionImportOptions): NotionImportPlan {
  const report: NotionImportReport = {
    pages: 0,
    databases: 0,
    rows: 0,
    attachments: 0,
    converted: { pageLinks: 0, mentions: 0, databaseEmbeds: 0, databaseLinks: 0, attachmentLinks: 0, callouts: 0, relations: 0 },
    databaseDetails: [],
    renamedKeys: [],
    keptTypes: [],
    notRows: [],
    missing: [],
    outside: [],
    skipped: [],
  };
  const folder = options.folder.replace(/\/+$/, "");
  const byPath = new Map(entries.map((entry) => [entry.path.normalize("NFC"), entry]));
  const paths = [...byPath.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  // Directories: every segment loses its id and gets a D20 name.
  const dirCache = new Map<string, string>();
  const vaultDir = (zipDir: string): string => {
    if (!zipDir) return folder;
    const cached = dirCache.get(zipDir);
    if (cached !== undefined) return cached;
    const parent = vaultDir(posixDirname(zipDir));
    const mapped = `${parent}/${pageSegment(stripNotionId(posixBasename(zipDir)).name)}`;
    dirCache.set(zipDir, mapped);
    return mapped;
  };

  // Names taken in each vault folder (case-insensitive, D20).
  const taken = new Map<string, Set<string>>();
  const claim = (dir: string, name: string, extension: string): string => {
    const used = taken.get(dir) ?? new Set<string>();
    taken.set(dir, used);
    let candidate = name;
    for (let n = 2; used.has(`${candidate}${extension}`.toLowerCase()); n += 1) candidate = `${name} ${n}`;
    used.add(`${candidate}${extension}`.toLowerCase());
    return candidate;
  };

  // Databases first: their CSVs name the row folders.
  type Database = NotionPlannedDatabase & { zipDir: string; headers: string[]; viewHeaders: string[] | null };
  const databases = new Map<string, Database>();
  for (const path of paths) {
    if (!/\.csv$/i.test(path)) continue;
    const stem = posixBasename(path).replace(/\.csv$/i, "");
    const all = stem.endsWith("_all");
    const { name, id } = stripNotionId(all ? stem.slice(0, -4) : stem);
    const zipDir = posixDirname(path);
    const key = `${zipDir}\u0000${id ?? name}`;
    let database = databases.get(key);
    if (!database) {
      const dir = vaultDir(zipDir);
      const baseName = claim(dir, pageSegment(name), ".base");
      database = {
        name: baseName,
        basePath: `${dir}/${baseName}.base`,
        rowsFolder: vaultDir(zipDir ? `${zipDir}/${name}` : name),
        viewCsv: null,
        allCsv: null,
        rows: [],
        zipDir: zipDir ? `${zipDir}/${name}` : name,
        headers: [],
        viewHeaders: null,
      };
      databases.set(key, database);
    }
    if (all) {
      database.allCsv = path;
      database.headers = csvHeader(decoder.decode(byPath.get(path)!.data));
    } else {
      database.viewCsv = path;
      database.viewHeaders = csvHeader(decoder.decode(byPath.get(path)!.data));
      // Without `_all.csv`, the view's columns are all there is.
      if (!database.allCsv) database.headers = database.viewHeaders;
    }
  }
  const databaseByRowsDir = new Map([...databases.values()].map((database) => [database.zipDir, database]));
  const databaseByCsv = new Map<string, Database>();
  for (const database of databases.values()) {
    if (database.viewCsv) databaseByCsv.set(database.viewCsv, database);
    if (database.allCsv) databaseByCsv.set(database.allCsv, database);
  }

  // Pages.
  const pages = new Map<string, PageInfo>();
  const pageById = new Map<string, PageInfo>();
  for (const path of paths) {
    if (!/\.md$/i.test(path)) continue;
    const zipDir = posixDirname(path);
    const { name, id } = stripNotionId(posixBasename(path).replace(/\.md$/i, ""));
    const dir = vaultDir(zipDir);
    const title = claim(dir, pageSegment(name), ".md");
    const database = databaseByRowsDir.get(zipDir) ?? null;
    const info: PageInfo = { zipPath: path, vaultPath: `${dir}/${title}.md`, title, rawTitle: name, id, database };
    pages.set(path, info);
    if (id) pageById.set(id, info);
    if (database) database.rows.push(info.vaultPath);
    else {
      // Deeper than a database's rows folder: a row's sub-page, not a row (§6).
      const owner = [...databaseByRowsDir.entries()].find(([rowsDir]) => zipDir.startsWith(`${rowsDir}/`));
      if (owner) report.notRows.push({ page: info.vaultPath, database: owner[1].name });
    }
  }

  // Attachments: everything else, deduped by name within the folder and by content.
  const attachments = new Map<string, string>();
  const stored: Array<{ vaultPath: string; data: Uint8Array }> = [];
  const files: NotionPlannedFile[] = [];
  const attachmentNames = new Set<string>();
  for (const path of paths) {
    if (/\.(md|csv)$/i.test(path)) continue;
    const data = byPath.get(path)!.data;
    const same = stored.find((item) => sameBytes(item.data, data));
    if (same) {
      attachments.set(path, same.vaultPath);
      continue;
    }
    const name = attachmentName(posixBasename(path));
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : "";
    let candidate = name;
    for (let n = 1; attachmentNames.has(candidate.toLowerCase()); n += 1) candidate = `${stem}-${n}${extension}`;
    attachmentNames.add(candidate.toLowerCase());
    const vaultPath = `${options.attachmentsFolder}/${candidate}`;
    attachments.set(path, vaultPath);
    stored.push({ vaultPath, data });
    files.push({ path: vaultPath, content: data });
  }
  report.attachments = stored.length;

  // Link targets: the title when unique in the vault, else the path.
  const titleCounts = new Map<string, number>();
  for (const title of [...(options.vaultTitles ?? []), ...[...pages.values()].map((page) => page.title)]) {
    const key = title.toLowerCase();
    titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
  }
  const baseCounts = new Map<string, number>();
  for (const database of databases.values()) baseCounts.set(database.name.toLowerCase(), (baseCounts.get(database.name.toLowerCase()) ?? 0) + 1);
  const pageTarget = (page: PageInfo) =>
    (titleCounts.get(page.title.toLowerCase()) ?? 0) > 1 ? page.vaultPath.replace(/\.md$/, "") : page.title;
  const baseTarget = (database: NotionPlannedDatabase) =>
    (baseCounts.get(database.name.toLowerCase()) ?? 0) > 1 ? database.basePath : `${database.name}.base`;
  // A path target still reads as its title (spec §4: `[[Notion import/…/Title|Title]]`).
  const wikilink = (target: string, text: string, title: string) => {
    const shown = text || title;
    return shown !== target && (target.includes("/") || shown !== title) ? `[[${target}|${shown}]]` : `[[${target}]]`;
  };

  // Databases (§6): frontmatter for each row page, and the `.base`.
  const frontmatter = new Map<string, string>();
  const types: Record<string, PropertyType> = {};
  const keptTypes = new Map<string, NotionImportReport["keptTypes"][number]>();
  // Obsidian matches property names case-insensitively (`Due` is `due`), so types are looked up that way too.
  const vaultTypeByName = new Map(Object.entries(options.vaultTypes ?? {}).map(([key, type]) => [key.toLowerCase(), type]));
  const knownType = (key: string): PropertyType | undefined =>
    vaultTypeByName.get(key.toLowerCase()) ?? Object.entries(types).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
  for (const database of databases.values()) {
    const csvPath = database.allCsv ?? database.viewCsv;
    if (!csvPath) continue;
    const rows = parseCsv(decoder.decode(byPath.get(csvPath)!.data));
    const headers = (rows.shift() ?? []).map((header) => header.trim());
    const used = new Set<string>();
    const columns = headers.slice(1).map((header, offset) => {
      const index = offset + 1;
      const key = notionPropertyKey(header, used);
      if (key !== header) report.renamedKeys.push({ database: database.name, from: header, to: key });
      const values = rows.map((row) => row[index] ?? "");
      const kind: NotionColumnKind = inferNotionColumn(header, values);
      return { header, key, index, kind, values };
    });

    // Types: the vault's own (or an earlier database's) win; text is the default and never recorded.
    for (const column of columns) {
      if (!column.values.some((value) => value.trim())) continue;
      // `tags` (any case) is the note's tags in Obsidian and Gumply (#ippqkgus, core `isTagsKey`): never given a stored type.
      if (isTagsKey(column.key)) continue;
      const found = columnPropertyType(column.kind);
      const existing = knownType(column.key);
      if (existing !== undefined && existing !== found) keptTypes.set(column.key, { key: column.key, type: existing, found });
      else if (existing === undefined && found !== "text") types[column.key] = found;
    }

    // Rows → pages by title, in CSV order when titles repeat.
    const queue = new Map<string, PageInfo[]>();
    for (const vaultPath of database.rows) {
      const page = [...pages.values()].find((candidate) => candidate.vaultPath === vaultPath);
      if (!page) continue;
      const key = page.rawTitle.trim();
      queue.set(key, [...(queue.get(key) ?? []), page]);
    }
    const link = (row: PageInfo) => (item: RelationItem) => {
      const target = pageById.get(item.id.toLowerCase());
      if (target) {
        report.converted.relations += 1;
        return wikilink(pageTarget(target), "", target.title);
      }
      if (/^[a-z][a-z0-9+.-]*:/i.test(item.ref)) report.outside.push({ page: row.vaultPath, url: item.ref });
      else report.missing.push({ page: row.vaultPath, link: item.ref });
      return item.title;
    };
    for (const row of rows) {
      if (row.every((cell) => cell.trim() === "")) continue;
      const title = (row[0] ?? "").trim();
      const page = queue.get(title)?.shift();
      if (!page) {
        report.skipped.push({ path: csvPath, reason: `the row "${title}" has no page in the export` });
        continue;
      }
      const entries = columns.map((column) => [column.key, columnValue(column.kind, row[column.index] ?? "", link(page))] as const);
      const yaml = orderedFrontmatterYaml(entries);
      if (yaml) frontmatter.set(page.vaultPath, yaml);
    }

    // Views: a table in the exported view's order; a board where the view leaves out a select-like column.
    const byHeader = new Map(columns.map((column) => [column.header, column]));
    const shown = database.viewHeaders
      ? database.viewHeaders.slice(1).map((header) => byHeader.get(header.trim())).filter((column) => column !== undefined)
      : columns;
    const tableColumns = shown.map((column) => column.key);
    let kanban: { key: string; groups: string[]; columns: string[] } | null = null;
    let kanbanSkipped: { key: string; groups: number } | null = null;
    if (database.viewHeaders) {
      const visible = new Set(database.viewHeaders.map((header) => header.trim()));
      const hidden = columns.find(
        (column) => !visible.has(column.header) && column.values.some((value) => value.trim()) && isSelectLike(column.kind, column.values),
      );
      if (hidden) {
        const groups = [...new Set(hidden.values.map((value) => value.trim()).filter(Boolean))];
        if (groups.length <= KANBAN_MAX_GROUPS) kanban = { key: hidden.key, groups, columns: tableColumns };
        else kanbanSkipped = { key: hidden.key, groups: groups.length };
      }
    }
    files.push({ path: database.basePath, content: notionBaseSource({ rowsFolder: database.rowsFolder, columns: tableColumns, kanban }) });
    report.databaseDetails.push({
      name: database.name,
      base: database.basePath,
      properties: columns
        .filter((column) => column.values.some((value) => value.trim()))
        .map((column) => ({ key: column.key, type: isTagsKey(column.key) ? "tags" : (knownType(column.key) ?? columnPropertyType(column.kind)) })),
      kanban: kanban?.key ?? null,
      kanbanSkipped,
    });
  }
  report.keptTypes = [...keptTypes.values()];

  for (const page of pages.values()) {
    let text = decoder.decode(byPath.get(page.zipPath)!.data).replace(/^﻿/, "").replace(/\r\n/g, "\n");
    const noteId = page.vaultPath.replace(/\.md$/, "");

    // The leading `# Title` repeats the file name (decision 3).
    const heading = /^# (.*)\n(?:\n|$)?/.exec(text);
    if (heading && heading[1]!.trim() === page.rawTitle.trim()) text = text.slice(heading[0].length);

    // A row page's `Key: value` lines are Notion's dump of its properties (§6).
    const database = page.database as (NotionPlannedDatabase & { headers: string[] }) | null;
    if (database) {
      const keys = new Set(database.headers.slice(1));
      const lines = text.split("\n");
      let index = 0;
      while (index < lines.length && /^([^:\n]+): /.test(lines[index]!) && keys.has(/^([^:\n]+): /.exec(lines[index]!)![1]!)) index += 1;
      if (index > 0) {
        if (lines[index] === "") index += 1;
        text = lines.slice(index).join("\n");
      }
    }

    text = convertCallouts(text, () => (report.converted.callouts += 1));
    text = convertCodeFences(text);

    // Links, outside code.
    const masked = maskCode(text);
    const zipDir = posixDirname(page.zipPath);
    let out = "";
    let last = 0;
    for (const match of masked.matchAll(/(!?)\[([^\]\n]*)\]\(([^()\s]+)\)/g)) {
      const start = match.index!;
      const raw = text.slice(start, start + match[0].length);
      const bang = match[1]!;
      const label = text.slice(start + bang.length + 1, start + bang.length + 1 + match[2]!.length);
      const href = text.slice(start + match[0].length - 1 - match[3]!.length, start + match[0].length - 1);
      let replacement = raw;

      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
        const id = notionUrlId(href);
        if (id) {
          const target = pageById.get(id);
          if (target) {
            replacement = wikilink(pageTarget(target), label === "‣" ? "" : label, target.title);
            report.converted.mentions += 1;
          } else {
            replacement = `[${label === "‣" ? "Notion page" : label}](${href})`;
            report.outside.push({ page: page.vaultPath, url: href });
          }
        }
      } else {
        const resolved = normalisePath(zipDir ? `${zipDir}/${decodeHref(href)}` : decodeHref(href));
        const linkedPage = resolved ? pages.get(resolved) : undefined;
        const linkedDatabase = resolved ? databaseByCsv.get(resolved) : undefined;
        const linkedFile = resolved ? attachments.get(resolved) : undefined;
        if (linkedPage) {
          replacement = wikilink(pageTarget(linkedPage), label, linkedPage.title);
          report.converted.pageLinks += 1;
        } else if (linkedDatabase) {
          // Alone on its line: Notion's inline database → a live embed (decision 2).
          const lineStart = text.lastIndexOf("\n", start - 1) + 1;
          const lineEnd = text.indexOf("\n", start) === -1 ? text.length : text.indexOf("\n", start);
          const alone = text.slice(lineStart, lineEnd).trim() === raw;
          if (alone) {
            replacement = `![[${baseTarget(linkedDatabase)}]]`;
            report.converted.databaseEmbeds += 1;
          } else {
            replacement = `[[${baseTarget(linkedDatabase)}|${label || linkedDatabase.name}]]`;
            report.converted.databaseLinks += 1;
          }
        } else if (linkedFile) {
          replacement = `${bang}[${label}](${attachmentHref(noteId, linkedFile)})`;
          report.converted.attachmentLinks += 1;
        } else {
          report.missing.push({ page: page.vaultPath, link: href });
        }
      }
      out += text.slice(last, start) + replacement;
      last = start + match[0].length;
    }
    text = out + text.slice(last);

    text = text.replace(/\n+$/, "");
    const yaml = frontmatter.get(page.vaultPath);
    // As Gumply writes a note: the block, a blank line, the body (serializeNote).
    const body = text.length ? `${text}\n` : "";
    files.push({ path: page.vaultPath, content: yaml ? `---\n${yaml}---\n${body ? `\n${body}` : ""}` : body });
    if (database) report.rows += 1;
    else report.pages += 1;
  }

  report.databases = databases.size;
  const planned = [...databases.values()].map(({ zipDir: _zipDir, headers: _headers, viewHeaders: _view, ...database }) => database);
  return { files, databases: planned, report, types };
}

/** Property types in the report's words. */
const TYPE_WORDS: Record<PropertyType, string> = {
  text: "text",
  multitext: "list",
  number: "number",
  checkbox: "checkbox",
  date: "date",
  datetime: "date and time",
  tags: "tags",
  aliases: "aliases",
};

/** `1 page`, `2 pages`. */
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * `Import report.md` (§8), written into the import folder. Plain text only:
 * no `[[…]]` in it, so the report never links to pages by accident.
 */
export function notionReportMarkdown(report: NotionImportReport, folder: string): string {
  const { converted } = report;
  const lines = [
    `# Notion import`,
    "",
    `Imported into \`${folder}\`.`,
    "",
    "## Imported",
    "",
    `- ${count(report.pages, "page", "pages")}`,
    `- ${count(report.databases, "database", "databases")} with ${count(report.rows, "row", "rows")}`,
    `- ${count(report.attachments, "attachment", "attachments")}`,
    "",
    "## Converted",
    "",
    `- ${count(converted.pageLinks, "link", "links")} and ${count(converted.mentions, "mention", "mentions")} to wiki links`,
    `- ${count(converted.databaseEmbeds, "database", "databases")} embedded as live views, ${count(converted.databaseLinks, "database link", "database links")}`,
    ...(converted.relations ? [`- ${count(converted.relations, "relation", "relations")} to wiki links`] : []),
    `- ${count(converted.attachmentLinks, "link", "links")} to attachments`,
    `- ${count(converted.callouts, "callout", "callouts")} (their icons are not in the export)`,
  ];
  if (report.databaseDetails.length) {
    lines.push("", "## Databases", "");
    for (const database of report.databaseDetails) {
      const properties = database.properties.map((property) => `${property.key} (${TYPE_WORDS[property.type]})`).join(", ");
      let views = "a table view in Notion's column order";
      if (database.kanban) views += `, and a board grouped by ${database.kanban} (Notion's exported view leaves that column out, so it was probably a board)`;
      if (database.kanbanSkipped) {
        views += `; no board for ${database.kanbanSkipped.key}: it has ${database.kanbanSkipped.groups} values (more than ${KANBAN_MAX_GROUPS})`;
      }
      lines.push(`- ${database.name}: ${views}. Properties: ${properties || "none"}.`);
    }
  }
  if (report.renamedKeys.length) {
    lines.push("", "## Renamed properties", "");
    for (const item of report.renamedKeys) lines.push(`- ${item.database}: ${item.from} → ${item.to}`);
  }
  if (report.keptTypes.length) {
    lines.push("", "## Property types kept from your vault", "");
    for (const item of report.keptTypes) lines.push(`- ${item.key}: ${TYPE_WORDS[item.type]} (the import found ${TYPE_WORDS[item.found]})`);
  }
  if (report.notRows.length) {
    lines.push("", "## Sub-pages of database rows", "");
    for (const item of report.notRows) lines.push(`- ${item.page}: imported as a page, not as a row of ${item.database}`);
  }
  lines.push(
    "",
    "## Not in a Notion export",
    "",
    "Database views: filters, sorts and layouts (Gumply made a table, and a board where the export points to one), formula and rollup settings (their values arrive as text), option colours, text colours, toggles, comments, synced blocks, permissions, people, files in file properties (their names arrive as text), and embeds of other apps.",
  );
  if (report.outside.length) {
    lines.push("", "## Links to pages that weren't exported", "");
    for (const item of report.outside) lines.push(`- ${item.page}: ${item.url}`);
  }
  if (report.missing.length) {
    lines.push("", "## Links to files missing from the export", "");
    for (const item of report.missing) lines.push(`- ${item.page}: \`${item.link}\``);
  }
  if (report.skipped.length) {
    lines.push("", "## Skipped", "");
    for (const item of report.skipped) lines.push(`- \`${item.path}\`: ${item.reason}`);
  }
  return `${lines.join("\n")}\n`;
}
