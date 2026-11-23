import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  NOTION_REPORT_LANGUAGES,
  notionReportMarkdown,
  notionUrlId,
  planNotionImport,
  stripNotionId,
  type NotionEntry,
  type NotionImportOptions,
} from "../src/index";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "fixtures/notion");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** A fixture as the zip's entries (`/` paths, bytes). */
function fixtureEntries(fixture: string): NotionEntry[] {
  return walk(fixture).map((path) => ({ path: relative(fixture, path).split("\\").join("/"), data: readFileSync(path) }));
}

const enc = new TextEncoder();
const bytes = (content: string | Uint8Array) => (typeof content === "string" ? enc.encode(content) : content);

/** Plan `fixtures/notion/<name>` and compare every written file with `<name>.expected/`, byte for byte. */
function expectGolden(name: string, options: Partial<NotionImportOptions> = {}) {
  const plan = planNotionImport(fixtureEntries(join(FIXTURES, name)), {
    folder: "Notion import",
    attachmentsFolder: "attachments/Notion import",
    ...options,
  });
  const written = new Map(plan.files.map((file) => [file.path, bytes(file.content)]));
  written.set("Notion import/Import report.md", enc.encode(notionReportMarkdown(plan.report, "Notion import")));
  const expectedDir = join(FIXTURES, `${name}.expected`);
  if (process.env.UPDATE_NOTION_GOLDEN === "1") {
    for (const [path, data] of written) {
      mkdirSync(dirname(join(expectedDir, path)), { recursive: true });
      writeFileSync(join(expectedDir, path), data);
    }
  }
  expect(existsSync(expectedDir)).toBe(true);
  const expected = new Map(walk(expectedDir).map((path) => [relative(expectedDir, path).split("\\").join("/"), readFileSync(path)]));
  expect([...written.keys()].sort()).toEqual([...expected.keys()].sort());
  for (const [path, data] of written) expect(Buffer.from(data).equals(expected.get(path)!), path).toBe(true);

  // #n86gnptg: the same report in every other language the app ships, byte for byte.
  for (const language of NOTION_REPORT_LANGUAGES.filter((code) => code !== "en")) {
    const report = notionReportMarkdown(plan.report, "Notion import", language);
    const file = join(FIXTURES, "reports", `${name}.${language}.md`);
    if (process.env.UPDATE_NOTION_GOLDEN === "1") {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, report);
    }
    expect(report, file).toBe(readFileSync(file, "utf8"));
  }
  return plan;
}

describe("Notion import planner (#znyztw3t, spec/notion-import)", () => {
  it("plans the lorem fixture byte for byte (the golden in basic.expected/)", () => {
    const plan = expectGolden("basic");
    expect(plan.types).toEqual({ Number: "number", Date: "date" });
  });

  it("databases (B3, #cwi22mc6): every column type, relations, renamed keys, views (the golden in databases.expected/)", () => {
    const plan = expectGolden("databases", { vaultTypes: { Price: "number" } });
    expect(plan.types).toEqual({
      Due: "date",
      "Priority 1 5": "number",
      Done: "checkbox",
      Owner: "multitext",
      Estimate: "datetime",
      "created-notion": "datetime",
    });
    expect(plan.report.keptTypes).toEqual([{ key: "Price", type: "number", found: "text" }]);
    expect(plan.report.converted.relations).toBe(2);
    expect(plan.report.databaseDetails.map((database) => [database.name, database.kanban, database.kanbanSkipped])).toEqual([
      ["People", null, { key: "Group", groups: 13 }],
      ["Tasks", "Status", null],
    ]);
  });
  it("the synthetic export (1.0 N5, #inwiay4m): callouts, toggles, a shared image, both kinds of database, stripped titles (the golden in synthetic.expected/)", () => {
    const plan = expectGolden("synthetic");
    expect(plan.report.sharedAttachments).toEqual([
      { file: "attachments/Notion import/diagram with spaces.png", names: ["diagram with spaces.png", "Схема проекта.png"] },
    ]);
    // Every row found its page, the stripped `Q3: plan?` too (no rowWithoutPage).
    expect(plan.report.rows).toBe(5);
    expect(plan.report.missing).toEqual([]);
    expect(plan.report.outside).toEqual([]);
    expect(plan.report.skipped).toEqual([]);
  });
});

