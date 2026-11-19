/**
 * Accessible names for TipTap to-do checkboxes (spec/ux §11). The default
 * label is "Task item checkbox for empty task item", which tells a screen
 * reader neither the item nor what the click will do.
 */
export function taskCheckboxLabel(text: string, checked: boolean): string {
  const title = text.trim();
  if (title.length === 0) return checked ? "Mark to-do as not done" : "Mark to-do as done";
  return checked ? `Mark “${title}” as not done` : `Mark “${title}” as done`;
}
