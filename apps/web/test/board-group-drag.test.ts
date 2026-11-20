import { describe, expect, it } from "vitest";
import { groupOffset, offsetOf, setGroupOffset } from "../src/board/group-drag";

describe("group drag offsets (#r6biyzx6)", () => {
  it("gives moved objects the shared offset and everything else a constant zero", () => {
    setGroupOffset({ ids: new Set(["a", "b"]), dx: 12, dy: -4 });
    expect(offsetOf("a")).toMatchObject({ dx: 12, dy: -4 });
    expect(offsetOf("b")).toBe(offsetOf("a"));
    // Unaffected connectors must see the same object every time (no re-render).
    expect(offsetOf("c")).toEqual({ dx: 0, dy: 0 });
    expect(offsetOf("c")).toBe(offsetOf("d"));
  });

  it("clears back to zero for everyone after the drop", () => {
    setGroupOffset({ ids: new Set(["a"]), dx: 5, dy: 5 });
    setGroupOffset(null);
    expect(groupOffset()).toBeNull();
    expect(offsetOf("a")).toEqual({ dx: 0, dy: 0 });
  });
});
