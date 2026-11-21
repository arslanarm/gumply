/**
 * D33 folder overview copy. `otherFiles` (spec/api v1.10) counts what isn't a
 * page or board (PDFs, images…) at any depth, so a folder holding only a PDF
 * doesn't read as empty.
 */
export function folderSummary(items: number, otherFiles = 0): string {
  const parts: string[] = [];
  if (items > 0 || otherFiles === 0) parts.push(items === 1 ? "1 item" : `${items} items`);
  if (otherFiles > 0) parts.push(otherFiles === 1 ? "1 other file" : `${otherFiles} other files`);
  return `Folder · ${parts.join(" · ")}`;
}
