/**
 * G1: export a page as HTML, from the app (row ⋯ menu, Cmd+K). Wires the
 * pure builder (`html-export.ts`) to the API, then downloads the file (the
 * desktop app turns the download into its Save dialog, as board exports do).
 */
import type { BaseValue, PageId, PageMeta } from "@gumply/core";
import { api, fileUrl } from "../api/client.js";
import { display } from "../bases/TableView.js";
import { propertyLabel } from "../bases/labels.js";
import { downloadBlob } from "../board/export/download.js";
import { highlightToHtml } from "../editor/code/highlight-plugin.js";
import { currentLanguage, t } from "../i18n/index.js";
import { renderMermaid } from "../lib/diagram.js";
import { resolveFileLinkAsync } from "../lib/file-links.js";
import { mathToHtml } from "../lib/math.js";
import exportCss from "./export.css?raw";
import { buildPageHtml, exportFileName, type ExportFile, type ExportOptions, type ExportSource, type PrintOptions } from "./html-export.js";

/**
 * G2: the desktop app recognises this download (main's will-download) and
 * prints it to PDF in a hidden window instead of saving it. Keep in step
 * with apps/desktop/src/downloads.ts.
 */
export const PRINT_DOWNLOAD_SUFFIX = ".gumply-print.html";

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

/** A vault file's bytes as base64 (images only: anything else isn't inlined). */
async function loadFile(vaultPath: string): Promise<ExportFile | null> {
  const extension = vaultPath.split(".").pop()?.toLowerCase() ?? "";
  const mime = MIME[extension];
  if (!mime) return null;
  const response = await fetch(fileUrl(vaultPath));
  if (!response.ok) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return { mime, base64: btoa(binary) };
}

/** The builder's view of the app. */
export function exportSource(pages: readonly PageMeta[]): ExportSource {
  return {
    pages,
    loadPage: (id) => api.getPage(id).catch(() => null),
    resolveFile: (link, from, fileLinks) => resolveFileLinkAsync(link, from, fileLinks),
    loadFile,
    runBase: async (id, view, thisId) => {
      const [doc, result] = await Promise.all([api.getBase(id), api.runBaseView(id, { name: view, thisId })]);
      return { result, label: (columnId: string) => propertyLabel(columnId, doc.config, t) };
    },
    formatValue: (value, type) => display((value ?? null) as BaseValue, type),
    highlight: highlightToHtml,
    // MathML: no KaTeX fonts or CSS to inline, so the file stays small and offline.
    math: (tex, display) => mathToHtml(tex, { display, output: "mathml" }),
    diagram: (source, theme) => renderMermaid(source, { theme }),
    css: exportCss,
    t: (key, vars) => t(key, vars),
    language: currentLanguage(),
  };
}

/** Build and download `<Title>.html`; returns the file name. */
export async function exportPageAsHtml(id: PageId, pages: readonly PageMeta[], options: ExportOptions): Promise<string> {
  const page = await api.getPage(id);
  const html = await buildPageHtml(page, exportSource(pages), options);
  const name = exportFileName(page.title);
  downloadBlob(new Blob([html], { type: "text/html;charset=utf-8" }), name);
  return name;
}

/**
 * G2: print the page to PDF. The desktop app does it in main (printToPDF, a
 * Save dialog); a browser prints the same document from a hidden iframe, and
 * its own dialog offers "Save as PDF".
 */
export async function exportPageAsPdf(id: PageId, pages: readonly PageMeta[], print: PrintOptions): Promise<string> {
  const [page, health] = await Promise.all([api.getPage(id), api.health()]);
  const html = await buildPageHtml(page, exportSource(pages), { theme: "light", links: "text", print });
  const name = exportFileName(page.title).replace(/\.html$/, ".pdf");
  // The desktop app prints in main; it recognises the hand-off by this launch's token.
  if (health.desktop && health.printToken) {
    downloadBlob(new Blob([html], { type: "text/html;charset=utf-8" }), exportFileName(page.title).replace(/\.html$/, `.${health.printToken}${PRINT_DOWNLOAD_SUFFIX}`));
    return name;
  }
  printInFrame(html, page.title);
  return name;
}

/** The document in a hidden same-origin iframe, printed with the browser's own dialog. */
export function printInFrame(html: string, title: string): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  frame.title = title;
  frame.setAttribute("aria-hidden", "true");
  frame.dataset.testid = "print-frame";
  frame.style.cssText = "position: fixed; right: 0; bottom: 0; width: 0; height: 0; border: 0; visibility: hidden;";
  let printed = false;
  const remove = () => window.setTimeout(() => frame.remove(), 1000);
  frame.addEventListener("load", () => {
    if (printed) return;
    printed = true;
    const view = frame.contentWindow;
    if (!view) return;
    view.addEventListener("afterprint", remove, { once: true });
    view.focus();
    view.print();
    // Some browsers don't fire afterprint: don't keep the frame forever.
    window.setTimeout(() => frame.remove(), 120_000);
  });
  frame.srcdoc = html;
  document.body.append(frame);
  return frame;
}
