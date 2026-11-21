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

  it("never lands on a D33 folder: the first page or board inside, depth-first (#z9b6zg47)", () => {
    const folder = (id: string, parentId: string | null = null): PageMeta => ({ ...meta(id, id, parentId), kind: "folder" });
    // Tree order: folders first (Empty, files, Work), then the root page Zeta.
    const pages = [
      folder("Empty"),
      folder("files"),
      folder("Work"),
      meta("Work/Plan", "Plan", "Work"),
      meta("Zeta", "Zeta"),
    ];
    // A root page wins over pages inside folders, even though folders sort first.
    expect(chooseLandingPage(pages, null)).toBe("Zeta");
    expect(chooseLandingPage([folder("photos"), meta("Notes", "Notes")], null)).toBe("Notes");
    // Without one at the top: the first page inside, depth-first.
    expect(chooseLandingPage(pages.filter((page) => page.id !== "Zeta"), null)).toBe("Work/Plan");
    expect(
      chooseLandingPage([folder("Home"), meta("Home/Ideas", "Ideas", "Home"), meta("Index", "Index")], null),
    ).toBe("Index");
    expect(chooseLandingPage([folder("A"), { ...meta("A/Map.canvas", "Map", "A"), kind: "whiteboard" }], null)).toBe("A/Map.canvas");
  });

  it("a vault of folders without pages opens on nothing ('No pages yet')", () => {
    const folder = (id: string): PageMeta => ({ ...meta(id, id), kind: "folder" });
    expect(chooseLandingPage([folder("photos"), folder("files")], null)).toBeNull();
  });
});
