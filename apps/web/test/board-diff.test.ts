import type { CanvasBoard } from "@gumply/core";
import { describe, expect, it } from "vitest";
import { boardCardLabel, boardDiffView } from "../src/lib/board-diff";

const text = (id: string, value: string, x = 0) => ({ id, type: "text" as const, text: value, x, y: 0, width: 100, height: 50 });

describe("board Changes in the History panel (#fr5baurg)", () => {
  const version: CanvasBoard = {
    nodes: [text("a", "Kept"), text("b", "Gone"), text("c", "Before")],
    edges: [{ id: "e1", fromNode: "a", toNode: "b" }],
  };
  const current: CanvasBoard = {
    nodes: [text("a", "Kept"), text("c", "After"), text("d", "New")],
    edges: [{ id: "e2", fromNode: "a", toNode: "d" }],
  };

  it("draws the board as it is now plus the removed cards underneath, each card marked", () => {
    const view = boardDiffView(version, current, { added: ["d"], removed: ["b"], changed: ["c"] });
    expect(view.board.nodes.map((node) => node.id)).toEqual(["b", "a", "c", "d"]);
    expect([...view.marks]).toEqual([
      ["d", "added"],
      ["c", "changed"],
      ["b", "removed"],
    ]);
    // Only the current connectors, and only between cards on the drawn board.
    expect(view.board.edges.map((edge) => edge.id)).toEqual(["e2"]);
  });

  it("names a card by its first line of text, its file, link or label", () => {
    expect(boardCardLabel(text("x", "## Plan\nsecond line"))).toBe("Plan");
    expect(boardCardLabel({ id: "f", type: "file", file: "Projects/Q1 plan.md", x: 0, y: 0, width: 1, height: 1 })).toBe("Q1 plan.md");
    expect(boardCardLabel({ id: "l", type: "link", url: "https://example.com", x: 0, y: 0, width: 1, height: 1 })).toBe("https://example.com");
    expect(boardCardLabel(text("e", "   "))).toBeNull();
    expect(boardCardLabel(text("long", "x".repeat(100)))).toHaveLength(80);
  });
});
