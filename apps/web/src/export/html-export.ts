/**
 * G1 (spec/export-html): a page as one self-contained `.html` file.
 *
 * The body is the page-preview renderer's HTML (`renderEmbeddedMarkdown`:
 * markdown-it with `html: false`, so page content never becomes markup),
 * then rewritten here, as a string, on the renderer's own escaped output:
 *
 * - images: vault files inlined as `data:` URIs (resolved like #8k4ssrkb);
 *   anything else becomes a short note, so the file never loads from the net;
 * - code: highlighted with the editor's highlighter;
 * - callouts: their icon inlined as SVG, and always open (no script);
 * - page previews: inlined, to the same depth as in the app;
 * - database views: a static table of the view's rows;
 * - boards: their name, as a link card;
 * - `[[links]]`: plain text, or links to sibling `.html` files (an option).
 *
 * The document has no script at all and a CSP that allows only inline
 * styles and `data:` images. Everything that touches the app (fetches,
 * formatting, strings) comes in through `ExportSource`, so this module is
 * plain string work and unit-tested as such.
 */
import {
  embeddedMarkdown,
  pageLook,
  parseEmbedPart,
  resolveAttachmentHref,
  resolveWikilink,
  type BaseViewResult,
  type Page,
  type PageMeta,
  type Property,
} from "@gumply/core";
import { calloutIconMarkup } from "../editor/callout/types.js";
import { escapeHtml, renderEmbeddedMarkdown } from "../editor/page-embed/render.js";
import { obsidianLinkOf } from "../lib/file-links.js";

export type ExportTheme = "light" | "dark" | "system";
export type ExportLinks = "text" | "files";

export interface ExportOptions {
  theme: ExportTheme;
  links: ExportLinks;
}

/** A vault file's bytes, for a `data:` URI. */
export interface ExportFile {
  mime: string;
  base64: string;
}

export interface ExportSource {
  pages: readonly PageMeta[];
  loadPage: (id: string) => Promise<Page | null>;
  /** Where an Obsidian link (`photo.png`) from note `from` points (#8k4ssrkb), or null. */
  resolveFile: (link: string, from: string, fileLinks?: Record<string, string | null> | null) => Promise<string | null>;
  loadFile: (vaultPath: string) => Promise<ExportFile | null>;
  runBase: (id: string, view: string | undefined, thisId: string) => Promise<{ result: BaseViewResult; label: (columnId: string) => string } | null>;
  /** A base value as the app shows it (dates in the interface language…). */
  formatValue: (value: unknown, type: string) => string;
  highlight: (language: string, code: string) => Promise<string | null>;
  /** The stylesheet the file carries (export.css). */
  css: string;
  t: (key: ExportMessage, vars?: Record<string, string | number>) => string;
  /** The interface language, for `<html lang>`. */
  language: string;
}

export type ExportMessage =
  | "export.missingImage"
  | "export.remoteImage"
  | "export.missingPage"
  | "export.loopPage"
  | "export.tooDeep"
  | "export.board"
  | "export.baseMissing"
  | "export.moreRows"
  | "export.rows"
  | "export.exportedFrom";

/** As deep as page previews go in the app (PageEmbedView's MAX_DEPTH). */
const MAX_DEPTH = 3;
/** A database view's snapshot stops here, with a "+N more" line. */
export const MAX_BASE_ROWS = 200;

/** Every restriction spelled out, though `default-src 'none'` already implies most. */
const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'; script-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'";

/** The HTML entities markdown-it and `escapeHtml` produce, back to text. */
export function unescapeHtml(value: string): string {
  return value.replace(/&(lt|gt|quot|#39|amp);/g, (_, name: string) =>
    name === "lt" ? "<" : name === "gt" ? ">" : name === "quot" ? '"' : name === "#39" ? "'" : "&",
  );
}

/** The file name the export downloads as. */
export function exportFileName(title: string): string {
  const clean = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim() || "Page";
  return `${clean}.html`;
}

/**
 * A link to another page's export: the file it downloads as, in the same
 * folder (downloads land side by side, whatever the vault's folders; as in
 * @board-dev's first G1 draft, f454953).
 */
export function siblingHref(title: string): string {
  return encodeURIComponent(exportFileName(title));
}

/** Replace every match of `pattern` in `text` with an async result (in order). */
async function replaceAsync(text: string, pattern: RegExp, replace: (match: RegExpExecArray) => Promise<string>): Promise<string> {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const regex = new RegExp(pattern.source, flags);
  const parts: Array<string | Promise<string>> = [];
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    parts.push(text.slice(last, match.index), replace(match));
    last = match.index + match[0].length;
  }
  parts.push(text.slice(last));
  return (await Promise.all(parts)).join("");
}

