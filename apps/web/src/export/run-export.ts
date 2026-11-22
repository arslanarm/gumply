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
import { resolveFileLinkAsync } from "../lib/file-links.js";
import exportCss from "./export.css?raw";
import { buildPageHtml, exportFileName, type ExportFile, type ExportOptions, type ExportSource } from "./html-export.js";

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
