import { parseCanvas, serializeCanvas, type CanvasBoard, type CanvasNode } from "@gumply/core";
import { describe, expect, it } from "vitest";
import { amend, canRedo, canUndo, commit, createHistory, dropLast, HISTORY_LIMIT, redo, undo } from "../src/board/history.js";
import {
  addEdges,
  addFrame,
  clipboardFromText,
  clipboardToText,
  closestSides,
  copySelection,
  createEdge,
  createFrame,
  createInk,
  createShape,
  createSticky,
  createText,
  deleteElements,
  duplicateNodes,
  frameFollowers,
  moveNodes,
  nudgeNodes,
  pasteClipboard,
  reorderNodes,
  safeExternalUrl,
  updateEdge,
  updateNode,
} from "../src/board/model.js";

function text(id: string, x: number, y: number, width = 100, height = 100): CanvasNode {
  return { id, type: "text", text: id, x, y, width, height };
}

function board(...nodes: CanvasNode[]): CanvasBoard {
  return { nodes, edges: [] };
}

describe("factories", () => {
  it("create nodes in Obsidian's key order with whole-number geometry", () => {
    const sticky = createSticky({ x: 10.4, y: 20.6, width: 200, height: 200 });
    expect(Object.keys(sticky)).toEqual(["id", "type", "text", "gumply", "x", "y", "width", "height", "color"]);
    expect([sticky.x, sticky.y]).toEqual([10, 21]);
    expect(sticky.id).toMatch(/^[0-9a-f]{16}$/);
    expect(sticky.color).toBe("3");

    expect(Object.keys(createText({ x: 0, y: 0, width: 1, height: 1 }))).toEqual([
      "id",
      "type",
      "text",
      "x",
      "y",
      "width",
      "height",
    ]);
    expect(createShape({ x: 0, y: 0, width: 1, height: 1 }, "ellipse").gumply).toEqual({
      kind: "shape",
      shape: "ellipse",
    });
    // Real Obsidian writes a group's label after its geometry and colour.
    expect(Object.keys(createFrame({ x: 0, y: 0, width: 1, height: 1 }, "F", "2")).slice(2)).toEqual([
      "x",
      "y",
      "width",
      "height",
      "color",
      "label",
    ]);
  });

  it("creates edges without the default ends", () => {
    expect(Object.keys(createEdge("a", "right", "b", "left"))).toEqual(["id", "fromNode", "fromSide", "toNode", "toSide"]);
    expect(Object.keys(createEdge("a", undefined, "b", undefined))).toEqual(["id", "fromNode", "toNode"]);
  });

  it("creates ink nodes with points relative to a padded bounding box", () => {
    const ink = createInk(
      [
        [100, 200, 0.5],
        [150.25, 260.75, 0.612],
      ],
      4,
    );
    expect(ink).not.toBeNull();
    const node = ink as CanvasNode;
    // pad = ceil(4 / 2) + 2 = 4
    expect([node.x, node.y, node.width, node.height]).toEqual([96, 196, 59, 69]);
    expect(node.gumply).toEqual({
      kind: "ink",
      points: [
        [4, 4, 0.5],
        [54.3, 64.8, 0.61],
      ],
      width: 4,
    });
    expect(createInk([], 4)).toBeNull();
  });

  it("round-trips new nodes through the canvas format", () => {
    const b = addNodes([createSticky({ x: 0, y: 0, width: 200, height: 200 }, "1", "Hi [[Alice]]")]);
    expect(parseCanvas(serializeCanvas(b))).toEqual(b);
  });
});

function addNodes(nodes: CanvasNode[]): CanvasBoard {
  return { nodes, edges: [] };
}

