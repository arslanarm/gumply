import { t } from "../i18n/index.js";
/**
 * Accessible names for TipTap to-do checkboxes (spec/ux §11). The default
 * label is "Task item checkbox for empty task item", which tells a screen
 * reader neither the item nor what the click will do.
 */
export function taskCheckboxLabel(text: string, checked: boolean): string {
  const title = text.trim();
  if (title.length === 0) return checked ? t("tasks.markNotDone") : t("tasks.markDone");
  return checked ? t("tasks.markTitleNotDone", { title }) : t("tasks.markTitleDone", { title });
}
