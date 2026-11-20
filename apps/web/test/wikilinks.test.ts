import type { Attachment, PageMeta } from "@gumply/core";
import { describe, expect, it } from "vitest";
import {
  buildLinkSuggestions,
  parseWikiLinkText,
} from "../src/lib/wikilinks.js";

function page(id: string, title: string, parentId: string | null = null): PageMeta {
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

function attachment(name: string, mime = "text/plain"): Attachment {
  return { path: `attachments/${name}`, name, size: 100, mime };
}

const pages = [
  page("alpha", "Alpha"),
  page("beta", "Beta"),
  page("projects/plan", "Plan"),
  page("archive/plan", "Plan"),
  page("gamma", "Gamma"),
];

describe("buildLinkSuggestions", () => {
  it("lists pages sorted by title when the query is empty", () => {
    const items = buildLinkSuggestions(pages, "");
    expect(items.map((item) => item.title)).toEqual(["Alpha", "Beta", "Gamma", "Plan", "Plan"]);
    expect(items.some((item) => item.kind === "create")).toBe(false);
  });

  it("filters case-insensitively", () => {
    const items = buildLinkSuggestions(pages, "alp");
    expect(items[0]?.pageId).toBe("alpha");
  });

  it("shows the folder path for duplicate titles", () => {
    const items = buildLinkSuggestions(pages, "plan");
    expect(items.map((item) => item.label)).toEqual(["Archive/Plan", "Projects/Plan"]);
  });

  it("adds Create “X” when there is no exact match", () => {
    const items = buildLinkSuggestions(pages, "New page");
    const create = items.find((item) => item.kind === "create");
    expect(create?.title).toBe("New page");
    expect(create?.label).toBe("Create “New page”");
  });

  it("does not add Create when the typed title exists", () => {
    const items = buildLinkSuggestions(pages, "alpha");
    expect(items.some((item) => item.kind === "create")).toBe(false);
  });

  it("caps page rows at eight", () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      page(`page-${index}`, `Page ${String(index).padStart(2, "0")}`),
    );
    expect(buildLinkSuggestions(many, "").length).toBe(8);
  });
});

describe("buildLinkSuggestions attachments", () => {
  const attachments = [
    attachment("brief.pdf", "application/pdf"),
    attachment("q1-demo.svg", "image/svg+xml"),
    attachment("notes.txt"),
  ];

  it("lists matching attachments after page matches, before Create", () => {
    const items = buildLinkSuggestions(pages, "plan", attachments);
    const brief = buildLinkSuggestions(pages, "brief", attachments);
    expect(items.some((item) => item.kind === "attachment")).toBe(false);
    expect(brief.map((item) => item.kind)).toEqual(["attachment", "create"]);
    expect(brief[0]?.attachment?.name).toBe("brief.pdf");
    expect(brief[0]?.label).toBe("brief.pdf");
    expect(brief[brief.length - 1]?.kind).toBe("create");
  });

  it("filters attachments case-insensitively and by MIME-agnostic name", () => {
    const items = buildLinkSuggestions(pages, "Q1-DEMO", attachments);
    expect(
      items.filter((item) => item.kind === "attachment").map((item) => item.attachment?.name),
    ).toEqual(["q1-demo.svg"]);
  });

  it("shows all attachments for an empty query after pages", () => {
    const items = buildLinkSuggestions(pages, "", attachments);
    const attachmentRows = items.filter((item) => item.kind === "attachment");
    expect(attachmentRows.map((item) => item.attachment?.name)).toEqual([
      "brief.pdf",
      "notes.txt",
      "q1-demo.svg",
    ]);
    expect(items.some((item) => item.kind === "create")).toBe(false);
  });
});

describe("parseWikiLinkText", () => {
  it("parses plain, alias and heading forms", () => {
    expect(parseWikiLinkText("[[Plan]]")).toEqual({ title: "Plan", alias: "", heading: "" });
    expect(parseWikiLinkText("[[Plan|roadmap]]")).toEqual({
      title: "Plan",
      alias: "roadmap",
      heading: "",
    });
    expect(parseWikiLinkText("[[Plan#Q3]]")).toEqual({
      title: "Plan",
      alias: "",
      heading: "Q3",
    });
    expect(parseWikiLinkText("[[Plan#Q3|the plan]]")).toEqual({
      title: "Plan",
      alias: "the plan",
      heading: "Q3",
    });
  });

  it("rejects empty targets and non-links", () => {
    expect(parseWikiLinkText("[[]]")).toBeNull();
    expect(parseWikiLinkText("Plan")).toBeNull();
  });
});
