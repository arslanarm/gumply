import { describe, expect, it } from "vitest";
import { convertedLines, folderName, importErrorKind, looksLikeZip, progressPercent } from "../src/lib/notion-import.js";

describe("Import from Notion dialog helpers (B4)", () => {
  it("maps server answers to plain-words errors", () => {
    expect(importErrorKind({ status: 409, message: "Import abc is running" })).toBe("running");
    expect(importErrorKind({ status: 413 })).toBe("tooLarge");
    expect(importErrorKind({ status: 400 })).toBe("notExport");
    expect(importErrorKind({ status: 404 })).toBe("missingTarget");
    expect(importErrorKind(new TypeError("Failed to fetch"))).toBe("offline");
    expect(importErrorKind({ status: 500 })).toBe("other");
  });

  it("only zips are picked", () => {
    expect(looksLikeZip({ name: "Export-abc.zip" })).toBe(true);
    expect(looksLikeZip({ name: "export", type: "application/zip" })).toBe(true);
    expect(looksLikeZip({ name: "notes.md", type: "text/markdown" })).toBe(false);
  });

  it("progress: indeterminate until the total is known, then a percentage", () => {
    expect(progressPercent({ state: "reading", done: 0, total: 0 })).toBeNull();
    expect(progressPercent({ state: "writing", done: 3, total: 12 })).toBe(25);
    expect(progressPercent({ state: "done", done: 0, total: 0 })).toBe(100);
  });

  it("converted lines: only what happened, in order; folder names", () => {
    const report = { pages: 3, databases: 0, rows: 0, attachments: 1, converted: { pageLinks: 2, mentions: 0, databaseEmbeds: 1, databaseLinks: 0, attachmentLinks: 1, callouts: 0 }, missing: [], outside: [], skipped: [] };
    expect(convertedLines(report).map((line) => [line.key.split(".").pop(), line.count])).toEqual([
      ["pageLinks", 2],
      ["databaseEmbeds", 1],
      ["attachmentLinks", 1],
    ]);
    expect(folderName("Work/Notion import 2")).toBe("Notion import 2");
  });
});