interface Context {
  source: ExportSource;
  options: ExportOptions;
  /** Inlined files, so one image used twice is fetched once. */
  files: Map<string, Promise<string | null>>;
}

function dataUri(context: Context, vaultPath: string): Promise<string | null> {
  let uri = context.files.get(vaultPath);
  if (!uri) {
    uri = context.source
      .loadFile(vaultPath)
      .then((file) => (file ? `data:${file.mime};base64,${file.base64}` : null))
      .catch(() => null);
    context.files.set(vaultPath, uri);
  }
  return uri;
}

function missingImage(context: Context, name: string): string {
  return `<span class="export-note">${escapeHtml(context.source.t("export.missingImage", { name }))}</span>`;
}

/** A page or board link: plain text, or a link to its sibling `.html` file. */
function linkHtml(context: Context, title: string, label: string, heading: string): string {
  const shown = escapeHtml(label);
  const page = resolveWikilink(title, context.source.pages);
  if (context.options.links === "files" && page && (page.kind ?? "page") === "page") {
    const hash = heading ? `#${encodeURIComponent(heading)}` : "";
    return `<a class="wiki-link" href="${escapeHtml(siblingHref(page.title))}${hash}">${shown}</a>`;
  }
  return `<span class="wiki-link${page ? "" : " is-unresolved"}">${shown}</span>`;
}

async function inlineImages(context: Context, html: string, fromId: string, fileLinks: Record<string, string | null> | null | undefined): Promise<string> {
  return replaceAsync(html, /<img src="([^"]*)" alt="([^"]*)"([^>]*)>/g, async (match) => {
    const src = unescapeHtml(match[1] ?? "");
    const alt = match[2] ?? "";
    const rest = match[3] ?? "";
    const obsidian = /data-obsidian="([^"]*)"/.exec(rest)?.[1];
    let vaultPath: string | null = null;
    if (obsidian !== undefined) {
      const link = obsidianLinkOf(unescapeHtml(obsidian));
      vaultPath = link ? await context.source.resolveFile(link, fromId, fileLinks).catch(() => null) : null;
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//")) {
      // A web image: the file stays offline, so it's named, not loaded.
      return `<span class="export-note">${escapeHtml(context.source.t("export.remoteImage", { url: src }))}</span>`;
    } else {
      vaultPath = resolveAttachmentHref(fromId, src) ?? null;
    }
    const name = (unescapeHtml(alt) || src.split("/").pop() || src).trim();
    if (!vaultPath) return missingImage(context, name);
    const uri = await dataUri(context, vaultPath);
    if (!uri) return missingImage(context, name);
    const width = /\|(\d{2,4})(?:x\d{2,4})?\]\]$/.exec(obsidian ? unescapeHtml(obsidian) : "")?.[1];
    return `<img src="${escapeHtml(uri)}" alt="${alt}"${width ? ` width="${width}"` : ""}>`;
  });
}

async function highlightCode(context: Context, html: string): Promise<string> {
  return replaceAsync(html, /<pre><code class="language-([\w+#.-]+)">([\s\S]*?)<\/code><\/pre>/g, async (match) => {
    const language = match[1] ?? "";
    const code = unescapeHtml(match[2] ?? "");
    const highlighted = await context.source.highlight(language, code).catch(() => null);
    return `<pre><code class="language-${language}">${highlighted ?? match[2]}</code></pre>`;
  });
}

/** Callout icons inlined; foldable callouts shown open, without their (script-only) fold button. */
function staticCallouts(html: string): string {
  return html
    .replace(/<span class="callout-icon" data-callout-icon="([^"]*)" aria-hidden="true"><\/span>/g, (_, type: string) =>
      `<span class="callout-icon" aria-hidden="true">${calloutIconMarkup(unescapeHtml(type))}</span>`,
    )
    .replace(/<button type="button" class="callout-fold"[^>]*><\/button>/g, "")
    .replace(/(<div class="callout[^"]*?) is-closed"/g, '$1"');
}

