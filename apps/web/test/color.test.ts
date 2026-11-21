import MarkdownIt from "markdown-it";
import { Schema, type Mark as PMMark, type Node as PMNode } from "@tiptap/pm/model";
import { defaultMarkdownSerializer, MarkdownParser, MarkdownSerializer } from "prosemirror-markdown";
import { describe, expect, it } from "vitest";
import {
  canonicalOpenTag,
  COLOR_NAMES,
  colorMarkdownPlugin,
  colorSerializer,
  isSafeColor,
  paletteName,
  paletteValue,
  parseColorTag,
} from "../src/editor/color.js";
import { highlightMarkdownPlugin } from "../src/editor/highlight.js";

/*
 * Round trips through a ProseMirror schema shaped like the editor's: marks
 * in the editor's priority order (outermost first) and the colour marks'
 * real serializer, so what a file holds is what an edit elsewhere writes.
 */
const md = new MarkdownIt({ html: true });
highlightMarkdownPlugin(md);
colorMarkdownPlugin(md);
colorMarkdownPlugin(md); // idempotent: tiptap-markdown calls setup on every parse

// The editor tells the four colour marks apart by attributes on the HTML;
// prosemirror-markdown maps by token name, so rename them here.
type ColorMeta = { kind: string; wrap: boolean; value: string; source: string; close: string };
md.core.ruler.push("test_color_names", (state) => {
  const open: ColorMeta[] = [];
  for (const block of state.tokens) {
    for (const token of block.children ?? []) {
      const meta = token.meta as ColorMeta;
      if (token.type === "gumply_color_open") {
        open.push(meta);
        token.type = `${meta.kind}${meta.wrap ? "Wrap" : ""}_open`;
      } else if (token.type === "html_inline") {
        // Unpaired tags are raw inline atoms in the editor; plain text here.
        token.type = "text";
      } else if (token.type === "gumply_color_close") {
        const meta = open.pop()!;
        token.type = `${meta.kind}${meta.wrap ? "Wrap" : ""}_close`;
      }
    }
  }
});

const colorSpec = { toDOM: () => ["span", 0] as const, attrs: { color: { default: null }, source: { default: null }, close: { default: null } } };
const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*", toDOM: () => ["p", 0] },
    text: {},
  },
  // Outermost first, as TipTap orders them by priority.
  marks: {
    backgroundColorWrap: colorSpec,
    textColorWrap: colorSpec,
    link: { attrs: { href: {}, title: { default: null } }, inclusive: false, toDOM: () => ["a", 0] },
    strong: { toDOM: () => ["strong", 0] },
    em: { toDOM: () => ["em", 0] },
    highlight: { toDOM: () => ["mark", 0] },
    backgroundColor: colorSpec,
    textColor: colorSpec,
    code: { toDOM: () => ["code", 0] },
  },
});

const colorAttrs = (token: { meta: unknown }) => {
  const meta = token.meta as ColorMeta;
  return { color: meta.value, source: meta.source, close: meta.close };
};
const parser = new MarkdownParser(schema, md, {
  paragraph: { block: "paragraph" },
  strong: { mark: "strong" },
  em: { mark: "em" },
  mark: { mark: "highlight" },
  link: { mark: "link", getAttrs: (token) => ({ href: token.attrGet("href"), title: token.attrGet("title") }) },
  code_inline: { mark: "code", noCloseToken: true },
  text: { mark: "textColor", getAttrs: colorAttrs },
  background: { mark: "backgroundColor", getAttrs: colorAttrs },
  textWrap: { mark: "textColorWrap", getAttrs: colorAttrs },
  backgroundWrap: { mark: "backgroundColorWrap", getAttrs: colorAttrs },
});
const color = { ...colorSerializer, mixable: false, expelEnclosingWhitespace: false };
const serializer = new MarkdownSerializer(
  { paragraph: defaultMarkdownSerializer.nodes.paragraph!, text: defaultMarkdownSerializer.nodes.text! },
  {
    backgroundColorWrap: color,
    textColorWrap: color,
    link: defaultMarkdownSerializer.marks.link!,
    strong: defaultMarkdownSerializer.marks.strong!,
    em: defaultMarkdownSerializer.marks.em!,
    highlight: { open: "==", close: "==", mixable: true, expelEnclosingWhitespace: true },
    backgroundColor: color,
    textColor: color,
    code: defaultMarkdownSerializer.marks.code!,
  },
);
const parse = (source: string) => parser.parse(source) as PMNode;
const roundTrip = (source: string) => serializer.serialize(parse(source));

/** The paragraph's text runs as [text, mark names]. */
function runs(source: string): Array<[string, string[]]> {
  const out: Array<[string, string[]]> = [];
  parse(source).descendants((node) => {
    if (node.isText) out.push([node.text!, node.marks.map((mark: PMMark) => mark.type.name)]);
    return true;
  });
  return out;
}

