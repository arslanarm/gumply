import { describe, expect, it } from "vitest";
import { MAX_PASTE_OPTIONS, guessHeaderRow, guessType, offersSelect, parseCsv, pastedOptions, parseHtmlTable, pastedValue, plannedPaste, parseTsv, readPaste } from "../src/bases/paste";

/** #7prbquxu phase 2 (spec/database-tables §5): reading a paste from a spreadsheet. Invented data. */

describe("parseTsv", () => {
  it("splits rows and cells; a trailing newline and CRLF are fine", () => {
    expect(parseTsv("Name\tAge\r\nIvy\t31\r\nOtto\t8\r\n")).toEqual([
      ["Name", "Age"],
      ["Ivy", "31"],
      ["Otto", "8"],
    ]);
  });

  it("keeps empty cells, also at the ends of a row", () => {
    expect(parseTsv("\tb\t\nc\t\t")).toEqual([
      ["", "b", ""],
      ["c", "", ""],
    ]);
  });

  it("reads Excel's quoting: a tab, a newline and a doubled quote inside one cell", () => {
    expect(parseTsv('"a\tb"\t"line 1\nline 2"\n"say ""hi"""\tplain')).toEqual([
      ["a\tb", "line 1\nline 2"],
      ['say "hi"', "plain"],
    ]);
  });

  it("never splits on commas", () => {
    expect(parseTsv("Smith, John\t3")).toEqual([["Smith, John", "3"]]);
  });
});

describe("parseHtmlTable", () => {
  it("reads the first table's cells as text, <br> as a newline, entities decoded, attributes ignored", () => {
    const html =
      '<meta charset="utf-8"><table class="x"><tr><th>Name</th><th style="w">Note</th></tr>' +
      '<tr><td><b>Ivy</b></td><td>a &gt; b<br>c &amp; d</td></tr></table><table><tr><td>second</td></tr></table>';
    expect(parseHtmlTable(html)).toEqual([
      ["Name", "Note"],
      ["Ivy", "a > b\nc & d"],
    ]);
  });

  it("is null without a table", () => {
    expect(parseHtmlTable("<p>just text</p>")).toBeNull();
  });
});

describe("readPaste", () => {
  it("one value (no tab, no newline) goes into a cell as typing would, even with commas", () => {
    expect(readPaste("Smith, John")).toEqual({ value: "Smith, John" });
    expect(readPaste("42\n")).toEqual({ value: "42" });
  });

  it("a block: TSV when the text has a tab or several lines; the HTML table when the text has no tab", () => {
    expect(readPaste("a\tb\nc\td")).toEqual({ rows: [["a", "b"], ["c", "d"]] });
    expect(readPaste("a\nb")).toEqual({ rows: [["a"], ["b"]] });
    expect(readPaste("a b c d", "<table><tr><td>a b</td><td>c d</td></tr></table>")).toEqual({ rows: [["a b", "c d"]] });
  });
});

describe("type guesses (never Select silently)", () => {
  it("number, checkbox, date, else text", () => {
    expect(guessType(["1", "2.5", "-3", "1,200", ""])).toBe("number");
    expect(guessType(["TRUE", "FALSE", ""])).toBe("checkbox");
    expect(guessType(["✓", "", "✓"])).toBe("checkbox");
    expect(guessType(["yes", "no"])).toBe("checkbox");
    expect(guessType(["2026-01-05", "2026-02-10"])).toBe("date");
    expect(guessType(["05.01.2026", "10/02/2026"])).toBe("date");
    expect(guessType(["Ivy", "31"])).toBe("text");
    expect(guessType(["", ""])).toBe("text");
  });

  it("Select is offered for a column that repeats 12 or fewer values", () => {
    expect(offersSelect(["Todo", "Doing", "Todo", "Done", "Doing", "Todo"])).toBe(true);
    expect(offersSelect(["a", "b", "c"])).toBe(false);
    expect(offersSelect(Array.from({ length: 30 }, (_, i) => `v${i % 13}`))).toBe(false);
  });

  it("#bg7c9bzk (#faqr8pj9's #13): not for a column where most values aren't repeated, nor for a column of numbers", () => {
    // The hunt's "Water every days": numbers, one repeat in six.
    expect(offersSelect(["7", "14", "2", "3", "21", "7"])).toBe(false);
    // Text with one repeat in five: most values are unique, so "each repeated" would be untrue.
    expect(offersSelect(["Basil", "Cactus", "Mint", "Basil", "Aloe"])).toBe(false);
    // Numbers that do repeat a lot are still a number column, not a Select.
    expect(offersSelect(["1", "2", "1", "2", "1", "2"])).toBe(false);
    // A real Select column: few values, each used more than once.
    expect(offersSelect(["Full sun", "Shade", "Full sun", "Shade", "Partial", "Partial"])).toBe(true);
  });

  it("a Select's options from a pasted column: distinct, non-empty, a Multi-select's items split; capped at 200 (@lead, note f)", () => {
    expect(pastedOptions(["Todo", " Done ", "", "Todo"], "select")).toEqual(["Todo", "Done"]);
    expect(pastedOptions(["Go, Rust", "Go", ""], "multiselect")).toEqual(["Go", "Rust"]);
    expect(MAX_PASTE_OPTIONS).toBe(200);
  });

  it("the first row is headers when it's unique non-empty text and a later column isn't text", () => {
    expect(guessHeaderRow([["Name", "Age"], ["Ivy", "31"], ["Otto", "8"]])).toBe(true);
    expect(guessHeaderRow([["Name", "Pet"], ["Ivy", "cat"]])).toBe(false);
    expect(guessHeaderRow([["Name", "Name"], ["Ivy", "31"]])).toBe(false);
    expect(guessHeaderRow([["Name", ""], ["Ivy", "31"]])).toBe(false);
    expect(guessHeaderRow([["2026", "Age"], ["Ivy", "31"]])).toBe(false);
    expect(guessHeaderRow([["Name", "Age"]])).toBe(false);
  });
});

