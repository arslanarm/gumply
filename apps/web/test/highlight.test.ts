import MarkdownIt from "markdown-it";
import { Schema, type Node as PMNode } from "@tiptap/pm/model";
import { defaultMarkdownSerializer, MarkdownParser, MarkdownSerializer } from "prosemirror-markdown";
import { describe, expect, it } from "vitest";
import { highlightMarkdownPlugin } from "../src/editor/highlight.js";
import { escapeMarkdownText } from "../src/editor/raw-markdown/text.js";

const md = new MarkdownIt({ html: false });
highlightMarkdownPlugin(md);
const render = (source: string) => md.renderInline(source);

describe("==highlight== in Markdown (#bg3cb83t)", () => {
  it("reads ==text== as a highlight, like Obsidian", () => {
    expect(render("Some ==marked== text")).toBe("Some <mark>marked</mark> text");
    expect(render("==**bold** inside==")).toBe("<mark><strong>bold</strong> inside</mark>");
    expect(render("**==inside bold==**")).toBe("<strong><mark>inside bold</mark></strong>");
    expect(render("==a== and ==b==")).toBe("<mark>a</mark> and <mark>b</mark>");
  });

  it("leaves text that isn't a highlight alone", () => {
    expect(render("a == b and c==d")).toBe("a == b and c==d");
    expect(render("== spaced ==")).toBe("== spaced ==");
    expect(render("`==code==`")).toBe("<code>==code==</code>");
    expect(render("x = y")).toBe("x = y");
    expect(render("===a===")).toBe("=<mark>a</mark>=");
  });

  // Round trip through a ProseMirror schema with the same serializer spec as
  // the editor's mark, so untouched highlights are written back byte-for-byte.
  const schema = new Schema({
    nodes: {
      doc: { content: "paragraph+" },
      paragraph: { content: "text*", toDOM: () => ["p", 0] },
      text: {},
    },
    marks: {
      strong: { toDOM: () => ["strong", 0] },
      em: { toDOM: () => ["em", 0] },
      highlight: { toDOM: () => ["mark", 0] },
    },
  });
  const parser = new MarkdownParser(schema, md, {
    paragraph: { block: "paragraph" },
    strong: { mark: "strong" },
    em: { mark: "em" },
    mark: { mark: "highlight" },
  });
  const serializer = new MarkdownSerializer(
    { paragraph: defaultMarkdownSerializer.nodes.paragraph!, text: defaultMarkdownSerializer.nodes.text! },
    {
      strong: defaultMarkdownSerializer.marks.strong!,
      em: defaultMarkdownSerializer.marks.em!,
      highlight: { open: "==", close: "==", mixable: true, expelEnclosingWhitespace: true },
    },
  );
  const roundTrip = (source: string) => serializer.serialize(parser.parse(source) as PMNode);

  it("round-trips byte for byte", () => {
    for (const source of [
      "Some ==marked== text.",
      "==start== and end ==here==",
      "A **==bold highlight==** and ==half *italic*==.",
      "Two paragraphs ==one==\n\nand ==two==",
    ]) {
      expect(roundTrip(source)).toBe(source);
    }
  });

  it("known limit: two marks over exactly the same text are written in schema order", () => {
    // ProseMirror keeps no order for marks covering the same range; the
    // meaning is the same in both orders (and in Obsidian).
    expect(roundTrip("==*both*==")).toBe("*==both==*");
  });

  it("writes a new highlight as ==text==, spaces outside the markers", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("Plan "), schema.text(" key part ", [schema.marks.highlight!.create()]), schema.text("done")]),
    ]);
    expect(serializer.serialize(doc)).toBe("Plan  ==key part== done");
  });
});

describe("escaping a literal ==x== (#bg3cb83t, @opus-editor)", () => {
  it("escapes only a balanced run, so an escaped literal stays literal", () => {
    expect(escapeMarkdownText("show ==x== as typed", false)).toBe("show \\==x== as typed");
    expect(escapeMarkdownText("a == b and c==d", false)).toBe("a == b and c==d");
    expect(escapeMarkdownText("== spaced ==", false)).toBe("== spaced ==");
    expect(escapeMarkdownText("x = y, ===", false)).toBe("x = y, ===");
  });

  it("the escaped form reads back as the same literal text", () => {
    expect(render(escapeMarkdownText("show ==x== as typed", false))).toBe("show ==x== as typed");
    // And Obsidian's other escape style is read as text too.
    expect(render("=\\=x==")).toBe("==x==");
  });
});
