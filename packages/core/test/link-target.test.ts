import { describe, expect, it } from "vitest";
import { formatWikilink, linkTargetFor, rewriteLinksToPage } from "../src/link-target.js";
import { resolveWikilink } from "../src/links.js";
import type { PageMeta } from "../src/types.js";

const meta = (id: string, title: string): PageMeta =>
  ({ id, title, parentId: null, path: `${id}.md`, created: "", updated: "", tags: [] }) as unknown as PageMeta;

describe("linkTargetFor (#mp8eadhk)", () => {
  const ideas = meta("Ideas Q3", "Ideas: Q3?");
  const welcome = meta("Welcome", "Welcome");
  const nested = meta("Projects/Ideas Q3", "Ideas: Q3?");
  const pages = [ideas, welcome];

  it("keeps plain [[Title]] when title and file name agree", () => {
    expect(linkTargetFor(welcome, pages)).toEqual({ target: "Welcome", alias: "" });
    expect(formatWikilink(welcome, pages, { heading: "Try it" })).toBe("[[Welcome#Try it]]");
  });

  it("uses file name + title alias when they differ", () => {
    expect(linkTargetFor(ideas, pages)).toEqual({ target: "Ideas Q3", alias: "Ideas: Q3?" });
    expect(formatWikilink(ideas, pages)).toBe("[[Ideas Q3|Ideas: Q3?]]");
    expect(formatWikilink(ideas, pages, { alias: "my ideas" })).toBe("[[Ideas Q3|my ideas]]");
  });

  it("falls back to the full path when the file name is shared", () => {
    const all = [ideas, nested, welcome];
    expect(linkTargetFor(nested, all)).toEqual({ target: "Projects/Ideas Q3", alias: "Ideas: Q3?" });
  });

  it("the written target resolves back to the page in Gumply", () => {
    const all = [ideas, nested, welcome, meta("Plan", "Plan"), meta("Plan 2", "Plan")];
    for (const page of all) {
      expect(resolveWikilink(linkTargetFor(page, all).target, all)?.id).toBe(page.id);
    }
  });
});

describe("rewriteLinksToPage (D12/D20 rename)", () => {
  it("writes file name + new title, keeps user aliases, drops stale auto aliases", () => {
    const before = [meta("Ideas", "Ideas")];
    const after = [meta("Ideas Q3", "Ideas: Q3?")];
    const body = "See [[Ideas]], [[Ideas#Next|next steps]] and [[Ideas|Ideas]].";
    const out = rewriteLinksToPage(
      body,
      (link) => resolveWikilink(link.targetTitle, before)?.id === "Ideas",
      after[0]!,
      after,
      "Ideas",
    );
    expect(out.content).toBe(
      "See [[Ideas Q3|Ideas: Q3?]], [[Ideas Q3#Next|next steps]] and [[Ideas Q3|Ideas: Q3?]].",
    );
    expect(out.count).toBe(3);
  });

  it("goes back to plain [[Title]] when title and file name agree again", () => {
    const before = [meta("Ideas Q3", "Ideas: Q3?")];
    const after = [meta("Roadmap", "Roadmap")];
    const out = rewriteLinksToPage(
      "[[Ideas Q3|Ideas: Q3?]] and [[Ideas Q3|my ideas]]",
      (link) => resolveWikilink(link.targetTitle, before)?.id === "Ideas Q3",
      after[0]!,
      after,
      "Ideas: Q3?",
    );
    expect(out.content).toBe("[[Roadmap]] and [[Roadmap|my ideas]]");
  });
});

describe("no redundant alias (@opus-hunter nit)", () => {
  it("duplicate titles: [[Plan]] for Plan.md, [[Plan 2|Plan]] for the second", () => {
    const pages = [meta("Plan", "Plan"), meta("Plan 2", "Plan")];
    expect(formatWikilink(pages[0]!, pages)).toBe("[[Plan]]");
    expect(formatWikilink(pages[1]!, pages)).toBe("[[Plan 2|Plan]]");
  });
});

describe("rewriteLinksToPage computes the link form once per page list (#im3em6tq)", () => {
  const isOld = (link: { targetTitle: string }) => link.targetTitle === "Old";
  const plan = meta("Work/Plan", "Plan");

  it("a new list (another rename's, or one where a page was created meanwhile) is never served the old answer", () => {
    const first = [plan, meta("Welcome", "Welcome")];
    expect(rewriteLinksToPage("See [[Old]].", isOld, plan, first, "Old").content).toBe("See [[Plan]].");
    // Someone created another "Plan" before the next rename: the server builds a fresh list.
    const second = [...first, meta("Archive/Plan", "Plan")];
    expect(rewriteLinksToPage("See [[Old]].", isOld, plan, second, "Old").content).toBe("See [[Work/Plan|Plan]].");
    // And the first list still gives its own answer.
    expect(rewriteLinksToPage("Again [[Old]].", isOld, plan, first, "Old").content).toBe("Again [[Plan]].");
  });

  it("within one list, the answer is per page and per title", () => {
    const list = [plan, meta("Notes/Ideas Q3", "Ideas: Q3?")];
    const ideas = list[1]!;
    expect(rewriteLinksToPage("[[Old]]", isOld, plan, list, "Old").content).toBe("[[Plan]]");
    expect(rewriteLinksToPage("[[Old]]", isOld, ideas, list, "Old").content).toBe("[[Ideas Q3|Ideas: Q3?]]");
    // The same id with another title (a record retitled meanwhile) isn't served the cached form.
    expect(rewriteLinksToPage("[[Old]]", isOld, meta("Work/Plan", "Plan B"), list, "Old").content).toBe("[[Plan|Plan B]]");
  });

  it("gives exactly what linkTargetFor gives, for every page of a list", () => {
    const list = [plan, meta("Archive/Plan", "Plan"), meta("Ideas Q3", "Ideas: Q3?"), meta("Welcome", "Welcome")];
    for (const page of list) {
      const { target, alias } = linkTargetFor(page, list);
      expect(rewriteLinksToPage("[[Old]]", isOld, page, list, "Old").content, page.id).toBe(`[[${target}${alias ? `|${alias}` : ""}]]`);
    }
  });
});
