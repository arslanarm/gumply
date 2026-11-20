import { describe, expect, it } from "vitest";
import type { PageMeta } from "@gumply/core";
import { chooseLandingPage } from "../src/lib/first-run";

function meta(id: string, title: string, parentId: string | null = null): PageMeta {
  return {
    id,
    title,
    tags: [],
    parentId,
    childCount: 0,
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-01T00:00:00.000Z",
  };
}

describe("chooseLandingPage", () => {
  it("prefers the page the server announced", () => {
    const pages = [meta("Gumply demo", "Gumply demo"), meta("Welcome", "Welcome")];
    expect(chooseLandingPage(pages, "Gumply demo")).toBe("Gumply demo");
  });

  it("opens Welcome when the one-shot signal was missed", () => {
    const pages = [meta("Gumply demo", "Gumply demo"), meta("Welcome", "Welcome")];
    expect(chooseLandingPage(pages, null)).toBe("Welcome");
  });

  it("ignores a signal that is not in the list", () => {
    const pages = [meta("Gumply demo", "Gumply demo"), meta("Welcome", "Welcome")];
    expect(chooseLandingPage(pages, "deleted-page")).toBe("Welcome");
  });

  it("only treats a root Welcome as the demo landing page", () => {
    const pages = [
      meta("Gumply demo", "Gumply demo"),
      meta("Gumply demo/Welcome", "Welcome", "Gumply demo"),
    ];
    expect(chooseLandingPage(pages, null)).toBe("Gumply demo");
  });

  it("falls back to the first root in a normal vault", () => {
    const pages = [meta("Alpha", "Alpha"), meta("Beta", "Beta")];
    expect(chooseLandingPage(pages, null)).toBe("Alpha");
    expect(chooseLandingPage([], null)).toBeNull();
  });
});