describe("colour tags (#h368c8ni)", () => {
  it("reads colour-only tags", () => {
    expect(parseColorTag('<span style="color: var(--color-red);">')).toEqual({ kind: "text", value: "var(--color-red)", tag: "span" });
    expect(parseColorTag('<span style="background-color: rgba(var(--color-blue-rgb), 0.2)">')).toEqual({
      kind: "background",
      value: "rgba(var(--color-blue-rgb), 0.2)",
      tag: "span",
    });
    expect(parseColorTag('<mark style="background: #FF5582A6;">')).toEqual({ kind: "background", value: "#FF5582A6", tag: "mark" });
    expect(parseColorTag("<span style='color:#e03e3e'>")).toEqual({ kind: "text", value: "#e03e3e", tag: "span" });
    expect(parseColorTag('<font color="red">')).toEqual({ kind: "text", value: "red", tag: "font" });
    expect(parseColorTag("<font color=#f00>")).toEqual({ kind: "text", value: "#f00", tag: "font" });
  });

  it("leaves other tags and unsafe values alone", () => {
    expect(parseColorTag('<span class="red">')).toBeNull();
    expect(parseColorTag('<span style="color: red; font-weight: bold">')).toBeNull();
    expect(parseColorTag('<span style="background: url(x.png)">')).toBeNull();
    expect(parseColorTag('<span style="color: expression(alert(1))">')).toBeNull();
    expect(parseColorTag('<span style="color: red" onclick="x()">')).toBeNull();
    expect(isSafeColor("red;x:y")).toBe(false);
    expect(isSafeColor("rgb(1 2 3 / 50%)")).toBe(true);
  });

  it("knows its palette", () => {
    for (const name of COLOR_NAMES) {
      expect(paletteName("text", paletteValue("text", name))).toBe(name);
      expect(paletteName("background", paletteValue("background", name))).toBe(name);
      expect(isSafeColor(paletteValue("text", name))).toBe(true);
      expect(isSafeColor(paletteValue("background", name))).toBe(true);
    }
    expect(paletteName("text", "var(--color-RED)")).toBe("red");
    expect(paletteName("text", "#e03e3e")).toBeNull();
    expect(canonicalOpenTag("text", "var(--color-red)")).toBe('<span style="color: var(--color-red);">');
  });
});

describe("colour round trips (#h368c8ni)", () => {
  const sources = [
    // Gumply's palette.
    ...COLOR_NAMES.map((name) => `A ${canonicalOpenTag("text", paletteValue("text", name))}${name}</span> word.`),
    ...COLOR_NAMES.map((name) => `A ${canonicalOpenTag("background", paletteValue("background", name))}${name}</span> word.`),
    // Foreign colours, written as they were.
    'Highlightr <mark style="background: #FF5582A6;">pink</mark> and <mark style="background: #BBFABBA6;">green</mark>.',
    "Bare <span style='color:#e03e3e'>red</span> and <SPAN style=\"color: #0a0\">caps</SPAN>.",
    'Old <font color="red">font</font> tag.',
    // == plus a colour, either way round.
    '==hi <span style="color: var(--color-red);">red</span> there==',
    '<span style="color: var(--color-red);">==red highlight==</span>',
    // Colour inside and around formatting.
    '**<span style="color: var(--color-blue);">bold blue</span>** then <span style="color: var(--color-blue);">blue</span>',
    '<span style="color:#e03e3e">**bold** and *italic*</span> after',
    '<span style="color: var(--color-red);">a </span>**<span style="color: var(--color-red);">b</span>**<span style="color: var(--color-red);"> c</span>',
    // Across a link.
    '[<span style="color: var(--color-green);">link text</span>](https://example.com) and <span style="color: var(--color-green);">[link](https://example.com) inside</span>',
    // Both colours.
    '<span style="background-color: rgba(var(--color-yellow-rgb), 0.2);"><span style="color: var(--color-red);">both</span></span>',
    '<span style="color: var(--color-red);"><span style="background-color: rgba(var(--color-yellow-rgb), 0.2);">both, reversed</span></span>',
    // Code inside.
    '<span style="color: var(--color-red);">`code`</span> and `plain`',
    // Not colours: stay as they are.
    '<span class="x">classed</span> and <span style="color: red; font-weight: bold">styled</span>',
    'Unpaired <span style="color: red">open',
    "Stray </span> close",
    '<span style="color: red">**crossing</span>**',
  ];

  it("writes every file back byte for byte", () => {
    for (const source of sources) expect(roundTrip(source), source).toBe(source);
  });

  it("reads palette and foreign colours as marks", () => {
    expect(runs('a <span style="color: var(--color-red);">red</span>')).toEqual([
      ["a ", []],
      ["red", ["textColor"]],
    ]);
    expect(runs('<mark style="background: #FF5582A6;">pink</mark>')).toEqual([["pink", ["backgroundColor"]]]);
    expect(runs('<span style="color:#e03e3e">**bold** x</span>')).toEqual([
      ["bold", ["textColorWrap", "strong"]],
      [" x", ["textColorWrap"]],
    ]);
    expect(runs('<span style="color: red">**crossing</span>**')[0]![1]).toEqual([]);
  });

  it("writes a newly coloured range as one span per formatted piece", () => {
    const doc = parse("plain **bold** ==hi== `code` end");
    const red = schema.marks.textColor!.create({ color: paletteValue("text", "red") });
    const { content } = doc;
    const coloured = schema.node("doc", null, [
      schema.node(
        "paragraph",
        null,
        (() => {
          const nodes: PMNode[] = [];
          content.firstChild!.forEach((child) => nodes.push(child.mark(red.addToSet(child.marks))));
          return nodes;
        })(),
      ),
    ]);
    const tag = canonicalOpenTag("text", paletteValue("text", "red"));
    expect(serializer.serialize(coloured)).toBe(
      `${tag}plain </span>**${tag}bold</span>**${tag} </span>==${tag}hi</span>==${tag} \`code\` end</span>`,
    );
  });

  it("changing the colour drops the foreign tag", () => {
    const doc = parse('<mark style="background: #FF5582A6;">pink</mark>');
    const blue = schema.marks.backgroundColor!.create({ color: paletteValue("background", "blue") });
    const text = doc.firstChild!.firstChild!;
    const recoloured = schema.node("doc", null, [schema.node("paragraph", null, [schema.text(text.text!, [blue])])]);
    expect(serializer.serialize(recoloured)).toBe('<span style="background-color: rgba(var(--color-blue-rgb), 0.2);">pink</span>');
  });
});
