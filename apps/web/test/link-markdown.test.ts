import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { MarkdownSerializer, defaultMarkdownSerializer } from "prosemirror-markdown";
import { describe, expect, it } from "vitest";
import { MarkdownLink, markdownLink } from "../src/editor/link.js";

const schema = getSchema([StarterKit, MarkdownLink]);
const d = defaultMarkdownSerializer.nodes;
const serializer = new MarkdownSerializer(
  { doc: d.doc!, text: d.text!, paragraph: d.paragraph! },
  { ...defaultMarkdownSerializer.marks, link: markdownLink as never },
);

const link = (href: string, title: string | null = null) => schema.marks.link!.create({ href, title });
const para = (...nodes: ReturnType<typeof schema.text>[]) =>
  schema.node("doc", null, [schema.node("paragraph", null, nodes)]);

describe("Markdown links (#jmg9g5t3 hunt)", () => {
  it("keeps the URL of a [text](url) link", () => {
    const doc = para(schema.text("see "), schema.text("docs", [link("https://example.com/docs")]), schema.text(" now"));
    expect(serializer.serialize(doc)).toBe("see [docs](https://example.com/docs) now");
  });

  it("writes a linkified URL back as the bare URL, unescaped", () => {
    const url = "https://example.com/a_b*c";
    expect(serializer.serialize(para(schema.text("visit "), schema.text(url, [link(url)]), schema.text(" today"))))
      .toBe(`visit ${url} today`);
    expect(serializer.serialize(para(schema.text("www.example.com", [link("http://www.example.com")]))))
      .toBe("www.example.com");
  });

  it("keeps a link whose text is a URL but points elsewhere", () => {
    const doc = para(schema.text("https://a.com", [link("https://b.com")]));
    expect(serializer.serialize(doc)).toBe("[https://a.com](https://b.com)");
  });

  it("keeps link titles", () => {
    const doc = para(schema.text("x", [link("https://x.com", "Tip")]));
    expect(serializer.serialize(doc)).toBe('[x](https://x.com "Tip")');
  });
});
