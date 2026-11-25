import { describe, expect, it } from "vitest";
import { MarkdownSerializer, defaultMarkdownParser, defaultMarkdownSerializer } from "prosemirror-markdown";
import { renderListKeepingGaps } from "../src/editor/raw-markdown/list-source.js";

/**
 * #fy7pas58: `renderListKeepingGaps` is prosemirror-markdown's `renderList` with one change
 * (a loose list writes each item's recorded gap). With no gaps recorded it must write exactly
 * what upstream writes, so a prosemirror-markdown update that changes `renderList` fails here
 * instead of drifting (@opus-editor's guard).
 */
type Nodes = ConstructorParameters<typeof MarkdownSerializer>[0];
const upstream = defaultMarkdownSerializer;
const ours = new MarkdownSerializer(
  {
    ...upstream.nodes,
    bullet_list(state, node) {
      renderListKeepingGaps(state as never, node, "  ", () => `${node.attrs.bullet || "*"} `);
    },
    ordered_list(state, node) {
      const start = (node.attrs.order as number | null) ?? 1;
      const width = String(start + node.childCount - 1).length;
      const space = state.repeat(" ", width + 2);
      renderListKeepingGaps(state as never, node, space, (i) => {
        const number = String(start + i);
        return `${state.repeat(" ", width - number.length)}${number}. `;
      });
    },
  } as Nodes,
  upstream.marks,
);

const SOURCES: Record<string, string> = {
  tight: "* one\n* two\n* three\n",
  loose: "* one\n\n* two\n\n* three\n",
  "loose with an item of two paragraphs": "* one\n\n  more\n* two\n",
  nested: "* one\n  * a\n  * b\n* two\n\n  * c\n\n  * d\n",
  ordered: "1. one\n2. two\n\n10. ten\n",
  "two lists in a row": "* a\n* b\n\npara\n\n1. one\n2. two\n\n* c\n",
  "in a quote": "> * a\n> * b\n>\n> * c\n",
};

describe("with no recorded gaps, our list writer writes what prosemirror-markdown writes (#fy7pas58)", () => {
  for (const [name, source] of Object.entries(SOURCES)) {
    it(name, () => {
      const doc = defaultMarkdownParser.parse(source);
      expect(ours.serialize(doc)).toBe(upstream.serialize(doc));
    });
  }
});
