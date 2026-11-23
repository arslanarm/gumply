/**
 * Text and background colour (#h368c8ni), as in Notion, stored the way
 * Obsidian reads it:
 *
 *   text:       <span style="color: var(--color-red);">text</span>
 *   background: <span style="background-color: rgba(var(--color-red-rgb), 0.2);">text</span>
 *
 * Obsidian's own palette variables, so the colours follow the theme in both
 * apps (Gumply defines the same variables). The default yellow background is
 * the plain `==highlight==` mark (editor/highlight.ts).
 *
 * Reading: a `<span style>` / `<mark style>` / `<font color>` tag holding only
 * a colour, paired with its closing tag in the same paragraph, becomes a
 * mark. The mark keeps the exact opening and closing tag it came from, so a
 * file from another tool (`#FF5582A6`, no `;`, Highlightr's `<mark>`) is
 * written back byte for byte; only picking another colour rewrites the tag.
 * Anything else (other style properties, unpaired tags) stays a raw inline
 * atom, as before.
 *
 * Nesting: what Gumply writes is the innermost mark (inside bold and `==`,
 * outside inline code), so a range across formatting is written as one span
 * per piece (`**<span …>bold</span>**`). Obsidian's reading view shows both
 * there; its live preview shows the colour but not the bold. Links are never
 * coloured (see applyColor). A span read from a file that wraps other markup
 * (`<span …>**bold** text</span>`) becomes the "wrap" variant of the mark,
 * which is outermost, so it is written back around that markup as it was.
 */
import { Mark, mergeAttributes, type Editor } from "@tiptap/core";
import type { Mark as PMMark } from "@tiptap/pm/model";

export type ColorKind = "text" | "background";

/** Obsidian's palette names, plus gray. Order is the palette's order. */
export const COLOR_NAMES = ["gray", "red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink"] as const;
export type ColorName = (typeof COLOR_NAMES)[number];

/** The CSS value Gumply writes for a palette colour. */
export function paletteValue(kind: ColorKind, name: ColorName): string {
  if (kind === "text") return name === "gray" ? "var(--text-muted)" : `var(--color-${name})`;
  return name === "gray" ? "rgba(var(--mono-rgb-100), 0.12)" : `rgba(var(--color-${name}-rgb), 0.2)`;
}

/** Which palette colour a value is, if any (spacing-insensitive). */
export function paletteName(kind: ColorKind, value: string | null | undefined): ColorName | null {
  if (!value) return null;
  const squash = (text: string) => text.replace(/\s+/g, "").toLowerCase();
  const wanted = squash(value);
  return COLOR_NAMES.find((name) => squash(paletteValue(kind, name)) === wanted) ?? null;
}

/**
 * A CSS colour that is safe to put in a style attribute: hex, a colour word,
 * rgb()/hsl() with plain numbers, `var(--x)`, or `rgba(var(--x), a)`. No
 * `url()`, `expression()`, quotes or `;`.
 */
const SAFE_COLOR =
  /^(#[0-9a-f]{3,8}|[a-z]{3,30}|(rgba?|hsla?)\([\d\s.,%/+-]*\)|var\(--[\w-]+\)|rgba?\(\s*var\(--[\w-]+\)\s*,\s*[\d.]+%?\s*\))$/i;

export function isSafeColor(value: string): boolean {
  return SAFE_COLOR.test(value.trim());
}

/** The opening tag Gumply writes. */
export function canonicalOpenTag(kind: ColorKind, value: string): string {
  return `<span style="${kind === "text" ? "color" : "background-color"}: ${value};">`;
}

export interface ColorTag {
  kind: ColorKind;
  value: string;
  /** Lower-case tag name (`span`, `mark`, `font`), for matching the closing tag. */
  tag: string;
}

const ATTR_VALUE = String.raw`(?:"([^"<>]*)"|'([^'<>]*)')`;
const STYLE_TAG = new RegExp(String.raw`^<(span|mark)\s+style\s*=\s*${ATTR_VALUE}\s*>$`, "i");
const FONT_TAG = new RegExp(String.raw`^<(font)\s+color\s*=\s*(?:${ATTR_VALUE}|([#\w]+))\s*>$`, "i");

/** A colour-only opening tag, or null. */
export function parseColorTag(source: string): ColorTag | null {
  const font = FONT_TAG.exec(source);
  if (font) {
    const value = (font[2] ?? font[3] ?? font[4] ?? "").trim();
    return value && isSafeColor(value) ? { kind: "text", value, tag: "font" } : null;
  }
  const match = STYLE_TAG.exec(source);
  if (!match) return null;
  const tag = match[1]!.toLowerCase();
  const declarations = (match[2] ?? match[3] ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  if (declarations.length !== 1) return null;
  const colon = declarations[0]!.indexOf(":");
  if (colon < 0) return null;
  const property = declarations[0]!.slice(0, colon).trim().toLowerCase();
  const value = declarations[0]!.slice(colon + 1).trim();
  if (!isSafeColor(value)) return null;
  if (property === "color") return { kind: "text", value, tag };
  if (property === "background" || property === "background-color") return { kind: "background", value, tag };
  return null;
}

/* markdown-it is untyped here (see the wikilink plugin). */
/* eslint-disable @typescript-eslint/no-explicit-any */

export const COLOR_OPEN = "gumply_color_open";
export const COLOR_CLOSE = "gumply_color_close";

function closingTagName(source: string): string | null {
  const match = /^<\/(\w+)\s*>$/.exec(source);
  return match ? match[1]!.toLowerCase() : null;
}

function openingTagName(source: string): string | null {
  const match = /^<(\w+)[\s>]/.exec(source);
  return match && !/\/>$/.test(source) ? match[1]!.toLowerCase() : null;
}

/** Pair colour tags in one inline token list (in place). */
function pairColorTags(tokens: any[]): void {
  const stack: Array<{ index: number; name: string; color: ColorTag | null }> = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== "html_inline") continue;
    const source = String(token.content);
    const closing = closingTagName(source);
    if (closing) {
      // Find the nearest open tag of that name; tags left open above it are unpaired.
      let at = stack.length - 1;
      while (at >= 0 && stack[at]!.name !== closing) at -= 1;
      if (at < 0) continue;
      const open = stack[at]!;
      stack.length = at;
      if (!open.color || !balanced(tokens, open.index, index)) continue;
      const wrap = tokens.slice(open.index + 1, index).some(isMarkup);
      const opener = tokens[open.index];
      opener.type = COLOR_OPEN;
      opener.nesting = 1;
      opener.meta = { ...open.color, source: String(opener.content), close: source, wrap };
      token.type = COLOR_CLOSE;
      token.nesting = -1;
      continue;
    }
    const name = openingTagName(source);
    if (name && !/^(br|img|hr|input|wbr)$/.test(name)) stack.push({ index, name, color: parseColorTag(source) });
  }
}

