import { describe, expect, it } from "vitest";
import { splitSnippet, visibleBacklinks } from "../src/lib/backlinks.js";

describe("splitSnippet", () => {
  it("returns plain text untouched", () => {
    expect(splitSnippet("A plain sentence.")).toEqual([
      { text: "A plain sentence.", highlight: false },
    ]);
  });

  it("shows link text without the brackets, including at the edges", () => {
    expect(splitSnippet("[[Source]] links to [[Target]] here.")).toEqual([
      { text: "Source", highlight: true },
      { text: " links to ", highlight: false },
      { text: "Target", highlight: true },
      { text: " here.", highlight: false },
    ]);
  });

  it("uses the alias and keeps the heading for alias/heading links", () => {
    expect(splitSnippet("See [[Source|the source]] and [[Target#Intro]].")).toEqual([
      { text: "See ", highlight: false },
      { text: "the source", highlight: true },
      { text: " and ", highlight: false },
      { text: "Target#Intro", highlight: true },
      { text: ".", highlight: false },
    ]);
  });

  it("reads a board embed as the board's name; its |height isn't an alias (#ux5cukze)", () => {
    expect(splitSnippet("Plan: ![[Projects/Map.canvas|480]] and ![[Map.canvas]].")).toEqual([
      { text: "Plan: ", highlight: false },
      { text: "Map", highlight: true },
      { text: " and ", highlight: false },
      { text: "Map", highlight: true },
      { text: ".", highlight: false },
    ]);
  });

  it("leaves malformed brackets alone", () => {
    expect(splitSnippet("An empty [[]] and array[0].")).toEqual([
      { text: "An empty ", highlight: false },
      { text: "[[]]", highlight: true },
      { text: " and array[0].", highlight: false },
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
