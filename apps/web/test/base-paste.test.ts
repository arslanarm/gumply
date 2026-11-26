import { describe, expect, it } from "vitest";
import { guessHeaderRow, guessType, offersSelect, parseHtmlTable, parseTsv, readPaste } from "../src/bases/paste";

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
    expect(offersSelect(["Todo", "Doing", "Todo", "Done"])).toBe(true);
    expect(offersSelect(["a", "b", "c"])).toBe(false);
    expect(offersSelect(Array.from({ length: 30 }, (_, i) => `v${i % 13}`))).toBe(false);
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
