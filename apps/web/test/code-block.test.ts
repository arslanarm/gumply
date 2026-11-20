import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import MarkdownIt from "markdown-it";
import { MarkdownSerializer, defaultMarkdownSerializer } from "prosemirror-markdown";
import { describe, expect, it } from "vitest";
import { NotionCodeBlock, fenceFor, serializeCodeBlock } from "../src/editor/code-block.js";

const schema = getSchema([StarterKit.configure({ codeBlock: false }), NotionCodeBlock]);
const d = defaultMarkdownSerializer.nodes;
const serializer = new MarkdownSerializer(
  { doc: d.doc!, text: d.text!, paragraph: d.paragraph!, codeBlock: serializeCodeBlock as never },
  defaultMarkdownSerializer.marks,
);
const code = (text: string, attrs: Record<string, unknown> = {}) =>
  schema.node("doc", null, [schema.node("codeBlock", attrs, text ? [schema.text(text)] : [])]);

describe("code fences (#82x82ek7)", () => {
  it("is longer than any backtick run inside", () => {
    expect(fenceFor("```js\ninner\n```", "````")).toBe("````");
    expect(fenceFor("```js\ninner\n```", null)).toBe("````");
    expect(fenceFor("a ````` b", "```")).toBe("``````");
    expect(fenceFor("plain", null)).toBe("```");
  });

  it("keeps the original fence style", () => {
    expect(serializer.serialize(code('print("x")', { language: "python", markdownFence: "~~~" }))).toBe(
      '~~~python\nprint("x")\n~~~',
    );
    expect(serializer.serialize(code("```js\ninner\n```", { language: "md", markdownFence: "````" }))).toBe(
      "````md\n```js\ninner\n```\n````",
    );
    expect(serializer.serialize(code("line one\n\nline two", { markdownFence: "indent" }))).toBe(
      "    line one\n\n    line two",
    );
  });

  it("a nested fence round-trips through markdown-it as one block", () => {
    const written = serializer.serialize(code("```js\ninner\n```", { language: "md" }));
    const tokens = new MarkdownIt().parse(written, {}).filter((t) => t.type === "fence");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.content).toBe("```js\ninner\n```\n");
  });
});
