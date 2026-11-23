import { describe, expect, it } from "vitest";
import { OwnSaves } from "../src/lib/own-saves.js";

/** #4tquqqdv: a restore follows only this app's own confirmed saves. */
describe("OwnSaves", () => {
  it("follows our own saves from the version the dialog read", () => {
    const saves = new OwnSaves();
    saves.record("Ledger", "v1", "v2");
    saves.record("Ledger", "v2", "v3");
    expect(saves.follow("Ledger", "v1")).toBe("v3");
    expect(saves.follow("Ledger", "v2")).toBe("v3");
    expect(saves.follow("Ledger", "v3")).toBe("v3");
  });

  it("a gap (an outside change, or a save we never saw answered) stops it: the old version stays, so the server refuses", () => {
    const saves = new OwnSaves();
    saves.record("Ledger", "v1", "v2");
    // v2 → v3 was someone else's write; our next save replaced v3.
    saves.record("Ledger", "v3", "v4");
    expect(saves.follow("Ledger", "v1")).toBe("v2");
    expect(saves.follow("Ledger", "v0")).toBe("v0");
  });

  it("is per page, and forgets other pages when the open page changes", () => {
    const saves = new OwnSaves();
    saves.record("A", "a1", "a2");
    saves.record("B", "b1", "b2");
    expect(saves.follow("B", "a1")).toBe("a1");
    saves.keepOnly("B");
    expect(saves.follow("A", "a1")).toBe("a1");
    expect(saves.follow("B", "b1")).toBe("b2");
  });

  it("is bounded, and ignores no-op or unknown saves", () => {
    const saves = new OwnSaves(3);
    for (let i = 1; i <= 10; i++) saves.record("P", `v${i}`, `v${i + 1}`);
    // Only the last 3 links are kept: an old version can't be followed through forgotten ones.
    expect(saves.follow("P", "v1")).toBe("v1");
    expect(saves.follow("P", "v8")).toBe("v11");
    saves.record("P", "v11", "v11");
    saves.record("P", undefined, "v12");
    expect(saves.follow("P", "v11")).toBe("v11");
  });

  it("never loops on a cycle", () => {
    const saves = new OwnSaves();
    saves.record("P", "x", "y");
    saves.record("P", "y", "x");
    expect(["x", "y"]).toContain(saves.follow("P", "x"));
  });
});