describe("Notion import planner: constructs the lorem fixture doesn't show (synthetic, unverified)", () => {
  const A = "a".repeat(32);
  const B = "b".repeat(32);
  const C = "c".repeat(32);
  const D = "d".repeat(32);
  const page = (path: string, text: string): NotionEntry => ({ path, data: enc.encode(text) });
  const plan = (entries: NotionEntry[], vaultTitles: string[] = []) =>
    planNotionImport(entries, { folder: "Notion import", attachmentsFolder: "attachments/Notion import", vaultTitles });
  const content = (result: ReturnType<typeof plan>, path: string) => {
    const file = result.files.find((item) => item.path === path);
    return typeof file?.content === "string" ? file.content : undefined;
  };

  it("names: the id goes, D20 names, duplicates get a number, a different first heading stays", () => {
    expect(stripNotionId(`Plan ${A}`)).toEqual({ name: "Plan", id: A });
    expect(stripNotionId("Plain name")).toEqual({ name: "Plain name", id: null });
    const result = plan([
      page(`Root/Plan ${A}.md`, "# Plan\n\nOne"),
      page(`Root/Plan ${B}.md`, "# Another heading\n\nTwo"),
      page(`Root/Untitled ${C}.md`, "# Untitled\n\nThree"),
    ]);
    expect(content(result, "Notion import/Root/Plan.md")).toBe("One\n");
    // The second "Plan" gets a number; its first heading differs from the title, so it stays.
    expect(content(result, "Notion import/Root/Plan 2.md")).toBe("# Another heading\n\nTwo\n");
    expect(content(result, "Notion import/Root/Untitled.md")).toBe("Three\n");
  });

  it("links: pages and mentions become wiki links (with a path when the title isn't unique); outside mentions stay web links", () => {
    const result = plan(
      [
        page(`Root/Home ${A}.md`, `# Home\n\nSee [Notes](Notes%20${B}.md), [my notes](Notes%20${B}.md), [‣](https://app.notion.com/p/${B}?pvs=21), [‣](https://www.notion.so/Old-${D}?pvs=21) and [site](https://example.com).\n\n\`[code](Notes%20${B}.md)\``),
        page(`Root/Notes ${B}.md`, "# Notes\n\nBody"),
        page(`Root/Home/Sub ${C}.md`, "# Sub\n\nBack to [Home](../Home%20" + A + ".md)"),
      ],
      ["Home"],
    );
    expect(content(result, "Notion import/Root/Home.md")).toBe(
      `See [[Notes]], [[Notes|my notes]], [[Notes]], [Notion page](https://www.notion.so/Old-${D}?pvs=21) and [site](https://example.com).\n\n\`[code](Notes%20${B}.md)\`\n`,
    );
    // "Home" is also a page already in the vault: the link names its path.
    expect(content(result, "Notion import/Root/Home/Sub.md")).toBe("Back to [[Notion import/Root/Home|Home]]\n");
    expect(result.report.outside).toEqual([{ page: "Notion import/Root/Home.md", url: `https://www.notion.so/Old-${D}?pvs=21` }]);
    // The mention of a page outside the export is counted under `outside`, not converted.
    expect(result.report.converted).toMatchObject({ pageLinks: 3, mentions: 1 });
    expect(notionUrlId(`https://app.notion.com/p/${A}?pvs=21`)).toBe(A);
  });

  it("databases: an embed alone on its line, a link inside text; row pages get their properties as frontmatter (B3)", () => {
    const result = plan([
      page(`Root/Home ${A}.md`, `# Home\n\n[Tasks](Home/Tasks%20${B}.csv)\n\nSee [the list](Home/Tasks%20${B}.csv) too.`),
      page(`Root/Home/Tasks ${B}.csv`, "﻿Name,Status\r\nWrite,Doing"),
      page(`Root/Home/Tasks ${B}_all.csv`, "﻿Name,Status,Due\r\nWrite,Doing,\"November 3, 2026\""),
      page(`Root/Home/Tasks/Write ${C}.md`, "# Write\n\nStatus: Doing\nDue: November 3, 2026\n\nThe body stays."),
    ]);
    expect(content(result, "Notion import/Root/Home.md")).toBe("![[Tasks.base]]\n\nSee [[Tasks.base|the list]] too.\n");
    expect(content(result, "Notion import/Root/Home/Tasks/Write.md")).toBe("---\nStatus: Doing\nDue: 2026-11-03\n---\n\nThe body stays.\n");
    // A table in the view's order (Due isn't in the view, and isn't select-like: no board).
    expect(content(result, "Notion import/Root/Home/Tasks.base")).toBe(
      'filters:\n  and:\n    - file.folder == "Notion import/Root/Home/Tasks"\nviews:\n  - type: table\n    name: Table\n    order:\n      - file.name\n      - Status\n',
    );
    expect(result.types).toEqual({ Due: "date" });
    expect(result.databases).toEqual([
      {
        name: "Tasks",
        basePath: "Notion import/Root/Home/Tasks.base",
        rowsFolder: "Notion import/Root/Home/Tasks",
        viewCsv: `Root/Home/Tasks ${B}.csv`,
        allCsv: `Root/Home/Tasks ${B}_all.csv`,
        rows: ["Notion import/Root/Home/Tasks/Write.md"],
      },
    ]);
    expect(result.report).toMatchObject({ pages: 1, rows: 1, databases: 1 });
  });

  it("types: the vault's own win case-insensitively, as Obsidian matches names (`Due` is the vault's `due`; @opus-hunter, B5)", () => {
    const entries = [
      page(`Root/Home ${A}.md`, `# Home\n\n[Tasks](Home/Tasks%20${B}.csv)`),
      page(`Root/Home/Tasks ${B}_all.csv`, "\uFEFFName,Due,Size\r\nWrite,\"November 3, 2026\",3"),
      page(`Root/Home/Tasks/Write ${C}.md`, "# Write\n\nDue: November 3, 2026\nSize: 3"),
    ];
    const typed = (vaultTypes: Record<string, "text" | "date" | "number">) =>
      planNotionImport(entries, { folder: "Notion import", attachmentsFolder: "attachments/Notion import", vaultTypes });
    // Same type, other case: nothing to add, nothing to report.
    const same = typed({ due: "date" });
    expect(same.types).toEqual({ Size: "number" });
    expect(same.report.keptTypes).toEqual([]);
    // A different type under another case: the vault's wins and is reported; no second entry.
    const other = typed({ DUE: "text" });
    expect(other.types).toEqual({ Size: "number" });
    expect(other.report.keptTypes).toEqual([{ key: "Due", type: "text", found: "date" }]);
    expect(other.report.databaseDetails[0]!.properties).toEqual([
      { key: "Due", type: "text" },
      { key: "Size", type: "number" },
    ]);
  });

  it("callouts and code: the emoji picks the type and is dropped; Notion's language names map to the editor's", () => {
    const result = plan([
      page(
        `Root/Tips ${A}.md`,
        "# Tips\n\n<aside>\n💡 Remember this\n\nSecond line\n</aside>\n\n<aside>\n🦄 Odd one\n</aside>\n\n```Plain Text\nx\n```\n\n```JavaScript\nlet a;\n```\n\n```C++\nint a;\n```",
      ),
    ]);
    expect(content(result, "Notion import/Root/Tips.md")).toBe(
      "> [!tip]\n> Remember this\n>\n> Second line\n\n> [!note]\n> Odd one\n\n```\nx\n```\n\n```javascript\nlet a;\n```\n\n```cpp\nint a;\n```\n",
    );
    expect(result.report.converted.callouts).toBe(2);
  });

  it("attachments: one folder per import, a name taken twice gets -1, identical bytes are stored once, missing files are reported", () => {
    const result = plan([
      page(`Root/A ${A}.md`, `# A\n\n![x](A/image.png)\n\n[gone](A/missing.pdf)`),
      { path: "Root/A/image.png", data: new Uint8Array([1, 2, 3]) },
      page(`Root/B ${B}.md`, "# B\n\n![y](B/image.png)\n\n![z](B/copy.png)"),
      { path: "Root/B/image.png", data: new Uint8Array([9, 9]) },
      { path: "Root/B/copy.png", data: new Uint8Array([1, 2, 3]) },
    ]);
    expect(content(result, "Notion import/Root/A.md")).toBe("![x](../../attachments/Notion%20import/image.png)\n\n[gone](A/missing.pdf)\n");
    expect(content(result, "Notion import/Root/B.md")).toBe(
      "![y](../../attachments/Notion%20import/image-1.png)\n\n![z](../../attachments/Notion%20import/image.png)\n",
    );
    const stored = result.files.filter((file) => file.path.startsWith("attachments/")).map((file) => file.path);
    expect(stored.sort()).toEqual(["attachments/Notion import/image-1.png", "attachments/Notion import/image.png"]);
    expect(result.report.missing).toEqual([{ page: "Notion import/Root/A.md", link: "A/missing.pdf" }]);
    // #inwiay4m: the merge is reported, with the export's names, in every language.
    expect(result.report.sharedAttachments).toEqual([{ file: "attachments/Notion import/image.png", names: ["image.png", "copy.png"] }]);
    expect(notionReportMarkdown(result.report, "Notion import")).toContain(
      "- 2 attachments\n  - 2 identical files share one copy (`attachments/Notion import/image.png`): image.png, copy.png\n",
    );
    expect(notionReportMarkdown(result.report, "Notion import", "ru")).toContain(
      "- Вложений: 2\n  - Одинаковых файлов в одной копии (`attachments/Notion import/image.png`): 2 — image.png, copy.png\n",
    );
  });

  it("a report without shared copies has no such line", () => {
    const result = plan([page(`Root/A ${A}.md`, "# A\n\n![x](A/one.png)"), { path: "Root/A/one.png", data: new Uint8Array([1]) }]);
    expect(result.report.sharedAttachments).toEqual([]);
    expect(notionReportMarkdown(result.report, "Notion import")).not.toContain("share one copy");
  });

  it("titles: a first heading that differs from the file name only by what a file name can't hold becomes `title:` (#inwiay4m, D20)", () => {
    const result = plan([
      // Notion stripped `:` and `?` from the file name.
      page(`Root/Q3 plan ${A}.md`, "# Q3: plan?\n\nGoals."),
      // ...and the dot.
      page(`Root/Section 1 1 ${B}.md`, "# Section 1.1\n\nText."),
      // A heading that really differs stays, and there's no title.
      page(`Root/Notes ${C}.md`, "# Notes on Q3\n\nBody."),
      // A plain match is dropped, as before.
      page(`Root/Plain ${D}.md`, "# Plain\n\nBody."),
    ]);
    expect(content(result, "Notion import/Root/Q3 plan.md")).toBe('---\ntitle: "Q3: plan?"\n---\n\nGoals.\n');
    expect(content(result, "Notion import/Root/Section 1 1.md")).toBe("---\ntitle: Section 1.1\n---\n\nText.\n");
    expect(content(result, "Notion import/Root/Notes.md")).toBe("# Notes on Q3\n\nBody.\n");
    expect(content(result, "Notion import/Root/Plain.md")).toBe("Body.\n");
  });

  it("rows: a CSV title Notion stripped from the file name still finds its page, and an exact title wins first (#inwiay4m)", () => {
    const E = "e".repeat(32);
    const result = plan([
      page(`Root/Home ${A}.md`, `# Home\n\n[Tasks](Home/Tasks%20${B}.csv)`),
      // "Q3: plan?" comes first in the CSV, but the page named exactly "Q3 plan" belongs to the later row.
      page(`Root/Home/Tasks ${B}.csv`, "\uFEFFName,Status\r\nQ3: plan?,Doing\r\nQ3 plan,Done"),
      page(`Root/Home/Tasks/Q3 plan ${C}.md`, "# Q3: plan?\n\nStatus: Doing\n\nStripped."),
      page(`Root/Home/Tasks/Q3 plan ${D}.md`, "# Q3 plan\n\nStatus: Done\n\nExact."),
      page(`Root/Home/Tasks/Other ${E}.md`, "# Other\n\nNo row."),
    ]);
    const files = result.files.filter((file) => file.path.startsWith("Notion import/Root/Home/Tasks/")).map((file) => [file.path, file.content]);
    expect(Object.fromEntries(files)).toEqual({
      "Notion import/Root/Home/Tasks/Q3 plan.md": '---\ntitle: "Q3: plan?"\nStatus: Doing\n---\n\nStripped.\n',
      "Notion import/Root/Home/Tasks/Q3 plan 2.md": "---\nStatus: Done\n---\n\nExact.\n",
      "Notion import/Root/Home/Tasks/Other.md": "No row.\n",
    });
    expect(result.report.skipped).toEqual([]);
  });

  it("titles: a case change is a real difference; a row page's title goes before its properties", () => {
    const result = plan([
      page(`Root/Plan ${A}.md`, "# plan\n\nBody."),
      page(`Root/Home ${B}.md`, `# Home\n\n[Tasks](Home/Tasks%20${C}.csv)`),
      page(`Root/Home/Tasks ${C}.csv`, "\uFEFFName,Status\r\nWhat now,Doing"),
      page(`Root/Home/Tasks/What now ${D}.md`, "# What now?\n\nStatus: Doing\n\nBody."),
    ]);
    expect(content(result, "Notion import/Root/Plan.md")).toBe("# plan\n\nBody.\n");
    expect(content(result, "Notion import/Root/Home/Tasks/What now.md")).toBe('---\ntitle: What now?\nStatus: Doing\n---\n\nBody.\n');
  });

  it("links that climb out of the export resolve to nothing (reported, never followed)", () => {
    const result = plan([page(`Root/A ${A}.md`, "# A\n\n[x](../../../etc/passwd)")]);
    expect(content(result, "Notion import/Root/A.md")).toBe("[x](../../../etc/passwd)\n");
    expect(result.report.missing).toHaveLength(1);
  });
});
