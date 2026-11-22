import { describe, expect, it } from "vitest";
import { encodePropertyValue, propertyLinkSpans } from "../src/index.js";

/** #3c86ify2 / #rpugpydh: the one walk of frontmatter values links can sit in. */

const YAML = [
  'related: "[[Alpha]]" # main',
  "quoted: '[[Alpha|it''s]]'",
  "plain: see [[Alpha]] first",
  "up: [[Alpha#Goals]]",
  "list:",
  '  - "[[Beta]]"',
  "  - [[Gamma]]",
  "  - 3",
  'flow: ["[[Delta|the d]]", other]',
  "block: |",
  "  [[Alpha]] in a block scalar",
  "tags: [alpha]",
  "title: Page",
  'escaped: "\\\\[[Alpha]]"',
  "anchored: &a '[[Alpha]]'",
  "count: 4",
  "related: '[[Second]]'",
  "",
].join("\n");

describe("propertyLinkSpans", () => {
  it("lists text values and list items in file order, decoded, with their style and exact source range", () => {
    const spans = propertyLinkSpans(YAML)!;
    expect(spans.map(({ key, style, value }) => [key, style, value])).toEqual([
      ["related", "double", "[[Alpha]]"],
      ["quoted", "single", "[[Alpha|it's]]"],
      ["plain", "plain", "see [[Alpha]] first"],
      ["up", "flow-link", "[[Alpha#Goals]]"],
      ["list", "double", "[[Beta]]"],
      ["list", "flow-link", "[[Gamma]]"],
      ["flow", "double", "[[Delta|the d]]"],
      ["flow", "plain", "other"],
      // #7xbdttxy: tags are walked like any key (a link there is a link, never a tag).
      ["tags", "plain", "alpha"],
      // YAML "\\[[Alpha]]" decodes to \[[Alpha]]: an escaped opener (text), as in a body.
      ["escaped", "double", "\\[[Alpha]]"],
    ]);
    // Ranges point at the value's own source text, quotes included.
    for (const span of spans) {
      const source = YAML.slice(span.start, span.end);
      expect(source.includes(span.style === "single" ? span.value.replace(/'/g, "''") : span.value.replace(/\\/g, "\\\\"))).toBe(true);
    }
    expect(YAML.slice(spans[0]!.start, spans[0]!.end)).toBe('"[[Alpha]]"');
  });

  it("skips header keys, block scalars, anchors, numbers and repeated keys; null for invalid YAML", () => {
    const keys = propertyLinkSpans(YAML)!.map((span) => span.key);
    for (const key of ["block", "title", "anchored", "count"]) expect(keys).not.toContain(key);
    // #7xbdttxy: tags (any case), aliases and cssclasses are walked like any key; header keys aren't.
    expect(keys).toContain("tags");
    expect(keys.filter((key) => key === "related")).toHaveLength(1);
    expect(propertyLinkSpans('Tags: ["[[X]]"]\nTAGS: "[[Y]]"\nrel: "[[Z]]"\n')!.map((span) => span.key)).toEqual(["Tags", "TAGS", "rel"]);
    expect(propertyLinkSpans("plain: [[Alpha]] then text\n")).toBeNull();
    expect(propertyLinkSpans("- a list\n- not a mapping\n")).toBeNull();
    expect(propertyLinkSpans("")).toBeNull();
  });
});

describe("encodePropertyValue", () => {
  it("writes a value back in its own style, quoting a plain one only when it must", () => {
    expect(encodePropertyValue("double", 'say "hi" \\ [[A]]')).toBe('"say \\"hi\\" \\\\ [[A]]"');
    expect(encodePropertyValue("single", "[[A|it's]]")).toBe("'[[A|it''s]]'");
    expect(encodePropertyValue("plain", "see [[A]]")).toBe("see [[A]]");
    expect(encodePropertyValue("plain", "[[A|Q3: plan]]")).toBe('"[[A|Q3: plan]]"');
    expect(encodePropertyValue("plain", "see [[A]] #not-a-comment")).toBe('"see [[A]] #not-a-comment"');
    expect(encodePropertyValue("flow-link", "[[B#h]]")).toBe("[[B#h]]");
    // Each reads back as the same value.
    for (const [style, value] of [["double", 'a "b"'], ["single", "it's"], ["plain", "x: y"], ["plain", "true"]] as const) {
      expect(propertyLinkSpans(`k: ${encodePropertyValue(style, value)}\n`)![0]!.value).toBe(value);
    }
  });
});