/** `<wiki-link>` and file attachments as the chosen link style / plain names. */
function staticLinks(context: Context, html: string): string {
  return html
    .replace(/<wiki-link ([^>]*)>([\s\S]*?)<\/wiki-link>/g, (_, attrs: string, label: string) => {
      const title = unescapeHtml(/data-wikilink-title="([^"]*)"/.exec(attrs)?.[1] ?? "");
      const heading = unescapeHtml(/data-wikilink-heading="([^"]*)"/.exec(attrs)?.[1] ?? "");
      return linkHtml(context, title, unescapeHtml(label), heading);
    })
    .replace(/<file-attachment [^>]*data-name="([^"]*)"[^>]*>[\s\S]*?<\/file-attachment>/g, (_, name: string) => `<span class="export-file">${name}</span>`)
    .replace(/<a href="([^"]*)"/g, (whole, href: string) => (/^(https?:|mailto:)/i.test(unescapeHtml(href)) ? `${whole} rel="noopener noreferrer"` : "<a"));
}

async function baseSnapshot(context: Context, target: string, view: string | undefined, thisId: string): Promise<string> {
  const base = resolveWikilink(target, context.source.pages);
  const name = escapeHtml((target.split("/").pop() ?? target).replace(/\.base$/i, ""));
  const loaded = base ? await context.source.runBase(base.id, view, thisId).catch(() => null) : null;
  if (!loaded) {
    return `<div class="export-base"><div class="export-base-title">${name}</div><p class="export-note">${escapeHtml(context.source.t("export.baseMissing"))}</p></div>`;
  }
  const { result, label } = loaded;
  const head = result.columns.map((column) => `<th>${escapeHtml(label(column.id))}</th>`).join("");
  const rows = result.rows.slice(0, MAX_BASE_ROWS).map((row) => {
    const cells = result.columns.map((column) => {
      if (column.id === "file.name") return `<td>${row.icon ? `${escapeHtml(row.icon)} ` : ""}${linkHtml(context, row.id, row.title, "")}</td>`;
      const value = row.values[column.id] ?? null;
      if (typeof value === "boolean") return `<td class="is-check">${value ? "☑" : "☐"}</td>`;
      return `<td>${escapeHtml(context.source.formatValue(value, column.type))}</td>`;
    });
    return `<tr>${cells.join("")}</tr>`;
  });
  const more = result.rows.length > MAX_BASE_ROWS ? `<p class="export-note">${escapeHtml(context.source.t("export.moreRows", { count: result.rows.length - MAX_BASE_ROWS }))}</p>` : "";
  const viewName = escapeHtml(result.view);
  return [
    `<div class="export-base"><div class="export-base-title">${name}${viewName ? ` · ${viewName}` : ""}</div>`,
    `<div class="export-table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`,
    more,
    `<p class="export-base-count">${escapeHtml(context.source.t("export.rows", { count: result.total }))}</p></div>`,
  ].join("");
}

