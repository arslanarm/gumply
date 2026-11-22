import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import MarkdownIt from "markdown-it";
import { MarkdownSerializer, defaultMarkdownSerializer } from "prosemirror-markdown";
import { describe, expect, it } from "vitest";
import { NotionCodeBlock, serializeCodeBlock } from "../src/editor/code-block.js";
import { findLanguage } from "../src/editor/code/languages.js";
import { DIAGRAM_FONT, mermaidConfig, SECURE_KEYS } from "../src/lib/diagram-config.js";
import { diagramMarkdownPlugin, isMermaidInfo } from "../src/lib/diagram-markdown.js";

/**
 * v0.8 F2 (#d57wfbzd): Mermaid. A ```mermaid block is a code block (the save
 * path is unchanged); the config is strict; previews get escaped
 * placeholders. (Rendering itself, and the malicious-diagram checks, need a
 * real browser: see e2e/mermaid.spec.ts.)
 */

const schema = getSchema([StarterKit.configure({ codeBlock: false }), NotionCodeBlock]);
const d = defaultMarkdownSerializer.nodes;
const serializer = new MarkdownSerializer(
  { doc: d.doc!, text: d.text!, paragraph: d.paragraph!, codeBlock: serializeCodeBlock as never },
  defaultMarkdownSerializer.marks,
);

/** Parse one fence as the editor does (language, info, fence kept), serialise it back. */
function roundTrip(markdown: string): string {
  const token = new MarkdownIt().parse(markdown, {}).find((t) => t.type === "fence")!;
  const info = token.info;
  const text = token.content.replace(/\n$/, "");
  const node = schema.node("doc", null, [
    schema.node(
      "codeBlock",
      { language: info.trim().split(/\s+/)[0] || null, markdownInfo: info || null, markdownFence: token.markup },
      text ? [schema.text(text)] : [],
    ),
  ]);
  return serializer.serialize(node);
}

describe("```mermaid blocks keep their bytes", () => {
  const cases = [
    "```mermaid\nflowchart LR\n  A[Start] --> B{Choice}\n  B -- yes --> C\n```",
    "~~~mermaid\nsequenceDiagram\n  Alice->>Bob: Hi\n~~~",
    '```mermaid title="Flow"\ngraph TD\n  A --> B\n```',
    "````mermaid\nflowchart LR\n  A[\"```\"] --> B\n````",
    "```mmd\npie\n  \"a\" : 1\n```",
    "```mermaid\n%%{init: {\"theme\": \"forest\"}}%%\ngraph TD\n  A-->B\n```",
  ];
  for (const markdown of cases) {
    it(JSON.stringify(markdown.split("\n")[0]), () => {
      expect(roundTrip(markdown)).toBe(markdown);
    });
  }

  it("mermaid is a known language (no grammar), mmd an alias", () => {
    expect(findLanguage("mermaid")).toMatchObject({ id: "mermaid", label: "Mermaid" });
    expect(findLanguage("mmd")?.id).toBe("mermaid");
    expect(findLanguage("mermaid")?.grammar).toBeUndefined();
  });
});

describe("strict Mermaid config", () => {
  for (const theme of ["light", "dark"] as const) {
    it(theme, () => {
      const config = mermaidConfig(theme);
      expect(config).toMatchObject({
        startOnLoad: false,
        securityLevel: "strict",
        htmlLabels: false,
        flowchart: { htmlLabels: false },
        class: { htmlLabels: false },
        fontFamily: DIAGRAM_FONT,
        theme: theme === "dark" ? "dark" : "default",
        // ELK (elkjs, EPL-2.0 / GPL-3.0) isn't shipped: only dagre.
        layout: "dagre",
      });
      // A diagram's own %%{init}%% can't loosen any of these.
      for (const key of ["securityLevel", "htmlLabels", "startOnLoad", "flowchart", "maxTextSize", "fontFamily", "themeCSS", "secure", "dompurifyConfig", "layout"]) {
        expect(config.secure, key).toContain(key);
      }
      expect(config.secure).toEqual([...SECURE_KEYS]);
      expect(config.maxTextSize).toBeLessThanOrEqual(50_000);
      // No web font: only the system stack.
      expect(config.fontFamily).not.toMatch(/url\(|https?:/);
    });
  }
});

describe("previews and stickies", () => {
  const md = new MarkdownIt({ html: false });
  diagramMarkdownPlugin(md);

  it("```mermaid becomes an escaped placeholder; other fences are unchanged", () => {
    const html = md.render('```mermaid\ngraph TD\n  A["<img src=x onerror=alert(1)>"] --> B\n```\n\n```js\nx()\n```');
    expect(html).toContain('<div class="mermaid-block" data-mermaid="graph TD\n  A[&quot;&lt;img src=x onerror=alert(1)&gt;&quot;] --&gt; B"');
    expect(html).not.toContain("<img");
    expect(html).toContain('<pre><code class="language-js">x()\n</code></pre>');
  });

  it("recognises mermaid and mmd, with or without an info string", () => {
    expect(isMermaidInfo("mermaid")).toBe(true);
    expect(isMermaidInfo(" MMD ")).toBe(true);
    expect(isMermaidInfo('mermaid title="x"')).toBe(true);
    expect(isMermaidInfo("mermaidjs")).toBe(false);
    expect(isMermaidInfo("")).toBe(false);
  });
});
