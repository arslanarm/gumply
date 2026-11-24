import MarkdownIt from "markdown-it";
import { MarkdownSerializerState } from "prosemirror-markdown";
import { describe, expect, it } from "vitest";
import { ImageBlock } from "../src/editor/attachments/nodes.js";
import { rawMarkdownPlugin } from "../src/editor/raw-markdown/markdown-plugin.js";

/**
 * #3zpgenmw (D37): an image's alt keeps its escaped characters on read, and a
 * caption written by Gumply reads back the same (it used to lose `|`, `_`, `*`, `[`).
 */
const md = new MarkdownIt({ html: false });
rawMarkdownPlugin(md);

/** The block image's own Markdown writer, as tiptap-markdown calls it. */
function write(attrs: Record<string, unknown>): string {
  const storage = (ImageBlock.config.addStorage as () => { markdown: { serialize: (state: unknown, node: unknown) => void } }).call({});
  // Its type declares no constructor arguments; at runtime it takes (nodes, marks, options).
  const State = MarkdownSerializerState as unknown as new (nodes: object, marks: object, options: object) => { out: string; closeBlock: () => void };
  const state = new State({}, {}, {});
  state.closeBlock = () => undefined;
  storage.markdown.serialize(state, { attrs: { title: "", obsidian: null, markdownRaw: null, markdownRawKey: null, ...attrs } });
  return state.out;
}

/** The alt the editor reads from this Markdown. */
const altOf = (source: string) =>
  /alt="([^"]*)"/.exec(md.render(source))![1]!.replace(/&amp;/g, "&").replace(/&quot;/g, '"');

describe("a caption Gumply writes reads back the same", () => {
  for (const caption of ["A|300", "my_photo", "a*b*", "x [1]", "a & b", "back\\slash"]) {
    it(JSON.stringify(caption), () => {
      const written = write({ src: "a.png", alt: caption });
      expect(altOf(written)).toBe(caption);
    });
  }

  it("an edited caption keeps the escapes it needs", () => {
    expect(write({ src: "a.png", alt: "A|301" })).toBe("![A\\|301](a.png)");
    expect(write({ src: "a.png", alt: "a*b*" })).toBe("![a\\*b\\*](a.png)");
  });
});
