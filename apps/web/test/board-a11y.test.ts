import { describe, expect, it } from "vitest";
import { describeNode, nextInOrder, readingOrder } from "../src/board/a11y";

const node = (id: string, x: number, y: number, extra: Record<string, unknown> = {}) =>
  ({ id, type: "text", text: id, x, y, width: 100, height: 60, ...extra }) as never;

describe("boards from the keyboard (#pujmbsyz)", () => {
  it("Tab walks rows top to bottom, each left to right, with a little slack for a row", () => {
    const order = readingOrder([node("c", 300, 10), node("a", 0, 0), node("d", 0, 200), node("b", 150, 12), node("e", 150, 190)]);
    expect(order).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("next and previous stop at either end; nothing selected starts at the first or last", () => {
    const order = ["a", "b", "c"];
    expect(nextInOrder(order, "a", false)).toBe("b");
    expect(nextInOrder(order, "a", true)).toBeNull();
    expect(nextInOrder(order, "c", false)).toBeNull();
    expect(nextInOrder(order, null, false)).toBe("a");
    expect(nextInOrder(order, null, true)).toBe("c");
    expect(nextInOrder([], null, false)).toBeNull();
  });

  it("names an object by its kind and its text", () => {
    const t = (key: string) => ({ "board.tools.sticky": "Sticky note", "board.tools.text": "Text", "board.a11y.kinds.drawing": "Drawing" })[key] ?? key;
    expect(describeNode(node("x", 0, 0, { text: "Goal: ship", gumply: { kind: "sticky" } }), t as never)).toBe("Sticky note: Goal: ship");
    expect(describeNode(node("y", 0, 0, { text: "" }), t as never)).toBe("Text");
    expect(describeNode(node("z", 0, 0, { text: "", gumply: { kind: "ink", width: 2, points: [[0, 0]] } }), t as never)).toBe("Drawing");
  });
});