describe("updates", () => {
  it("keeps key order and identity of untouched nodes", () => {
    const a = text("a", 0, 0);
    const b = text("b", 0, 0);
    const before = board(a, b);
    const after = updateNode(before, "a", { text: "changed", color: "2" });
    expect(Object.keys(after.nodes[0] ?? {})).toEqual(["id", "type", "text", "x", "y", "width", "height", "color"]);
    expect(after.nodes[1]).toBe(b);
    expect(before.nodes[0]?.text).toBe("a");
  });

  it("returns the same board when nothing changes and removes keys set to undefined", () => {
    const before = board({ ...text("a", 0, 0), color: "4" });
    expect(updateNode(before, "a", { text: "a" })).toBe(before);
    expect(updateNode(before, "missing", { text: "x" })).toBe(before);
    expect(updateNode(before, "a", { color: undefined }).nodes[0]).not.toHaveProperty("color");
  });

  it("rounds geometry and keeps sizes positive", () => {
    const after = updateNode(board(text("a", 0, 0)), "a", { x: 1.6, width: 0.2 });
    expect(after.nodes[0]).toMatchObject({ x: 2, width: 1 });
  });

  it("moves and nudges", () => {
    const before = board(text("a", 0, 0), text("b", 50, 50));
    expect(moveNodes(before, new Map([["a", { x: 10.2, y: -5 }]])).nodes[0]).toMatchObject({ x: 10, y: -5 });
    const nudged = nudgeNodes(before, new Set(["a", "b"]), 10, 0);
    expect(nudged.nodes.map((node) => node.x)).toEqual([10, 60]);
  });

  it("updates edges", () => {
    const before: CanvasBoard = { nodes: [text("a", 0, 0), text("b", 0, 0)], edges: [createEdge("a", "right", "b", "left")] };
    const id = before.edges[0]?.id ?? "";
    expect(updateEdge(before, id, { label: "yes" }).edges[0]?.label).toBe("yes");
    expect(updateEdge(before, id, { label: undefined })).toBe(before);
  });
});

describe("add, delete, order", () => {
  it("deletes nodes with their edges, and edges alone", () => {
    const e1 = { id: "e1", fromNode: "a", toNode: "b" };
    const e2 = { id: "e2", fromNode: "b", toNode: "c" };
    const before: CanvasBoard = { nodes: [text("a", 0, 0), text("b", 0, 0), text("c", 0, 0)], edges: [e1, e2] };
    const after = deleteElements(before, new Set(["a"]));
    expect(after.nodes.map((node) => node.id)).toEqual(["b", "c"]);
    expect(after.edges).toEqual([e2]);
    expect(deleteElements(before, new Set(), new Set(["e2"])).edges).toEqual([e1]);
    expect(deleteElements(before, new Set(["zzz"]))).toBe(before);
  });

  it("only adds edges whose ends exist", () => {
    const before = board(text("a", 0, 0), text("b", 0, 0));
    const after = addEdges(before, [
      { id: "ok", fromNode: "a", toNode: "b" },
      { id: "bad", fromNode: "a", toNode: "nope" },
    ]);
    expect(after.edges.map((edge) => edge.id)).toEqual(["ok"]);
  });

  it("brings to front and sends to back, keeping relative order", () => {
    const before = board(text("a", 0, 0), text("b", 0, 0), text("c", 0, 0), text("d", 0, 0));
    expect(reorderNodes(before, new Set(["a", "c"]), "front").nodes.map((n) => n.id)).toEqual(["b", "d", "a", "c"]);
    expect(reorderNodes(before, new Set(["b", "d"]), "back").nodes.map((n) => n.id)).toEqual(["b", "d", "a", "c"]);
    expect(reorderNodes(before, new Set(["c", "d"]), "front")).toBe(before);
  });

  it("puts a new frame just behind what it contains", () => {
    const before = board(text("far", 1000, 1000), text("in", 10, 10), text("top", 2000, 0));
    const frame = createFrame({ x: 0, y: 0, width: 300, height: 300 });
    expect(addFrame(before, frame).nodes.map((n) => n.id)).toEqual(["far", frame.id, "in", "top"]);
    const empty = createFrame({ x: -500, y: -500, width: 10, height: 10 });
    expect(addFrame(before, empty).nodes.at(-1)).toBe(empty);
  });
});

describe("frames", () => {
  it("drags what lies fully inside a selected frame", () => {
    const frame = { id: "f", type: "group" as const, label: "F", x: 0, y: 0, width: 400, height: 400 };
    const before = board(frame, text("in", 10, 10), text("edge", 350, 350), text("out", 500, 0));
    expect([...frameFollowers(before, new Set(["f"]))]).toEqual(["in"]);
    // Already-selected nodes aren't followers (they move anyway).
    expect([...frameFollowers(before, new Set(["f", "in"]))]).toEqual([]);
    expect(frameFollowers(before, new Set(["in"])).size).toBe(0);
  });
});

