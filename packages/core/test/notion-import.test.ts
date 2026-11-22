import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { notionReportMarkdown, notionUrlId, planNotionImport, stripNotionId, type NotionEntry } from "../src/index";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "fixtures/notion/basic");
const EXPECTED = join(here, "fixtures/notion/basic.expected");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** The fixture as the zip's entries (`/` paths, bytes). */
function fixtureEntries(): NotionEntry[] {
  return walk(FIXTURE).map((path) => ({ path: relative(FIXTURE, path).split("\\").join("/"), data: readFileSync(path) }));
}

const enc = new TextEncoder();
const bytes = (content: string | Uint8Array) => (typeof content === "string" ? enc.encode(content) : content);

describe("Notion import planner (#znyztw3t, spec/notion-import)", () => {
  it("plans the lorem fixture byte for byte (the golden in basic.expected/)", () => {
    const plan = planNotionImport(fixtureEntries(), { folder: "Notion import", attachmentsFolder: "attachments/Notion import" });
    const written = new Map(plan.files.map((file) => [file.path, bytes(file.content)]));
    written.set("Notion import/Import report.md", enc.encode(notionReportMarkdown(plan.report, "Notion import")));

    if (process.env.UPDATE_NOTION_GOLDEN === "1") {
      for (const [path, data] of written) {
        mkdirSync(dirname(join(EXPECTED, path)), { recursive: true });
        writeFileSync(join(EXPECTED, path), data);
      }
    }
    expect(existsSync(EXPECTED)).toBe(true);
    const expected = new Map(walk(EXPECTED).map((path) => [relative(EXPECTED, path).split("\\").join("/"), readFileSync(path)]));
    expect([...written.keys()].sort()).toEqual([...expected.keys()].sort());
    for (const [path, data] of written) expect(Buffer.from(data).equals(expected.get(path)!), path).toBe(true);
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

  it("databases: an embed alone on its line, a link inside text; row pages lose their property lines (B3 hooks)", () => {
    const result = plan([
      page(`Root/Home ${A}.md`, `# Home\n\n[Tasks](Home/Tasks%20${B}.csv)\n\nSee [the list](Home/Tasks%20${B}.csv) too.`),
      page(`Root/Home/Tasks ${B}.csv`, "﻿Name,Status\r\nWrite,Doing"),
      page(`Root/Home/Tasks ${B}_all.csv`, "﻿Name,Status,Due\r\nWrite,Doing,\"November 3, 2026\""),
      page(`Root/Home/Tasks/Write ${C}.md`, "# Write\n\nStatus: Doing\nDue: November 3, 2026\n\nThe body stays."),
    ]);
    expect(content(result, "Notion import/Root/Home.md")).toBe("![[Tasks.base]]\n\nSee [[Tasks.base|the list]] too.\n");
    expect(content(result, "Notion import/Root/Home/Tasks/Write.md")).toBe("The body stays.\n");
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
  });

  it("links that climb out of the export resolve to nothing (reported, never followed)", () => {
    const result = plan([page(`Root/A ${A}.md`, "# A\n\n[x](../../../etc/passwd)")]);
    expect(content(result, "Notion import/Root/A.md")).toBe("[x](../../../etc/passwd)\n");
    expect(result.report.missing).toHaveLength(1);
  });
});
