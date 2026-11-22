/**
 * B4 (spec/notion-import §8): the pure parts of the "Import from Notion…"
 * dialog. Which message an error gets, what the progress bar shows, and which
 * "converted" counts are worth a line.
 */
import type { NotionImportReport } from "@gumply/core";
import type { NotionImportJob } from "../api/client.js";
import type { MessageKey } from "../i18n/index.js";

export type ImportErrorKind = "running" | "tooLarge" | "notExport" | "missingTarget" | "offline" | "failed" | "other";

/** The plain-words kind of a failed start or a failed job. */
export function importErrorKind(error: { status?: number; message?: string } | null | undefined): ImportErrorKind {
  const status = error?.status;
  if (status === 409) return "running";
  if (status === 413) return "tooLarge";
  if (status === 404) return "missingTarget";
  if (status === 400) return "notExport";
  if (status === undefined && error instanceof TypeError) return "offline";
  return "other";
}

export const IMPORT_ERROR_MESSAGES: Record<ImportErrorKind, MessageKey> = {
  running: "notionImport.errors.running",
  tooLarge: "notionImport.errors.tooLarge",
  notExport: "notionImport.errors.notExport",
  missingTarget: "notionImport.errors.missingTarget",
  offline: "notionImport.errors.offline",
  failed: "notionImport.errors.failed",
  other: "notionImport.errors.other",
};

/** Whether a picked file can be a Notion export (the server checks the rest). */
export function looksLikeZip(file: { name: string; type?: string }): boolean {
  return /\.zip$/i.test(file.name) || file.type === "application/zip" || file.type === "application/x-zip-compressed";
}

export const STEP_MESSAGES: Record<NotionImportJob["state"], MessageKey> = {
  reading: "notionImport.step.reading",
  planning: "notionImport.step.planning",
  writing: "notionImport.step.writing",
  done: "notionImport.step.done",
  failed: "notionImport.step.failed",
};

/** 0–100 while writing, null while the total isn't known yet (an indeterminate bar). */
export function progressPercent(job: Pick<NotionImportJob, "state" | "done" | "total">): number | null {
  if (job.state === "done") return 100;
  if (job.total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((job.done / job.total) * 100)));
}

/** The "converted" lines to show: only kinds that happened, in a fixed order. */
export function convertedLines(report: NotionImportReport): Array<{ key: MessageKey; count: number }> {
  const order: Array<[keyof NotionImportReport["converted"], MessageKey]> = [
    ["pageLinks", "notionImport.converted.pageLinks"],
    ["mentions", "notionImport.converted.mentions"],
    ["databaseEmbeds", "notionImport.converted.databaseEmbeds"],
    ["databaseLinks", "notionImport.converted.databaseLinks"],
    ["attachmentLinks", "notionImport.converted.attachmentLinks"],
    ["callouts", "notionImport.converted.callouts"],
    ["relations", "notionImport.converted.relations"],
  ];
  return order.map(([field, key]) => ({ key, count: report.converted[field] ?? 0 })).filter((line) => line.count > 0);
}

/** What Notion's "Markdown & CSV" export never carries (§8, always shown). */
export const NOT_IN_EXPORT: MessageKey[] = [
  "notionImport.lost.views",
  "notionImport.lost.formulas",
  "notionImport.lost.optionColours",
  "notionImport.lost.textColours",
  "notionImport.lost.toggles",
  "notionImport.lost.comments",
  "notionImport.lost.synced",
  "notionImport.lost.permissions",
  "notionImport.lost.people",
  "notionImport.lost.files",
  "notionImport.lost.embeds",
];

/** `Work/Notion import 2` → `Notion import 2`: the name the report leads with. */
export function folderName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

type DatabaseDetail = NotionImportReport["databaseDetails"][number];

/** One database's report line (B3): the views made and why, then its properties with their types. */
export function databaseLine(
  database: DatabaseDetail,
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
  typeName: (type: DatabaseDetail["properties"][number]["type"]) => string,
  maxGroups: number,
): string {
  const views = database.kanban
    ? t("notionImport.database.board", { name: database.name, key: database.kanban })
    : database.kanbanSkipped
      ? t("notionImport.database.boardSkipped", { name: database.name, key: database.kanbanSkipped.key, count: database.kanbanSkipped.groups, max: maxGroups })
      : t("notionImport.database.table", { name: database.name });
  const properties = database.properties.length
    ? t("notionImport.database.properties", { list: database.properties.map((property) => `${property.key} (${typeName(property.type)})`).join(", ") })
    : t("notionImport.database.noProperties");
  return `${views} ${properties}`;
}
