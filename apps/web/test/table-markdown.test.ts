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

  it("writes an untouched table byte-for-byte, an edited one canonically", () => {
    const source = "Name | Score\n:-- | --:\nAnn | 10";
    const doc = table(
      row(cell("tableHeader", "Name", "left"), cell("tableHeader", "Score", "right")),
      row(cell("tableCell", "Ann", "left"), cell("tableCell", "10", "right")),
    );
    registerTableSources(doc, [source]);
    expect(serializer.serialize(doc)).toBe(source);

    // Any edit makes a new node: canonical GFM, alignment kept.
    const edited = doc.copy(doc.content.replaceChild(0, doc.firstChild!.copy(doc.firstChild!.content.addToEnd(
      row(cell("tableCell", "Bob", "left"), cell("tableCell", "7", "right")),
    ))));
    expect(serializer.serialize(edited)).toBe("| Name | Score |\n|:--|--:|\n| Ann | 10 |\n| Bob | 7 |");
  });

  it("skips pairing when the table count doesn't match", () => {
    const doc = table(row(cell("tableHeader", "A")), row(cell("tableCell", "1")));
    registerTableSources(doc, ["| A |\n|---|\n| 1 |", "| extra |"]);
    expect(serializer.serialize(doc)).toBe("| A |\n|---|\n| 1 |");
  });
});
