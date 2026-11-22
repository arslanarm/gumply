/**
 * Read-only rendering of a page preview (#5dpxwac4). One markdown-it pass
 * turns the embedded Markdown into HTML styled like the editor
 * (`.gumply-editor` typography): headings, lists, read-only task checkboxes,
 * tables, callouts (folded toggles start closed), code, images, `==marks==`,
 * `#tag` chips and `[[links]]`.
 *
 * Safety: `html: false`, so raw HTML in a page is shown as text, never run;
 * everything the renderer adds itself is escaped. The view then fixes image
 * sources (vault files only) and drops unsafe link targets.
 *
 * A page preview inside the preview becomes a placeholder the view fills in
 * (up to a depth); a board embed becomes a link card (never a live board).
 */
import { hasAttachmentExtension, isBoardTarget, WIKILINK_INNER, WIKILINK_PART, WIKILINK_TARGET } from "@gumply/core";
import MarkdownIt from "markdown-it";
import { calloutStyle, defaultCalloutTitle } from "../callout/types.js";
import { parseColorTag } from "../color.js";
import { columnsMarkdownPlugin } from "../columns/markdown.js";
import { wikilinkMarkdownPlugin } from "../wikilink/markdown-plugin.js";
import { parsePageEmbed } from "./markdown-plugin.js";
import { mathMarkdownPlugin } from "../../lib/math-markdown.js";
import { diagramMarkdownPlugin } from "../../lib/diagram-markdown.js";

// markdown-it's types are an optional peer dependency (see the editor plugins).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const CALLOUT_START = /^ {0,3}>\s?\[!([^\]\s]+)\]([+-]?)[ \t]*(.*)$/;

/** `> [!type]± Title` and its `>` lines, rendered as the editor's callout. */
function calloutRule(md: Any) {
  return (state: Any, startLine: number, endLine: number, silent: boolean): boolean => {
    if (state.sCount[startLine] - state.blkIndent >= 4) return false;
    const first = state.src.slice(state.bMarks[startLine] + state.tShift[startLine] - state.tShift[startLine], state.eMarks[startLine]);
    const match = CALLOUT_START.exec(first.trimStart());
    if (!match) return false;
    if (silent) return true;
    const body: string[] = [];
    let line = startLine + 1;
    for (; line < endLine; line += 1) {
      const text = state.src.slice(state.bMarks[line], state.eMarks[line]);
      const quoted = /^ {0,3}>\s?(.*)$/.exec(text);
      if (!quoted) break;
      body.push(quoted[1] ?? "");
    }
    const type = match[1] ?? "note";
    const fold = match[2] ?? "";
    const title = (match[3] ?? "").trim();
    const token = state.push("html_block", "", 0);
    token.map = [startLine, line];
    token.content = [
      `<div class="callout${fold ? " is-foldable" : ""}${fold === "-" ? " is-closed" : ""}" data-callout="${escapeHtml(type)}" data-callout-style="${calloutStyle(type)}" data-fold="${fold}">`,
      `<span class="callout-icon" data-callout-icon="${escapeHtml(type)}" aria-hidden="true"></span>`,
      `<div class="callout-content"><div class="callout-title">${title ? md.renderInline(title) : escapeHtml(defaultCalloutTitle(type))}</div>`,
      `<div class="callout-body">${md.render(body.join("\n"))}</div></div>`,
      fold ? `<button type="button" class="callout-fold" data-callout-fold aria-expanded="${fold === "-" ? "false" : "true"}"></button>` : "",
      "</div>\n",
    ].join("");
    state.line = line;
    return true;
  };
}

