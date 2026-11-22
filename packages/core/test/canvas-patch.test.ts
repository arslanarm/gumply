import { describe, expect, it } from "vitest";
import { parseCanvas, patchCanvasFile, serializeCanvas, type CanvasBoard } from "../src/index.js";

/** #3c86ify2: minimal `.canvas` writes keep the file's own layout. */

const board = (raw: string): CanvasBoard => parseCanvas(raw);
const text = (id: string, value: string, y = 0) => ({ id, type: "text" as const, text: value, x: 0, y, width: 10, height: 10 });

const TABS = serializeCanvas({ nodes: [text("a", "See [[A]]"), text("b", "B", 20)], edges: [] });
const SPACED = '{\n  "nodes": [\n    {"id": "a", "type": "text", "text": "See [[A]]", "x": 0, "y": 0, "width": 10, "height": 10}\n  ],\n  "edges": []\n}\n';

describe("patchCanvasFile", () => {
  it("replaces only the changed string", () => {
    const before = board(TABS);
    const after = { ...before, nodes: [{ ...before.nodes[0]!, text: "See [[B]]" } as CanvasBoard["nodes"][number], before.nodes[1]!] };
    expect(patchCanvasFile(TABS, before, after)).toBe(TABS.replace("See [[A]]", "See [[B]]"));
  });

  it("escapes the new string as JSON and leaves other escapes alone", () => {
    const raw = '{"nodes":[{"id":"a","type":"text","text":"x","x":0,"y":0,"width":1,"height":1},{"id":"b","type":"text","text":"\\u00e9","x":0,"y":0,"width":1,"height":1}],"edges":[]}';
    const before = board(raw);
    const after = { ...before, nodes: [{ ...before.nodes[0]!, text: 'say "hi"\n' } as CanvasBoard["nodes"][number], before.nodes[1]!] };
    expect(patchCanvasFile(raw, before, after)).toBe(raw.replace('"text":"x"', '"text":"say \\"hi\\"\\n"'));
  });

  it("keeps a byte-order mark", () => {
    const raw = `﻿${SPACED}`;
    const before = board(SPACED);
    const after = { ...before, nodes: [{ ...before.nodes[0]!, text: "See [[B]]" } as CanvasBoard["nodes"][number]] };
    expect(patchCanvasFile(raw, before, after)).toBe(raw.replace("[[A]]", "[[B]]"));
  });

  it("appends a node with nested values in the file's indent", () => {
    const before = board(SPACED);
    const sticky = { ...text("n", "Hi", 50), color: "3", gumply: { kind: "sticky" } } as CanvasBoard["nodes"][number];
    const out = patchCanvasFile(SPACED, before, { ...before, nodes: [...before.nodes, sticky] });
    expect(out).toBe(
      SPACED.replace(
        '"height": 10}\n',
        '"height": 10},\n    {\n      "id":"n",\n      "type":"text",\n      "text":"Hi",\n      "x":0,\n      "y":50,\n      "width":10,\n      "height":10,\n      "color":"3",\n      "gumply":{"kind":"sticky"}\n    }\n',
      ),
    );
    expect(JSON.parse(out!)).toEqual(JSON.parse(JSON.stringify({ ...before, nodes: [...before.nodes, sticky] })));
  });

  it("appends to an empty board, multi-line and one-line", () => {
    const multi = '{\n\t"nodes":[],\n\t"edges":[]\n}';
    const node = text("n", "Hi") as CanvasBoard["nodes"][number];
    expect(patchCanvasFile(multi, board(multi), { ...board(multi), nodes: [node] })).toBe(
      `{\n\t"nodes":[\n\t\t${JSON.stringify(node)}\n\t],\n\t"edges":[]\n}`,
    );
    const flat = '{"nodes":[],"edges":[]}';
    expect(patchCanvasFile(flat, board(flat), { ...board(flat), nodes: [node] })).toBe(`{"nodes":[${JSON.stringify(node)}],"edges":[]}`);
  });

  it("returns the file unchanged when nothing changed", () => {
    expect(patchCanvasFile(SPACED, board(SPACED), board(SPACED))).toBe(SPACED);
  });

  it("refuses anything that isn't a minimal change (the caller writes the whole file)", () => {
    const before = board(TABS);
    const [a, b] = before.nodes as [CanvasBoard["nodes"][number], CanvasBoard["nodes"][number]];
    const cases: CanvasBoard[] = [
      { ...before, nodes: [a] }, // a node removed
      { ...before, nodes: [b, a] }, // reordered
      { ...before, nodes: [{ ...a, x: 5 }, b] }, // a number changed
      { ...before, nodes: [{ ...a, color: "1" } as typeof a, b] }, // a key added
      { ...before, edges: [{ id: "e", fromNode: "a", toNode: "b" }] }, // edges changed
      { ...before, extra: 1 } as CanvasBoard, // the top level changed
    ];
    for (const after of cases) expect(patchCanvasFile(TABS, before, after)).toBeNull();
    // The file on disk isn't the board we think it is (changed outside, or not JSON).
    expect(patchCanvasFile(TABS.replace('"B"', '"C"'), before, before)).toBeNull();
    expect(patchCanvasFile("not json", before, before)).toBeNull();
  });
});
