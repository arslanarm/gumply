import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import type { Node as PMNode } from "@tiptap/pm/model";
import MarkdownIt from "markdown-it";
import { MarkdownSerializer, defaultMarkdownSerializer } from "prosemirror-markdown";
import { describe, expect, it } from "vitest";
import {
  GumplyTable,
  GumplyTableCell,
  GumplyTableHeader,
  GumplyTableRow,
  registerTableSources,
  serializeTable,
} from "../src/editor/table/table.js";

const schema = getSchema([StarterKit, GumplyTable, GumplyTableRow, GumplyTableHeader, GumplyTableCell]);
const d = defaultMarkdownSerializer.nodes;
const m = defaultMarkdownSerializer.marks;
const serializer = new MarkdownSerializer(
  { doc: d.doc!, text: d.text!, paragraph: d.paragraph!, table: serializeTable as never },
  { bold: m.strong!, italic: m.em!, code: m.code!, strike: { open: "~~", close: "~~", mixable: true, expelEnclosingWhitespace: true } },
);

type Cell = string | PMNode[];
const para = (content: Cell) =>
  schema.node("paragraph", null, typeof content === "string" ? (content ? [schema.text(content)] : []) : content);
const cell = (type: "tableHeader" | "tableCell", content: Cell, align: string | null = null) =>
  schema.node(type, { align }, [para(content)]);
const row = (...cells: PMNode[]) => schema.node("tableRow", null, cells);
const table = (...rows: PMNode[]) => schema.node("doc", null, [schema.node("table", null, rows)]);

describe("editable tables → GFM (#7witbbun)", () => {
  it("writes a header row, the alignment row and body rows", () => {
    const doc = table(
      row(cell("tableHeader", "Left", "left"), cell("tableHeader", "Mid", "center"), cell("tableHeader", "Right", "right"), cell("tableHeader", "None")),
      row(cell("tableCell", "a", "left"), cell("tableCell", "b", "center"), cell("tableCell", "c", "right"), cell("tableCell", "")),
    );
    expect(serializer.serialize(doc)).toBe("| Left | Mid | Right | None |\n|:--|:-:|--:|---|\n| a | b | c |  |");
  });

  it("escapes pipes in text and code, keeps inline marks", () => {
    const bold = schema.text("bold", [schema.marks.bold!.create()]);
    const code = schema.text("x|y", [schema.marks.code!.create()]);
    const doc = table(
      row(cell("tableHeader", "A"), cell("tableHeader", "B")),
      row(cell("tableCell", "a | b"), cell("tableCell", [bold, schema.text(" and "), code])),
    );
    const out = serializer.serialize(doc);
    expect(out).toBe("| A | B |\n|---|---|\n| a \\| b | **bold** and `x\\|y` |");
    // markdown-it reads it back as the same two columns.
    const html = new MarkdownIt().render(out);
    expect(html).toContain("<td>a | b</td>");
    expect(html).toContain("<code>x|y</code>");
  });

  it("writes a header-less table with an empty header row", () => {
    const doc = table(row(cell("tableCell", "1"), cell("tableCell", "2")));
    expect(serializer.serialize(doc)).toBe("|  |  |\n|---|---|\n| 1 | 2 |");
  });

  it("writes an untouched table byte-for-byte; an edited one keeps untouched lines", () => {
    const source = "Name | Score\n:-- | --:\nAnn | 10";
    const doc = table(
      row(cell("tableHeader", "Name", "left"), cell("tableHeader", "Score", "right")),
      row(cell("tableCell", "Ann", "left"), cell("tableCell", "10", "right")),
    );
    registerTableSources(doc, [source]);
    expect(serializer.serialize(doc)).toBe(source);

    // Adding a row: the table is re-written, but untouched lines are kept.
    const edited = doc.copy(doc.content.replaceChild(0, doc.firstChild!.copy(doc.firstChild!.content.addToEnd(
      row(cell("tableCell", "Bob", "left"), cell("tableCell", "7", "right")),
    ))));
    expect(serializer.serialize(edited)).toBe("Name | Score\n:-- | --:\nAnn | 10\n| Bob | 7 |");
  });

  it("skips pairing when the table count doesn't match", () => {
    const doc = table(row(cell("tableHeader", "A")), row(cell("tableCell", "1")));
    registerTableSources(doc, ["| A |\n|---|\n| 1 |", "| extra |"]);
    expect(serializer.serialize(doc)).toBe("| A |\n|---|\n| 1 |");
  });
});

describe("row-level preservation (@opus-hunter release gate)", () => {
  const source = "No | leading | pipes\n--- | :-: | ---\n1 | 2 | 3\n4 \\| x | 5 | 6";
  const build = () =>
    table(
      row(cell("tableHeader", "No"), cell("tableHeader", "leading", "center"), cell("tableHeader", "pipes")),
      row(cell("tableCell", "1"), cell("tableCell", "2", "center"), cell("tableCell", "3")),
      row(cell("tableCell", "4 | x"), cell("tableCell", "5", "center"), cell("tableCell", "6")),
    );
  const replaceRow = (doc: PMNode, index: number, next: PMNode) => {
    const tableNode = doc.firstChild!;
    return doc.copy(doc.content.replaceChild(0, tableNode.copy(tableNode.content.replaceChild(index, next))));
  };

  it("editing one cell rewrites only that row", () => {
    const doc = build();
    registerTableSources(doc, [source]);
    const edited = replaceRow(doc, 1, row(cell("tableCell", "1!"), cell("tableCell", "2", "center"), cell("tableCell", "3")));
    expect(serializer.serialize(edited)).toBe("No | leading | pipes\n--- | :-: | ---\n| 1! | 2 | 3 |\n4 \\| x | 5 | 6");
  });

  it("adding a row keeps every original line", () => {
    const doc = build();
    registerTableSources(doc, [source]);
    const tableNode = doc.firstChild!;
    const added = doc.copy(doc.content.replaceChild(0, tableNode.copy(tableNode.content.addToEnd(
      row(cell("tableCell", "7"), cell("tableCell", "8", "center"), cell("tableCell", "9")),
    ))));
    expect(serializer.serialize(added)).toBe(`${source}\n| 7 | 8 | 9 |`);
  });

  it("changing the alignment rewrites the alignment row (and the changed rows)", () => {
    const doc = build();
    registerTableSources(doc, [source]);
    const header = row(cell("tableHeader", "No", "right"), cell("tableHeader", "leading", "center"), cell("tableHeader", "pipes"));
    const out = serializer.serialize(replaceRow(doc, 0, header));
    expect(out.split("\n").slice(0, 2)).toEqual(["| No | leading | pipes |", "|--:|:-:|---|"]);
    expect(out.split("\n").slice(2)).toEqual(["1 | 2 | 3", "4 \\| x | 5 | 6"]);
  });
});