/** A page preview or board embed on its own line inside the preview. */
function nestedEmbedRule(state: Any, startLine: number, _endLine: number, silent: boolean): boolean {
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  const text = state.src.slice(state.bMarks[startLine] + state.tShift[startLine], state.eMarks[startLine]).trim();
  if (!text.startsWith("![[")) return false;
  const page = parsePageEmbed(text);
  // A board or a database view (D34) inside a preview: a card linking to it.
  const board = new RegExp(String.raw`^!\[\[(${WIKILINK_TARGET}+?\.(?:canvas|base))(?:#(${WIKILINK_PART}*))?(?:\|${WIKILINK_INNER}*)?\]\]$`, "i").exec(text);
  if (!page && !board) return false;
  if (silent) return true;
  const token = state.push("html_block", "", 0);
  token.map = [startLine, startLine + 1];
  if (page) {
    token.content = `<div class="page-embed-nested" data-target="${escapeHtml(page.target)}" data-part="${escapeHtml(page.part)}"></div>\n`;
  } else {
    const target = (board![1] ?? "").trim();
    const name = (target.split("/").pop() ?? target).replace(/\.(?:canvas|base)$/i, "");
    // A database view's name (`![[Tasks.base#Board]]`), for the HTML export's snapshot.
    const view = board![2]?.trim() ? ` data-view="${escapeHtml(board![2].trim())}"` : "";
    token.content = `<div class="page-embed-board-card"${view}><span class="page-embed-board-icon" aria-hidden="true"></span><wiki-link data-wikilink-title="${escapeHtml(target)}" data-wikilink-alias="${escapeHtml(name)}">${escapeHtml(name)}</wiki-link></div>\n`;
  }
  state.line = startLine + 1;
  return true;
}

/** `- [ ]` / `- [x]` items: the editor's task list markup, checkboxes read-only. */
function taskListRule(state: Any): void {
  const tokens = state.tokens;
  for (let index = 0; index < tokens.length; index += 1) {
    const item = tokens[index];
    if (item.type !== "list_item_open") continue;
    const inline = tokens[index + 2];
    if (tokens[index + 1]?.type !== "paragraph_open" || inline?.type !== "inline") continue;
    // `- [ ] ` with nothing after it is an (empty) task too, as in Obsidian.
    const match = /^\[([ xX])\](?:\s+|$)/.exec(inline.content);
    if (!match) continue;
    const checked = match[1] !== " ";
    item.attrSet("data-checked", String(checked));
    item.attrSet("data-type", "taskItem");
    // The list that holds it is a task list.
    for (let back = index - 1; back >= 0; back -= 1) {
      const open = tokens[back];
      if ((open.type === "bullet_list_open" || open.type === "ordered_list_open") && open.level === item.level - 1) {
        open.attrSet("data-type", "taskList");
        break;
      }
    }
    const first = inline.children?.[0];
    if (first?.type === "text") first.content = first.content.replace(/^\[[ xX]\](?:\s+|$)/, "");
    const markup = `<label contenteditable="false"><input type="checkbox" disabled${checked ? " checked" : ""}><span></span></label><div>`;
    if (tokens[index + 1].hidden) {
      // Tight list: no <p>, so the box goes in front of the text.
      const box = new state.Token("html_inline", "", 0);
      box.content = markup;
      inline.children = [box, ...(inline.children ?? [])];
    } else {
      // Loose list: the item's paragraphs render as <p>, and a <div> opened
      // inside a <p> would split it (checkbox and text on separate lines).
      // Open the content div before the first paragraph instead.
      const box = new state.Token("html_block", "", 0);
      box.content = markup;
      tokens.splice(index + 1, 0, box);
    }
    // The content div holds the whole item, nested lists too (as in the editor).
    for (let close = index + 1; close < tokens.length; close += 1) {
      const token = tokens[close];
      if (token.type === "list_item_close" && token.level === item.level) {
        const end = new state.Token("html_block", "", 0);
        end.content = "</div>";
        tokens.splice(close, 0, end);
        break;
      }
    }
  }
}