/** Open and close tokens between two indexes match up (no `**` crossing the span). */
function balanced(tokens: any[], from: number, to: number): boolean {
  let depth = 0;
  for (let index = from + 1; index < to; index += 1) {
    depth += tokens[index].nesting ?? 0;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/** Other Markdown formatting (or another colour) inside a span. */
function isMarkup(token: any): boolean {
  return token.nesting !== 0 || token.type === "code_inline";
}

function colorRule(state: any): void {
  for (const block of state.tokens as any[]) {
    if (block.type === "inline" && block.children) pairColorTags(block.children);
  }
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const COLOR_ATTR = {
  kind: "data-gumply-color",
  value: "data-color-value",
  source: "data-color-source",
  close: "data-color-close",
  wrap: "data-color-wrap",
} as const;

/** markdown-it: colour tag pairs → `<span data-gumply-color …>` for the editor to parse. */
export function colorMarkdownPlugin(md: any): void {
  if (md.__gumplyColor) return;
  md.__gumplyColor = true;
  md.core.ruler.after("inline", "gumply_color", colorRule);
  md.renderer.rules[COLOR_OPEN] = (tokens: any[], index: number) => {
    const meta = tokens[index].meta as ColorTag & { source: string; close: string; wrap: boolean };
    return (
      `<span ${COLOR_ATTR.kind}="${meta.kind}" ${COLOR_ATTR.value}="${escapeAttr(meta.value)}"` +
      ` ${COLOR_ATTR.source}="${escapeAttr(meta.source)}" ${COLOR_ATTR.close}="${escapeAttr(meta.close)}"` +
      `${meta.wrap ? ` ${COLOR_ATTR.wrap}="1"` : ""}>`
    );
  };
  md.renderer.rules[COLOR_CLOSE] = () => "</span>";
}

/** The four mark types: what Gumply writes (inner) and spans read around markup (wrap). */
export const COLOR_MARKS = {
  text: "textColor",
  background: "backgroundColor",
  textWrap: "textColorWrap",
  backgroundWrap: "backgroundColorWrap",
} as const;

const ALL_COLOR_MARKS: readonly string[] = Object.values(COLOR_MARKS);

export function markNamesFor(kind: ColorKind): string[] {
  return kind === "text" ? [COLOR_MARKS.text, COLOR_MARKS.textWrap] : [COLOR_MARKS.background, COLOR_MARKS.backgroundWrap];
}

/** How a colour mark is written: the tags it was read from, else Gumply's own. */
export const colorSerializer = {
  open(_state: unknown, mark: PMMark): string {
    const kind: ColorKind = mark.type.name.startsWith("text") ? "text" : "background";
    return mark.attrs.source ? String(mark.attrs.source) : canonicalOpenTag(kind, String(mark.attrs.color));
  },
  close(_state: unknown, mark: PMMark): string {
    return mark.attrs.source && mark.attrs.close ? String(mark.attrs.close) : "</span>";
  },
};

function colorMark(name: string, kind: ColorKind, wrap: boolean, priority: number) {
  return Mark.create({
    name,
    priority,
    // #hz23dqif: Enter (and Shift+Enter) starts the new line plain, as Notion does.
    keepOnSplit: false,

    addAttributes() {
      return {
        color: { default: null },
        source: { default: null },
        close: { default: null },
      };
    },

    parseHTML() {
      return [
        {
          tag: `span[${COLOR_ATTR.kind}="${kind}"]`,
          getAttrs: (element: HTMLElement) => {
            if (element.hasAttribute(COLOR_ATTR.wrap) !== wrap) return false;
            const color = element.getAttribute(COLOR_ATTR.value) ?? "";
            if (!isSafeColor(color)) return false;
            return {
              color,
              source: element.getAttribute(COLOR_ATTR.source),
              close: element.getAttribute(COLOR_ATTR.close),
            };
          },
        },
      ];
    },

    renderHTML({ mark }) {
      const color = String(mark.attrs.color ?? "");
      const safe = isSafeColor(color) ? color : "";
      const style = safe ? (kind === "text" ? `color: ${safe}` : `background-color: ${safe}`) : undefined;
      return [
        "span",
        mergeAttributes({
          class: kind === "text" ? "md-text-color" : "md-bg-color",
          [COLOR_ATTR.kind]: kind,
          // The same attributes parseHTML reads, so copy and paste inside Gumply keeps the colour.
          [COLOR_ATTR.value]: safe || undefined,
          [COLOR_ATTR.source]: mark.attrs.source ?? undefined,
          [COLOR_ATTR.close]: mark.attrs.close ?? undefined,
          [COLOR_ATTR.wrap]: wrap ? "1" : undefined,
          // Gumply's palette name, for theme-aware CSS; foreign colours render as written.
          "data-palette": paletteName(kind, safe) ?? undefined,
          style,
        }),
        0,
      ];
    },

    addStorage() {
      return {
        markdown: {
          serialize: { ...colorSerializer, mixable: false, expelEnclosingWhitespace: false },
          parse: {
            setup(md: any) {
              colorMarkdownPlugin(md);
            },
          },
        },
      };
    },
  });
}

/*
 * Priorities: a higher one is opened first (outermost). Bold, italic, links
 * and highlight are 100 (TipTap's default), inline code is 90.
 */
export const TextColor = colorMark(COLOR_MARKS.text, "text", false, 95);
export const BackgroundColor = colorMark(COLOR_MARKS.background, "background", false, 96);
export const TextColorWrap = colorMark(COLOR_MARKS.textWrap, "text", true, 1000);
export const BackgroundColorWrap = colorMark(COLOR_MARKS.backgroundWrap, "background", true, 1001);

export const ColorMarks = [TextColor, BackgroundColor, TextColorWrap, BackgroundColorWrap];

/** The colour on the selection (its start), as a value, or null. */
export function currentColor(editor: Editor, kind: ColorKind): string | null {
  if (kind === "background" && editor.isActive("highlight")) return paletteValue("background", "yellow");
  for (const name of markNamesFor(kind)) {
    const attrs = editor.getAttributes(name);
    if (attrs.color) return String(attrs.color);
  }
  return null;
}

/**
 * Colour the selection (null = Default: remove the colour). The yellow
 * background is Obsidian's own highlight, `==text==` (#h368c8ni), so it is
 * the highlight mark; Default background removes that too.
 */
export function applyColor(editor: Editor, kind: ColorKind, name: ColorName | null): void {
  const { state } = editor;
  const { from, to } = state.selection;
  if (from === to) return;
  let tr = state.tr;
  const remove = [...markNamesFor(kind), ...(kind === "background" ? ["highlight"] : [])];
  for (const markName of remove) {
    const type = state.schema.marks[markName];
    if (type) tr = tr.removeMark(from, to, type);
  }
  if (kind === "background" && name === "yellow" && state.schema.marks.highlight) {
    tr = tr.addMark(from, to, state.schema.marks.highlight.create());
  } else if (name) {
    const type = state.schema.marks[kind === "text" ? COLOR_MARKS.text : COLOR_MARKS.background];
    if (type) {
      // Links are never coloured (#h368c8ni, measured in Obsidian): the span
      // ends before a link and starts again after it. `[[A|<span>…</span>]]`
      // shows raw HTML in Obsidian, and a span around a link isn't
      // clickable in its live preview. Atoms (wiki links, images, math) too.
      const mark = type.create({ color: paletteValue(kind, name) });
      const link = state.schema.marks.link;
      state.doc.nodesBetween(from, to, (node, pos) => {
        if (!node.isInline) return true;
        if (node.isText && !(link && link.isInSet(node.marks))) {
          tr = tr.addMark(Math.max(from, pos), Math.min(to, pos + node.nodeSize), mark);
        }
        return false;
      });
    }
  }
  editor.view.dispatch(tr.scrollIntoView());
  editor.commands.focus();
}

export function isColorMark(name: string): boolean {
  return ALL_COLOR_MARKS.includes(name);
}