describe("pastedValue", () => {
  it("fits a pasted cell to its column's type, or null", () => {
    expect(pastedValue("TRUE", "checkbox")).toEqual({ value: true });
    expect(pastedValue("", "checkbox")).toEqual({ value: false });
    expect(pastedValue("maybe", "checkbox")).toBeNull();
    expect(pastedValue("1,200.5", "number")).toEqual({ value: 1200.5 });
    expect(pastedValue("abc", "number")).toBeNull();
    expect(pastedValue("5.1.2026", "date")).toEqual({ value: "2026-01-05" });
    expect(pastedValue("2026-01-05", "date")).toEqual({ value: "2026-01-05" });
    expect(pastedValue("a, b, a", "multitext")).toEqual({ value: ["a", "b"] });
    expect(pastedValue("  hello ", "text")).toEqual({ value: "hello" });
    expect(pastedValue("", "text")).toEqual({ value: null });
  });
});

describe("plannedPaste", () => {
  const columns = [
    { id: "file.name", type: "file", editable: false },
    { id: "note.role", type: "text", editable: true },
    { id: "note.age", type: "number", editable: true },
  ];

  it("overwrites down and right from the active cell; rows past the end become new rows named by the title column", () => {
    const shown = [
      { id: "Rows/Zed", updated: "v1" },
      { id: "Rows/Ann", updated: "v2" },
    ];
    const plan = plannedPaste([["Ann", "Chef", "30"], ["Bo", "Pilot", "41"], ["Cy", "Diver", "7"]], { row: 1, col: 0 }, columns, shown, "Untitled");
    expect(plan.rows).toEqual([
      { id: "Rows/Ann", expectedUpdated: "v2", set: { role: "Chef", age: 30 } },
      { title: "Bo", set: { role: "Pilot", age: 41 } },
      { title: "Cy", set: { role: "Diver", age: 7 } },
    ]);
    // The existing row's title cell isn't a rename.
    expect(plan.left).toBe(1);
    expect(plan.pastLast).toBe(0);
  });

  it("counts what it leaves out: a value that doesn't fit, a column past the last; new rows without a title get one", () => {
    const plan = plannedPaste([["Chef", "abc", "extra"], ["Pilot", "41", "more"]], { row: 0, col: 1 }, columns, [{ id: "Rows/Ann", updated: "v1" }], "Untitled");
    expect(plan.rows).toEqual([
      { id: "Rows/Ann", expectedUpdated: "v1", set: { role: "Chef" } },
      { title: "Untitled", set: { role: "Pilot", age: 41 } },
    ]);
    expect(plan.left).toBe(1);
    expect(plan.pastLast).toBe(1);
  });
});

describe("parseCsv (Import CSV…)", () => {
  it("splits on commas with RFC 4180 quoting; a byte-order mark and CRLF are fine", () => {
    expect(parseCsv('﻿Name,Note,Age\r\n"Smith, John","said ""hi""\nthen left",41\r\nIvy,,31\r\n')).toEqual([
      ["Name", "Note", "Age"],
      ["Smith, John", 'said "hi"\nthen left', "41"],
      ["Ivy", "", "31"],
    ]);
  });
});
