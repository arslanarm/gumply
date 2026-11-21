import { describe, expect, it } from "vitest";
import { vaultName, windowTitle } from "../src/lib/title.js";

describe("window title (#ux5cukze)", () => {
  it("is page, vault folder, Gumply", () => {
    expect(windowTitle({ page: "Q4 launch", vaultPath: "/home/me/Notes" })).toBe("Q4 launch — Notes — Gumply");
    expect(windowTitle({ page: null, vaultPath: "/home/me/Notes/" })).toBe("Notes — Gumply");
    expect(windowTitle({ page: "Map", vaultPath: null })).toBe("Map — Gumply");
    expect(windowTitle({})).toBe("Gumply");
  });

  it("reads the folder name from POSIX and Windows paths", () => {
    expect(vaultName("C:\\Users\\me\\My vault")).toBe("My vault");
    expect(vaultName("/Users/me/Obsidian/Work")).toBe("Work");
  });
});
