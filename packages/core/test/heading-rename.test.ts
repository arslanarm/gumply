import { describe, expect, it } from "vitest";
import { headingRenames, rewriteHeadingLinks, rewriteHeadingSubpath, type WikiLink } from "../src/index";

/** v0.8 C2 (#u84ebtf3): renaming a heading rewrites [[Page#Old]] across the vault. */

describe("headingRenames", () => {
  const page = "# Plan\n\n## Goals\n\ntext\n\n### Detail\n\n## Risks\n";

  it("finds a heading renamed in place", () => {
    expect(headingRenames(page, page.replace("## Goals", "## Objectives"))).toEqual([{ from: "Goals", to: "Objectives" }]);
    expect(headingRenames(page, page.replace("## Goals", "## Objectives").replace("## Risks", "## Dangers"))).toEqual([
      { from: "Goals", to: "Objectives" },
      { from: "Risks", to: "Dangers" },
    ]);
  });

  it("ignores formatting-only changes and unchanged pages", () => {
    expect(headingRenames(page, page)).toEqual([]);
    expect(headingRenames(page, page.replace("## Goals", "## **Goals**"))).toEqual([]);
  });

  it("does nothing when headings were added, removed, or changed level", () => {
    expect(headingRenames(page, page.replace("## Risks\n", "## Risks\n\n## New\n"))).toEqual([]);
    expect(headingRenames(page, page.replace("### Detail\n\n", ""))).toEqual([]);
    expect(headingRenames(page, page.replace("## Goals", "### Objectives"))).toEqual([]);
  });

  it("duplicate headings: only when the old text was unique before and the new one is unique after", () => {
    const twice = "## Notes\n\na\n\n## Notes\n\nb\n";
    expect(headingRenames(twice, twice.replace("## Notes\n\na", "## Ideas\n\na"))).toEqual([]);
    const two = "## A\n\n## B\n";
    // Renamed to an existing heading's text: links would become ambiguous.
    expect(headingRenames(two, "## B\n\n## B\n")).toEqual([]);
    // A swap leaves both texts in the page: nothing is "gone".
    expect(headingRenames(two, "## B\n\n## A\n")).toEqual([]);
  });

  it("headings in code don't count", () => {
    const withCode = "## Real\n\n```\n## Fake\n```\n";
    expect(headingRenames(withCode, withCode.replace("## Real", "## Renamed"))).toEqual([{ from: "Real", to: "Renamed" }]);
    expect(headingRenames(withCode, withCode.replace("## Fake", "## Other"))).toEqual([]);
  });
});

describe("rewriteHeadingLinks", () => {
  const toPlan = (link: WikiLink) => link.targetTitle.toLowerCase() === "plan" || link.targetTitle === "Projects/Plan";
  const rename = [{ from: "Goals", to: "Objectives" }];
  const rewrite = (text: string, renames = rename) => rewriteHeadingLinks(text, toPlan, renames);

  it("rewrites links, aliased links and embeds; every other byte stays", () => {
    const text = "See [[Plan#Goals]], [[Plan#Goals|our goals]] and\r\n![[Projects/Plan#Goals]] and [[Plan#  goals  |x]].\n";
    expect(rewrite(text)).toEqual({
      content: "See [[Plan#Objectives]], [[Plan#Objectives|our goals]] and\r\n![[Projects/Plan#Objectives]] and [[Plan#  Objectives  |x]].\n",
      count: 4,
    });
  });

  it("a table alias `\\|` keeps its backslash (#u84ebtf3)", () => {
    const text = "| a | [[Plan#Goals\\|piped]] |\n| b | ![[Plan#Goals\\|300]] |\n";
    expect(rewrite(text)).toEqual({ content: "| a | [[Plan#Objectives\\|piped]] |\n| b | ![[Plan#Objectives\\|300]] |\n", count: 2 });
  });

  it("an escaped `\\[[` is text, not a link; `\\\\[[` is a link", () => {
    expect(rewrite(String.raw`\[[Plan#Goals]] \![[Plan#Goals]]`).content).toBe(String.raw`\[[Plan#Goals]] \![[Plan#Objectives]]`);
    expect(rewrite(String.raw`\\[[Plan#Goals]]`).content).toBe(String.raw`\\[[Plan#Objectives]]`);
  });

  it("nested heading paths: only the matching segment", () => {
    expect(rewrite("[[Plan#Plan#Goals]] [[Plan#Goals#Detail]]").content).toBe("[[Plan#Plan#Objectives]] [[Plan#Objectives#Detail]]");
  });

  it("leaves other pages, other headings, block ids, plain links and code alone", () => {
    const text = "[[Other#Goals]] [[Plan#Risks]] [[Plan#^goals]] [[Plan]] `[[Plan#Goals]]`\n```\n[[Plan#Goals]]\n```\n";
    expect(rewrite(text)).toEqual({ content: text, count: 0 });
  });

  it("matches headings the way embeds do (case, formatting) and writes link-safe text", () => {
    expect(rewrite("[[Plan#GOALS]]").content).toBe("[[Plan#Objectives]]");
    expect(rewrite("[[Plan#Goals]]", [{ from: "**Goals**", to: "Goals [v2] | #now" }]).content).toBe("[[Plan#Goals v2 now]]");
  });

  it("several renames at once, with no chaining", () => {
    const renames = [
      { from: "Goals", to: "Risks" },
      { from: "Risks", to: "Dangers" },
    ];
    expect(rewrite("[[Plan#Goals]] [[Plan#Risks]]", renames).content).toBe("[[Plan#Risks]] [[Plan#Dangers]]");
  });
});

describe("rewriteHeadingSubpath (JSON Canvas file nodes)", () => {
  const rename = [{ from: "Goals", to: "Objectives" }];
  it("rewrites the matching segment, keeps the rest", () => {
    expect(rewriteHeadingSubpath("#Goals", rename)).toBe("#Objectives");
    expect(rewriteHeadingSubpath("#goals#Detail", rename)).toBe("#Objectives#Detail");
    expect(rewriteHeadingSubpath("#Plan# Goals ", rename)).toBe("#Plan# Objectives ");
  });
  it("null when nothing matches", () => {
    expect(rewriteHeadingSubpath("#Risks", rename)).toBeNull();
    expect(rewriteHeadingSubpath("#^goals", rename)).toBeNull();
    expect(rewriteHeadingSubpath("Goals", rename)).toBeNull();
    expect(rewriteHeadingSubpath("#Goals", [])).toBeNull();
  });
});
