import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import type { Node as PMNode } from "@tiptap/pm/model";
import MarkdownIt from "markdown-it";
import { MarkdownSerializer, defaultMarkdownSerializer } from "prosemirror-markdown";
import { describe, expect, it } from "vitest";
import { EmptyLineParagraph, emptyLinesMarkdownPlugin, serializeParagraph } from "../src/editor/empty-lines.js";

const schema = getSchema([StarterKit.configure({ paragraph: false }), EmptyLineParagraph]);
const d = defaultMarkdownSerializer.nodes;
const serializer = new MarkdownSerializer(
  {
    text: d.text!,
    paragraph: serializeParagraph as never,
    heading: d.heading!,
    bulletList: d.bullet_list!,
    orderedList: d.ordered_list!,
    listItem: d.list_item!,
    blockquote: d.blockquote!,
    codeBlock: d.code_block!,
  },
  defaultMarkdownSerializer.marks,
);

const md = new MarkdownIt({ html: false });
emptyLinesMarkdownPlugin(md);
emptyLinesMarkdownPlugin(md); // idempotent: tiptap-markdown calls setup on every parse

/** Compact block outline of rendered HTML: `p:a`, `p:` (empty), `ul`, … */
function outline(markdown: string): string[] {
  const html = md.render(markdown);
  const blocks: string[] = [];
  const re = /<(p|h[1-3]|ul|ol|blockquote|pre)>([\s\S]*?)<\/\1>\n?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const tag = match[1]!;
    blocks.push(tag === "p" ? `p:${match[2]}` : tag);
  }
  return blocks;
}

const p = (text?: string) => schema.node("paragraph", null, text ? [schema.text(text)] : []);
const ul = (...items: string[]) =>
  schema.node("bulletList", null, items.map((item) => schema.node("listItem", null, [p(item)])));
const doc = (...blocks: PMNode[]) => schema.node("doc", null, blocks);

describe("empty lines round-trip (#jmg9g5t3)", () => {
  it("writes each empty line as one extra blank line", () => {
    expect(serializer.serialize(doc(p("a"), p(), p("b")))).toBe("a\n\n\nb");
    expect(serializer.serialize(doc(p("a"), p(), p(), p("b")))).toBe("a\n\n\n\nb");
    expect(serializer.serialize(doc(p("a"), p("b")))).toBe("a\n\nb");
  });

  it("reads extra blank lines back as empty paragraphs", () => {
    expect(outline("a\n\nb")).toEqual(["p:a", "p:b"]);
    expect(outline("a\n\n\nb")).toEqual(["p:a", "p:", "p:b"]);
    expect(outline("a\n\n\n\nb")).toEqual(["p:a", "p:", "p:", "p:b"]);
  });

  it("does not count blank lines inside code fences or after lists", () => {
    expect(outline("```\nx\n\n\n```\n\ny")).toEqual(["pre", "p:y"]);
    expect(outline("- a\n- b\n\n\nc")).toEqual(["ul", "p:", "p:c"]);
    expect(outline("# h\n\n\n\np")).toEqual(["h1", "p:", "p:", "p:p"]);
  });

  it("keeps two lists apart with an &nbsp; line", () => {
    const markdown = serializer.serialize(doc(ul("a"), p(), p(), ul("b")));
    expect(markdown).toBe("* a\n\n\n&nbsp;\n\n* b");
    expect(outline(markdown)).toEqual(["ul", "p:", "p:", "ul"]);
  });

  it("keeps leading empty lines with an &nbsp; first line", () => {
    const markdown = serializer.serialize(doc(p(), p(), p("a")));
    expect(markdown).toBe("&nbsp;\n\n\na");
    expect(outline(markdown)).toEqual(["p:", "p:", "p:a"]);
  });

  it("drops trailing empty lines", () => {
    expect(serializer.serialize(doc(p("a"), p(), p()))).toBe("a");
    expect(serializer.serialize(doc(p()))).toBe("");
  });

  it("round-trips a mixed document", () => {
    const source = doc(
      schema.node("heading", { level: 1 }, [schema.text("Title")]),
      p(),
      p("one"),
      p(),
      p(),
      p("two"),
      schema.node("blockquote", null, [p("q")]),
      p(),
      p("end"),
    );
    expect(outline(serializer.serialize(source))).toEqual([
      "h1", "p:", "p:one", "p:", "p:", "p:two", "blockquote", "p:", "p:end",
    ]);
  });
});
