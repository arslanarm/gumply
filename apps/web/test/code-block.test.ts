import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import MarkdownIt from "markdown-it";
import { MarkdownSerializer, defaultMarkdownSerializer } from "prosemirror-markdown";
import { describe, expect, it } from "vitest";
import { EditorState } from "@tiptap/pm/state";
import { NotionCodeBlock, fenceFor, fenceInfo, serializeCodeBlock } from "../src/editor/code-block.js";
import {
  CODE_LANGUAGES,
  findLanguage,
  languageLabel,
  searchLanguages,
  typedLanguage,
} from "../src/editor/code/languages.js";
import { codeHighlightKey, codeHighlightPlugin, loadGrammar } from "../src/editor/code/highlight-plugin.js";

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

describe("code languages on the fence (#zvhhn84v)", () => {
  const info = (markdown: string) =>
    new MarkdownIt().parse(markdown, {}).find((t) => t.type === "fence")?.info;

  it("writes the language on the fence and reads it back", () => {
    const written = serializer.serialize(code("const x = 1;", { language: "ts" }));
    expect(written).toBe("```ts\nconst x = 1;\n```");
    expect(info(written)).toBe("ts");
    // Plain text: an empty fence.
    expect(serializer.serialize(code("plain", { language: null }))).toBe("```\nplain\n```");
  });

  it("keeps unknown languages and extra info words as written", () => {
    expect(serializer.serialize(code("TABLE file", { language: "dataviewjs" }))).toBe(
      "```dataviewjs\nTABLE file\n```",
    );
    const attrs = { language: "js", markdownInfo: 'js title="app.js" {1,3}' };
    expect(serializer.serialize(code("run()", attrs))).toBe('```js title="app.js" {1,3}\nrun()\n```');
    // A new language from the picker replaces the info string.
    expect(serializer.serialize(code("run()", { ...attrs, language: "ts" }))).toBe("```ts\nrun()\n```");
  });

  it("fenceInfo only reuses the original info while the language is unchanged", () => {
    expect(fenceInfo("python", "python linenums")).toBe("python linenums");
    expect(fenceInfo("ts", "js")).toBe("ts");
    expect(fenceInfo("", "js")).toBe("");
    expect(fenceInfo("go", null)).toBe("go");
  });
});

describe("language table", () => {
  it("finds languages by id or alias, case-insensitively", () => {
    expect(findLanguage("ts")?.label).toBe("TypeScript");
    expect(findLanguage("TypeScript")?.id).toBe("ts");
    expect(findLanguage("py")?.id).toBe("python");
    expect(findLanguage("yml")?.id).toBe("yaml");
    expect(findLanguage("")).toBeNull();
    expect(findLanguage("text")).toBeNull();
    expect(findLanguage("dataviewjs")).toBeNull();
  });

  it("labels unknown names as written and empty as Plain text", () => {
    expect(languageLabel("ts")).toBe("TypeScript");
    expect(languageLabel("")).toBe("Plain text");
    expect(languageLabel("plaintext")).toBe("Plain text");
    expect(languageLabel("dataviewjs")).toBe("dataviewjs");
  });

  it("offers about 30 languages and searches prefixes first", () => {
    expect(CODE_LANGUAGES.length).toBeGreaterThanOrEqual(30);
    expect(searchLanguages("")[0]?.label).toBe("Plain text");
    expect(searchLanguages("ru").map((l) => l.label)).toEqual(["Ruby", "Rust"]);
    expect(searchLanguages("script").map((l) => l.label)).toEqual(["JavaScript", "TypeScript"]);
  });

  it("recognises a language typed after ``` only for names we know", () => {
    expect(typedLanguage("python")).toBe("python");
    expect(typedLanguage(" TS ")).toBe("TS");
    expect(typedLanguage("const x")).toBeNull();
    expect(typedLanguage("hello")).toBeNull();
    expect(typedLanguage("text")).toBeNull();
  });
});

describe("highlighting", () => {
  const decorations = (attrs: Record<string, unknown>, text: string) => {
    const state = EditorState.create({ schema, doc: code(text, attrs), plugins: [codeHighlightPlugin("codeBlock")] });
    return codeHighlightKey.getState(state)!.find();
  };

  it("highlights known languages once their grammar is loaded, and nothing else", async () => {
    await loadGrammar(findLanguage("ts")!);
    const found = decorations({ language: "ts" }, "const answer: number = 42; // ok");
    const classes = found.map((d) => (d as unknown as { type: { attrs: { class: string } } }).type.attrs.class);
    expect(classes).toContain("hljs-keyword");
    expect(classes).toContain("hljs-number");
    expect(classes).toContain("hljs-comment");
    // Never auto-detected: plain and unknown languages stay plain text.
    expect(decorations({ language: null }, "const answer = 42;")).toHaveLength(0);
    expect(decorations({ language: "dataviewjs" }, "const answer = 42;")).toHaveLength(0);
  });
});
