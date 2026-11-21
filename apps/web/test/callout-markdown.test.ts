import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import type { Node as PMNode } from "@tiptap/pm/model";
import MarkdownIt from "markdown-it";
import { MarkdownSerializer, defaultMarkdownSerializer } from "prosemirror-markdown";
import { describe, expect, it } from "vitest";
import { Callout, CalloutTitle } from "../src/editor/callout/callout.js";
import {
  calloutSource,
  parseCalloutHead,
  retargetSource,
  serializeCallout,
} from "../src/editor/callout/markdown.js";
import { calloutStyle, defaultCalloutTitle } from "../src/editor/callout/types.js";
import { rawMarkdownPlugin } from "../src/editor/raw-markdown/markdown-plugin.js";

const md = new MarkdownIt({ html: false });
rawMarkdownPlugin(md);

const decode = (value: string) =>
  value.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

interface Parsed {
  type: string;
  fold: string;
  source: string | null;
}

/** type, fold and remembered source of every callout, outermost first. */
function callouts(markdown: string): Parsed[] {
  return [...md.render(markdown).matchAll(/<div data-gumply-callout="([^"]*)" data-fold="([^"]*)"(?: data-md-source="([^"]*)")?>/g)].map(
    (m) => ({ type: decode(m[1]!), fold: m[2]!, source: m[3] === undefined ? null : decode(m[3]) }),
  );
}

describe("callout Markdown → editor HTML (D29)", () => {
  it("reads every Obsidian type and both fold markers", () => {
    for (const type of ["note", "tip", "info", "success", "question", "warning", "danger", "bug", "example", "quote"]) {
      for (const fold of ["", "+", "-"]) {
        const source = `> [!${type}]${fold} Title\n> Body`;
        expect(callouts(source)).toEqual([{ type, fold, source }]);
      }
    }
  });

  it("splits the title line from a body in the same paragraph", () => {
    const html = md.render("> [!tip] Use **this**\n> Body *text*");
    expect(html).toMatch(/<div data-callout-title="">Use <strong>this<\/strong><\/div>/);
    expect(html).toMatch(/<p>Body <em>text<\/em><\/p>/);
  });

  it("keeps an untitled callout's title empty and an empty body empty", () => {
    const html = md.render("> [!note]");
    expect(html).toContain('<div data-callout-title=""></div>');
    expect(html).not.toContain("<p>");
  });

  it("keeps custom types by name", () => {
    expect(callouts("> [!my-type] Custom")).toEqual([{ type: "my-type", fold: "", source: "> [!my-type] Custom" }]);
    expect(calloutStyle("my-type")).toBe("note"); // Obsidian's fallback
    expect(calloutStyle("FAQ")).toBe("question");
    expect(defaultCalloutTitle("my-type")).toBe("My-type");
  });

  it("nests callouts with `>>`, remembering each source relative to its level", () => {
    const outer = "> [!note] Outer\n> Text\n>\n>> [!warning]- Inner\n>> Hidden";
    expect(callouts(outer)).toEqual([
      { type: "note", fold: "", source: outer },
      { type: "warning", fold: "-", source: "> [!warning]- Inner\n> Hidden" },
    ]);
  });

  it("parses code blocks, lists and quotes in the body", () => {
    const source = "> [!example] Code\n> ```js\n> const a = 1;\n> ```\n> - one\n> - two";
    const html = md.render(source);
    expect(html).toContain('<code class="language-js">const a = 1;');
    expect(html).toContain("<li>one</li>");
    expect(callouts(source)[0]?.source).toBe(source);
  });

  it("leaves plain quotes and `[!x]` mid-text alone", () => {
    expect(callouts("> just a quote")).toEqual([]);
    expect(callouts("> text [!note] later")).toEqual([]);
    expect(callouts("[!note] not quoted")).toEqual([]);
  });

  it("cuts a callout out of a list item", () => {
    expect(calloutSource(["- item", "  > [!tip] In list", "  > body"], [1, 3], 0)).toBe("> [!tip] In list\n> body");
    expect(calloutSource(["- > [!tip] On marker"], [0, 1], 0)).toBeNull();
    // A lazy continuation line in a nested quote can't be cut out.
    expect(calloutSource(["> > [!tip] x", "lazy"], [0, 2], 1)).toBeNull();
  });

  it("reads the head", () => {
    expect(parseCalloutHead("[!note]- Title  ")).toEqual({ type: "note", fold: "-", title: "Title" });
    expect(parseCalloutHead("[!note]")).toEqual({ type: "note", fold: "", title: "" });
    expect(parseCalloutHead("[!note]Title")).toBeNull();
  });
});

describe("callout → Markdown", () => {
  const schema = getSchema([StarterKit, Callout, CalloutTitle]);
  const d = defaultMarkdownSerializer.nodes;
  const serializer = new MarkdownSerializer(
    {
      ...d,
      callout: ((state: never, node: PMNode) => serializeCallout(state, node)) as never,
      calloutTitle: (() => undefined) as never,
      bulletList: d.bullet_list!,
      listItem: d.list_item!,
      codeBlock: d.code_block!,
    },
    defaultMarkdownSerializer.marks,
  );
  const p = (text = "") => schema.node("paragraph", null, text ? [schema.text(text)] : []);
  const callout = (attrs: Record<string, unknown>, title: string, ...body: PMNode[]) =>
    schema.node("callout", attrs, [schema.node("calloutTitle", null, title ? [schema.text(title)] : []), ...(body.length ? body : [p()])]);
  const out = (...nodes: PMNode[]) => serializer.serialize(schema.node("doc", null, nodes));

  it("writes type, fold marker, title and body", () => {
    expect(out(callout({ type: "tip", fold: "" }, "Title", p("Body")))).toBe("> [!tip] Title\n> Body");
    expect(out(callout({ type: "note", fold: "-" }, "Closed", p("a"), p("b")))).toBe("> [!note]- Closed\n> a\n>\n> b");
    expect(out(callout({ type: "note", fold: "+" }, "Open", p("x")))).toBe("> [!note]+ Open\n> x");
  });

  it("writes an untitled callout and an empty body", () => {
    expect(out(callout({ type: "warning", fold: "" }, "", p("Careful")))).toBe("> [!warning]\n> Careful");
    expect(out(callout({ type: "note", fold: "-" }, "Only a title"))).toBe("> [!note]- Only a title");
  });

  it("nests a callout and a code block in the body", () => {
    const inner = callout({ type: "bug", fold: "" }, "Inner", p("deep"));
    const code = schema.node("codeBlock", null, [schema.text("let a = 1;")]);
    expect(out(callout({ type: "note", fold: "" }, "Outer", code, inner))).toBe(
      "> [!note] Outer\n> ```\n> let a = 1;\n> ```\n>\n> > [!bug] Inner\n> > deep",
    );
  });

  it("separates two callouts with a blank line", () => {
    expect(out(callout({ type: "tip", fold: "" }, "A", p("a")), callout({ type: "tip", fold: "" }, "B", p("b")))).toBe(
      "> [!tip] A\n> a\n\n> [!tip] B\n> b",
    );
  });

  it("changes the head of a kept source, nothing else", () => {
    expect(retargetSource("> [!note]-   Spaced  title\n>  body *x*", "warning", "+")).toBe(
      "> [!warning]+   Spaced  title\n>  body *x*",
    );
    expect(retargetSource(">[!note] T", "tip", "")).toBe(">[!tip] T");
    expect(retargetSource(null, "tip", "")).toBeNull();
  });
});
