import { describe, expect, it } from "vitest";
import { convertedLines, databaseLine, failedJobMessage, skippedReason, folderName, importErrorKind, looksLikeZip, progressPercent } from "../src/lib/notion-import.js";
import { notionReportStrings } from "@gumply/core";
import en from "../src/i18n/en.json";
import ru from "../src/i18n/ru.json";

describe("Import from Notion dialog helpers (B4)", () => {
  it("maps server answers to plain-words errors", () => {
    expect(importErrorKind({ status: 409, message: "Import abc is running" })).toBe("running");
    expect(importErrorKind({ status: 413 })).toBe("tooLarge");
    expect(importErrorKind({ status: 400 })).toBe("notExport");
    expect(importErrorKind({ status: 404 })).toBe("missingTarget");
    expect(importErrorKind(new TypeError("Failed to fetch"))).toBe("offline");
    expect(importErrorKind({ status: 500 })).toBe("other");
  });

  it("a damaged export (#4zzay6mn): its own message naming the file, in en and ru; other failures keep the server's reason as the detail", () => {
    const file = "Workspace/Handbook 00000000000000000000000000000001.md";
    expect(failedJobMessage({ error: "x", errorCode: "damaged", errorFile: file })).toEqual({ key: "notionImport.errors.damagedFile", vars: { file }, details: null });
    expect(failedJobMessage({ error: "x", errorCode: "damaged" })).toEqual({ key: "notionImport.errors.damaged", vars: {}, details: null });
    expect(failedJobMessage({ error: "disk full" })).toEqual({ key: "notionImport.errors.failed", vars: {}, details: "disk full" });
    expect(failedJobMessage({})).toEqual({ key: "notionImport.errors.failed", vars: {}, details: null });
    expect(en.notionImport.errors.damagedFile).toBe("The export looks damaged (file {{file}}). Download it again from Notion.");
    expect(en.notionImport.errors.damaged).toBe("The export looks damaged. Download it again from Notion.");
    expect(ru.notionImport.errors.damagedFile).toBe("Похоже, экспорт повреждён (файл {{file}}). Скачайте его из Notion заново.");
    expect(ru.notionImport.errors.damaged).toBe("Похоже, экспорт повреждён. Скачайте его из Notion заново.");
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
    const report = {
      pages: 3,
      databases: 0,
      rows: 0,
      attachments: 1,
      sharedAttachments: [],
      converted: { pageLinks: 2, mentions: 0, databaseEmbeds: 1, databaseLinks: 0, attachmentLinks: 1, callouts: 0, relations: 4 },
      databaseDetails: [],
      renamedKeys: [],
      keptTypes: [],
      notRows: [],
      missing: [],
      outside: [],
      skipped: [],
    };
    expect(convertedLines(report).map((line) => [line.key.split(".").pop(), line.count])).toEqual([
      ["pageLinks", 2],
      ["databaseEmbeds", 1],
      ["attachmentLinks", 1],
      ["relations", 4],
    ]);
    expect(folderName("Work/Notion import 2")).toBe("Notion import 2");
  });

  it("database lines (B3): the views made and why, then the properties with their types", () => {
    const t = (key: string, vars: Record<string, string | number> = {}) => `${key.split(".").pop()}(${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(",")})`;
    const base = { name: "Tasks", base: "Notion import/Tasks.base", properties: [{ key: "Due", type: "date" as const }] };
    expect(databaseLine({ ...base, kanban: "Status", kanbanSkipped: null }, t as never, (type) => type, 12)).toBe(
      "board(name=Tasks,key=Status) properties(list=Due (date))",
    );
    expect(databaseLine({ ...base, properties: [], kanban: null, kanbanSkipped: { key: "Group", groups: 13 } }, t as never, (type) => type, 12)).toBe(
      "boardSkipped(name=Tasks,key=Group,count=13,max=12) noProperties()",
    );
  });

  it("skipped reasons (#n86gnptg): by code in the app's language, else the English reason", () => {
    const t = (key: string, vars: Record<string, string | number> = {}) => `${key}${JSON.stringify(vars)}`;
    expect(skippedReason({ path: "a", reason: "larger than 5 bytes", code: "tooLarge", params: { limit: "5 bytes" } }, t as never)).toBe(
      'notionImport.skip.tooLarge{"limit":"5 bytes"}',
    );
    expect(skippedReason({ path: "a", reason: "something old" }, t as never)).toBe("something old");
  });

  it("every skip code has a message in en and ru; the report's Russian type names are the app's", () => {
    const codes = Object.keys(notionReportStrings("en").skip);
    for (const messages of [en, ru]) expect(Object.keys(messages.notionImport.skip).sort()).toEqual([...codes].sort());
    for (const [type, word] of Object.entries(notionReportStrings("ru").types)) {
      expect(word, type).toBe(ru.properties.types[type as keyof typeof ru.properties.types].toLowerCase());
    }
  });
});

