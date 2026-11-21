/**
 * D33 folder overview copy. `otherFiles` (spec/api v1.10) counts what isn't a
 * page or board (PDFs, images…) at any depth, so a folder holding only a PDF
 * doesn't read as empty.
 */
import { t } from "../i18n/index.js";

export function folderSummary(items: number, otherFiles = 0): string {
  const parts: string[] = [];
  if (items > 0 || otherFiles === 0) parts.push(t("counts.items", { count: items }));
  if (otherFiles > 0) parts.push(t("counts.otherFiles", { count: otherFiles }));
  return t("folders.summary", { parts: parts.join(" · ") });
}