async function boardCards(context: Context, html: string, thisId: string): Promise<string> {
  return replaceAsync(html, /<div class="page-embed-board-card"( data-view="([^"]*)")?>[\s\S]*?<wiki-link data-wikilink-title="([^"]*)"[^>]*>[\s\S]*?<\/wiki-link><\/div>/g, async (match) => {
    const target = unescapeHtml(match[3] ?? "");
    if (/\.base$/i.test(target)) return baseSnapshot(context, target, match[2] ? unescapeHtml(match[2]) : undefined, thisId);
    const name = (target.split("/").pop() ?? target).replace(/\.canvas$/i, "");
    return `<div class="export-board">${escapeHtml(context.source.t("export.board"))}: ${escapeHtml(name)}</div>`;
  });
}

async function nestedPreviews(context: Context, html: string, depth: number, chain: readonly string[]): Promise<string> {
  return replaceAsync(html, /<div class="page-embed-nested" data-target="([^"]*)" data-part="([^"]*)"><\/div>/g, async (match) => {
    const target = unescapeHtml(match[1] ?? "");
    const part = unescapeHtml(match[2] ?? "");
    const meta = resolveWikilink(target, context.source.pages);
    const note = (key: ExportMessage) => `<div class="export-embed"><p class="export-note">${escapeHtml(context.source.t(key, { name: target }))}</p></div>`;
    if (!meta || (meta.kind ?? "page") !== "page") return note("export.missingPage");
    if (chain.includes(meta.id)) return note("export.loopPage");
    if (depth >= MAX_DEPTH) return note("export.tooDeep");
    const page = await context.source.loadPage(meta.id).catch(() => null);
    if (!page) return note("export.missingPage");
    const markdown = embeddedMarkdown(page.content, parseEmbedPart(part));
    if (markdown === null) return note("export.missingPage");
    const body = await renderBody(context, markdown, page.id, page.fileLinks, depth + 1, [...chain, page.id]);
    const title = part ? `${page.title} › ${part.replace(/^\^/, "")}` : page.title;
    return `<div class="export-embed"><div class="export-embed-title">${escapeHtml(title)}</div><div class="export-embed-body">${body}</div></div>`;
  });
}

/** A note's Markdown as static HTML (see the module comment). */
async function renderBody(
  context: Context,
  markdown: string,
  fromId: string,
  fileLinks: Record<string, string | null> | null | undefined,
  depth: number,
  chain: readonly string[],
): Promise<string> {
  let html = renderEmbeddedMarkdown(markdown);
  html = await nestedPreviews(context, html, depth, chain);
  html = await boardCards(context, html, fromId);
  html = await inlineImages(context, html, fromId, fileLinks);
  html = await highlightCode(context, html);
  html = staticCallouts(html);
  return staticLinks(context, html);
}

const COVER_COLORS: Record<string, string> = {
  gray: "rgba(var(--mono-rgb-100), 0.22)",
};
const coverColor = (name: string) => COVER_COLORS[name] ?? `rgba(var(--color-${name}-rgb), 0.55)`;

async function coverHtml(context: Context, page: Page): Promise<string> {
  const look = pageLook(page.properties);
  const cover = look.cover;
  if (!cover) return "";
  if (cover.kind === "color") return `<div class="export-cover" style="background: ${coverColor(cover.name)}"></div>`;
  if (cover.kind === "gradient") return `<div class="export-cover cover-gradient-${cover.name}"></div>`;
  if (cover.kind === "url") return "";
  const link = cover.link;
  const vaultPath = await context.source.resolveFile(link, page.id, page.fileLinks).catch(() => null);
  const uri = vaultPath ? await dataUri(context, vaultPath) : null;
  if (!uri) return "";
  return `<div class="export-cover"><img src="${escapeHtml(uri)}" alt="" style="object-position: 50% ${look.position}%"></div>`;
}

/** Shown properties: everything the page header lists (not the cover and background, which show as such). */
function propertiesHtml(context: Context, properties: readonly Property[] | undefined): string {
  const shown = (properties ?? []).filter((property) => !["cover", "banner", "background", "cover-position", "banner_y", "banner_icon"].includes(property.key));
  if (!shown.length) return "";
  const value = (property: Property) => {
    if (typeof property.value === "boolean") return property.value ? "☑" : "☐";
    if (Array.isArray(property.value)) return property.value.map((item) => escapeHtml(context.source.formatValue(String(item), "text"))).join(", ");
    if (property.value === null || property.value === undefined) return "";
    if (typeof property.value === "object") return escapeHtml(JSON.stringify(property.value));
    return escapeHtml(context.source.formatValue(property.value, property.type));
  };
  const rows = shown.map((property) => `<tr><th>${escapeHtml(property.key)}</th><td>${value(property)}</td></tr>`).join("");
  return `<table class="export-properties"><tbody>${rows}</tbody></table>`;
}

/** The whole page as one self-contained HTML document. */
export async function buildPageHtml(page: Page, source: ExportSource, options: ExportOptions): Promise<string> {
  const context: Context = { source, options, files: new Map() };
  const look = pageLook(page.properties);
  const [cover, body] = await Promise.all([coverHtml(context, page), renderBody(context, page.content, page.id, page.fileLinks, 1, [page.id])]);
  const tintRgb = look.background ? (look.background === "gray" ? "var(--mono-rgb-100)" : `var(--color-${look.background}-rgb)`) : null;
  const bodyAttrs = tintRgb ? ` class="export has-tint" style="--page-tint-rgb: ${tintRgb}"` : ' class="export"';
  const icon = page.icon ? `<span class="export-icon">${escapeHtml(page.icon)}</span>` : "";
  return [
    "<!doctype html>",
    `<html lang="${escapeHtml(source.language)}" data-theme="${options.theme}">`,
    "<head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="generator" content="Gumply">',
    `<title>${escapeHtml(page.title)}</title>`,
    `<style>${source.css.replace(/<\/style/gi, "<\\/style")}</style>`,
    "</head>",
    `<body${bodyAttrs}>`,
    cover,
    `<main class="export-page${cover ? " has-cover" : ""}">`,
    `<header>${icon}<h1 class="export-title">${escapeHtml(page.title)}</h1></header>`,
    propertiesHtml(context, page.properties),
    `<article class="export-body">${body}</article>`,
    `<footer class="export-footer">${escapeHtml(source.t("export.exportedFrom"))}</footer>`,
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