/** `==marks==` and `#tag` chips in escaped text. */
function decorate(text: string): string {
  return escapeHtml(text)
    .replace(/==([^=\n]+)==/g, "<mark>$1</mark>")
    .replace(/(^|[\s([{"'])#([\p{L}\p{N}][\p{L}\p{N}_/-]*)/gu, (match: string, before: string, tag: string) =>
      // Obsidian's rule (#9bx3aznb): `#2024` alone isn't a tag.
      /\D/.test(tag) ? `${before}<span class="tag-chip" data-tag="${tag}">#${tag}</span>` : match,
    );
}

/** A colour tag around plain text, closed in the same run (#h368c8ni): `<span style="color: …">x</span>`. */
const COLOR_RUN = /(<(span|mark|font)\b[^<>]*>)([^<>]*)<\/\2\s*>/gi;

/**
 * Text with its colour tags (only a colour, the editor's own rule) as
 * coloured spans; the value is re-checked, never copied as markup. Any other
 * HTML stays text, as before (`html: false`).
 */
function decorateWithColors(text: string): string {
  let out = "";
  let last = 0;
  for (const match of text.matchAll(COLOR_RUN)) {
    const color = parseColorTag(match[1]!);
    if (!color) continue;
    out += decorate(text.slice(last, match.index));
    const style = color.kind === "text" ? `color: ${color.value}` : `background-color: ${color.value}`;
    out += `<span class="${color.kind === "text" ? "md-color" : "md-bg-color"}" style="${escapeHtml(style)}">${decorate(match[3] ?? "")}</span>`;
    last = match.index! + match[0].length;
  }
  return out + decorate(text.slice(last));
}

/** `#tags` as chips, `==text==` as marks and colour tags as colours, in text only (never in code). */
function textDecorations(state: Any): void {
  for (const block of state.tokens) {
    if (block.type !== "inline" || !block.children) continue;
    const out: Any[] = [];
    for (const child of block.children) {
      if (child.type !== "text") {
        out.push(child);
        continue;
      }
      const html = decorateWithColors(child.content);
      if (html === escapeHtml(child.content)) {
        out.push(child);
        continue;
      }
      const token = new state.Token("html_inline", "", 0);
      token.content = html;
      out.push(token);
    }
    block.children = out;
  }
}

/** Obsidian block ids (` ^abc123` at a line's end, or alone on a line) aren't shown. */
export function stripBlockIds(markdown: string): string {
  let fence: string | null = null;
  return markdown
    .split("\n")
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
        return line;
      }
      if (marker) {
        fence = marker;
        return line;
      }
      if (/^\s*\^[A-Za-z0-9-]+\s*$/.test(line)) return "";
      return line.replace(/\s+\^[A-Za-z0-9-]+\s*$/, "");
    })
    .join("\n");
}

function createRenderer(): Any {
  const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
  wikilinkMarkdownPlugin(md as Any);
  md.block.ruler.before("blockquote", "callout", calloutRule(md), { alt: ["paragraph", "reference", "blockquote", "list"] });
  md.block.ruler.before("paragraph", "nested_embed", nestedEmbedRule);
  md.core.ruler.push("task_list", taskListRule);
  md.core.ruler.push("text_decorations", textDecorations);
  // F1: math placeholders, typeset by the view (hydrateMath) with the editor's own detection rules.
  mathMarkdownPlugin(md as Any);
  // F2: ```mermaid fences become diagram placeholders (drawn by hydrateDiagrams).
  diagramMarkdownPlugin(md as Any);
  // spec/columns: a preview shows columns as the editor does (same classes; widths as flex shares).
  columnsMarkdownPlugin(md as Any);
  md.renderer.rules.gumply_columns_open = () => '<div class="md-columns">\n';
  md.renderer.rules.gumply_column_open = (tokens: Any[], index: number) => {
    // The column's share of the row (bare columns split what the set widths leave).
    const width = Number(tokens[index].meta?.width);
    const share = Math.round(Number(tokens[index].meta?.share) * 100) / 100;
    return `<div class="md-column"${width > 0 || share > 0 ? ` style="flex: ${share > 0 ? share : width} 1 0"` : ""}>\n`;
  };
  // Code keeps its language for the highlighter; content is escaped by markdown-it.
  return md;
}

let renderer: Any = null;

/** HTML for an embedded part of a page (see the module comment). */
export function renderEmbeddedMarkdown(markdown: string): string {
  renderer ??= createRenderer();
  return renderer.render(stripBlockIds(markdown));
}

/** Attachment-looking names the wikilink plugin renders as images or files. */
export function isAttachmentName(name: string): boolean {
  return hasAttachmentExtension(name) && !isBoardTarget(name);
}
