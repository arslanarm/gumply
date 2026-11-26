import { describe, expect, it, vi } from "vitest";

/**
 * #idmfvvkg's follow-up (in #6pyunynv, measured in its perf A/B: "links indexed" +~400 ms on the 10k vault):
 * the link index runs `markdownPageLinks` over every page, and most pages hold no Markdown link at all. A text
 * without `](` can't hold one, so it returns before the code mask. Counted, not timed.
 */
const masked = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../src/links.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/links.js")>();
  return {
    ...actual,
    maskCode: (markdown: string) => {
      masked.calls += 1;
      return actual.maskCode(markdown);
    },
  };
});

const { markdownPageLinks } = await import("../src/attachment-paths.js");
const isPage = (id: string) => id === "Home";

describe("markdownPageLinks skips a text with no Markdown link before the code mask", () => {
  it("no `](`: no mask, no links", () => {
    masked.calls = 0;
    expect(markdownPageLinks("Notes/Day", "Plain text with [[Home]], a [bracket] and (parens).\n```\ncode\n```", isPage)).toEqual([]);
    expect(masked.calls).toBe(0);
  });

  it("a Markdown link: masked once, and found as before", () => {
    masked.calls = 0;
    expect(markdownPageLinks("Notes/Day", "See [home](../Home.md).", isPage)).toEqual(["Home"]);
    expect(masked.calls).toBe(1);
  });
});
