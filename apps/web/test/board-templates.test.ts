import { CANVAS_PRESET_COLORS, GUMPLY_SHAPES, canvasNodeKind, parseCanvas, serializeCanvas, type CanvasNode } from "@gumply/core";
import { describe, expect, it } from "vitest";
import { BOARD_TEMPLATES, boardTemplate } from "../src/board/templates";

const STANDARD_TYPES = new Set(["text", "file", "link", "group"]);
const SIDES = new Set(["top", "right", "bottom", "left"]);

const inside = (node: CanvasNode, frame: CanvasNode): boolean =>
  node.x >= frame.x &&
  node.y >= frame.y &&
  node.x + node.width <= frame.x + frame.width &&
  node.y + node.height <= frame.y + frame.height;

describe("board templates (#yewapn9k)", () => {
  it("offers the five templates of spec/v0-6 §D", () => {
    expect(BOARD_TEMPLATES.map((template) => template.name())).toEqual([
      "Kanban",
      "Mind map",
      "Retrospective",
      "Flowchart",
      "Weekly plan",
    ]);
    expect(boardTemplate("kanban")?.name()).toBe("Kanban");
    expect(boardTemplate("nope")).toBeUndefined();
  });

  for (const template of BOARD_TEMPLATES) {
    describe(template.name(), () => {
      const board = template.build();

      it("is a valid JSON Canvas file that round-trips byte for byte", () => {
        const text = serializeCanvas(board);
        const parsed = parseCanvas(text);
        // Nothing dropped by the parser: every node and edge is drawable.
        expect(parsed.nodes).toHaveLength(board.nodes.length);
        expect(parsed.edges).toHaveLength(board.edges.length);
        expect(serializeCanvas(parsed)).toBe(text);
        expect(board.nodes.length).toBeGreaterThan(2);
      });

      it("uses only standard node types, whole-number geometry and Obsidian colours", () => {
        for (const node of board.nodes) {
          expect(STANDARD_TYPES.has(node.type)).toBe(true);
          expect(canvasNodeKind(node)).not.toBe("unknown");
          expect(/^[0-9a-f]{16}$/.test(node.id)).toBe(true);
          for (const key of ["x", "y", "width", "height"] as const) expect(Number.isInteger(node[key])).toBe(true);
          expect(node.width).toBeGreaterThan(0);
          expect(node.height).toBeGreaterThan(0);
          if (node.color !== undefined) expect(CANVAS_PRESET_COLORS).toContain(node.color);
          const gumply = node.gumply as { kind?: string; shape?: string } | undefined;
          if (gumply?.kind === "shape") expect(GUMPLY_SHAPES).toContain(gumply.shape);
        }
        for (const edge of board.edges) {
          expect(SIDES.has(edge.fromSide!)).toBe(true);
          expect(SIDES.has(edge.toSide!)).toBe(true);
        }
      });

      it("draws frames behind their content, and content sits inside its frame", () => {
        const frames = board.nodes.filter((node) => node.type === "group");
        const lastFrame = board.nodes.map((node) => node.type).lastIndexOf("group");
        const firstOther = board.nodes.findIndex((node) => node.type !== "group");
        if (frames.length > 0) expect(lastFrame).toBeLessThan(firstOther);
        for (const node of board.nodes) {
          if (node.type === "group") continue;
          const overlapping = frames.filter(
            (frame) =>
              node.x < frame.x + frame.width &&
              node.x + node.width > frame.x &&
              node.y < frame.y + frame.height &&
              node.y + node.height > frame.y,
          );
          // Never half in a frame: moving the frame moves all of it or none.
          for (const frame of overlapping) expect(inside(node, frame)).toBe(true);
        }
      });

      it("gets fresh ids on every build", () => {
        const again = template.build();
        const first = new Set([...board.nodes, ...board.edges].map((item) => item.id));
        for (const item of [...again.nodes, ...again.edges]) expect(first.has(item.id)).toBe(false);
        expect(first.size).toBe(board.nodes.length + board.edges.length);
      });
    });
  }
});