describe("copy, paste, duplicate", () => {
  const edge = { id: "e", fromNode: "a", toNode: "b", label: "rel" };
  const source: CanvasBoard = { nodes: [text("a", 0, 0), text("b", 200, 0), text("c", 400, 0)], edges: [edge] };

  it("copies the selection with the edges between selected nodes only", () => {
    expect(copySelection(source, new Set(["a", "b"])).edges).toEqual([edge]);
    expect(copySelection(source, new Set(["a", "c"])).edges).toEqual([]);
  });

  it("round-trips through clipboard text and rejects other text", () => {
    const clip = copySelection(source, new Set(["a", "b"]));
    expect(clipboardFromText(clipboardToText(clip))).toEqual(clip);
    expect(clipboardFromText("hello")).toBeNull();
    expect(clipboardFromText('{"gumply-board-clipboard":1,"nodes":[],"edges":[]}')).toBeNull();
    expect(clipboardFromText("gumply-board-clipboard {")).toBeNull();
  });

  it("pastes with fresh ids, remapped edges, centred on a point", () => {
    const clip = copySelection(source, new Set(["a", "b"]));
    const { board: after, nodeIds } = pasteClipboard(board(), clip, { at: { x: 1000, y: 1000 } });
    expect(nodeIds).toHaveLength(2);
    expect(nodeIds).not.toContain("a");
    // Clip bounds are 0..300 × 0..100, centre (150, 50).
    expect(after.nodes.map((n) => [n.x, n.y])).toEqual([
      [850, 950],
      [1050, 950],
    ]);
    expect(after.edges).toHaveLength(1);
    expect(after.edges[0]).toMatchObject({ fromNode: nodeIds[0], toNode: nodeIds[1], label: "rel" });
    expect(after.edges[0]?.id).not.toBe("e");
  });

  it("duplicates with an offset", () => {
    const { board: after, nodeIds } = duplicateNodes(source, new Set(["c"]));
    expect(after.nodes).toHaveLength(4);
    expect(after.nodes[3]).toMatchObject({ id: nodeIds[0], x: 424, y: 24, text: "c" });
  });
});

describe("closestSides", () => {
  const a = { x: 0, y: 0, width: 100, height: 100 };
  it("picks facing sides", () => {
    expect(closestSides(a, { x: 300, y: 10, width: 100, height: 100 })).toEqual(["right", "left"]);
    expect(closestSides(a, { x: -300, y: 10, width: 100, height: 100 })).toEqual(["left", "right"]);
    expect(closestSides(a, { x: 0, y: 300, width: 100, height: 100 })).toEqual(["bottom", "top"]);
    expect(closestSides(a, { x: 0, y: -300, width: 100, height: 100 })).toEqual(["top", "bottom"]);
  });
});

describe("history", () => {
  it("undoes and redoes, and a new commit clears redo", () => {
    const b0 = board();
    const b1 = board(text("a", 0, 0));
    const b2 = board(text("a", 0, 0), text("b", 0, 0));
    let history = commit(commit(createHistory(b0), b1), b2);
    expect(canUndo(history)).toBe(true);
    history = undo(history);
    expect(history.present).toBe(b1);
    expect(canRedo(history)).toBe(true);
    history = redo(history);
    expect(history.present).toBe(b2);
    history = commit(undo(history), b0);
    expect(canRedo(history)).toBe(false);
    expect(undo(createHistory(b0)).present).toBe(b0);
    expect(redo(createHistory(b0)).present).toBe(b0);
  });

  it("ignores no-op commits and caps its length", () => {
    const b0 = board();
    const history = createHistory(b0);
    expect(commit(history, b0)).toBe(history);
    let long = history;
    for (let i = 0; i < HISTORY_LIMIT + 20; i += 1) long = commit(long, board(text(String(i), 0, 0)));
    expect(long.past).toHaveLength(HISTORY_LIMIT);
  });

  it("amends the last step and drops it", () => {
    const b0 = board();
    const b1 = board(text("a", 0, 0));
    const b2 = board({ ...text("a", 0, 0), text: "typed" });
    const created = commit(createHistory(b0), b1);
    const typed = amend(created, b2);
    expect(typed.past).toEqual([b0]);
    expect(typed.present).toBe(b2);
    expect(undo(typed).present).toBe(b0);
    expect(amend(createHistory(b0), b1).past).toEqual([b0]);
    const dropped = dropLast(created);
    expect(dropped.present).toBe(b0);
    expect(canUndo(dropped)).toBe(false);
    expect(dropLast(createHistory(b0)).present).toBe(b0);
  });
});

describe("safeExternalUrl", () => {
  it("opens only web and mail links", () => {
    expect(safeExternalUrl("https://jsoncanvas.org/spec")).toBe("https://jsoncanvas.org/spec");
    expect(safeExternalUrl("  http://example.com ")).toBe("http://example.com/");
    expect(safeExternalUrl("mailto:team@example.com")).toBe("mailto:team@example.com");
  });

  it("refuses script, data, file and broken URLs", () => {
    for (const url of [
      "javascript:alert(1)",
      " JavaScript:alert(1)",
      "java\tscript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "vbscript:msgbox(1)",
      "not a url",
      "",
      undefined,
      42,
    ]) {
      expect(safeExternalUrl(url)).toBeNull();
    }
  });
});
