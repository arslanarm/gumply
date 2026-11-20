import { describe, expect, it } from "vitest";
import { splitSnippet, visibleBacklinks } from "../src/lib/backlinks.js";

describe("splitSnippet", () => {
  it("returns plain text untouched", () => {
    expect(splitSnippet("A plain sentence.")).toEqual([
      { text: "A plain sentence.", highlight: false },
    ]);
  });

  it("highlights wiki links, including at the edges", () => {
    expect(splitSnippet("[[Source]] links to [[Target]] here.")).toEqual([
      { text: "[[Source]]", highlight: true },
      { text: " links to ", highlight: false },
      { text: "[[Target]]", highlight: true },
      { text: " here.", highlight: false },
    ]);
  });
});

describe("visibleBacklinks", () => {
  const items = Array.from({ length: 7 }, (_, index) => `item-${index}`);

  it("shows five rows before expanding", () => {
    expect(visibleBacklinks(items, false)).toEqual(items.slice(0, 5));
  });

  it("shows everything when expanded", () => {
    expect(visibleBacklinks(items, true)).toEqual(items);
  });
});
