/**
 * Downloads in the desktop app (spec/v0-6 §D, board export). The web app
 * saves exports with a normal browser download of a `blob:` URL it made; the
 * app then shows the native Save dialog. Nothing else may download: only
 * blob URLs created by the app's own origin are allowed (no remote files, no
 * `data:`/`file:` URLs, no blobs from another origin).
 */

/** Whether a download of `url` is the app's own export. */
export function isAppDownload(url: string, appOrigin: string): boolean {
  if (!appOrigin || !url.startsWith("blob:")) return false;
  try {
    // `blob:http://127.0.0.1:1234/uuid` has the origin of the page that made it.
    return new URL(url).origin === appOrigin;
  } catch {
    return false;
  }
}

/** A safe file name to suggest: no folders, no reserved characters. */
export function suggestedName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim();
  return clean && clean !== "." && clean !== ".." ? clean : "Gumply export";
}

/**
 * G2: the web app hands a page to print as a download named
 * `<Title>.<token>.gumply-print.html` (keep in step with
 * apps/web/src/export/run-export.ts). The token is random per launch and
 * only the app's own page learns it (/api/health), so a file that merely
 * ends in `.gumply-print.html` (say, a vault attachment) is a normal
 * download. Main prints only these to PDF instead of saving them.
 */
export const PRINT_DOWNLOAD_SUFFIX = ".gumply-print.html";

export function isPrintDownload(fileName: string, token: string): boolean {
  if (!/^[0-9a-f]{16,}$/.test(token)) return false;
  const ending = `.${token}${PRINT_DOWNLOAD_SUFFIX}`;
  return fileName.endsWith(ending) && fileName.length > ending.length;
}

/** `Plan.<token>.gumply-print.html` → `Plan.pdf`, safe for the Save dialog. */
export function pdfName(fileName: string, token: string): string {
  return `${suggestedName(fileName.slice(0, -`.${token}${PRINT_DOWNLOAD_SUFFIX}`.length))}.pdf`;
}
