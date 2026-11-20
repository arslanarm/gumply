/** Formatting helpers for attachment cards (Q1c). */

/** Human-readable size: `820 B`, `12 KB`, `3.4 MB`. Empty when unknown. */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** `photo.png` → `photo` (used as the default image caption). */
export function fileNameWithoutExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

export function isImageMime(mime: string): boolean {
  return /^image\//i.test(mime);
}

/** `photo.PNG` → `PNG` (for the file-card badge). */
export function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toUpperCase() : "FILE";
}
